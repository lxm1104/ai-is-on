/**
 * MVP20 §9.2 (PR3)：commitmentAgent handler 按 selfRole 分支行为测试。
 *
 * 7 个核心场景见方案 §9.2 表。
 *
 * 运行：npx tsx --test apps/server/test/mvp20-commitment-agent-self-role.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'aiio-mvp20-commit-agent-')
);
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { trackCommitmentHandler } = await import(
  '../src/agents/commitmentAgent.js'
);
const ms = await import('../src/matter/matterStore.js');
const { raiseMatterProgressProposal } = await import('../src/matter/matterResolveProposal.js');
import type { ContextUnit } from '../src/context/ContextUnit.js';
import type { AgentContextPacket } from '../src/context/agentContextAssembler.js';
import type { TriggerRow } from '../src/db.js';

// ============================================================================
// helpers
// ============================================================================

function resetDb() {
  db.db.exec(`
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM context_entities;
    DELETE FROM entity_aliases;
    DELETE FROM action_proposals;
    DELETE FROM cards;
    DELETE FROM agent_runs;
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

/**
 * 构造 unit + 写库 + 返回内存 ContextUnit。
 * createdAtMs / dueAtMs 给绝对毫秒戳，便于控制 stalled 判定。
 */
function mkCommitmentUnit(opts: {
  title: string;
  entities: Array<{ entityId: string; entityName: string; entityType: string; role: string }>;
  actionability?: 'none' | 'record' | 'notify' | 'ask' | 'act';
  createdAtMs?: number;
  updatedAtMs?: number;
  dueAtMs?: number;
}): ContextUnit {
  const id = randomUUID();
  const now = Date.now();
  const createdAt = new Date(opts.createdAtMs ?? now).toISOString();
  const updatedAt = new Date(opts.updatedAtMs ?? now).toISOString();
  const dueAt =
    opts.dueAtMs !== undefined ? new Date(opts.dueAtMs).toISOString() : undefined;
  const actionability = opts.actionability ?? 'record';
  db.db.prepare(
    `INSERT INTO context_units
     (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
      actionability, confidence, version, status, created_at, updated_at, time_json)
     VALUES (?, 'me', 'work', 'manual', 'test', 'commitment', ?, '',
             ?, 0.9, 1, 'active', ?, ?, ?)`
  ).run(id, opts.title, actionability, createdAt, updatedAt, dueAt ? JSON.stringify({ dueAt }) : null);
  for (const e of opts.entities) {
    db.db.prepare(
      `INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence)
       VALUES (?, ?, ?, 1.0)`
    ).run(id, e.entityId, e.role);
  }
  return {
    id,
    subjectId: 'me',
    scope: 'work',
    origin: { kind: 'manual', refId: 'test' },
    kind: 'commitment',
    title: opts.title,
    content: '',
    entities: opts.entities.map((e) => ({
      type: e.entityType, name: e.entityName, role: e.role, confidence: 1.0,
    })),
    time: dueAt ? { dueAt } : undefined,
    actionability,
    confidence: 0.9,
    version: 1,
    status: 'active',
    createdAt,
    updatedAt,
  };
}

