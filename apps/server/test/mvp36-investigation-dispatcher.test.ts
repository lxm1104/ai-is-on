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

test('isInvestigationWorthy：具体"确认是否…"→true', () => {
  assert.equal(isInvestigationWorthy('确认评测集是否已实际发送给鲁升纲'), true);
  assert.equal(isInvestigationWorthy('跟进黄炜深/冼晓东排查进展，确认修复排期'), true);
  assert.equal(isInvestigationWorthy('核实对方是否已收到文档'), true);
});

test('isInvestigationWorthy：泛兜底/过短/空 → false', () => {
  assert.equal(isInvestigationWorthy('跟进进展并确认结果'), false); // 兜底文案
  assert.equal(isInvestigationWorthy('推进交付并向对方确认收到'), false); // 兜底文案
  assert.equal(isInvestigationWorthy('开会'), false); // 过短
  assert.equal(isInvestigationWorthy(''), false);
  assert.equal(isInvestigationWorthy(null), false);
  assert.equal(isInvestigationWorthy('把排期草案发给 Yufan'), false); // 纯发送动作，非查证
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
