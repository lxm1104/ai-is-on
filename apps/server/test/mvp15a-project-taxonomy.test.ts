/**
 * MVP15A §8.1 — projectTaxonomy 测试。
 *
 * 覆盖：parseClusterJson 容错 / hook 注入 / 缓存命中跳过 LLM / 增量解析 /
 *      force / LLM 失败兜底不污染缓存.
 *
 * 运行：npx tsx --test apps/server/test/mvp15a-project-taxonomy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp15a-pt-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const {
  parseProjectClusters,
  refreshProjectTaxonomyIfNeeded,
  __internal,
} = await import('../src/util/projectTaxonomy.js');

function resetDb() {
  db.db.exec(`
    DELETE FROM org_project_taxonomy;
    DELETE FROM context_entities;
  `);
}

function mkProject(name: string): void {
  db.insertContextEntity({
    id: randomUUID(),
    type: 'project',
    name,
    aliases_json: null,
    source: null,
    confidence: 0.8,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    attributes_json: null,
  });
}

// ----------------------------------------------------------------------------
// T9: parseClusterJson 容错
// ----------------------------------------------------------------------------
test('T9 parseClusterJson 解析合法 JSON + 自动补 canonical 进 members', () => {
  const raw = `{"clusters":[{"canonicalName":"Chatbot","memberNames":["a","b"],"summary":"x"}]}`;
  const out = __internal.parseClusterJson(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].canonicalName, 'Chatbot');
  // memberNames=[a,b] 没含 canonical → 自动 unshift Chatbot 进去
  assert.equal(out[0].memberNames.length, 3);
  assert.ok(out[0].memberNames.includes('Chatbot'));
});

test('T9.bis parseClusterJson 兼容 ```json fence', () => {
  const raw = '```json\n{"clusters":[{"canonicalName":"A","memberNames":["A"]}]}\n```';
  const out = __internal.parseClusterJson(raw);
  assert.equal(out.length, 1);
});

test('T9.ter parseClusterJson 缺 canonical 自动补 memberNames[0]', () => {
  // memberNames 不含 canonicalName 时应该自动加进去
  const raw = `{"clusters":[{"canonicalName":"Z","memberNames":["X","Y"]}]}`;
  const out = __internal.parseClusterJson(raw);
  assert.equal(out.length, 1);
  assert.ok(out[0].memberNames.includes('Z'), 'canonical 自动插入 memberNames');
});

// ----------------------------------------------------------------------------
// T10: hook 注入 + 写缓存
// ----------------------------------------------------------------------------
test('T10 parseProjectClusters with llmHook 写入 org_project_taxonomy', async () => {
  resetDb();
  const fakeOutput = JSON.stringify({
    clusters: [
      { canonicalName: 'Chatbot 产研协同', memberNames: ['chatbot agent', 'Chatbot 产研协同'], summary: 'chatbot 总线' },
      { canonicalName: 'AIME', memberNames: ['AIME'], summary: '' },
    ],
  });
  const clusters = await parseProjectClusters(
    [
      { entityName: 'chatbot agent', cooccurNames: ['张三'] },
      { entityName: 'Chatbot 产研协同', cooccurNames: ['张三'] },
      { entityName: 'AIME', cooccurNames: ['赵六'] },
    ],
    { llmHook: async () => fakeOutput }
  );
  assert.equal(clusters.length, 2);
  const tax = db.listProjectTaxonomy();
  assert.equal(tax.length, 2);
  assert.equal(db.resolveProjectCanonical('chatbot agent'), 'Chatbot 产研协同');
});

// ----------------------------------------------------------------------------
// T11: 缓存命中跳过 LLM
// ----------------------------------------------------------------------------
test('T11 refreshProjectTaxonomyIfNeeded 全缓存命中 → run=false 不调 LLM', async () => {
  resetDb();
  // 先 seed 2 个 entity + 已缓存
  mkProject('chatbot agent');
  mkProject('Chatbot 产研协同');
  db.upsertProjectTaxonomy({
    canonical_name: 'Chatbot 产研协同',
    aliases_json: JSON.stringify(['chatbot agent', 'Chatbot 产研协同']),
    summary: null,
    parsed_by: 'llm',
    parsed_at: new Date().toISOString(),
  });

  let hookCalls = 0;
  const r = await refreshProjectTaxonomyIfNeeded({
    llmHook: async () => {
      hookCalls++;
      return '{"clusters":[]}';
    },
  });
  assert.equal(r.run, false, '已缓存 → run=false');
  assert.equal(hookCalls, 0, 'hook 不被调用');
});

// ----------------------------------------------------------------------------
// T12: 增量 + force + LLM 失败兜底
// ----------------------------------------------------------------------------
test('T12 增量解析：新增 entity 仅对它调 LLM', async () => {
  resetDb();
  mkProject('chatbot agent');
  db.upsertProjectTaxonomy({
    canonical_name: 'chatbot agent',
    aliases_json: JSON.stringify(['chatbot agent']),
    summary: null,
    parsed_by: 'llm',
    parsed_at: new Date().toISOString(),
  });
  mkProject('codex'); // 新增

  let lastMsg = '';
  await refreshProjectTaxonomyIfNeeded({
    llmHook: async (msg) => {
      lastMsg = msg;
      return JSON.stringify({
        clusters: [{ canonicalName: 'codex', memberNames: ['codex'] }],
      });
    },
  });
  assert.ok(lastMsg.includes('codex'), '新 entity 在 LLM input');
  assert.ok(!lastMsg.includes('chatbot agent'), '已缓存 entity 不重发');
});

test('T12.bis force=true 跳过缓存', async () => {
  resetDb();
  mkProject('a');
  db.upsertProjectTaxonomy({
    canonical_name: 'a',
    aliases_json: '["a"]',
    summary: null,
    parsed_by: 'llm',
    parsed_at: new Date().toISOString(),
  });
  let hookCalls = 0;
  await refreshProjectTaxonomyIfNeeded({
    force: true,
    llmHook: async () => {
      hookCalls++;
      return '{"clusters":[{"canonicalName":"a","memberNames":["a"]}]}';
    },
  });
  assert.equal(hookCalls, 1, 'force 即使全缓存也调 LLM');
});

test('T12.ter LLM 失败 → 不写缓存 + 不抛', async () => {
  resetDb();
  mkProject('orphan');
  const r = await refreshProjectTaxonomyIfNeeded({
    llmHook: async () => {
      throw new Error('mocked llm down');
    },
  });
  // run=true（确实尝试了），但缓存里 orphan 仍未 cached
  assert.equal(r.run, true);
  assert.equal(db.resolveProjectCanonical('orphan'), 'orphan');
  assert.equal(db.listProjectTaxonomy().length, 0);
});

// ============================================================================
// MVP19 §M1：项目 canonical 注册表与闭词表抽取
// ============================================================================

// ----- M1-1: resolveProjectCanonical lower-case alias 命中 -----
test('M19.lower-case alias 命中（chatbot 命中存为 Chatbot 的 alias）', () => {
  resetDb();
  db.upsertProjectTaxonomy({
    canonical_name: 'Chatbot 产研协同',
    aliases_json: JSON.stringify(['Chatbot 产研协同', 'Chatbot']),
    summary: null,
    parsed_by: 'llm',
    parsed_at: new Date().toISOString(),
  });
  // 输入大小写不同也能命中
  assert.equal(db.resolveProjectCanonical('chatbot'), 'Chatbot 产研协同');
  assert.equal(db.resolveProjectCanonical('CHATBOT'), 'Chatbot 产研协同');
  assert.equal(db.resolveProjectCanonical('ChAtBoT'), 'Chatbot 产研协同');
  // 中文不受大小写影响（本来就字面匹配）
  assert.equal(db.resolveProjectCanonical('Chatbot 产研协同'), 'Chatbot 产研协同');
  // canonical 仍以注册表原大小写返回
  const tax = db.listProjectTaxonomy();
  assert.equal(tax[0].canonical_name, 'Chatbot 产研协同');
});

// ----- M1-2: getProjectAncestorChain 单层 / 多层 / 不存在 -----
test('M19.ancestor chain：单层 parent', () => {
  resetDb();
  const now = new Date().toISOString();
  db.upsertProjectTaxonomy({
    canonical_name: 'Chatbot 产研协同',
    aliases_json: '["Chatbot 产研协同"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
  });
  db.upsertProjectTaxonomy({
    canonical_name: 'Chatbot Skill Market',
    aliases_json: '["Chatbot Skill Market"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
    parent_canonical_name: 'Chatbot 产研协同',
  });
  assert.deepEqual(db.getProjectAncestorChain('Chatbot Skill Market'), [
    'Chatbot 产研协同',
  ]);
  // 顶层 canonical 没有祖先
  assert.deepEqual(db.getProjectAncestorChain('Chatbot 产研协同'), []);
  // 不存在的 canonical
  assert.deepEqual(db.getProjectAncestorChain('nonexistent'), []);
});

test('M19.ancestor chain：3 层链', () => {
  resetDb();
  const now = new Date().toISOString();
  db.upsertProjectTaxonomy({
    canonical_name: 'L1',
    aliases_json: '["L1"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
  });
  db.upsertProjectTaxonomy({
    canonical_name: 'L2',
    aliases_json: '["L2"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
    parent_canonical_name: 'L1',
  });
  db.upsertProjectTaxonomy({
    canonical_name: 'L3',
    aliases_json: '["L3"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
    parent_canonical_name: 'L2',
  });
  assert.deepEqual(db.getProjectAncestorChain('L3'), ['L2', 'L1']);
});

// ----- M1-3: getProjectAncestorChain 环防护 -----
test('M19.ancestor chain：环防护抛错', () => {
  resetDb();
  const now = new Date().toISOString();
  // 先建无环，再绕过 upsert 直接 SQL 构造 A → B → A
  db.upsertProjectTaxonomy({
    canonical_name: 'A',
    aliases_json: '["A"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
  });
  db.upsertProjectTaxonomy({
    canonical_name: 'B',
    aliases_json: '["B"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
    parent_canonical_name: 'A',
  });
  // 手动 SQL 把 A.parent 指回 B，形成环（绕过应用层 upsert 检查）
  db.db
    .prepare(
      `UPDATE org_project_taxonomy SET parent_canonical_name='B' WHERE canonical_name='A'`
    )
    .run();
  assert.throws(
    () => db.getProjectAncestorChain('A'),
    /cycle detected|hierarchy cycle/i
  );
});

// ----- M1-4: getProjectCanonicalSet 包含自身 + 祖先 -----
test('M19.canonical set：包含 canonical + ancestor，alias 大小写不敏感', () => {
  resetDb();
  const now = new Date().toISOString();
  db.upsertProjectTaxonomy({
    canonical_name: 'Chatbot 产研协同',
    aliases_json: JSON.stringify(['Chatbot 产研协同', 'Chatbot']),
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
  });
  db.upsertProjectTaxonomy({
    canonical_name: 'Chatbot Skill Market',
    aliases_json: JSON.stringify(['Chatbot Skill Market', 'Skill 市场']),
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
    parent_canonical_name: 'Chatbot 产研协同',
  });
  // 用 alias 输入也能展开
  const set = db.getProjectCanonicalSet('Skill 市场');
  assert.deepEqual(
    [...set].sort(),
    ['Chatbot Skill Market', 'Chatbot 产研协同'].sort()
  );
  // canonical 直接输入
  const set2 = db.getProjectCanonicalSet('Chatbot 产研协同');
  assert.deepEqual([...set2], ['Chatbot 产研协同']);
  // 不存在的名字
  const set3 = db.getProjectCanonicalSet('未知项目');
  assert.deepEqual([...set3], ['未知项目']);
});

// ----- M1-5: getProjectAuthoritativeSpaceId -----
test('M19.authoritative_space_id 反查', () => {
  resetDb();
  const now = new Date().toISOString();
  db.upsertProjectTaxonomy({
    canonical_name: 'Has Space',
    aliases_json: '["Has Space"]',
    summary: null,
    parsed_by: 'work_map_writer',
    parsed_at: now,
    authoritative_space_id: 'space-uuid-123',
  });
  db.upsertProjectTaxonomy({
    canonical_name: 'No Space',
    aliases_json: '["No Space"]',
    summary: null,
    parsed_by: 'llm',
    parsed_at: now,
  });
  assert.equal(db.getProjectAuthoritativeSpaceId('Has Space'), 'space-uuid-123');
  assert.equal(db.getProjectAuthoritativeSpaceId('No Space'), null);
  assert.equal(db.getProjectAuthoritativeSpaceId('nonexistent'), null);
});

// ----- M1-6: upsertProjectTaxonomy alias 跨行唯一性 -----
test('M19.alias 跨行冲突抛 AliasConflictError', () => {
  resetDb();
  const now = new Date().toISOString();
  db.upsertProjectTaxonomy({
    canonical_name: 'Alpha',
    aliases_json: JSON.stringify(['Alpha', '别名X']),
    summary: null,
    parsed_by: 'llm',
    parsed_at: now,
  });
  // 别名 X 已属 Alpha，试图把它分给 Beta 应抛 AliasConflictError
  assert.throws(
    () => {
      db.upsertProjectTaxonomy({
        canonical_name: 'Beta',
        aliases_json: JSON.stringify(['Beta', '别名X']),
        summary: null,
        parsed_by: 'llm',
        parsed_at: now,
      });
    },
    (e: unknown) =>
      e instanceof db.AliasConflictError &&
      e.alias === '别名X' &&
      e.existingCanonical === 'Alpha' &&
      e.proposedCanonical === 'Beta'
  );
  // Beta 不应被写入
  assert.equal(db.listProjectTaxonomy().length, 1);
});

test('M19.alias 冲突大小写不敏感（chatbot ≈ Chatbot）', () => {
  resetDb();
  const now = new Date().toISOString();
  db.upsertProjectTaxonomy({
    canonical_name: 'Alpha',
    aliases_json: JSON.stringify(['Alpha', 'Chatbot']),
    summary: null,
    parsed_by: 'llm',
    parsed_at: now,
  });
  assert.throws(() => {
    db.upsertProjectTaxonomy({
      canonical_name: 'Beta',
      aliases_json: JSON.stringify(['Beta', 'chatbot']), // lower-case 同名
      summary: null,
      parsed_by: 'llm',
      parsed_at: now,
    });
  }, db.AliasConflictError);
});

test('M19.同 canonical 行内重复写入 aliases 并集不冲突', () => {
  resetDb();
  const now = new Date().toISOString();
  db.upsertProjectTaxonomy({
    canonical_name: 'Alpha',
    aliases_json: JSON.stringify(['Alpha', '别名X']),
    summary: null,
    parsed_by: 'llm',
    parsed_at: now,
  });
  // 同 canonical 再次 upsert（增量 alias），不该抛
  db.upsertProjectTaxonomy({
    canonical_name: 'Alpha',
    aliases_json: JSON.stringify(['Alpha', '别名X', '别名Y']),
    summary: null,
    parsed_by: 'llm',
    parsed_at: now,
  });
  const tax = db.listProjectTaxonomy();
  assert.equal(tax.length, 1);
  const aliases = JSON.parse(tax[0].aliases_json) as string[];
  assert.ok(aliases.includes('别名X'));
  assert.ok(aliases.includes('别名Y'));
});

// ----- M1-7: upsertProjectTaxonomy 接受新可选字段 -----
test('M19.upsert 接受 parent / authoritative_space_id 并保持现状语义', () => {
  resetDb();
  const now = new Date().toISOString();
  db.upsertProjectTaxonomy({
    canonical_name: 'Parent',
    aliases_json: '["Parent"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
  });
  // 创建 child 时显式指定 parent
  db.upsertProjectTaxonomy({
    canonical_name: 'Child',
    aliases_json: '["Child"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
    parent_canonical_name: 'Parent',
    authoritative_space_id: 'space-xyz',
  });
  // 验证字段持久化
  let row = db.db
    .prepare(
      `SELECT parent_canonical_name, authoritative_space_id FROM org_project_taxonomy WHERE canonical_name='Child'`
    )
    .get() as { parent_canonical_name: string | null; authoritative_space_id: string | null };
  assert.equal(row.parent_canonical_name, 'Parent');
  assert.equal(row.authoritative_space_id, 'space-xyz');
  // 不传 parent / authoritative_space_id 的 upsert 不应清空现有值
  db.upsertProjectTaxonomy({
    canonical_name: 'Child',
    aliases_json: '["Child", "Child alias"]',
    summary: null,
    parsed_by: 'llm',
    parsed_at: now,
  });
  row = db.db
    .prepare(
      `SELECT parent_canonical_name, authoritative_space_id FROM org_project_taxonomy WHERE canonical_name='Child'`
    )
    .get() as { parent_canonical_name: string | null; authoritative_space_id: string | null };
  assert.equal(row.parent_canonical_name, 'Parent', '未显式传 parent 应保留');
  assert.equal(row.authoritative_space_id, 'space-xyz', '未显式传 authoritative_space_id 应保留');
  // 显式传 null 应清空
  db.upsertProjectTaxonomy({
    canonical_name: 'Child',
    aliases_json: '["Child", "Child alias"]',
    summary: null,
    parsed_by: 'llm',
    parsed_at: now,
    parent_canonical_name: null,
    authoritative_space_id: null,
  });
  row = db.db
    .prepare(
      `SELECT parent_canonical_name, authoritative_space_id FROM org_project_taxonomy WHERE canonical_name='Child'`
    )
    .get() as { parent_canonical_name: string | null; authoritative_space_id: string | null };
  assert.equal(row.parent_canonical_name, null);
  assert.equal(row.authoritative_space_id, null);
});

// ----- M1-8: project_canonical_proposals 表存在 + partial unique -----
test('M19.proposals 表 partial unique（pending 同名冲突，reject 后可再来）', () => {
  // 此 test 不依赖 resetDb（直接用底层 db 句柄写一遍即可）
  const now = new Date().toISOString();
  db.db
    .prepare(
      `INSERT INTO project_canonical_proposals
       (id, proposed_name, source_unit_ids_json, source_event_id, occurrences,
        first_seen_at, last_seen_at, status)
       VALUES ('p1', 'M19TestProj', '[]', NULL, 1, ?, ?, 'pending')`
    )
    .run(now, now);
  // pending 同名第二条应被 partial unique 拒绝
  assert.throws(() => {
    db.db
      .prepare(
        `INSERT INTO project_canonical_proposals
         (id, proposed_name, source_unit_ids_json, source_event_id, occurrences,
          first_seen_at, last_seen_at, status)
         VALUES ('p2', 'M19TestProj', '[]', NULL, 1, ?, ?, 'pending')`
      )
      .run(now, now);
  }, /UNIQUE constraint failed/);
  // 把第一条置 rejected → partial index 不再覆盖 → 同名 pending 可以新进
  db.db
    .prepare(
      `UPDATE project_canonical_proposals SET status='rejected', resolved_at=? WHERE id='p1'`
    )
    .run(now);
  db.db
    .prepare(
      `INSERT INTO project_canonical_proposals
       (id, proposed_name, source_unit_ids_json, source_event_id, occurrences,
        first_seen_at, last_seen_at, status)
       VALUES ('p2', 'M19TestProj', '[]', NULL, 1, ?, ?, 'pending')`
    )
    .run(now, now);
  // 清理本测试写的行，避免污染后续
  db.db.prepare(`DELETE FROM project_canonical_proposals WHERE proposed_name='M19TestProj'`).run();
});
