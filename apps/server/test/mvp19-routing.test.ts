/**
 * MVP19 §M2 — routing + ranking 接入 canonical hierarchy 测试。
 *
 * 覆盖：
 *   - resolveUnitToSpaces 通过 project canonical / 祖先链命中 authoritative_space_id
 *     对应的 space（即便该 project entity 没被任何 space 直接 seed-link）
 *   - selfCollaboratorRanking 的 sharedProjectCanonicalNames 沿父链展开求交，
 *     使 sub-canonical 的协作证据能算到父级 canonical
 *   - boot migration（spaces → taxonomy / Chatbot-* 归并）幂等
 *
 * 运行：npx tsx --test apps/server/test/mvp19-routing.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp19-routing-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const dbMod = await import('../src/db.js');
const { resolveUnitToSpaces, createSpace } = await import(
  '../src/spaces/contextSpaceService.js'
);
const { buildSelfCollaboratorRanking, __internal } = await import(
  '../src/context/selfCollaboratorRanking.js'
);

function nowIso() {
  return new Date().toISOString();
}

function resetDb() {
  dbMod.db.exec(`
    DELETE FROM context_space_links;
    DELETE FROM context_spaces;
    DELETE FROM context_unit_entities;
    DELETE FROM context_units;
    DELETE FROM context_entities;
    DELETE FROM entity_edges;
    DELETE FROM entity_aliases;
    DELETE FROM org_project_taxonomy;
    DELETE FROM project_canonical_proposals;
    DELETE FROM settings WHERE key='self_person_entity_id';
  `);
  __internal.resetCache();
}

// ============================================================================
// T1: resolveUnitToSpaces via project canonical
// ============================================================================

test('M19.resolveUnitToSpaces：sub-canonical 通过祖先链命中父 space', () => {
  resetDb();
  const t = nowIso();

  // 建一个 space "Chatbot 产研协同"
  // createSpace 内部会自动同步到 taxonomy（authoritative_space_id 锚定）
  const chatbotSpace = createSpace({
    type: 'project',
    name: 'Chatbot 产研协同',
  });

  // 把 "Chatbot Skill Market" canonical 挂为子（boot migration 一般做这件事，
  // 但这里 reset 过 taxonomy；显式建一行模拟）
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'Chatbot Skill Market',
    aliases_json: JSON.stringify(['Chatbot Skill Market']),
    summary: null,
    parsed_by: 'manual',
    parsed_at: t,
    parent_canonical_name: 'Chatbot 产研协同',
  });

  // 构造一个 unit，entities 里出现 'Chatbot Skill Market' 这个 project。
  // 注意：这个 project entity 没被任何 space 直接 seed-link，
  // 走 canonical→authoritative_space_id 才能命中 chatbotSpace。
  const unitId = randomUUID();
  dbMod.db
    .prepare(
      `INSERT INTO context_units
        (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
         actionability, confidence, version, created_at, updated_at)
       VALUES (?, 'me', 'work', 'manual', ?, 'state', 'test', 'test',
               'record', 0.8, 1, ?, ?)`
    )
    .run(unitId, unitId, t, t);

  const linked = resolveUnitToSpaces({
    id: unitId,
    subjectId: 'me',
    scope: 'work',
    originKind: 'manual',
    originRefId: unitId,
    kind: 'state',
    title: 'test',
    content: 'test',
    actionability: 'record',
    confidence: 0.8,
    version: 1,
    createdAt: t,
    updatedAt: t,
    status: 'active',
    entities: [
      { type: 'project', name: 'Chatbot Skill Market', role: 'about' },
    ],
  } as never);

  assert.ok(
    linked.includes(chatbotSpace.id),
    `unit should route to Chatbot 产研协同 space via canonical hierarchy; got: ${JSON.stringify(linked)}`
  );

  // 验证 link 的 reason 标了 project_canonical
  const link = dbMod.db
    .prepare(
      `SELECT reason_json FROM context_space_links
        WHERE space_id=? AND target_type='context_unit' AND target_id=?`
    )
    .get(chatbotSpace.id, unitId) as { reason_json: string } | undefined;
  assert.ok(link, 'link should exist');
  const reason = JSON.parse(link!.reason_json);
  assert.equal(reason.via, 'project_canonical');
  assert.equal(reason.sourceEntityName, 'Chatbot 产研协同');
});

test('M19.resolveUnitToSpaces：unknown project name 不撞父链时走原路径', () => {
  resetDb();
  const t = nowIso();
  const space = createSpace({ type: 'project', name: 'harness 优化原则' });

  // 一个未注册到 taxonomy 的 project name，应当通过原 entity seed 路径
  // 命中 space（createSpace 默认会建 project entity 同名 seed link）
  const unitId = randomUUID();
  dbMod.db
    .prepare(
      `INSERT INTO context_units
        (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
         actionability, confidence, version, created_at, updated_at)
       VALUES (?, 'me', 'work', 'manual', ?, 'state', 'test', 'test',
               'record', 0.8, 1, ?, ?)`
    )
    .run(unitId, unitId, t, t);

  const linked = resolveUnitToSpaces({
    id: unitId,
    subjectId: 'me',
    scope: 'work',
    originKind: 'manual',
    originRefId: unitId,
    kind: 'state',
    title: 'test',
    content: 'test',
    actionability: 'record',
    confidence: 0.8,
    version: 1,
    createdAt: t,
    updatedAt: t,
    status: 'active',
    entities: [
      { type: 'project', name: 'harness 优化原则', role: 'about' },
    ],
  } as never);

  assert.ok(linked.includes(space.id));
});

// ============================================================================
// T2: selfCollaboratorRanking sub-canonical 展开求交
// ============================================================================

test('M19.sharedProjects：other 走 sub-canonical，self 走 parent，两侧展开后命中', () => {
  resetDb();
  const t = nowIso();

  // 建 taxonomy 层级：Chatbot Skill Market ⊂ Chatbot 产研协同
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'Chatbot 产研协同',
    aliases_json: '["Chatbot 产研协同"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: t,
  });
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'Chatbot Skill Market',
    aliases_json: '["Chatbot Skill Market"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: t,
    parent_canonical_name: 'Chatbot 产研协同',
  });

  // 建 self person entity + 一个 other person entity
  const selfId = 'self-' + randomUUID();
  const otherId = 'other-' + randomUUID();
  const insertEnt = dbMod.db.prepare(
    `INSERT INTO context_entities (id, type, name, aliases_json, source, confidence, created_at, updated_at, attributes_json)
     VALUES (?, 'person', ?, NULL, NULL, 0.9, ?, ?, NULL)`
  );
  insertEnt.run(selfId, 'me-self', t, t);
  insertEnt.run(otherId, '程圣淳', t, t);

  dbMod.db
    .prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('self_person_entity_id', ?, ?)`
    )
    .run(selfId, t);

  // self 的 person_project 边：仅 to_id='Chatbot 产研协同'（父）
  // other 的 person_project 边：仅 to_id='Chatbot Skill Market'（子）
  const insertEdge = (
    edge_kind: string,
    from_id: string,
    to_id: string,
    role_or_type: string | null,
    weight: number
  ) =>
    dbMod.upsertEntityEdge({
      id: randomUUID(),
      edge_kind,
      from_id,
      to_id,
      role_or_type,
      weight,
      business_relation: null,
      shared_ids_json: null,
      evidence_unit_ids_json: '[]',
      detected_at: t,
      last_seen_at: t,
      updated_at: t,
      decision_authority: null,
      collab_type: null,
      llm_classified_at: null,
      llm_why: null,
    });
  insertEdge('person_project', selfId, 'Chatbot 产研协同', 'contributor', 1.5);
  insertEdge('person_project', otherId, 'Chatbot Skill Market', 'driver', 2.0);
  // self ↔ other person_person 边（person_person 强制 from < to）
  insertEdge(
    'person_person',
    selfId < otherId ? selfId : otherId,
    selfId < otherId ? otherId : selfId,
    null,
    3.0
  );

  const entries = buildSelfCollaboratorRanking({ bypassCache: true });
  const otherEntry = entries.find((e) => e.personEntityId === otherId);
  assert.ok(otherEntry, `expected other entry in ranking, got: ${JSON.stringify(entries.map((e) => e.name))}`);
  assert.ok(
    otherEntry!.sharedProjectCanonicalNames.includes('Chatbot 产研协同'),
    `sharedProjects 应包含父 'Chatbot 产研协同'，实际：${JSON.stringify(otherEntry!.sharedProjectCanonicalNames)}`
  );
});

test('M19.sharedProjects：两侧 canonical 完全无交集（不同业务线）应空', () => {
  resetDb();
  const t = nowIso();

  // 两个独立顶层 canonical，无父子关系
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'Chatbot 产研协同',
    aliases_json: '["Chatbot 产研协同"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: t,
  });
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'harness 优化原则',
    aliases_json: '["harness 优化原则"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: t,
  });

  const selfId = 'self-' + randomUUID();
  const otherId = 'other-' + randomUUID();
  const insertEnt = dbMod.db.prepare(
    `INSERT INTO context_entities (id, type, name, aliases_json, source, confidence, created_at, updated_at, attributes_json)
     VALUES (?, 'person', ?, NULL, NULL, 0.9, ?, ?, NULL)`
  );
  insertEnt.run(selfId, 'me', t, t);
  insertEnt.run(otherId, '其他人', t, t);
  dbMod.db
    .prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('self_person_entity_id', ?, ?)`
    )
    .run(selfId, t);

  const insertEdge = (
    edge_kind: string,
    from_id: string,
    to_id: string,
    role_or_type: string | null,
    weight: number
  ) =>
    dbMod.upsertEntityEdge({
      id: randomUUID(),
      edge_kind,
      from_id,
      to_id,
      role_or_type,
      weight,
      business_relation: null,
      shared_ids_json: null,
      evidence_unit_ids_json: '[]',
      detected_at: t,
      last_seen_at: t,
      updated_at: t,
      decision_authority: null,
      collab_type: null,
      llm_classified_at: null,
      llm_why: null,
    });
  insertEdge('person_project', selfId, 'Chatbot 产研协同', 'contributor', 1.5);
  insertEdge('person_project', otherId, 'harness 优化原则', 'driver', 2.0);
  insertEdge(
    'person_person',
    selfId < otherId ? selfId : otherId,
    selfId < otherId ? otherId : selfId,
    null,
    3.0
  );

  const entries = buildSelfCollaboratorRanking({ bypassCache: true });
  const otherEntry = entries.find((e) => e.personEntityId === otherId);
  assert.ok(otherEntry);
  assert.deepEqual(otherEntry!.sharedProjectCanonicalNames, []);
});

// ============================================================================
// T3: boot migration 幂等性
// ============================================================================

test('M19.boot migration：createSpace 自动同步到 taxonomy，重复创建幂等', () => {
  resetDb();
  // 第一次创建
  const s1 = createSpace({ type: 'project', name: 'New Project A' });
  const row1 = dbMod.db
    .prepare(`SELECT * FROM org_project_taxonomy WHERE canonical_name='New Project A'`)
    .get() as {
    parsed_by: string;
    authoritative_space_id: string | null;
    aliases_json: string;
  };
  assert.equal(row1.parsed_by, 'work_map_writer');
  assert.equal(row1.authoritative_space_id, s1.id);
  assert.ok(JSON.parse(row1.aliases_json).includes('New Project A'));

  // 重复 createSpace 同名 → 返回 existing，syncSpaceToProjectTaxonomy 再跑一次也安全
  const s2 = createSpace({ type: 'project', name: 'New Project A' });
  assert.equal(s2.id, s1.id);
  const row2 = dbMod.db
    .prepare(`SELECT * FROM org_project_taxonomy WHERE canonical_name='New Project A'`)
    .get() as { parsed_by: string; authoritative_space_id: string | null };
  assert.equal(row2.authoritative_space_id, s1.id);

  // 验证只有一行
  const cnt = dbMod.db
    .prepare(`SELECT count(*) AS c FROM org_project_taxonomy WHERE canonical_name='New Project A'`)
    .get() as { c: number };
  assert.equal(cnt.c, 1);
});

test('M19.boot migration：topic 类 space 不同步到 taxonomy', () => {
  resetDb();
  createSpace({ type: 'topic', name: 'Topic X' });
  const cnt = dbMod.db
    .prepare(`SELECT count(*) AS c FROM org_project_taxonomy WHERE canonical_name='Topic X'`)
    .get() as { c: number };
  assert.equal(cnt.c, 0, 'topic 类不应进 project taxonomy');
});

test('M19.boot migration：syncSpaceToProjectTaxonomy 不覆盖已设的 parent', () => {
  resetDb();
  const t = nowIso();
  // 先建好 taxonomy 行带 parent
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'Parent Project',
    aliases_json: '["Parent Project"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: t,
  });
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'Pre-existing Canonical',
    aliases_json: '["Pre-existing Canonical"]',
    summary: 'an existing summary',
    parsed_by: 'llm',
    parsed_at: t,
    parent_canonical_name: 'Parent Project',
  });

  // 用户后续才把它建成 space
  const sp = createSpace({ type: 'project', name: 'Pre-existing Canonical' });

  const row = dbMod.db
    .prepare(`SELECT * FROM org_project_taxonomy WHERE canonical_name='Pre-existing Canonical'`)
    .get() as {
    parent_canonical_name: string | null;
    authoritative_space_id: string | null;
    summary: string | null;
    parsed_by: string;
  };
  assert.equal(row.parent_canonical_name, 'Parent Project', 'parent 不应被清空');
  assert.equal(row.authoritative_space_id, sp.id, 'authoritative_space_id 应更新');
  assert.equal(row.summary, 'an existing summary', 'summary 不应被覆盖');
  assert.equal(row.parsed_by, 'work_map_writer', 'parsed_by 应升级为 work_map_writer');
});
