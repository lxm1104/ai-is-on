/**
 * MVP27 §12.1 红队测试 — Matter Reducer 的误关 / 误并 / reopen / dropped / 阈值。
 *
 * 误 resolve（把没做完的事标成已完成）是反向信任杀手，所以重点覆盖：
 *  - 低置信不改 status、不同事不误并、resolved 才可 reopen、dropped 永不自动 reopen。
 * LLM 判定用注入的 stub（确定性），测的是 reducer 的落地逻辑而非 LLM。
 *
 * Run: npx tsx --test apps/server/test/mvp27-matter-reducer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp27-reducer-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const mr = await import('../src/matter/matterReducer.js');
const mm = await import('../src/matter/matterMatcher.js');
const ca = await import('../src/agents/commitmentAgent.js');
import type { ContextEntityRef, ContextUnit } from '../src/context/ContextUnit.js';
import type { MatterReduceDecision } from '../src/matter/matterTypes.js';

const NOW = Date.parse('2026-06-02T09:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();
const YUFAN: ContextEntityRef = { type: 'person', name: 'Yufan', role: 'actor' };

let refCounter = 0;
function mkUnit(opts: {
  kind: ContextUnit['kind'];
  title: string;
  content: string;
  entities: ContextEntityRef[];
  actionability?: ContextUnit['actionability'];
  dueAt?: string;
}): ContextUnit {
  refCounter += 1;
  return cs.upsertContextUnit({
    kind: opts.kind,
    title: opts.title,
    content: opts.content,
    scope: 'work',
    origin: { kind: 'manual', refId: `t-${refCounter}` },
    entities: opts.entities,
    actionability: opts.actionability ?? 'record',
    time: opts.dueAt ? { dueAt: opts.dueAt } : undefined,
  }).unit;
}

function mkJudge(decision: MatterReduceDecision) {
  return async () => decision;
}
const failJudge = async () => {
  throw new Error('judge should not be called');
};

function resetDb() {
  db.db.exec(`
    DELETE FROM matters; DELETE FROM matter_entities;
    DELETE FROM matter_context_links; DELETE FROM matter_transitions;
    DELETE FROM context_units; DELETE FROM context_entities;
    DELETE FROM context_unit_entities; DELETE FROM context_links;
    DELETE FROM context_space_links;
    DELETE FROM settings WHERE key='self_person_entity_id';
  `);
}

async function seedOpenMatter() {
  const u1 = mkUnit({ kind: 'commitment', title: '安排与 Yufan 讨论记忆召回', content: '准备拉 Yufan 同步设计', entities: [YUFAN], actionability: 'act' });
  await mr.reduceMatterForContextUnit(u1, undefined, { now: NOW, judge: failJudge });
  const m = ms.getMatterByCreatedFromContextUnit(u1.id);
  assert.ok(m, 'commitment 应建出 Matter');
  return { u1, m: m! };
}

test('T1 commitment 无候选 → 规则建 Matter（不调 judge）', async () => {
  resetDb();
  const { m } = await seedOpenMatter();
  assert.equal(m.status, 'open');
  assert.equal(m.type, 'discussion');
  const tr = ms.listMatterTransitions(m.id);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].toStatus, 'open');
});

test('T2 action_result 同人同动作 → resolve 原 Matter + 兼容 context_links', async () => {
  resetDb();
  const { u1, m } = await seedOpenMatter();
  const u2 = mkUnit({ kind: 'action_result', title: '已拉 Yufan 进群讨论', content: '已经拉群讨论上了', entities: [YUFAN] });
  const res = await mr.reduceMatterForContextUnit(u2, undefined, {
    now: NOW,
    judge: mkJudge({ action: 'attach', matterId: m.id, effect: 'resolve', confidence: 0.9, reason: '已拉群讨论' }),
  });
  assert.equal(res.applied, true);
  assert.equal(res.effect, 'resolve');
  const m2 = ms.getMatterById(m.id)!;
  assert.equal(m2.status, 'resolved');
  assert.ok(m2.resolvedAt);
  assert.ok(ms.listMatterTransitions(m.id).some((t) => t.fromStatus === 'open' && t.toStatus === 'resolved'));
  assert.ok(ms.listMatterContextLinks(m.id).some((l) => l.contextUnitId === u2.id && l.relation === 'resolved_by'));
  // §6.7 兼容：action_result → commitment 写 context_links('updates')
  assert.ok(db.listContextLinksFor(u2.id).some((l) => l.to_context_id === u1.id && l.link_type === 'updates'));
});

test('T3 同人不同事 → judge=create，不误并、原 Matter 不动', async () => {
  resetDb();
  const { m: m1 } = await seedOpenMatter();
  const u2 = mkUnit({ kind: 'commitment', title: '跟 Yufan 对一下下周排期', content: '约 Yufan 过一下排期', entities: [YUFAN], actionability: 'act' });
  const res = await mr.reduceMatterForContextUnit(u2, undefined, {
    now: NOW,
    judge: mkJudge({ action: 'create', confidence: 0.9, reason: '不同事项：排期 vs 记忆召回' }),
  });
  assert.equal(res.action, 'create');
  assert.notEqual(res.matterId, m1.id);
  assert.equal(ms.getMatterById(m1.id)!.status, 'open');
  assert.equal(ms.listMatters().length, 2);
});

test('T4 中置信(0.55-0.78) → 只 attach evidence 不改 status', async () => {
  resetDb();
  const { m } = await seedOpenMatter();
  const u2 = mkUnit({ kind: 'action_result', title: '提醒了 Yufan 一下', content: '只是提醒了下', entities: [YUFAN] });
  const res = await mr.reduceMatterForContextUnit(u2, undefined, {
    now: NOW,
    judge: mkJudge({ action: 'attach', matterId: m.id, effect: 'resolve', confidence: 0.6, reason: '可能已处理' }),
  });
  assert.equal(res.applied, false);
  assert.equal(res.effect, 'no_change');
  assert.equal(ms.getMatterById(m.id)!.status, 'open', '中置信不得改 status');
  const link = ms.listMatterContextLinks(m.id).find((l) => l.contextUnitId === u2.id);
  assert.ok(link && link.relation === 'evidence');
  // 没有新的 status transition（只剩初始 create）
  assert.equal(ms.listMatterTransitions(m.id).length, 1);
});

test('T5 <0.55 → ignore，不留痕', async () => {
  resetDb();
  const { m } = await seedOpenMatter();
  const u2 = mkUnit({ kind: 'action_result', title: '随口说了句', content: '无关', entities: [YUFAN] });
  const res = await mr.reduceMatterForContextUnit(u2, undefined, {
    now: NOW,
    judge: mkJudge({ action: 'attach', matterId: m.id, effect: 'resolve', confidence: 0.4, reason: '弱' }),
  });
  assert.equal(res.action, 'ignore');
  assert.equal(ms.getMatterById(m.id)!.status, 'open');
  assert.equal(ms.listMatterContextLinks(m.id).filter((l) => l.contextUnitId === u2.id).length, 0);
});

test('T6 resolved 后明确催促 → reopen（reopenedCount+1, resolvedAt 清空）', async () => {
  resetDb();
  const { m } = await seedOpenMatter();
  const u2 = mkUnit({ kind: 'action_result', title: '已拉 Yufan 进群', content: '拉群讨论了', entities: [YUFAN] });
  await mr.reduceMatterForContextUnit(u2, undefined, {
    now: NOW,
    judge: mkJudge({ action: 'attach', matterId: m.id, effect: 'resolve', confidence: 0.9, reason: 'x' }),
  });
  assert.equal(ms.getMatterById(m.id)!.status, 'resolved');

  const u3 = mkUnit({ kind: 'commitment', title: '重新给 Yufan 发方案', content: 'Yufan 说还没收到方案，催了一下', entities: [YUFAN], actionability: 'act' });
  const res = await mr.reduceMatterForContextUnit(u3, undefined, {
    now: NOW,
    judge: mkJudge({ action: 'attach', matterId: m.id, effect: 'reopen', confidence: 0.85, reason: '对方说没收到' }),
  });
  assert.equal(res.effect, 'reopen');
  const m3 = ms.getMatterById(m.id)!;
  assert.equal(m3.status, 'in_progress');
  assert.equal(m3.reopenedCount, 1);
  assert.equal(m3.resolvedAt, null);
});

test('T7 dropped 永不自动 reopen（dropped 不进召回）', async () => {
  resetDb();
  const { m } = await seedOpenMatter();
  ms.saveMatter({ ...ms.getMatterById(m.id)!, status: 'dropped', droppedAt: NOW_ISO });
  const u3 = mkUnit({ kind: 'commitment', title: '重做给 Yufan 的方案', content: 'Yufan 说还没收到，催了', entities: [YUFAN], actionability: 'act' });
  await mr.reduceMatterForContextUnit(u3, undefined, {
    now: NOW,
    judge: mkJudge({ action: 'attach', matterId: m.id, effect: 'reopen', confidence: 0.95, reason: '催' }),
  });
  const mDropped = ms.getMatterById(m.id)!;
  assert.equal(mDropped.status, 'dropped');
  assert.equal(mDropped.reopenedCount, 0);
});

test('T8 uncertainty → block 既有 Matter', async () => {
  resetDb();
  const { m } = await seedOpenMatter();
  const u2 = mkUnit({ kind: 'uncertainty', title: 'Yufan 方案是否还作数存疑', content: 'Yufan 那边可能变了', entities: [YUFAN], actionability: 'ask' });
  const res = await mr.reduceMatterForContextUnit(u2, undefined, {
    now: NOW,
    judge: mkJudge({ action: 'attach', matterId: m.id, effect: 'block', confidence: 0.85, reason: '不确定' }),
  });
  assert.equal(res.effect, 'block');
  assert.equal(ms.getMatterById(m.id)!.status, 'blocked');
  assert.ok(ms.listMatterTransitions(m.id).some((t) => t.toStatus === 'blocked'));
});

test('T9 decision → 更新 summary（no_change 不改 status）', async () => {
  resetDb();
  const { m } = await seedOpenMatter();
  const u2 = mkUnit({ kind: 'decision', title: '定了用方案A', content: '最终决定采用方案A', entities: [YUFAN] });
  const res = await mr.reduceMatterForContextUnit(u2, undefined, {
    now: NOW,
    judge: mkJudge({ action: 'attach', matterId: m.id, effect: 'no_change', summaryPatch: '已决定采用方案A', confidence: 0.8, reason: '决定' }),
  });
  assert.equal(res.applied, false);
  const m2 = ms.getMatterById(m.id)!;
  assert.equal(m2.status, 'open');
  assert.equal(m2.currentSummary, '已决定采用方案A');
});

test('T10 scoreFeatures 权重 + resolved 无 reopen 惩罚', () => {
  const base = {
    personOverlap: false, projectOrSpaceOverlap: false, docTaskOverlap: false,
    chatOverlap: false, titleSimilar: false, unitAfterMatterCreated: false,
    actionResultOnActiveMatter: false, selfRoleConsistent: false, matterResolvedNoReopen: false,
  };
  assert.ok(Math.abs(mm.scoreFeatures({ ...base, personOverlap: true }) - 0.35) < 1e-9);
  assert.ok(Math.abs(mm.scoreFeatures({ ...base, projectOrSpaceOverlap: true }) - 0.3) < 1e-9);
  // resolved 无 reopen 迹象 → 强惩罚把同人重叠压下去
  assert.ok(
    Math.abs(mm.scoreFeatures({ ...base, personOverlap: true, matterResolvedNoReopen: true }) - -0.05) < 1e-9
  );
});

test('T11 commitmentAgent：关联 Matter resolved → skip', async () => {
  resetDb();
  const { u1, m } = await seedOpenMatter();
  ms.saveMatter({ ...ms.getMatterById(m.id)!, status: 'resolved', resolvedAt: NOW_ISO });
  const trigger = {
    id: 'tr1', trigger_type: 'commitment_due', context_unit_id: u1.id,
    payload_json: JSON.stringify({ commitmentTitle: '安排与 Yufan 讨论记忆召回' }),
    status: 'pending', due_at: null, due_at_bucket: null, reasoning: null,
    created_at: NOW_ISO, updated_at: NOW_ISO,
  };
  const out = await ca.trackCommitmentHandler({
    trigger: trigger as never,
    unit: u1,
    packet: undefined as never,
    agentRunId: 'run1',
  } as never);
  assert.equal((out.data as { skipped?: string }).skipped, 'matter_resolved');
  assert.equal(out.proposalIds.length, 0);
});