function mkTrigger(opts: { commitmentTitle: string; dueAt?: string; overdue?: boolean; hoursAbs?: number; entities?: Array<{ type: string; name: string }> }): TriggerRow {
  return {
    id: `trig-${randomUUID()}`,
    trigger_type: 'commitment_due',
    context_unit_id: null,
    payload_json: JSON.stringify({
      commitmentTitle: opts.commitmentTitle,
      dueAt: opts.dueAt,
      overdue: opts.overdue ?? false,
      hoursAbs: opts.hoursAbs ?? 12,
      entities: opts.entities ?? [],
    }),
    status: 'pending',
    fire_at: new Date().toISOString(),
    fired_at: null,
    reasoning: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function mkPacket(): AgentContextPacket {
  // 最小骨架——commitmentAgent 主要用到 spaces / graphContext / subject / latestActionResult / boundary
  // 这里都缺省，看 handler 默认行为（应该不崩）。
  return {
    packetAssemblerVersion: 1,
    packetSliceVersion: 2,
    materializedSlices: [],
    agentRunId: 'test-run',
    trigger: { id: 'test-trig', type: 'commitment_due', reasoning: null },
  };
}

async function runHandler(unit: ContextUnit, opts: { overdue?: boolean; hoursAbs?: number } = {}) {
  const trigger = mkTrigger({
    commitmentTitle: unit.title,
    dueAt: unit.time?.dueAt,
    overdue: opts.overdue,
    hoursAbs: opts.hoursAbs,
    entities: unit.entities.map((e) => ({ type: e.type, name: e.name })),
  });
  // 写一个 dummy agent_run 让 action_proposals.agent_run_id 外键不报错
  db.db.prepare(
    `INSERT INTO agent_runs (id, agent_type, status, trigger_id, input_json, created_at)
     VALUES (?, 'track_commitment', 'running', ?, '{}', ?)`
  ).run('test-run', trigger.id, new Date().toISOString());
  return await trackCommitmentHandler({
    trigger,
    unit,
    packet: mkPacket(),
    agentRunId: 'test-run',
  });
}

// ============================================================================
// scenarios
// ============================================================================

test('selfRole=executor：现状逻辑不变（regression baseline）', async () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const otherId = mkEntity('person', '张三');

  const unit = mkCommitmentUnit({
    title: '我答应张三周三补方案',
    entities: [
      { entityId: selfId, entityName: '刘昕明', entityType: 'person', role: 'actor' },
      { entityId: otherId, entityName: '张三', entityType: 'person', role: 'target' },
    ],
    dueAtMs: Date.now() + 24 * 3600_000,
  });
  const out = await runHandler(unit, { hoursAbs: 24 });

  assert.equal((out.data as any).selfRole, 'executor');
  assert.equal(out.proposalIds.length, 1, 'executor 应出 proposal');
  assert.equal(out.cardIds.length, 1, 'executor 应出 card');
  // title 是 cardTitle 现状："承诺即将到期：..."
  const proposal = db.db.prepare(`SELECT title FROM action_proposals WHERE id=?`).get(out.proposalIds[0]) as { title: string };
  assert.match(proposal.title, /承诺即将到期|承诺已逾期/, 'executor 文案应是现状版');
});

test('selfRole=requester 且无进展信号 → skipped', async () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const otherId = mkEntity('person', '张三');

  // 三路条件全 false：
  //  - recentlyUpdated: updatedAt 是 12h 前（> 6h 阈值，false）
  //  - isUrgentAsk: actionability=record（非 ask）
  //  - stalled: createdAt 是 1h 前，dueAt 是 23h 后，总 24h；now-created=1h < 12h，false
  const dueAt = Date.now() + 23 * 3600_000;
  const createdAt = Date.now() - 1 * 3600_000;
  const updatedAt = Date.now() - 12 * 3600_000;
  const unit = mkCommitmentUnit({
    title: '张三答应我做 2 条文案',
    entities: [
      { entityId: otherId, entityName: '张三', entityType: 'person', role: 'actor' },
      { entityId: selfId, entityName: '刘昕明', entityType: 'person', role: 'target' },
    ],
    actionability: 'record',
    createdAtMs: createdAt,
    updatedAtMs: updatedAt,
    dueAtMs: dueAt,
  });

  const out = await runHandler(unit, { hoursAbs: 24 });
  assert.equal((out.data as any).selfRole, 'requester');
  assert.equal((out.data as any).skipped, 'requester_silent', 'requester 无信号应早退');
  assert.equal(out.proposalIds.length, 0);
  assert.equal(out.cardIds.length, 0);
});

