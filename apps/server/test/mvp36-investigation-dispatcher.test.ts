/**
 * MVP36 — 自主排查 dispatcher 选件纯函数测试（worthiness + top-1 选择）。
 *
 * Run: npx tsx --test apps/server/test/mvp36-investigation-dispatcher.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInvestigationWorthy,
  selectInvestigationCandidate,
} from '../src/investigation/investigationDispatcher.js';
import type { Matter } from '../src/matter/matterTypes.js';

function mkMatter(p: Partial<Matter> & { id: string }): Matter {
  return {
    id: p.id,
    subjectId: 'me',
    scope: 'work',
    type: 'follow_up',
    title: p.title ?? 't',
    canonicalKey: 'k',
    status: p.status ?? 'open',
    priority: p.priority ?? 'P2',
    currentSummary: '',
    nextAction: p.nextAction ?? null,
    confidence: 0.7,
    reopenedCount: 0,
    version: 1,
    createdFromContextUnitId: 'u',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: p.updatedAt ?? '2026-06-10T00:00:00Z',
  } as Matter;
}

test('isInvestigationWorthy：具体"确认是否…"→true（nextAction 命中）', () => {
  assert.equal(isInvestigationWorthy({ nextAction: '确认评测集是否已实际发送给鲁升纲' }), true);
  assert.equal(isInvestigationWorthy({ nextAction: '跟进黄炜深/冼晓东排查进展，确认修复排期' }), true);
  assert.equal(isInvestigationWorthy({ nextAction: '核实对方是否已收到文档' }), true);
});

test('isInvestigationWorthy：标题命中"排查…"即便 nextAction 是泛兜底 → true', () => {
  assert.equal(isInvestigationWorthy({ title: '排查宁波力劲 /new 指令上下文清理问题', nextAction: '跟进进展并确认结果' }), true);
  assert.equal(isInvestigationWorthy({ title: '核实智能体授权超时时长', nextAction: '推进交付并向对方确认收到' }), true);
});

test('isInvestigationWorthy：泛兜底+无查证标题/过短/空 → false', () => {
  assert.equal(isInvestigationWorthy({ title: '帮王爽优化数据查询', nextAction: '跟进进展并确认结果' }), false);
  assert.equal(isInvestigationWorthy({ nextAction: '开会' }), false);
  assert.equal(isInvestigationWorthy({}), false);
  assert.equal(isInvestigationWorthy({ nextAction: '把排期草案发给 Yufan' }), false); // 纯发送，非查证
});

test('isInvestigationWorthy：MVP48 IM-可查悬置状态(标题命中)→ true，即便 nextAction 泛兜底', () => {
  // 这些状态就在飞书 IM 里、现在能查清
  assert.equal(isInvestigationWorthy({ title: '评测集已发送但接收方不确定', nextAction: '向相关方澄清阻塞点并推动解除' }), true);
  assert.equal(isInvestigationWorthy({ title: '多维表格智能体暂停功能全量时间待确认', nextAction: '跟进进展并确认结果' }), true);
  assert.equal(isInvestigationWorthy({ title: '双日会你的待办未闭环', nextAction: '跟进进展并确认结果' }), true);
  assert.equal(isInvestigationWorthy({ title: '方案待回复', nextAction: '参与讨论并推动形成结论' }), true);
});

test('isInvestigationWorthy：泛兜底文案不被新扩词误触发；代码/系统类不扩', () => {
  // 7 个泛兜底 nextAction 均不含 待确认/待回复/未回复/未闭环/不确定 → 仍 false（无查证标题时）
  for (const na of [
    '跟进进展并确认结果', '推进交付并向对方确认收到', '向相关方澄清阻塞点并推动解除',
    '完成评审并反馈意见', '确认决策结论并同步相关方', '协调相关方对齐时间与分工', '参与讨论并推动形成结论',
  ]) {
    assert.equal(isInvestigationWorthy({ title: '帮王爽优化数据查询', nextAction: na }), false, na);
  }
  // 「待验证」是代码/系统类，刻意不纳入（留给外部取数能力）→ 标题仅含待验证不 worthy
  assert.equal(isInvestigationWorthy({ title: 'BOE yaml 配置替换待验证', nextAction: '跟进进展并确认结果' }), false);
});

test('select：worthy + 非冷却中 → 按优先级 → 最久未动 取 top-1', () => {
  const matters = [
    mkMatter({ id: 'a', priority: 'P2', nextAction: '确认评测集是否已发给鲁升纲', updatedAt: '2026-06-12T00:00:00Z' }),
    mkMatter({ id: 'b', priority: 'P1', nextAction: '核实对方是否已收到', updatedAt: '2026-06-13T00:00:00Z' }),
    mkMatter({ id: 'c', priority: 'P1', nextAction: '核实修复是否完成', updatedAt: '2026-06-10T00:00:00Z' }), // P1 且更久未动
    mkMatter({ id: 'd', priority: 'P0', nextAction: '跟进进展并确认结果' }), // P0 但兜底文案→不 worthy
  ];
  const pick = selectInvestigationCandidate(matters, () => false);
  assert.equal(pick?.id, 'c', 'P1 中最久未动的 c（d 虽 P0 但 nextAction 不 worthy）');
});

test('select：冷却中的被跳过', () => {
  const matters = [
    mkMatter({ id: 'a', priority: 'P0', nextAction: '确认是否已完成' }),
    mkMatter({ id: 'b', priority: 'P2', nextAction: '核实是否已收到' }),
  ];
  const pick = selectInvestigationCandidate(matters, (id) => id === 'a'); // a 在冷却
  assert.equal(pick?.id, 'b');
});

test('select：非 open/in_progress 不选；无 worthy → null', () => {
  const matters = [
    mkMatter({ id: 'a', status: 'resolved', nextAction: '确认是否已完成' }),
    mkMatter({ id: 'b', status: 'open', nextAction: '跟进进展并确认结果' }), // 兜底
  ];
  assert.equal(selectInvestigationCandidate(matters, () => false), null);
});

// MVP42：止损门
import { isStuckOnUnknowns } from '../src/investigation/investigationDispatcher.js';

const u = (c: number) => ({ verdict: 'unknown', confidence: c });
const v = (verdict: string, c: number) => ({ verdict, confidence: c });

test('isStuckOnUnknowns：近2次都真 unknown(conf>0) → true；有非 unknown → false', () => {
  assert.equal(isStuckOnUnknowns([u(0.3), u(0.2), u(0.2)]), true);
  assert.equal(isStuckOnUnknowns([u(0.3), u(0.2)]), true);
  assert.equal(isStuckOnUnknowns([v('progressed', 0.8), u(0.3)]), false); // 最新非 unknown
  assert.equal(isStuckOnUnknowns([u(0.3), v('progressed', 0.8)]), false); // 第2次非 unknown
  assert.equal(isStuckOnUnknowns([u(0.3)]), false); // 不足 2 次
  assert.equal(isStuckOnUnknowns([]), false);
});

test('isStuckOnUnknowns：conf=0 退化哨兵(排查器空转/工具报错)不算止损 → 重试', () => {
  // 实测 2e48e9fb / c70abecf：两次 conf0 退化、从没真查过 → 不该被永久放弃
  assert.equal(isStuckOnUnknowns([u(0), u(0)]), false);
  assert.equal(isStuckOnUnknowns([u(0), u(0), u(0)]), false);
  // 退化 + 1 真 unknown → 真 unknown 不足 2 个 → 重试
  assert.equal(isStuckOnUnknowns([u(0), u(0), u(0.3)]), false);
  // 退化夹在真 unknown 中间，仍有 2 个真 unknown → 止损
  assert.equal(isStuckOnUnknowns([u(0), u(0.3), u(0.3)]), true);
});

test('select：shouldSkip 命中的事项被跳过（已有提案/查不清）', () => {
  const matters = [
    mkMatter({ id: 'skip', priority: 'P0', nextAction: '确认是否已完成' }), // 高优但 shouldSkip
    mkMatter({ id: 'keep', priority: 'P2', nextAction: '核实是否已收到' }),
  ];
  const pick = selectInvestigationCandidate(matters, () => false, (id) => id === 'skip');
  assert.equal(pick?.id, 'keep', '止损跳过 skip，选 keep（即便 keep 优先级更低）');
});
