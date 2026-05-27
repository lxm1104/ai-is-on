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
