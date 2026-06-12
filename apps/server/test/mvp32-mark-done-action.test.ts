/**
 * MVP32 — 「已处理」(mark_done) 动作：Matter 落库 + 处理说明 + 幂等 + 投影。
 *
 * Run: npx tsx --test apps/server/test/mvp32-mark-done-action.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp32-markdone-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.MATTER_VERIFY_ENABLED = 'false'; // 本文件只测第一档；第二档见 mvp32-matter-verify

const { db } = await import('../src/db.js');
const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { insertAttentionItem } = await import('../src/attention/attentionStore.js');
const { applyCardAction } = await import('../src/cards/cardsService.js');
const { projectAttentionItemToCard } = await import('../src/attention/attentionProjection.js');

let n = 0;

function mkUnit() {
  n += 1;
  return cs.upsertContextUnit({
    kind: 'commitment',
    title: `承诺${n}`,
    content: `给张三回复方案 ${n}`,
    scope: 'work',
    origin: { kind: 'manual', refId: `u-${n}` },
    silent: true, // 测试里不触发 reducer/trigger hooks
  }).unit;
}

function mkMatter() {
  const unit = mkUnit();
  return ms.createMatter({
    scope: 'work',
    type: 'follow_up',
    title: `回复张三方案${n}`,
    canonicalKey: `k-${n}`,
    createdFromContextUnitId: unit.id,
  });
}

function mkAttnItem(matterId?: string) {
  return insertAttentionItem({
    id: randomUUID(),
    generation: 1,
    llmRunId: null,
    inputHash: `hash-${randomUUID()}`,
    now: new Date().toISOString(),
    llmItem: {
      priority: 'P1',
      title: '催办：回复张三',
      why: '张三在等方案回复',
      signalIds: [],
      relatedEntityIds: [],
      relatedSpaceIds: [],
      matterId,
    },
  });
}

function userResolvedTransitions(matterId: string) {
  return ms
    .listMatterTransitions(matterId)
    .filter((t) => t.toStatus === 'resolved' && t.triggerContextUnitId === 'user_action');
}

test('mark_done 带说明：matter resolved + reason 含 note + unit 落库挂链 + 投影 done', async () => {
  const matter = mkMatter();
  const item = mkAttnItem(matter.id);

  const r = await applyCardAction(item.id, 'mark_done', { note: '已当面和张三对齐，方案口头确认' });
  assert.equal(r.ok, true);

  // Matter 层
  const after = ms.getMatterById(matter.id)!;
  assert.equal(after.status, 'resolved');
  const transitions = userResolvedTransitions(matter.id);
  assert.equal(transitions.length, 1);
  assert.match(transitions[0].reason, /^用户标记已处理：已当面和张三对齐/);

  // 处理说明 unit + matter 链接
  const links = ms
    .listMatterContextLinks(matter.id)
    .filter((l) => l.relation === 'resolved_by');
  assert.equal(links.length, 1);
  const unit = cs.getContextUnitById(links[0].contextUnitId)!;
  assert.equal(unit.kind, 'action_result');
  assert.equal(unit.origin.kind, 'card_action');
  assert.equal(unit.origin.refId, item.id);
  assert.match(unit.content, /已当面和张三对齐/);

  // 交互记录
  const inter = db
    .prepare(`SELECT action FROM attention_interactions WHERE attention_id = ?`)
    .all(item.id) as Array<{ action: string }>;
  assert.deepEqual(inter.map((x) => x.action), ['mark_done']);

  // 卡片投影：acted + matter resolved → done（含 verification 缺省为空）
  assert.equal(r.card?.status, 'done');
  assert.equal(r.card?.verification, undefined);
});

test('mark_done 幂等：重复点击不写重复 transition、note unit 合并为同一条', async () => {
  const matter = mkMatter();
  const item = mkAttnItem(matter.id);

  await applyCardAction(item.id, 'mark_done', { note: '处理过了' });
  const r2 = await applyCardAction(item.id, 'mark_done', { note: '处理过了' });
  assert.equal(r2.ok, true);

  assert.equal(userResolvedTransitions(matter.id).length, 1);
  const links = ms
    .listMatterContextLinks(matter.id)
    .filter((l) => l.relation === 'resolved_by');
  assert.equal(links.length, 1); // mergeHint 幂等 → 同一 unit，链接 upsert 不翻倍
});

test('mark_done 无说明：不产 note unit，matter 照常 resolved', async () => {
  const matter = mkMatter();
  const item = mkAttnItem(matter.id);

  const r = await applyCardAction(item.id, 'mark_done');
  assert.equal(r.ok, true);
  assert.equal(ms.getMatterById(matter.id)!.status, 'resolved');
  const links = ms
    .listMatterContextLinks(matter.id)
    .filter((l) => l.relation === 'resolved_by');
  assert.equal(links.length, 0);
});

test('mark_done 无 matter 卡：防御性兜底，仅 acted + 交互记录', async () => {
  const item = mkAttnItem(undefined);
  const r = await applyCardAction(item.id, 'mark_done', { note: '随手记一笔' });
  assert.equal(r.ok, true);
  // 无 matter → 投影回 acknowledged（不是 done）
  assert.equal(r.card?.status, 'acknowledged');
});

test('截断前缀 matterId（MVP29D）：mark_done 仍能 resolve 完整 matter，投影 done', async () => {
  const matter = mkMatter();
  const item = mkAttnItem(matter.id.slice(0, 8)); // LLM 截断成 8 位前缀

  const r = await applyCardAction(item.id, 'mark_done', { note: '搞定' });
  assert.equal(r.ok, true);
  assert.equal(ms.getMatterById(matter.id)!.status, 'resolved');
  assert.equal(r.card?.status, 'done');
});

test('silent upsert：不触发 upsert hooks；非 silent 触发', () => {
  let calls = 0;
  cs.registerUpsertHook(() => {
    calls += 1;
  });

  cs.upsertContextUnit({
    kind: 'action_result',
    title: '静默写入',
    content: 'x',
    scope: 'work',
    origin: { kind: 'card_action', refId: 'probe-1' },
    silent: true,
  });
  assert.equal(calls, 0);

  cs.upsertContextUnit({
    kind: 'action_result',
    title: '正常写入',
    content: 'y',
    scope: 'work',
    origin: { kind: 'card_action', refId: 'probe-2' },
  });
  assert.equal(calls, 1);
});

test('mark_done 后再投影（独立读取路径）状态稳定为 done', async () => {
  const matter = mkMatter();
  const item = mkAttnItem(matter.id);
  await applyCardAction(item.id, 'mark_done');
  const { getAttentionItem } = await import('../src/attention/attentionStore.js');
  const fresh = getAttentionItem(item.id)!;
  assert.equal(fresh.status, 'acted');
  assert.equal(projectAttentionItemToCard(fresh).status, 'done');
});
