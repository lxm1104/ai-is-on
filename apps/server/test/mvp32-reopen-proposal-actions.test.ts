/**
 * MVP32 — 动作组投影 + matter_reopen 双入口 + 重开提案 dismiss 语义。
 *
 * Run: npx tsx --test apps/server/test/mvp32-reopen-proposal-actions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp32-reopen-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.MATTER_VERIFY_ENABLED = 'false';

const { db } = await import('../src/db.js');
const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const ma = await import('../src/matter/matterActions.js');
const { insertAttentionItem, getAttentionItem } = await import(
  '../src/attention/attentionStore.js'
);
const { applyCardAction } = await import('../src/cards/cardsService.js');
const { defaultAttentionActions } = await import('../src/attention/attentionProjection.js');

let n = 0;

function mkMatter() {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment',
    title: `承诺${n}`,
    content: `c-${n}`,
    scope: 'work',
    origin: { kind: 'manual', refId: `ru-${n}` },
    silent: true,
  }).unit;
  return ms.createMatter({
    scope: 'work',
    type: 'follow_up',
    title: `事项${n}`,
    canonicalKey: `rk-${n}`,
    createdFromContextUnitId: unit.id,
  });
}

function mkAttnItem(opts: { matterId?: string; inputHash?: string; title?: string }) {
  return insertAttentionItem({
    id: randomUUID(),
    generation: 0,
    llmRunId: null,
    inputHash: opts.inputHash ?? `hash-${randomUUID()}`,
    now: new Date().toISOString(),
    llmItem: {
      priority: 'P1',
      title: opts.title ?? '测试卡',
      why: 'why',
      signalIds: [],
      relatedEntityIds: [],
      relatedSpaceIds: [],
      matterId: opts.matterId,
    },
  });
}

test('动作组投影：matter 卡头部含「已处理」；无 matter 卡不含；两类提案卡固定动作组', () => {
  const matter = mkMatter();

  const withMatter = mkAttnItem({ matterId: matter.id });
  const a1 = defaultAttentionActions(withMatter).map((a) => a.id);
  assert.equal(a1[0], 'mark_done');
  assert.ok(a1.includes('ack') && a1.includes('dismiss'));

  const noMatter = mkAttnItem({});
  const a2 = defaultAttentionActions(noMatter).map((a) => a.id);
  assert.ok(!a2.includes('mark_done'));

  const resolveProposal = mkAttnItem({
    matterId: matter.id,
    inputHash: `proposal:matter-resolve:${matter.id}`,
  });
  assert.deepEqual(
    defaultAttentionActions(resolveProposal).map((a) => a.id),
    ['matter_resolve', 'dismiss']
  );

  const reopenProposal = mkAttnItem({
    matterId: matter.id,
    inputHash: `proposal:matter-reopen:${matter.id}`,
  });
  assert.deepEqual(
    defaultAttentionActions(reopenProposal).map((a) => a.id),
    ['matter_reopen', 'dismiss']
  );
});

test('重开提案卡 matter_reopen：matter→in_progress（reopened_count+1）、提案卡 acted', async () => {
  const matter = mkMatter();
  ma.userResolveMatter(matter.id, '用户标记已处理');
  const proposal = mkAttnItem({
    matterId: matter.id,
    inputHash: `proposal:matter-reopen:${matter.id}`,
  });

  const r = await applyCardAction(proposal.id, 'matter_reopen');
  assert.equal(r.ok, true);

  const after = ms.getMatterById(matter.id)!;
  assert.equal(after.status, 'in_progress');
  assert.equal(after.reopenedCount, 1);
  assert.equal(getAttentionItem(proposal.id)!.status, 'acted');
});

test('done 原卡「撤销已处理」：fallback 合法化 + matter 重开 + item 回 live', async () => {
  const matter = mkMatter();
  const item = mkAttnItem({ matterId: matter.id });
  await applyCardAction(item.id, 'mark_done', { note: '搞定' });
  assert.equal(ms.getMatterById(matter.id)!.status, 'resolved');

  // 'matter_reopen' 不在普通卡的投影动作组里——必须走 fallback 合法化
  const r = await applyCardAction(item.id, 'matter_reopen');
  assert.equal(r.ok, true);
  assert.equal(ms.getMatterById(matter.id)!.status, 'in_progress');
  assert.equal(getAttentionItem(item.id)!.status, 'live');
  assert.equal(r.card?.status, 'new'); // live 投影回待处理
});

test('重开提案卡 dismiss（确实已完成）：不学负反馈 + verification 改记 user_confirmed', async () => {
  const matter = mkMatter();
  ma.userResolveMatter(matter.id, '用户标记已处理');
  ms.setMatterResolveVerification(matter.id, {
    verdict: 'contradicted',
    confidence: 0.9,
    evidence: '对方又催了',
    checkedAt: new Date().toISOString(),
  });
  const proposal = mkAttnItem({
    matterId: matter.id,
    inputHash: `proposal:matter-reopen:${matter.id}`,
  });

  const r = await applyCardAction(proposal.id, 'dismiss');
  assert.equal(r.ok, true);
  assert.equal(getAttentionItem(proposal.id)!.status, 'dismissed');

  // verification 被改写为用户裁决
  const after = ms.getMatterById(matter.id)!;
  assert.equal(after.resolveVerification?.verdict, 'user_confirmed');
  assert.equal(after.resolveVerification?.evidence, '对方又催了'); // 证据保留

  // 不学 not_relevant 负反馈：交互表只有 dismiss，没有 not_relevant；feedback 表无记录
  const inter = db
    .prepare(`SELECT action FROM attention_interactions WHERE attention_id = ?`)
    .all(proposal.id) as Array<{ action: string }>;
  assert.deepEqual(inter.map((x) => x.action), ['dismiss']);
});

test('matter_reopen 幂等：matter 已被 Reducer 先一步重开 → 只动卡片状态不再写 transition', async () => {
  const matter = mkMatter();
  const item = mkAttnItem({ matterId: matter.id });
  await applyCardAction(item.id, 'mark_done');
  ma.userReopenMatter(matter.id, '模拟 Reducer 自动重开');
  const transitionsBefore = ms.listMatterTransitions(matter.id).length;

  const r = await applyCardAction(item.id, 'matter_reopen');
  assert.equal(r.ok, true);
  assert.equal(ms.listMatterTransitions(matter.id).length, transitionsBefore); // 无新 transition
  assert.equal(getAttentionItem(item.id)!.status, 'live');
});
