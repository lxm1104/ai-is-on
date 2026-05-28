/**
 * MVP21 S1 §9 — 装配集成测试。
 * 验证 assembleGlobalContextPacket 给 commitments / goals / uncertainties 每条挂上
 * 正确的 _layerHint（按 mergeKey / origin.kind 分到 work_map_seed / triage 等）。
 *
 * 运行：npx tsx --test apps/server/test/assembler-layer-hint.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp21-assembler-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { assembleGlobalContextPacket } = await import(
  '../src/context/agentContextAssembler.js'
);

function resetDb() {
  db.db.exec(`
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM context_entities;
    DELETE FROM entity_aliases;
  `);
}

/** 直接插一条 ContextUnit，绕过 contextStore.upsertContextUnit 的合并逻辑，方便控制 mergeKey/origin。 */
function insertUnit(opts: {
  kind: string;
  title: string;
  mergeKey?: string | null;
  originKind: 'event' | 'system' | 'manual' | 'chat' | 'card_action' | 'agent_run';
  originRefId: string;
  dueOffsetMs?: number;
}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const timeJson =
    opts.dueOffsetMs !== undefined
      ? JSON.stringify({ dueAt: new Date(Date.now() + opts.dueOffsetMs).toISOString() })
      : null;
  db.db
    .prepare(
      `INSERT INTO context_units
       (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
        actionability, confidence, merge_key, version, status, created_at, updated_at, time_json)
       VALUES (?, 'me', 'work', ?, ?, ?, ?, '', 'record', 0.9, ?, 1, 'active', ?, ?, ?)`
    )
    .run(
      id,
      opts.originKind,
      opts.originRefId,
      opts.kind,
      opts.title,
      opts.mergeKey ?? null,
      now,
      now,
      timeJson
    );
  return id;
}

// ============================================================================

test('packet.commitments 每条都挂 _layerHint，区分 work_map_seed 与 triage 来源', () => {
  resetDb();
  const idSeed = insertUnit({
    kind: 'commitment',
    title: 'Work Map 登记的 Base UX 文案 2 条',
    mergeKey: 'work_map:commitment:base-ux:image-2',
    originKind: 'system',
    originRefId: 'work_map',
    dueOffsetMs: 24 * 3600_000,
  });
  const idTriage = insertUnit({
    kind: 'commitment',
    title: 'IM 抓到的承诺：周五前给方案',
    mergeKey: 'sha1-stub-aaa',
    originKind: 'event',
    originRefId: 'ev-1',
    dueOffsetMs: 48 * 3600_000,
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const byId = new Map(packet.commitments.map((c) => [c.id, c]));

  const seed = byId.get(idSeed);
  const triage = byId.get(idTriage);
  assert.ok(seed && seed._layerHint, 'work_map seed commitment 应在 packet 里且挂了 _layerHint');
  assert.equal(seed!._layerHint!.source, 'work_map_seed');
  assert.equal(seed!._layerHint!.layer, 'dynamic_signal');
  assert.equal(seed!._layerHint!.asserted, true);

  assert.ok(triage && triage._layerHint, 'triage commitment 应挂 _layerHint');
  assert.equal(triage!._layerHint!.source, 'triage');
  assert.equal(triage!._layerHint!.layer, 'dynamic_signal');
});

test('packet.goals 每条都挂 _layerHint', () => {
  resetDb();
  const idSeed = insertUnit({
    kind: 'goal',
    title: 'Q3 让 Chatbot 渗透率到 40%',
    mergeKey: 'work_map:goal:chatbot:q3-ramp',
    originKind: 'system',
    originRefId: 'work_map',
  });
  const idTriage = insertUnit({
    kind: 'goal',
    title: '从对话中抽出来的目标',
    mergeKey: 'sha1-bbb',
    originKind: 'event',
    originRefId: 'ev-2',
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const byId = new Map(packet.goals.map((g) => [g.id, g]));

  const seed = byId.get(idSeed);
  assert.ok(seed && seed._layerHint);
  assert.equal(seed!._layerHint!.layer, 'project_intent');
  assert.equal(seed!._layerHint!.source, 'work_map_seed');

  const triage = byId.get(idTriage);
  assert.ok(triage && triage._layerHint);
  assert.equal(triage!._layerHint!.source, 'triage');
  assert.equal(triage!._layerHint!.layer, 'dynamic_signal');
});

test('packet.uncertainties 每条都挂 _layerHint', () => {
  resetDb();
  const idSeed = insertUnit({
    kind: 'uncertainty',
    title: 'Work Map 登记的 bandwidth 风险',
    mergeKey: 'work_map:risk:base-ux:bandwidth',
    originKind: 'system',
    originRefId: 'work_map',
  });
  const idTriage = insertUnit({
    kind: 'uncertainty',
    title: 'IM 抓到的不确定性',
    mergeKey: 'sha1-ccc',
    originKind: 'event',
    originRefId: 'ev-3',
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const byId = new Map(packet.uncertainties.map((u) => [u.id, u]));

  const seed = byId.get(idSeed);
  assert.ok(seed && seed._layerHint);
  assert.equal(seed!._layerHint!.source, 'work_map_seed');
  assert.equal(seed!._layerHint!.layer, 'dynamic_signal'); // risk:* 走 dynamic 不是 identity

  const triage = byId.get(idTriage);
  assert.ok(triage && triage._layerHint);
  assert.equal(triage!._layerHint!.source, 'triage');
});

test('既有 selfRoleOnUnit 又有 _layerHint 同时挂在 commitment 上，不互相覆盖', () => {
  resetDb();
  const id = insertUnit({
    kind: 'commitment',
    title: 'mixed',
    mergeKey: 'work_map:commitment:test',
    originKind: 'system',
    originRefId: 'work_map',
    dueOffsetMs: 24 * 3600_000,
  });
  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const c = packet.commitments.find((x) => x.id === id);
  assert.ok(c);
  // selfRoleOnUnit 在没有 entity link 时是 null（不报错），_layerHint 仍正常
  assert.equal(c!.selfRoleOnUnit ?? null, null);
  assert.ok(c!._layerHint);
  assert.equal(c!._layerHint!.source, 'work_map_seed');
});