test('selfRole=requester 且 actionability=ask → 出 card，priority ≤ P2', async () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const otherId = mkEntity('person', '张三');

  const unit = mkCommitmentUnit({
    title: '张三答应我做 2 条文案',
    entities: [
      { entityId: otherId, entityName: '张三', entityType: 'person', role: 'actor' },
      { entityId: selfId, entityName: '刘昕明', entityType: 'person', role: 'target' },
    ],
    actionability: 'ask',  // 关键
    dueAtMs: Date.now() + 12 * 3600_000,
  });
  const out = await runHandler(unit, { hoursAbs: 12 });

  assert.equal((out.data as any).selfRole, 'requester');
  assert.equal(out.proposalIds.length, 1, '有 ask 信号应出 proposal');
  assert.equal(out.cardIds.length, 1);
  // priority 上限 P2
  const card = db.db.prepare(`SELECT priority, title FROM cards WHERE id=?`).get(out.cardIds[0]) as { priority: string; title: string };
  assert.ok(['P2', 'P3'].includes(card.priority), `requester priority ≤ P2，实际 ${card.priority}`);
  assert.match(card.title, /你提的需求/, 'requester 文案应是"你提的需求..."');
});

test('selfRole=observer 默认 → skipped (digest only)', async () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const otherId = mkEntity('person', '张三');

  const unit = mkCommitmentUnit({
    title: 'launch plan 我被 cc',
    entities: [
      { entityId: otherId, entityName: '张三', entityType: 'person', role: 'actor' },
      { entityId: selfId, entityName: '刘昕明', entityType: 'person', role: 'cc' },
    ],
    actionability: 'record',  // 非 ask
    dueAtMs: Date.now() + 7 * 24 * 3600_000,
  });
  const out = await runHandler(unit);

  assert.equal((out.data as any).selfRole, 'observer');
  assert.equal((out.data as any).skipped, 'observer_digest_only');
  assert.equal(out.proposalIds.length, 0);
  assert.equal(out.cardIds.length, 0);
});

test('selfRole=observer 且 actionability=ask → 出 card，priority=P2', async () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const otherId = mkEntity('person', '张三');

  const unit = mkCommitmentUnit({
    title: 'X 看下这个方案？',
    entities: [
      { entityId: otherId, entityName: '张三', entityType: 'person', role: 'actor' },
      { entityId: selfId, entityName: '刘昕明', entityType: 'person', role: 'mentioned' },
    ],
    actionability: 'ask',
    dueAtMs: Date.now() + 24 * 3600_000,
  });
  const out = await runHandler(unit, { hoursAbs: 24 });

  assert.equal((out.data as any).selfRole, 'observer');
  assert.equal(out.cardIds.length, 1);
  const card = db.db.prepare(`SELECT priority, title FROM cards WHERE id=?`).get(out.cardIds[0]) as { priority: string; title: string };
  assert.equal(card.priority, 'P2');
  assert.match(card.title, /进展同步/);
});

test('selfRole=reviewer → 出 card，priority 上限 P1', async () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const otherId = mkEntity('person', '张三');

  const unit = mkCommitmentUnit({
    title: '设计稿等我审',
    entities: [
      { entityId: otherId, entityName: '张三', entityType: 'person', role: 'actor' },
      { entityId: selfId, entityName: '刘昕明', entityType: 'person', role: 'reviewer' },
    ],
    actionability: 'ask',
    dueAtMs: Date.now() + 6 * 3600_000,  // 临期
  });
  // overdue=true 模拟逾期，让基础 priority 想升 P0；selfRole=reviewer 应该把它压回 P1
  const out = await runHandler(unit, { overdue: true, hoursAbs: 6 });

  assert.equal((out.data as any).selfRole, 'reviewer');
  assert.equal(out.cardIds.length, 1);
  const card = db.db.prepare(`SELECT priority, title FROM cards WHERE id=?`).get(out.cardIds[0]) as { priority: string; title: string };
  assert.ok(['P1', 'P2', 'P3'].includes(card.priority), `reviewer priority ≤ P1，实际 ${card.priority}`);
  assert.match(card.title, /等你审/);
});

test('selfRole=null（self 不在 entities）→ executor 现状逻辑', async () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const a = mkEntity('person', '张三');
  const b = mkEntity('person', '李四');

  const unit = mkCommitmentUnit({
    title: '张三和李四的事跟我无关',
    entities: [
      { entityId: a, entityName: '张三', entityType: 'person', role: 'actor' },
      { entityId: b, entityName: '李四', entityType: 'person', role: 'target' },
    ],
    dueAtMs: Date.now() + 24 * 3600_000,
  });
  const out = await runHandler(unit, { hoursAbs: 24 });

  assert.equal((out.data as any).selfRole, null);
  assert.equal(out.proposalIds.length, 1, '现状逻辑：null selfRole 仍照常出 proposal');
});

