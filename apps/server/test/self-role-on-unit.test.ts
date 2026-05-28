/**
 * MVP20 §9.1：selfRoleOnUnit 派生函数单测。
 *
 * 覆盖：
 *   - mapToSelfRole 归一表（每个桶 + 大小写 + 未识别 + 空）
 *   - computeSelfRoleOnUnit 单 unit 单 / 多 role（取最强）
 *   - computeSelfRoleOnUnit self 不在 entities / role 未归类
 *   - computeSelfRoleOnUnit B 路兜底（name='我' 无 alias 链）
 *   - computeSelfRoleOnUnit selfCanonicalId='' 时仍能 B 路命中
 *   - computeSelfRolesOnUnits 批量结果 = 多次单调用
 *
 * 运行：npx tsx --test apps/server/test/self-role-on-unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp20-selfrole-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const {
  mapToSelfRole,
  computeSelfRoleOnUnit,
  computeSelfRolesOnUnits,
  __internal,
} = await import('../src/context/selfRoleOnUnit.js');

// ---------- helpers ----------
function resetDb() {
  db.db.exec(`
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM context_entities;
    DELETE FROM entity_aliases;
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

function mkUnit(kind: string, entities: Array<{ entityId: string; role: string }>): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.db.prepare(
    `INSERT INTO context_units
     (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
      actionability, confidence, version, status, created_at, updated_at)
     VALUES (?, 'me', 'work', 'manual', 'test', ?, 'test-title', '',
             'record', 0.9, 1, 'active', ?, ?)`
  ).run(id, kind, now, now);
  for (const e of entities) {
    db.db.prepare(
      `INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence)
       VALUES (?, ?, ?, 1.0)`
    ).run(id, e.entityId, e.role);
  }
  return id;
}

// ============================================================================
// mapToSelfRole 归一表
// ============================================================================

test('mapToSelfRole：EXECUTOR 桶全部归到 executor', () => {
  for (const r of __internal.EXECUTOR_ROLES) {
    assert.equal(mapToSelfRole(r), 'executor', `expected '${r}' → executor`);
  }
});

test('mapToSelfRole：REQUESTER 桶全部归到 requester（含 target）', () => {
  for (const r of __internal.REQUESTER_ROLES) {
    assert.equal(mapToSelfRole(r), 'requester', `expected '${r}' → requester`);
  }
  // 重申核心修正：target 必须是 requester（不是 observer）
  assert.equal(mapToSelfRole('target'), 'requester');
});

test('mapToSelfRole：REVIEWER 桶全部归到 reviewer', () => {
  for (const r of __internal.REVIEWER_ROLES) {
    assert.equal(mapToSelfRole(r), 'reviewer', `expected '${r}' → reviewer`);
  }
});

test('mapToSelfRole：OBSERVER 桶全部归到 observer', () => {
  for (const r of __internal.OBSERVER_ROLES) {
    assert.equal(mapToSelfRole(r), 'observer', `expected '${r}' → observer`);
  }
});

test('mapToSelfRole：大小写不敏感 + 边缘空白', () => {
  assert.equal(mapToSelfRole('ACTOR'), 'executor');
  assert.equal(mapToSelfRole('Actor'), 'executor');
  assert.equal(mapToSelfRole(' target '), 'requester');
});

test('mapToSelfRole：未识别 → null', () => {
  assert.equal(mapToSelfRole('definitely_not_a_role'), null);
  assert.equal(mapToSelfRole(''), null);
});

test('mapToSelfRole：归一表覆盖 personProjectInducer 全集（不漏 role）', () => {
  // personProjectInducer 现有 ACTOR_LIKE(22) + ABOUT_LIKE(16) = 38 项
  // 本模块必须能给每一项都映射出 SelfRoleOnUnit（不能漏一个返回 null）
  const PERSON_PROJECT_ACTOR_LIKE = [
    'actor', 'author', 'owner', 'assignee', 'requester', 'reporter', 'organizer',
    'speaker', 'coordinator', 'proposer', 'decision_maker', 'editor', 'developer',
    'tester', 'verifier', 'fixer', 'evaluator', 'source', 'handler', 'confirmer',
    'responder', 'initiator',
  ];
  const PERSON_PROJECT_ABOUT_LIKE = [
    'about', 'subject', 'mentioned', 'cc', 'observer', 'participant', 'target',
    'peer', 'forwarder', 'counterpart', 'concerned_party', 'blocker_source',
    'stakeholder', 'gatekeeper', 'involved', 'explainer',
  ];
  for (const r of [...PERSON_PROJECT_ACTOR_LIKE, ...PERSON_PROJECT_ABOUT_LIKE]) {
    const result = mapToSelfRole(r);
    assert.notEqual(result, null, `'${r}' should map to a SelfRoleOnUnit`);
  }
});

// ============================================================================
// computeSelfRoleOnUnit / computeSelfRolesOnUnits
// ============================================================================

test('computeSelfRoleOnUnit：self=actor → executor', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  const uid = mkUnit('commitment', [{ entityId: selfId, role: 'actor' }]);
  assert.equal(computeSelfRoleOnUnit(uid, selfId), 'executor');
});

test('computeSelfRoleOnUnit：self=target → requester（Base UX case）', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  const otherId = mkEntity('person', '张三');
  // 张三答应我做某事 → entities: { 张三:actor, 我:target }
  const uid = mkUnit('commitment', [
    { entityId: otherId, role: 'actor' },
    { entityId: selfId, role: 'target' },
  ]);
  assert.equal(computeSelfRoleOnUnit(uid, selfId), 'requester');
});

test('computeSelfRoleOnUnit：self=cc → observer', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  const uid = mkUnit('commitment', [{ entityId: selfId, role: 'cc' }]);
  assert.equal(computeSelfRoleOnUnit(uid, selfId), 'observer');
});

test('computeSelfRoleOnUnit：self=reviewer → reviewer', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  const uid = mkUnit('commitment', [{ entityId: selfId, role: 'reviewer' }]);
  assert.equal(computeSelfRoleOnUnit(uid, selfId), 'reviewer');
});

test('computeSelfRoleOnUnit：self 出现多次取 ROLE_PRIORITY 最强', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  // self 既被 cc 又是 actor —— 取 executor（更强）
  const uid = mkUnit('commitment', [
    { entityId: selfId, role: 'cc' },
    { entityId: selfId, role: 'actor' },
  ]);
  assert.equal(computeSelfRoleOnUnit(uid, selfId), 'executor');
});

test('computeSelfRoleOnUnit：self 不在 entities → null', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  const otherId = mkEntity('person', '张三');
  const uid = mkUnit('commitment', [{ entityId: otherId, role: 'actor' }]);
  assert.equal(computeSelfRoleOnUnit(uid, selfId), null);
});

test('computeSelfRoleOnUnit：self 在 entities 但 role 未归类 → null', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  const uid = mkUnit('commitment', [{ entityId: selfId, role: 'unknown_xyz' }]);
  assert.equal(computeSelfRoleOnUnit(uid, selfId), null);
});

test('computeSelfRoleOnUnit：B 路兜底——name=\'我\' entity 无 alias 链也能命中', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');   // canonical self
  const woId = mkEntity('person', '我');           // 独立 entity，不在 alias 链上
  // self 通过 "我" 字面 entity 出现（模拟 triage LLM 输出）
  const uid = mkUnit('commitment', [{ entityId: woId, role: 'actor' }]);
  // A 路：resolveAliased(woId) !== selfId，失败
  // B 路：name='我' 命中
  assert.equal(computeSelfRoleOnUnit(uid, selfId), 'executor');
});

test('computeSelfRoleOnUnit：selfCanonicalId=\'\' 时 B 路仍可工作', () => {
  resetDb();
  const woId = mkEntity('person', '我');
  const uid = mkUnit('commitment', [{ entityId: woId, role: 'target' }]);
  // 没设 self 也能通过 name='我' 命中
  assert.equal(computeSelfRoleOnUnit(uid, ''), 'requester');
});

test('computeSelfRoleOnUnit：A + B 双路同时命中不双计', () => {
  resetDb();
  const selfId = mkEntity('person', '我');   // 罕见：self entity 自己就叫 '我'
  // A 路 resolveAliased(selfId)===selfId ✓，B 路 name='我' ✓
  const uid = mkUnit('commitment', [{ entityId: selfId, role: 'actor' }]);
  assert.equal(computeSelfRoleOnUnit(uid, selfId), 'executor');
});

test('computeSelfRolesOnUnits：批量 = 多次单调用', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  const otherId = mkEntity('person', '张三');
  const u1 = mkUnit('commitment', [{ entityId: selfId, role: 'actor' }]);
  const u2 = mkUnit('commitment', [{ entityId: selfId, role: 'target' }]);
  const u3 = mkUnit('commitment', [{ entityId: otherId, role: 'actor' }]);
  const u4 = mkUnit('commitment', [{ entityId: selfId, role: 'cc' }]);

  const batch = computeSelfRolesOnUnits([u1, u2, u3, u4], selfId);
  assert.equal(batch.size, 4);
  assert.equal(batch.get(u1), 'executor');
  assert.equal(batch.get(u2), 'requester');
  assert.equal(batch.get(u3), null);
  assert.equal(batch.get(u4), 'observer');

  // 跟单调用一致
  for (const uid of [u1, u2, u3, u4]) {
    assert.equal(batch.get(uid), computeSelfRoleOnUnit(uid, selfId), `mismatch on ${uid}`);
  }
});

test('computeSelfRolesOnUnits：空数组返回空 Map', () => {
  const m = computeSelfRolesOnUnits([], 'self-id');
  assert.equal(m.size, 0);
});

test('computeSelfRolesOnUnits：所有传入 unitId 都有键', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  // 故意构造一个不存在 entities 的 unit
  const u1 = mkUnit('commitment', []);
  const u2 = mkUnit('commitment', [{ entityId: selfId, role: 'actor' }]);
  const m = computeSelfRolesOnUnits([u1, u2], selfId);
  assert.equal(m.size, 2);
  assert.equal(m.get(u1), null);  // 没 entity，null
  assert.equal(m.get(u2), 'executor');
});
