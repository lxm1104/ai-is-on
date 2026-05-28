/**
 * MVP20 §9.2：装配集成测试——验证 packet.commitments[i].selfRoleOnUnit
 * 在 assembleGlobalContextPacket 里被正确派生 + B 路兜底命中。
 *
 * 运行：npx tsx --test apps/server/test/mvp20-self-role-assembler.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp20-assembler-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { assembleGlobalContextPacket } = await import(
  '../src/context/agentContextAssembler.js'
);

// ---------- helpers ----------
function resetDb() {
  db.db.exec(`
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM context_entities;
    DELETE FROM entity_aliases;
    DELETE FROM settings WHERE key='self_person_entity_id';
  `);
}

function mkEntity(type: string, name: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insertContextEntity({
    id, type, name,
    aliases_json: null, source: null, confidence: 0.8,
    created_at: now, updated_at: now,
    attributes_json: null,
  });
  return id;
}

function mkCommitment(opts: {
  title: string;
  entities: Array<{ entityId: string; role: string }>;
  dueOffsetMs?: number;
}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const dueAt =
    opts.dueOffsetMs !== undefined
      ? new Date(Date.now() + opts.dueOffsetMs).toISOString()
      : null;
  const timeJson = dueAt ? JSON.stringify({ dueAt }) : null;
  db.db
    .prepare(
      `INSERT INTO context_units
       (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
        actionability, confidence, version, status, created_at, updated_at, time_json)
       VALUES (?, 'me', 'work', 'manual', 'test', 'commitment', ?, '',
               'record', 0.9, 1, 'active', ?, ?, ?)`
    )
    .run(id, opts.title, now, now, timeJson);
  for (const e of opts.entities) {
    db.db
      .prepare(
        `INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence)
         VALUES (?, ?, ?, 1.0)`
      )
      .run(id, e.entityId, e.role);
  }
  return id;
}

// ============================================================================

test('packet.commitments 上正确派生 selfRoleOnUnit（4 类全覆盖）', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const otherId = mkEntity('person', '张三');

  const uExec = mkCommitment({
    title: '我答应张三周三补方案',
    entities: [
      { entityId: selfId, role: 'actor' },
      { entityId: otherId, role: 'target' },
    ],
    dueOffsetMs: 24 * 3600_000,
  });
  const uReq = mkCommitment({
    title: '张三答应我做 2 条文案',  // Base UX case
    entities: [
      { entityId: otherId, role: 'actor' },
      { entityId: selfId, role: 'target' },
    ],
    dueOffsetMs: 24 * 3600_000,
  });
  const uRev = mkCommitment({
    title: '设计稿等我审',
    entities: [
      { entityId: otherId, role: 'actor' },
      { entityId: selfId, role: 'reviewer' },
    ],
    dueOffsetMs: 12 * 3600_000,
  });
  const uObs = mkCommitment({
    title: 'launch plan 我被 cc',
    entities: [
      { entityId: otherId, role: 'actor' },
      { entityId: selfId, role: 'cc' },
    ],
    dueOffsetMs: 7 * 24 * 3600_000,
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const byId = new Map(packet.commitments.map((c) => [c.id, c]));

  assert.equal(byId.get(uExec)?.selfRoleOnUnit, 'executor', 'self=actor → executor');
  assert.equal(byId.get(uReq)?.selfRoleOnUnit, 'requester', 'self=target → requester (Base UX core fix)');
  assert.equal(byId.get(uRev)?.selfRoleOnUnit, 'reviewer', 'self=reviewer → reviewer');
  assert.equal(byId.get(uObs)?.selfRoleOnUnit, 'observer', 'self=cc → observer');
});

test('B 路兜底——self 以 name=\'我\' 出现（无 alias 链）也能命中', () => {
  resetDb();
  // 模拟真实场景：larkOrgCollector 注册的 self entity 用 localizedName
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  // triage LLM 输出的"我" entity（独立 entity，不在 alias 链上）
  const woEntity = mkEntity('person', '我');

  const uid = mkCommitment({
    title: 'IM 双向消息：我答应了',
    entities: [{ entityId: woEntity, role: 'actor' }],
    dueOffsetMs: 24 * 3600_000,
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const c = packet.commitments.find((x) => x.id === uid);
  assert.ok(c, 'commitment 应在 packet 里');
  assert.equal(
    c!.selfRoleOnUnit,
    'executor',
    'name=\'我\' 兜底应命中并归 executor'
  );
});

test('未设 self_person_entity_id 时 B 路仍可工作', () => {
  resetDb();
  // 故意不设 self_person_entity_id
  const woEntity = mkEntity('person', '我');
  const uid = mkCommitment({
    title: '没设 self 但有"我"',
    entities: [{ entityId: woEntity, role: 'target' }],
    dueOffsetMs: 24 * 3600_000,
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const c = packet.commitments.find((x) => x.id === uid);
  assert.ok(c);
  assert.equal(
    c!.selfRoleOnUnit,
    'requester',
    '即便没 self 设置，B 路 name=\'我\' 兜底仍能识别角色'
  );
});

test('commitment 上 self 不在 entities → selfRoleOnUnit = null', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const a = mkEntity('person', '张三');
  const b = mkEntity('person', '李四');
  const uid = mkCommitment({
    title: '张三答应李四的事',
    entities: [
      { entityId: a, role: 'actor' },
      { entityId: b, role: 'target' },
    ],
    dueOffsetMs: 24 * 3600_000,
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const c = packet.commitments.find((x) => x.id === uid);
  assert.ok(c);
  assert.equal(
    c!.selfRoleOnUnit,
    null,
    'self 不在 entities，selfRoleOnUnit 应为 null（不强行兜底）'
  );
});

test('packet.goals / packet.uncertainties 不挂 selfRoleOnUnit（MVP20 范围）', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);

  // 写一个 goal + 一个 uncertainty，self 都是 target
  const now = new Date().toISOString();
  for (const kind of ['goal', 'uncertainty']) {
    const id = randomUUID();
    db.db.prepare(
      `INSERT INTO context_units
       (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
        actionability, confidence, version, status, created_at, updated_at)
       VALUES (?, 'me', 'work', 'manual', 'test', ?, ?, '', 'record', 0.9, 1, 'active', ?, ?)`
    ).run(id, kind, `${kind}-fixture`, now, now);
    db.db.prepare(
      `INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence)
       VALUES (?, ?, 'target', 1.0)`
    ).run(id, selfId);
  }

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  // 类型上 goals/uncertainties 是 ContextUnit[]，没有 selfRoleOnUnit 字段
  for (const g of packet.goals) {
    assert.equal(
      (g as Record<string, unknown>).selfRoleOnUnit,
      undefined,
      'goals 不应有 selfRoleOnUnit'
    );
  }
  for (const u of packet.uncertainties) {
    assert.equal(
      (u as Record<string, unknown>).selfRoleOnUnit,
      undefined,
      'uncertainties 不应有 selfRoleOnUnit'
    );
  }
});

test('packet.commitments 空时不报错', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  // 不写任何 commitment
  const packet = assembleGlobalContextPacket({ now: Date.now() });
  assert.equal(packet.commitments.length, 0);
});
