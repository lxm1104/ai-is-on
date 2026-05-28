/**
 * MVP21 S3 §6.2 — Space detail handler 每条 ContextUnit 挂 _layerHint。
 *
 * 用真实 express 实例 + 真 listen 端口，fetch 调用 /api/context-spaces/:id。
 * 验证 commitments / goals / risks / state / recentEvents 五组每条 unit 都带
 * 正确的 _layerHint，区分 work_map_seed 与 triage。
 *
 * 运行：npx tsx --test apps/server/test/mvp21-space-detail-layer-hint.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp21-detail-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const dbMod = await import('../src/db.js');
const { contextSpacesRouter } = await import('../src/routes/contextSpaces.js');

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', contextSpacesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === 'object' && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function nowIso() {
  return new Date().toISOString();
}

function makeSpace(name: string): string {
  const id = randomUUID();
  const now = nowIso();
  dbMod.insertContextSpace({
    id,
    type: 'project',
    name,
    description: null,
    owner_subject_id: 'me',
    status: 'active',
    created_at: now,
    updated_at: now,
    intent_json: null,
    work_map_ref_json: null,
    suggestion_policy: 'manual_confirm',
  });
  return id;
}

function insertUnit(opts: {
  kind: string;
  title: string;
  mergeKey?: string;
  originKind: 'event' | 'system' | 'manual' | 'card_action' | 'agent_run' | 'chat';
  originRefId: string;
}): string {
  const id = randomUUID();
  const now = nowIso();
  dbMod.db
    .prepare(
      `INSERT INTO context_units
       (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
        actionability, confidence, merge_key, version, status, created_at, updated_at)
       VALUES (?, 'me', 'work', ?, ?, ?, ?, '', 'record', 0.9, ?, 1, 'active', ?, ?)`
    )
    .run(id, opts.originKind, opts.originRefId, opts.kind, opts.title, opts.mergeKey ?? null, now, now);
  return id;
}

function linkUnitToSpace(spaceId: string, unitId: string) {
  dbMod.tryInsertContextSpaceLink({
    id: randomUUID(),
    space_id: spaceId,
    target_type: 'context_unit',
    target_id: unitId,
    link_type: 'about',
    confidence: 0.9,
    created_at: nowIso(),
    reason_json: null,
  });
}

function resetDb() {
  dbMod.db.exec(`
    DELETE FROM context_units;
    DELETE FROM context_space_links;
    DELETE FROM context_spaces;
  `);
}

// ============================================================================

test('detail.commitments 每条都挂 _layerHint，正确区分 work_map_seed 与 triage', async () => {
  resetDb();
  const spaceId = makeSpace('proj-A');

  const seedId = insertUnit({
    kind: 'commitment',
    title: 'Work Map 登记的 deadline',
    mergeKey: 'work_map:commitment:proj-A:image-2',
    originKind: 'system',
    originRefId: 'work_map',
  });
  const triageId = insertUnit({
    kind: 'commitment',
    title: 'IM 抓到的承诺',
    mergeKey: 'a1b2c3d4',
    originKind: 'event',
    originRefId: 'ev-1',
  });
  linkUnitToSpace(spaceId, seedId);
  linkUnitToSpace(spaceId, triageId);

  const res = await fetch(`${baseUrl}/context-spaces/${spaceId}`);
  assert.equal(res.status, 200);
  const detail = (await res.json()) as {
    commitments: Array<{
      id: string;
      _layerHint?: { layer: string; source: string; asserted: boolean; voluntary: boolean };
    }>;
  };
  const byId = new Map(detail.commitments.map((u) => [u.id, u]));

  const seed = byId.get(seedId);
  const triage = byId.get(triageId);
  assert.ok(seed?._layerHint, 'work_map seed commitment 应挂 _layerHint');
  assert.equal(seed!._layerHint!.layer, 'dynamic_signal');
  assert.equal(seed!._layerHint!.source, 'work_map_seed');
  assert.equal(seed!._layerHint!.asserted, true);

  assert.ok(triage?._layerHint, 'triage commitment 应挂 _layerHint');
  assert.equal(triage!._layerHint!.source, 'triage');
});

test('detail.goals / risks / state / recentEvents 五组都挂 _layerHint', async () => {
  resetDb();
  const spaceId = makeSpace('proj-B');

  const goalId = insertUnit({
    kind: 'goal',
    title: 'Q3 目标',
    mergeKey: 'work_map:goal:proj-B:q3',
    originKind: 'system',
    originRefId: 'work_map',
  });
  const riskId = insertUnit({
    kind: 'uncertainty',
    title: '风险点',
    originKind: 'event',
    originRefId: 'ev-r',
  });
  const stateId = insertUnit({
    kind: 'state',
    title: '当前状态',
    originKind: 'event',
    originRefId: 'ev-s',
  });
  const eventId = insertUnit({
    kind: 'event',
    title: '日历事件',
    mergeKey: 'event:cal-1',
    originKind: 'event',
    originRefId: 'cal-1',
  });
  linkUnitToSpace(spaceId, goalId);
  linkUnitToSpace(spaceId, riskId);
  linkUnitToSpace(spaceId, stateId);
  linkUnitToSpace(spaceId, eventId);

  const res = await fetch(`${baseUrl}/context-spaces/${spaceId}`);
  const detail = (await res.json()) as {
    goals: Array<{ id: string; _layerHint?: { source: string; layer: string } }>;
    risks: Array<{ id: string; _layerHint?: { source: string } }>;
    state: Array<{ id: string; _layerHint?: { source: string } }>;
    recentEvents: Array<{ id: string; _layerHint?: { source: string } }>;
  };

  const g = detail.goals.find((x) => x.id === goalId);
  assert.equal(g?._layerHint?.layer, 'project_intent');
  assert.equal(g?._layerHint?.source, 'work_map_seed');

  const r = detail.risks.find((x) => x.id === riskId);
  assert.equal(r?._layerHint?.source, 'triage');

  const s = detail.state.find((x) => x.id === stateId);
  assert.equal(s?._layerHint?.source, 'triage');

  const e = detail.recentEvents.find((x) => x.id === eventId);
  assert.equal(e?._layerHint?.source, 'collector');
});

test('detail 字段名保持不变（commitments / goals / risks / state / recentEvents）', async () => {
  resetDb();
  const spaceId = makeSpace('proj-C');
  const id = insertUnit({
    kind: 'commitment',
    title: 't',
    originKind: 'event',
    originRefId: 'e',
  });
  linkUnitToSpace(spaceId, id);

  const res = await fetch(`${baseUrl}/context-spaces/${spaceId}`);
  const detail = (await res.json()) as Record<string, unknown>;
  for (const k of [
    'space',
    'entityLinks',
    'commitments',
    'goals',
    'decisions',
    'risks',
    'state',
    'recentEvents',
    'allUnitCount',
  ]) {
    assert.ok(k in detail, `detail 应包含字段 ${k}`);
  }
  // 确认没有新造 currentCommitments / currentGoals 之类的字段
  assert.equal('currentCommitments' in detail, false);
  assert.equal('currentGoals' in detail, false);
  assert.equal('currentUncertainties' in detail, false);
});