test('M5.3 调权顺序：graphContext.projectPhase=overdue + selfRole=requester → 最终 P2 不到 P0', async () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const otherId = mkEntity('person', '张三');

  const unit = mkCommitmentUnit({
    title: '张三答应我的事',
    entities: [
      { entityId: otherId, entityName: '张三', entityType: 'person', role: 'actor' },
      { entityId: selfId, entityName: '刘昕明', entityType: 'person', role: 'target' },
    ],
    actionability: 'ask',  // 触发出卡
    dueAtMs: Date.now() + 24 * 3600_000,
  });
  // 构造一个 graphContext.projectPhase='overdue' 的 packet
  const packet: AgentContextPacket = {
    packetAssemblerVersion: 1,
    packetSliceVersion: 2,
    materializedSlices: [],
    agentRunId: 'test-run',
    trigger: { id: 'test-trig', type: 'commitment_due', reasoning: null },
    graphContext: {
      projectPhase: { phase: 'execution', health: 'overdue', summary: 'overdue' },
      decisionPath: [],
      expectedButMissing: { persons: [], docs: [] },
      activeBlockers: [],
    },
  };
  // dummy agent run
  db.db.prepare(
    `INSERT INTO agent_runs (id, agent_type, status, trigger_id, input_json, created_at)
     VALUES (?, 'track_commitment', 'running', ?, '{}', ?)`
  ).run('test-run', 'test-trig', new Date().toISOString());
  const trigger = mkTrigger({
    commitmentTitle: unit.title,
    dueAt: unit.time?.dueAt,
    overdue: false,
    hoursAbs: 24,
    entities: unit.entities.map((e) => ({ type: e.type, name: e.name })),
  });
  const out = await trackCommitmentHandler({ trigger, unit, packet, agentRunId: 'test-run' });

  // projectPhase=overdue 想把 P2 升到 P1、P1 升 P0；
  // 但 selfRole=requester 上限 P2，应当压回 P2（或更低）
  assert.equal((out.data as any).selfRole, 'requester');
  assert.equal(out.cardIds.length, 1);
  const card = db.db.prepare(`SELECT priority FROM cards WHERE id=?`).get(out.cardIds[0]) as { priority: string };
  assert.ok(['P2', 'P3'].includes(card.priority), `unit 级 selfRole 应覆盖项目级 projectPhase 升档，实际 ${card.priority}`);
});

test('MVP59：AI 已对关联事项升进展/办结提案 → 承诺到期提醒去重(不机械催)', async () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const unit = mkCommitmentUnit({
    title: '给王爽发月报',
    entities: [{ entityId: selfId, entityName: '刘昕明', entityType: 'person', role: 'actor' }],
    actionability: 'act',
    dueAtMs: Date.now() + 3600_000,
  });
  // 关联一个 open matter，AI 自主排查已对它升了「进展回执」提案
  const m = ms.createMatter({
    scope: 'work', type: 'follow_up', title: '给王爽发月报',
    canonicalKey: 'k-' + randomUUID(), createdFromContextUnitId: unit.id,
    currentSummary: '', nextAction: '确认是否已发',
  });
  raiseMatterProgressProposal(m, { verdict: 'progressed', factSummary: '查到 6/13 已发初版', evidence: [], confidence: 0.7 });

  const r = await trackCommitmentHandler({
    trigger: mkTrigger({ commitmentTitle: '给王爽发月报', dueAt: new Date(Date.now() + 3600_000).toISOString() }),
    unit,
    packet: mkPacket(),
    agentRunId: 'test-run',
  });
  assert.equal(r.data?.skipped, 'ai_proposal_live', 'AI 已升提案 → 跳过机械催办');
  assert.equal(r.cardIds.length, 0, '不再出机械提醒卡');
});
