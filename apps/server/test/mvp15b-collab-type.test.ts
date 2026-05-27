/**
 * MVP15B M4 — collabTypeClassifier 测试。
 *
 * 模式跟 decisionAuthority 一致；这里只覆盖差异点：
 *   - person_person 边（双 person 输入）
 *   - 4 档 collabType: collab / reviewer_author / cross_team / mentor
 *   - 默认 collab（保守原则）
 *
 * 运行：npx tsx --test apps/server/test/mvp15b-collab-type.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp15b-ct-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { classifyTopPpEdges } = await import('../src/util/collabTypeClassifier.js');

const NOW = Date.parse('2026-05-27T10:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();

function resetDb() {
  db.db.exec(`
    DELETE FROM entity_edges;
    DELETE FROM context_entities;
  `);
}

function mkPerson(name: string, biz?: string): string {
  const id = randomUUID();
  db.insertContextEntity({
    id, type: 'person', name,
    aliases_json: null, source: null, confidence: 0.9,
    created_at: NOW_ISO, updated_at: NOW_ISO,
    attributes_json: biz
      ? JSON.stringify({
          larkLocalizedName: name,
          larkDeptBusiness: biz,
          larkSyncedAt: NOW_ISO,
        })
      : null,
  });
  return id;
}

function mkPpEdge(a: string, b: string, weight: number, biz: string | null = 'same_business'): string {
  const id = randomUUID();
  const [from, to] = a < b ? [a, b] : [b, a];
  db.upsertEntityEdge({
    id, edge_kind: 'person_person',
    from_id: from, to_id: to,
    role_or_type: null, weight,
    business_relation: biz, shared_ids_json: '[]',
    evidence_unit_ids_json: '[]',
    detected_at: NOW_ISO, last_seen_at: NOW_ISO, updated_at: NOW_ISO,
    decision_authority: null, collab_type: null, llm_classified_at: null, llm_why: null,
  });
  return id;
}

test('T1 happy path：4 档 collabType 全部能写入', async () => {
  resetDb();
  const A = mkPerson('A', 'Lark Base');
  const B = mkPerson('B', 'Lark Base');
  const C = mkPerson('C', 'Lark Base');
  const D = mkPerson('D', 'TikTok');
  const E = mkPerson('E', 'Lark Base');
  const e1 = mkPpEdge(A, B, 2.0);
  const e2 = mkPpEdge(A, C, 1.5);
  const e3 = mkPpEdge(A, D, 1.0, 'cross_business');
  const e4 = mkPpEdge(A, E, 0.8);
  const mock = async () =>
    JSON.stringify({
      results: [
        { edgeId: e1, collabType: 'collab', why: '默认协作无强信号' },
        { edgeId: e2, collabType: 'reviewer_author', why: 'evidence 反复出现 review 关系' },
        { edgeId: e3, collabType: 'cross_team', why: '跨业务对接' },
        { edgeId: e4, collabType: 'mentor', why: 'evidence 含师徒关系' },
      ],
    });
  const r = await classifyTopPpEdges({ now: NOW, llmHook: mock });
  assert.equal(r.classified, 4);
  const edges = db.listEntityEdges({ kind: 'person_person' });
  const types = new Map(edges.map((e: any) => [e.id, e.collab_type]));
  assert.equal(types.get(e1), 'collab');
  assert.equal(types.get(e2), 'reviewer_author');
  assert.equal(types.get(e3), 'cross_team');
  assert.equal(types.get(e4), 'mentor');
});

test('T2 非法 collabType 值被 filter', async () => {
  resetDb();
  const A = mkPerson('A');
  const B = mkPerson('B');
  const e = mkPpEdge(A, B, 1.0);
  const bad = async () =>
    JSON.stringify({
      results: [{ edgeId: e, collabType: 'NOT_IN_LIST', why: '应该被过滤掉这条' }],
    });
  const r = await classifyTopPpEdges({ now: NOW, llmHook: bad });
  assert.equal(r.classified, 0);
  assert.equal(r.failed, 1);
});

test('T3 LLM 抛错 → 整批 failed，db 不污染', async () => {
  resetDb();
  const A = mkPerson('A');
  const B = mkPerson('B');
  const e = mkPpEdge(A, B, 1.0);
  const err = async () => {
    throw new Error('boom');
  };
  const r = await classifyTopPpEdges({ now: NOW, llmHook: err });
  assert.equal(r.failed, 1);
  const row = db.listEntityEdges({ kind: 'person_person' }).find((x) => x.id === e);
  assert.equal(row?.collab_type, null);
});

test('T4 topN 限制 + cache 命中', async () => {
  resetDb();
  const A = mkPerson('A');
  const B = mkPerson('B');
  const C = mkPerson('C');
  const e1 = mkPpEdge(A, B, 3.0); // 高 weight
  const e2 = mkPpEdge(A, C, 0.5); // 低 weight
  let calls = 0;
  const mock = async (msg: string) => {
    calls++;
    const m = msg.match(/<edges>([\s\S]+?)<\/edges>/);
    const parsed = m ? JSON.parse(m[1]) : [];
    return JSON.stringify({
      results: parsed.map((p: any) => ({ edgeId: p.edgeId, collabType: 'collab', why: '默认 collab' })),
    });
  };
  // topN=1 → 只标 e1
  const r1 = await classifyTopPpEdges({ now: NOW, topN: 1, llmHook: mock });
  assert.equal(r1.classified, 1);

  // cache 命中：再跑一次（NOW 不变）→ topN=1 剩 e2 还没分类 → 应该跑 LLM 标 e2
  // 但是 14d cache 只对 e1 命中，e2 还没分类（llm_classified_at IS NULL）
  // 所以 should classify e2
  const r2 = await classifyTopPpEdges({ now: NOW + 1000, topN: 50, llmHook: mock });
  assert.equal(r2.classified, 1, 'e1 cache 命中跳过, e2 新分类');
});
