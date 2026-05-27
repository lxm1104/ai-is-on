/**
 * MVP15B M3 — decisionAuthorityClassifier 测试。
 *
 * 覆盖：top-N 控制 / 14d cache / force / LLM 失败 / LLM 漏返 / 非法值 filter /
 *       inducer 重跑后 LLM 标签**不被覆盖**（关键设计承诺，源自 M1 的 upsert ON CONFLICT）
 *
 * 运行：npx tsx --test apps/server/test/mvp15b-decision-authority.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp15b-da-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { classifyTopPpjEdges } = await import('../src/util/decisionAuthorityClassifier.js');

const NOW = Date.parse('2026-05-27T10:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();

function resetDb() {
  db.db.exec(`
    DELETE FROM entity_edges;
    DELETE FROM context_entities;
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
  `);
}

function mkPerson(name: string): string {
  const id = randomUUID();
  db.insertContextEntity({
    id, type: 'person', name,
    aliases_json: null, source: null, confidence: 0.9,
    created_at: NOW_ISO, updated_at: NOW_ISO,
    attributes_json: null,
  });
  return id;
}

function mkPpjEdge(personId: string, projectCanonical: string, weight: number): string {
  const id = randomUUID();
  db.upsertEntityEdge({
    id, edge_kind: 'person_project',
    from_id: personId, to_id: projectCanonical,
    role_or_type: 'contributor', weight,
    business_relation: null, shared_ids_json: null,
    evidence_unit_ids_json: '[]',
    detected_at: NOW_ISO, last_seen_at: NOW_ISO, updated_at: NOW_ISO,
    decision_authority: null, collab_type: null, llm_classified_at: null, llm_why: null,
  });
  return id;
}

test('T1 空 → run=false', async () => {
  resetDb();
  const r = await classifyTopPpjEdges({ now: NOW });
  assert.equal(r.run, false);
});

test('T2 happy path：2 条边，LLM 标 high/low', async () => {
  resetDb();
  const p1 = mkPerson('Owner');
  const p2 = mkPerson('Contributor');
  const e1 = mkPpjEdge(p1, 'X', 3.0);
  const e2 = mkPpjEdge(p2, 'X', 0.5);
  const mock = async () =>
    JSON.stringify({
      results: [
        { edgeId: e1, decisionAuthority: 'high', why: 'evidence 中"由 Owner 决定"明确 → high' },
        { edgeId: e2, decisionAuthority: 'low', why: '只是 contributor 执行任务，无决策语境' },
      ],
    });
  const r = await classifyTopPpjEdges({ now: NOW, llmHook: mock });
  assert.equal(r.classified, 2);
  assert.equal(r.failed, 0);
  const after = db.listEntityEdges({ kind: 'person_project' });
  const map = new Map(after.map((e: any) => [e.id, e]));
  assert.equal(map.get(e1)?.decision_authority, 'high');
  assert.equal(map.get(e2)?.decision_authority, 'low');
});

test('T3 cache 命中（14d 内）→ 不再分类', async () => {
  let called = 0;
  const mock = async () => {
    called++;
    return JSON.stringify({ results: [] });
  };
  const r = await classifyTopPpjEdges({ now: NOW + 1000, llmHook: mock });
  assert.equal(r.run, false);
  assert.equal(called, 0);
});

test('T4 14d 过期 → 自动重判', async () => {
  const future = NOW + 15 * 86400_000;
  let called = 0;
  const mock = async () => {
    called++;
    return JSON.stringify({
      results: [],  // empty results 模拟漏返
    });
  };
  const r = await classifyTopPpjEdges({ now: future, llmHook: mock });
  assert.equal(r.run, true);
  assert.equal(called, 1);
  // 2 条边都漏返 → 都 failed
  assert.equal(r.failed, 2);
});

test('T5 topN=1 → 只分类 weight 最高那条', async () => {
  resetDb();
  const p1 = mkPerson('High Weight');
  const p2 = mkPerson('Low Weight');
  const e1 = mkPpjEdge(p1, 'Y', 3.0);
  const e2 = mkPpjEdge(p2, 'Y', 0.5);
  const mock = async (msg: string) => {
    // 检查只传了 1 条边给 LLM
    const m = msg.match(/<edges>([\s\S]+?)<\/edges>/);
    const parsed = m ? JSON.parse(m[1]) : [];
    assert.equal(parsed.length, 1, 'LLM 输入应当只有 1 条边');
    return JSON.stringify({
      results: [
        { edgeId: parsed[0].edgeId, decisionAuthority: 'high', why: '高 weight 的应该是 owner' },
      ],
    });
  };
  const r = await classifyTopPpjEdges({ now: NOW, topN: 1, llmHook: mock });
  assert.equal(r.classified, 1);
});

test('T6 LLM 抛错 → 整批 failed，db 不污染', async () => {
  resetDb();
  const p = mkPerson('Z');
  const e = mkPpjEdge(p, 'Z', 1.0);
  const err = async () => {
    throw new Error('boom');
  };
  const r = await classifyTopPpjEdges({ now: NOW, llmHook: err });
  assert.equal(r.failed, 1);
  assert.equal(r.classified, 0);
  const row = db.listEntityEdges({ kind: 'person_project' }).find((x) => x.id === e);
  assert.equal(row?.decision_authority, null);
});

test('T7 非法 decisionAuthority 值被 filter', async () => {
  resetDb();
  const p = mkPerson('Bad');
  const e = mkPpjEdge(p, 'B', 1.0);
  const bad = async () =>
    JSON.stringify({
      results: [{ edgeId: e, decisionAuthority: 'INVALID', why: '无效值测试' }],
    });
  const r = await classifyTopPpjEdges({ now: NOW, llmHook: bad });
  assert.equal(r.classified, 0);
  assert.equal(r.failed, 1);
});

test('T8 关键设计：LLM 标后 inducer 重跑（upsertEntityEdge）不擦 LLM 字段', async () => {
  resetDb();
  const p = mkPerson('Preserved');
  const e = mkPpjEdge(p, 'P', 1.0);
  const mock = async () =>
    JSON.stringify({
      results: [{ edgeId: e, decisionAuthority: 'mid', why: 'mid 默认' }],
    });
  await classifyTopPpjEdges({ now: NOW, llmHook: mock });
  const beforeRerun = db.listEntityEdges({ kind: 'person_project' }).find((x) => x.id === e);
  assert.equal(beforeRerun?.decision_authority, 'mid');

  // inducer 重跑（用相同 row 触发 ON CONFLICT 分支）
  db.upsertEntityEdge({
    id: e, edge_kind: 'person_project',
    from_id: p, to_id: 'P',
    role_or_type: 'contributor', weight: 1.0,
    business_relation: null, shared_ids_json: null,
    evidence_unit_ids_json: '[]',
    detected_at: NOW_ISO, last_seen_at: NOW_ISO, updated_at: NOW_ISO,
    decision_authority: null, collab_type: null, llm_classified_at: null, llm_why: null,
  });
  const afterRerun = db.listEntityEdges({ kind: 'person_project' }).find((x) => x.id === e);
  // 关键断言：inducer 重跑不应该把 decision_authority 擦掉
  assert.equal(afterRerun?.decision_authority, 'mid', 'LLM 字段必须被 inducer 重跑保留');
  assert.equal(afterRerun?.llm_why, 'mid 默认');
});
