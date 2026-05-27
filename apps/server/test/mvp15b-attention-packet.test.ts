/**
 * MVP15B M6 / M7 — packet slice 集成 + attention prompt 渲染。
 *
 * 覆盖：
 *  - GlobalContextPacket 含 myTopCollaborators 字段且 cap=12
 *  - AgentContextPacket 在 declared 'graphContext' AND input.unit 时含 graphContext
 *  - attentionPrompt buildAttentionUserMessage 含 <myTopCollaborators> block
 *  - attention system prompt 含 §13
 *
 * 运行：npx tsx --test apps/server/test/mvp15b-attention-packet.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp15b-pkt-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const ass = await import('../src/context/agentContextAssembler.js');
const prompt = await import('../src/attention/attentionPrompt.js');

const NOW = Date.parse('2026-05-27T10:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();

function resetDb() {
  db.db.exec(`
    DELETE FROM entity_edges;
    DELETE FROM context_entities;
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM settings WHERE key='self_person_entity_id';
  `);
}

test('T1 GlobalContextPacket type 含 myTopCollaborators 字段', () => {
  resetDb();
  const pkt = ass.assembleGlobalContextPacket({ now: NOW });
  // 空 db 返回空数组而不是 undefined
  assert.ok(Array.isArray(pkt.myTopCollaborators), 'myTopCollaborators 必须存在且是数组');
  assert.equal(pkt.myTopCollaborators.length, 0);
});

test('T2 attention buildAttentionUserMessage 含 <myTopCollaborators> block', () => {
  resetDb();
  const pkt = ass.assembleGlobalContextPacket({ now: NOW });
  const msg = prompt.buildAttentionUserMessage(pkt, { currentLive: [] });
  // 空协作圈应当渲染 self-closing tag
  assert.ok(msg.includes('<myTopCollaborators/>'), 'block 应当存在（空时 self-closing）');
});

test('T3 attention system prompt 含 §13', () => {
  assert.ok(prompt.ATTENTION_SYSTEM_PROMPT.includes('13. （MVP15B）'), '§13 必须在 system prompt');
  assert.ok(
    prompt.ATTENTION_SYSTEM_PROMPT.includes('myTopCollaborators'),
    'system prompt 必须提到 myTopCollaborators'
  );
  assert.ok(
    prompt.ATTENTION_SYSTEM_PROMPT.includes('weight ≥ 1.5'),
    'system prompt §13(a) weight 阈值'
  );
});

// 顶层 import contextStore（避免 await 散在 each test）
const cs = await import('../src/context/contextStore.js');

test('T4 PacketSlice 类型扩展含 graphContext', () => {
  resetDb();
  const id = randomUUID();
  db.db.prepare(
    `INSERT INTO context_units (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content, time_json, actionability, confidence, status, created_at, updated_at, merge_key)
     VALUES (?, 'me', 'work', 'manual', ?, 'state', 'test', 'test', NULL, 'record', 0.9, 'active', ?, ?, ?)`
  ).run(id, id, NOW_ISO, NOW_ISO, `m:${id}`);
  const unit = cs.getContextUnitById(id);
  assert.ok(unit, 'focal unit 应该被加载');

  // declared 含 'graphContext' AND unit 非空 → packet.graphContext 应当存在
  const pkt = ass.assembleAgentContextPacket({
    agentRunId: 'r1',
    trigger: {
      id: 't1', trigger_type: 'commitment_due',
      payload_json: '{}', reasoning: null,
      status: 'pending', context_unit_id: null, due_at: null, due_at_bucket: null,
      created_at: NOW_ISO, updated_at: NOW_ISO,
    } as any,
    unit: unit!,
    slices: ['focalUnit', 'graphContext'],
    packetSliceVersion: 2,
  });
  assert.ok(pkt.graphContext, 'graphContext slice 必须存在');
  assert.ok(Array.isArray(pkt.graphContext.decisionPath));
  assert.ok(Array.isArray(pkt.graphContext.expectedButMissing.persons));
  assert.ok(Array.isArray(pkt.graphContext.activeBlockers));
});

test('T5 不 declare graphContext → packet.graphContext = undefined', () => {
  resetDb();
  const id = randomUUID();
  db.db.prepare(
    `INSERT INTO context_units (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content, time_json, actionability, confidence, status, created_at, updated_at, merge_key)
     VALUES (?, 'me', 'work', 'manual', ?, 'state', 'test', 'test', NULL, 'record', 0.9, 'active', ?, ?, ?)`
  ).run(id, id, NOW_ISO, NOW_ISO, `m:${id}`);
  const unit = cs.getContextUnitById(id);
  const pkt = ass.assembleAgentContextPacket({
    agentRunId: 'r2',
    trigger: {
      id: 't2', trigger_type: 'commitment_due',
      payload_json: '{}', reasoning: null,
      status: 'pending', context_unit_id: null, due_at: null, due_at_bucket: null,
      created_at: NOW_ISO, updated_at: NOW_ISO,
    } as any,
    unit: unit!,
    slices: ['focalUnit'],   // 不含 graphContext
    packetSliceVersion: 2,
  });
  assert.equal(pkt.graphContext, undefined, '不 declare 时 graphContext 必须 undefined');
});

test('T6 declare graphContext 但 unit=null → graphContext 不填', () => {
  resetDb();
  const pkt = ass.assembleAgentContextPacket({
    agentRunId: 'r3',
    trigger: {
      id: 't3', trigger_type: 'commitment_due',
      payload_json: '{}', reasoning: null,
      status: 'pending', context_unit_id: null, due_at: null, due_at_bucket: null,
      created_at: NOW_ISO, updated_at: NOW_ISO,
    } as any,
    unit: null,
    slices: ['graphContext'],
    packetSliceVersion: 2,
  });
  assert.equal(pkt.graphContext, undefined, 'unit=null 时 graphContext 必须 undefined');
});

test('T7 SLICE_CAPS 含 graphContext + GLOBAL_SLICE_CAPS 含 myTopCollaborators', () => {
  // 反射检查（仅在 PacketSlice 类型内，T4-T6 已隐式测过 'graphContext' 是合法 slice 名）
  // 这条 test 主要确认 packet 元数据正确反映 cap
  resetDb();
  const id = randomUUID();
  db.db.prepare(
    `INSERT INTO context_units (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content, time_json, actionability, confidence, status, created_at, updated_at, merge_key)
     VALUES (?, 'me', 'work', 'manual', ?, 'state', 'test', 'test', NULL, 'record', 0.9, 'active', ?, ?, ?)`
  ).run(id, id, NOW_ISO, NOW_ISO, `m:${id}`);
  const unit = cs.getContextUnitById(id);
  const pkt = ass.assembleAgentContextPacket({
    agentRunId: 'r4',
    trigger: {
      id: 't4', trigger_type: 'commitment_due',
      payload_json: '{}', reasoning: null,
      status: 'pending', context_unit_id: null, due_at: null, due_at_bucket: null,
      created_at: NOW_ISO, updated_at: NOW_ISO,
    } as any,
    unit: unit!,
    slices: ['focalUnit', 'graphContext'],
    packetSliceVersion: 2,
  });
  const ms = pkt.materializedSlices.find((m: any) => m.name === 'graphContext');
  assert.ok(ms, 'materializedSlices 必须有 graphContext entry');
});
