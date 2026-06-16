/**
 * MVP41 — 同 matter live 卡去重兜底 collapseDuplicateLiveCardsByMatter。
 *
 * Run: npx tsx --test apps/server/test/mvp41-collapse-dedup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp41-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { insertAttentionItem, listLiveAttentionItems, collapseDuplicateLiveCardsByMatter } = await import(
  '../src/attention/attentionStore.js'
);

let t = 0;
function mkCard(opts: { matterId?: string; inputHash: string; title: string; signalIds?: string[] }): string {
  t += 1;
  const id = randomUUID();
  insertAttentionItem({
    id,
    generation: 1,
    llmRunId: null,
    inputHash: opts.inputHash,
    now: new Date(Date.UTC(2026, 5, 16, 0, 0, t)).toISOString(), // 递增 created_at
    llmItem: { priority: 'P2', title: opts.title, why: 'x', signalIds: opts.signalIds ?? [], relatedEntityIds: [], relatedSpaceIds: [], matterId: opts.matterId },
  });
  return id;
}

test('同 matter 多张 live → 只留最新一张', () => {
  const M = 'matter-A';
  const a = mkCard({ matterId: M, inputHash: 'h1', title: '卡1' });
  const b = mkCard({ matterId: M, inputHash: 'h2', title: '卡2' });
  const c = mkCard({ matterId: M, inputHash: 'h3', title: '卡3（最新）' });
  void a; void b;
  const n = collapseDuplicateLiveCardsByMatter(new Date().toISOString());
  assert.equal(n, 2, '清掉 2 张旧的');
  const live = listLiveAttentionItems(100).filter((x) => x.matterId === M);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, c, '保留最新创建的那张');
});

test('不同 matter 各自保留', () => {
  mkCard({ matterId: 'matter-B', inputHash: 'b1', title: 'B' });
  mkCard({ matterId: 'matter-C', inputHash: 'c1', title: 'C' });
  collapseDuplicateLiveCardsByMatter(new Date().toISOString());
  assert.equal(listLiveAttentionItems(100).filter((x) => x.matterId === 'matter-B').length, 1);
  assert.equal(listLiveAttentionItems(100).filter((x) => x.matterId === 'matter-C').length, 1);
});

test('提案卡不被 collapse（独立生命周期）', () => {
  const M = 'matter-D';
  mkCard({ matterId: M, inputHash: 'd1', title: '催办' });
  mkCard({ matterId: M, inputHash: 'd2', title: '催办2' });
  mkCard({ matterId: M, inputHash: `proposal:matter-resolve:${M}`, title: '确认办结' });
  mkCard({ matterId: M, inputHash: `proposal:matter-progress:${M}`, title: 'AI 已查清进展' });
  collapseDuplicateLiveCardsByMatter(new Date().toISOString());
  const live = listLiveAttentionItems(100).filter((x) => x.matterId === M);
  // 2 张催办 collapse 成 1，但 2 张提案卡都保留 → 共 3
  assert.equal(live.length, 3);
  assert.ok(live.some((x) => x.inputHash.startsWith('proposal:matter-resolve:')));
  assert.ok(live.some((x) => x.inputHash.startsWith('proposal:matter-progress:')));
});

test('无 matterId：同 signal 集合(措辞不同)只留最新；不同集合各留', () => {
  // 同一信号源、每次换措辞重发 → 标题各异但 signal 相同 → 只留最新
  mkCard({ inputHash: 's1', title: 'trigger 聚合方案待文档化', signalIds: ['sigA'] });
  mkCard({ inputHash: 's2', title: 'Trigger 聚合展示方案文档待沉淀', signalIds: ['sigA'] });
  const newest = mkCard({ inputHash: 's3', title: 'trigger 方案待落档', signalIds: ['sigA'] });
  // 不同 signal 的另一件事 → 保留
  mkCard({ inputHash: 's4', title: '别的事', signalIds: ['sigB'] });
  collapseDuplicateLiveCardsByMatter(new Date().toISOString());
  const live = listLiveAttentionItems(300).filter((x) => !x.matterId);
  const sigA = live.filter((x) => (x.signalIds ?? []).join(',') === 'sigA');
  assert.equal(sigA.length, 1, '同 signal 只留 1 张');
  assert.equal(sigA[0].id, newest, '留最新创建的');
  assert.ok(live.some((x) => (x.signalIds ?? []).join(',') === 'sigB'), '不同 signal 的事保留');
});

test('无 matterId：同集合不同顺序也合并(排序归一化)', () => {
  mkCard({ inputHash: 'o1', title: '甲序', signalIds: ['x', 'y'] });
  const newest = mkCard({ inputHash: 'o2', title: '乙序', signalIds: ['y', 'x'] }); // 同集合反序
  collapseDuplicateLiveCardsByMatter(new Date().toISOString());
  const live = listLiveAttentionItems(300).filter(
    (x) => [...(x.signalIds ?? [])].sort().join(',') === 'x,y'
  );
  assert.equal(live.length, 1, '排序后同集合 → 合并成 1');
  assert.equal(live[0].id, newest);
});

test('提案卡同 signal 不被 collapse', () => {
  mkCard({ inputHash: 'p1', title: '催办', signalIds: ['sigP'] });
  mkCard({ inputHash: `proposal:matter-resolve:mP`, title: '确认办结', signalIds: ['sigP'] });
  collapseDuplicateLiveCardsByMatter(new Date().toISOString());
  const live = listLiveAttentionItems(300).filter((x) => (x.signalIds ?? []).join(',') === 'sigP');
  assert.equal(live.length, 2, '提案卡独立生命周期，不与普通卡按 signal 合并');
});

test('无 matterId：不同标题各留；同归一化标题只留最新', () => {
  mkCard({ inputHash: 'n1', title: '无matter甲' });
  mkCard({ inputHash: 'n2', title: '无matter乙' });
  // 同一件事的两种空格写法（归一化后相等）→ 只留最新
  mkCard({ inputHash: 'n3', title: '熔断 trace 待给孔恩培' });
  const newest = mkCard({ inputHash: 'n4', title: '熔断trace待给孔恩培' });
  collapseDuplicateLiveCardsByMatter(new Date().toISOString());
  const live = listLiveAttentionItems(300).filter((x) => !x.matterId);
  assert.ok(live.some((x) => x.title === '无matter甲') && live.some((x) => x.title === '无matter乙'), '不同标题各留');
  const rongduan = live.filter((x) => x.title.replace(/\s+/g, '') === '熔断trace待给孔恩培');
  assert.equal(rongduan.length, 1, '同归一化标题只留 1 张');
  assert.equal(rongduan[0].id, newest, '留最新的');
});
