/**
 * MVP19 §M3 — triage 闭词表抽取 + proposal 队列。
 *
 * 覆盖：
 *   - buildKnownProjectsBlock 渲染（顶层 + alias + sub + 排序 + 截断）
 *   - upsertProjectCanonicalProposal pending 唯一性 + occurrences bump + sourceUnitIds 累加
 *   - parseTriage 解析 proposedNewProjects
 *   - buildTriageUserMessage 注入 knownProjects 块
 *   - triageQueue 持久化：合法 canonical/alias 通过；未命中转 proposal；
 *     item.proposedNewProjects 落库
 *
 * 运行：npx tsx --test apps/server/test/mvp19-triage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp19-triage-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const dbMod = await import('../src/db.js');
const { parseTriageResult } = await import('../src/triage/parseTriage.js');
const { buildTriageUserMessage } = await import('../src/triage/triagePrompt.js');

function t() {
  return new Date().toISOString();
}

function resetDb() {
  dbMod.db.exec(`
    DELETE FROM org_project_taxonomy;
    DELETE FROM project_canonical_proposals;
    DELETE FROM context_units;
    DELETE FROM context_entities;
    DELETE FROM events;
  `);
}

// ============================================================================
// T1: buildKnownProjectsBlock
// ============================================================================

test('M19.buildKnownProjectsBlock：顶层 canonical + alias + sub 渲染', () => {
  resetDb();
  const now = t();
  // 顶层：Chatbot 产研协同（有 authoritative_space_id）+ harness 优化原则
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'Chatbot 产研协同',
    aliases_json: JSON.stringify(['Chatbot 产研协同', 'Chatbot', 'Chatbot 产研']),
    summary: null,
    parsed_by: 'work_map_writer',
    parsed_at: now,
    authoritative_space_id: 'space-cb',
  });
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'harness 优化原则',
    aliases_json: JSON.stringify(['harness 优化原则']),
    summary: null,
    parsed_by: 'work_map_writer',
    parsed_at: now,
    authoritative_space_id: 'space-h',
  });
  // 子：3 个挂在 Chatbot 产研协同 之下
  for (const name of ['Chatbot Skill Market', 'Chatbot Agent Builder', 'Chatbot一期']) {
    dbMod.upsertProjectTaxonomy({
      canonical_name: name,
      aliases_json: JSON.stringify([name]),
      summary: null,
      parsed_by: 'llm',
      parsed_at: now,
      parent_canonical_name: 'Chatbot 产研协同',
    });
  }

  const out = dbMod.buildKnownProjectsBlock();
  // 顶层条数（不含 sub canonical）
  assert.match(out, /<knownProjects count="2">/);
  // 父行包含 alias 列表
  assert.match(out, /- "Chatbot 产研协同" \(alias: "Chatbot", "Chatbot 产研"\)/);
  // sub 行存在且按字母序
  assert.match(out, /\n  sub: "Chatbot Agent Builder", "Chatbot Skill Market", "Chatbot一期"\n/);
  // harness 没有 sub，应只有单行
  assert.match(out, /- "harness 优化原则"\n<\/knownProjects>/);
});

test('M19.buildKnownProjectsBlock：authoritative_space_id 优先于其他排序', () => {
  resetDb();
  const now = t();
  // 三个顶层：A 有 space + 没近期 edge；B 无 space + 有近期 edge；C 啥都没有
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'A',
    aliases_json: '["A"]',
    summary: null,
    parsed_by: 'work_map_writer',
    parsed_at: now,
    authoritative_space_id: 'space-a',
  });
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'B',
    aliases_json: '["B"]',
    summary: null,
    parsed_by: 'llm',
    parsed_at: now,
  });
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'C',
    aliases_json: '["C"]',
    summary: null,
    parsed_by: 'llm',
    parsed_at: now,
  });
  // 给 B 一个近期 person_project edge
  const meId = 'me-' + randomUUID();
  dbMod.db
    .prepare(
      `INSERT INTO context_entities (id, type, name, aliases_json, source, confidence, created_at, updated_at, attributes_json)
       VALUES (?, 'person', 'me', NULL, NULL, 0.9, ?, ?, NULL)`
    )
    .run(meId, now, now);
  dbMod.upsertEntityEdge({
    id: randomUUID(),
    edge_kind: 'person_project',
    from_id: meId,
    to_id: 'B',
    role_or_type: 'contributor',
    weight: 1.0,
    business_relation: null,
    shared_ids_json: null,
    evidence_unit_ids_json: '[]',
    detected_at: now,
    last_seen_at: now,
    updated_at: now,
    decision_authority: null,
    collab_type: null,
    llm_classified_at: null,
    llm_why: null,
  });

  const out = dbMod.buildKnownProjectsBlock();
  // 期望顺序：A（有 space）→ B（近期 edge）→ C（字母序兜底）
  const idxA = out.indexOf('- "A"');
  const idxB = out.indexOf('- "B"');
  const idxC = out.indexOf('- "C"');
  assert.ok(idxA >= 0 && idxB >= 0 && idxC >= 0);
  assert.ok(idxA < idxB, 'A 有 authoritative_space_id 应排前');
  assert.ok(idxB < idxC, 'B 有近期 edge 应排在 C 前');
});

test('M19.buildKnownProjectsBlock：maxTopLevel 截断', () => {
  resetDb();
  const now = t();
  for (let i = 0; i < 5; i++) {
    dbMod.upsertProjectTaxonomy({
      canonical_name: `Proj${String(i).padStart(2, '0')}`,
      aliases_json: JSON.stringify([`Proj${String(i).padStart(2, '0')}`]),
      summary: null,
      parsed_by: 'llm',
      parsed_at: now,
    });
  }
  const out = dbMod.buildKnownProjectsBlock({ maxTopLevel: 2 });
  assert.match(out, /truncated="true"/);
  // 只渲染前 2 行
  assert.equal((out.match(/^- /gm) ?? []).length, 2);
});

// ============================================================================
// T2: upsertProjectCanonicalProposal
// ============================================================================

test('M19.upsertProjectCanonicalProposal：首次插入 status=pending occurrences=1', () => {
  resetDb();
  const r = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'NewProj',
    sourceUnitIds: ['u1'],
    sourceEventId: 'e1',
  });
  assert.equal(r.created, true);
  assert.equal(r.occurrences, 1);
  const row = dbMod.db
    .prepare(`SELECT * FROM project_canonical_proposals WHERE id=?`)
    .get(r.id) as Record<string, unknown>;
  assert.equal(row.proposed_name, 'NewProj');
  assert.equal(row.status, 'pending');
  assert.equal(row.occurrences, 1);
  assert.deepEqual(JSON.parse(row.source_unit_ids_json as string), ['u1']);
});

test('M19.upsertProjectCanonicalProposal：同名 pending 行 bump + 累加 unit ids', () => {
  resetDb();
  const r1 = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'X',
    sourceUnitIds: ['u1', 'u2'],
    sourceEventId: 'e1',
  });
  const r2 = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'X',
    sourceUnitIds: ['u2', 'u3'], // u2 重复，期望去重
    sourceEventId: 'e2',
  });
  assert.equal(r2.created, false);
  assert.equal(r2.id, r1.id);
  assert.equal(r2.occurrences, 2);
  const row = dbMod.db
    .prepare(`SELECT source_unit_ids_json FROM project_canonical_proposals WHERE id=?`)
    .get(r1.id) as { source_unit_ids_json: string };
  const ids = JSON.parse(row.source_unit_ids_json) as string[];
  assert.deepEqual(ids.sort(), ['u1', 'u2', 'u3']);
});

test('M19.upsertProjectCanonicalProposal：sourceUnitIds 截 20 条', () => {
  resetDb();
  const many = Array.from({ length: 30 }, (_, i) => `u${i}`);
  dbMod.upsertProjectCanonicalProposal({
    proposedName: 'Y',
    sourceUnitIds: many,
    sourceEventId: null,
  });
  const row = dbMod.db
    .prepare(`SELECT source_unit_ids_json FROM project_canonical_proposals WHERE proposed_name='Y'`)
    .get() as { source_unit_ids_json: string };
  const ids = JSON.parse(row.source_unit_ids_json) as string[];
  assert.equal(ids.length, 20);
  // 截尾 = 保留最后 20 条
  assert.equal(ids[0], 'u10');
  assert.equal(ids[19], 'u29');
});

test('M19.upsertProjectCanonicalProposal：rejected 后同名可重新进 pending', () => {
  resetDb();
  const r1 = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'Z',
    sourceUnitIds: ['u1'],
    sourceEventId: null,
  });
  // 模拟 reject
  dbMod.db
    .prepare(
      `UPDATE project_canonical_proposals SET status='rejected', resolved_at=? WHERE id=?`
    )
    .run(t(), r1.id);
  const r2 = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'Z',
    sourceUnitIds: ['u9'],
    sourceEventId: null,
  });
  assert.equal(r2.created, true, '应该新建一条 pending');
  assert.notEqual(r2.id, r1.id);
});

// ============================================================================
// T3: parseTriage 解析 proposedNewProjects
// ============================================================================

test('M19.parseTriage：proposedNewProjects 解析', () => {
  const raw = JSON.stringify({
    items: [
      {
        sourceEventId: 'e1',
        relevant: true,
        priority: 'P2',
        title: 't',
        summary: 's',
        reason: 'r',
        confidence: 0.8,
        shouldCreateCard: true,
        cardActions: [],
        contextUpdates: [],
        proposedNewProjects: [
          { name: 'Foo', evidence: '原文里出现了 Foo', suggestedParent: 'Chatbot 产研协同' },
          { name: 'Bar' },
          { name: '', evidence: '空 name 应被丢弃' }, // 跳过
          { evidence: 'no name' }, // 跳过
        ],
      },
    ],
  });
  const out = parseTriageResult(raw);
  assert.equal(out.items.length, 1);
  const proposals = out.items[0].proposedNewProjects;
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].name, 'Foo');
  assert.equal(proposals[0].evidence, '原文里出现了 Foo');
  assert.equal(proposals[0].suggestedParent, 'Chatbot 产研协同');
  assert.equal(proposals[1].name, 'Bar');
  assert.equal(proposals[1].evidence, undefined);
});

test('M19.parseTriage：缺 proposedNewProjects 默认空数组', () => {
  const raw = JSON.stringify({
    items: [
      {
        sourceEventId: 'e1',
        relevant: true,
        priority: 'P2',
        title: 't',
        summary: 's',
        reason: 'r',
        confidence: 0.8,
        shouldCreateCard: true,
        cardActions: [],
        contextUpdates: [],
      },
    ],
  });
  const out = parseTriageResult(raw);
  assert.deepEqual(out.items[0].proposedNewProjects, []);
});

// ============================================================================
// T4: buildTriageUserMessage 注入 knownProjects
// ============================================================================

test('M19.buildTriageUserMessage：传入 knownProjectsBlock 注入到 user message', () => {
  const msg = buildTriageUserMessage({
    signals: [
      {
        id: 'e1',
        source: 'im',
        kind: 'group_message',
        occurredAt: t(),
        title: null,
        text: 'hi',
        actor: null,
        url: null,
      },
    ],
    userRules: [],
    knownProjectsBlock: '<knownProjects count="1">\n- "TestProj"\n</knownProjects>',
  });
  assert.match(msg, /当前已知项目/);
  assert.match(msg, /<knownProjects count="1">/);
  assert.match(msg, /- "TestProj"/);
});

test('M19.buildTriageUserMessage：knownProjectsBlock=null 时不注入', () => {
  const msg = buildTriageUserMessage({
    signals: [
      {
        id: 'e1',
        source: 'im',
        kind: 'group_message',
        occurredAt: t(),
        title: null,
        text: 'hi',
        actor: null,
        url: null,
      },
    ],
    userRules: [],
    knownProjectsBlock: null,
  });
  assert.doesNotMatch(msg, /<knownProjects/);
  assert.doesNotMatch(msg, /当前已知项目/);
});
