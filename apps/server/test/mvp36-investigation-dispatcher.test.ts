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
  hasResolvableBadcase,
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

test('MVP52 hasResolvableBadcase：失败信号 + 凭据 双命中才 true', () => {
  // 有 traceID/日志ID 凭据 → run_command 能追 → worthy
  assert.equal(hasResolvableBadcase({ title: 'middleware 报错未返回 tool result', currentSummary: '鲁升纲@traceID 2fd12bef…' }), true);
  assert.equal(hasResolvableBadcase({ title: 'coding Agent 沙箱解压缩报错', currentSummary: '运行日志ID 7651916413615967418' }), true);
  // 只有失败信号、无凭据 → 不进（避免泛触发挤兑 gate）
  assert.equal(hasResolvableBadcase({ title: '模型走入安装技能链路导致报错', currentSummary: '需高优修复' }), false);
  // 只有凭据、无失败信号 → 不进
  assert.equal(hasResolvableBadcase({ title: '日常同步', currentSummary: '日志ID 7651916413615967418 已归档' }), true); // "日志" 本身是信号词
  assert.equal(hasResolvableBadcase({ title: '普通跟进', currentSummary: '无异常' }), false);
});

test('MVP52 isInvestigationWorthy：代码 badcase 带凭据 → worthy（即便泛兜底 nextAction）', () => {
  assert.equal(
    isInvestigationWorthy({ title: 'middleware 报错未返回 tool result 问题评审', nextAction: '跟进进展并确认结果', currentSummary: '@traceID 2fd12bef…' }),
    true
  );
  // 无凭据的纯 bug 标题仍不放行（run_command 也无从查起）
  assert.equal(
    isInvestigationWorthy({ title: '高优修复智能体安装技能权限链路报错', nextAction: '跟进进展并确认结果', currentSummary: '模型意外走入安装技能链路' }),
    false
  );
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

test('MVP57 select：badcase 类优先（但 P0 仍绝对最先）', () => {
  const matters = [
    mkMatter({ id: 'p0', priority: 'P0', title: '与王爽核对数据', nextAction: '确认是否已完成' }), // P0 非 badcase、worthy
    mkMatter({ id: 'bad', priority: 'P2', title: 'middleware 报错排查', nextAction: '排查为什么报错' }), // P2 badcase
    mkMatter({ id: 'norm', priority: 'P1', title: '确认评测集进度', nextAction: '核实是否已发' }), // P1 非 badcase、worthy
  ];
  assert.equal(selectInvestigationCandidate(matters, () => false)?.id, 'p0', 'P0 绝对最先');
  assert.equal(
    selectInvestigationCandidate(matters.filter((m) => m.id !== 'p0'), () => false)?.id,
    'bad',
    '去掉 P0 后，badcase(P2) 胜过更高优先级的非 badcase(P1)'
  );
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

test('MVP58 kick：onInvestigationKick 注册的 handler 收到 kickInvestigation（解耦 matterReducer↔dispatcher）', async () => {
  const k = await import('../src/investigation/investigationKick.js');
  let n = 0;
  k.onInvestigationKick(() => { n += 1; });
  k.kickInvestigation();
  k.kickInvestigation();
  assert.equal(n, 2, '每次 kick 都触达已注册 handler');
});

// MVP64 ⑥ 决策信息包：待拍板且信息不全的决策类 matter → worthy；已拍板/无未决信号 → 不查
import { isOpenDecision } from '../src/investigation/investigationDispatcher.js';

test('MVP64 isOpenDecision：仅 decision 类 + 未决信号 → true', () => {
  assert.equal(isOpenDecision({ type: 'decision', title: '多维表格定价方案待定' }), true);
  assert.equal(isOpenDecision({ type: 'decision', title: '技术选型', currentSummary: '两个方案有分歧' }), true);
  // 已拍板的决策（无未决信号）→ 不反复查
  assert.equal(isOpenDecision({ type: 'decision', title: '已确定用方案A' }), false);
  // 非 decision 类即便有"待定" → 交给别的 worthy 通道，这里不放行
  assert.equal(isOpenDecision({ type: 'follow_up', title: '价格待定' }), false);
});

test('MVP64 isInvestigationWorthy：决策类带未决信号 worthy（即便 nextAction 泛兜底）', () => {
  assert.equal(
    isInvestigationWorthy({ type: 'decision', title: '编辑器选型待拍板', nextAction: '确认决策结论并同步相关方' }),
    true
  );
  // 决策已拍板（无未决信号）+ 泛兜底 → 不查
  assert.equal(
    isInvestigationWorthy({ type: 'decision', title: '季度目标', nextAction: '确认决策结论并同步相关方' }),
    false
  );
});

test('MVP64 prompt：decision 类注入决策信息包指引；非 decision 不注入', async () => {
  const { buildInvestigateUserMessage } = await import('../src/investigation/investigationPrompt.js');
  const base = { matterTitle: 'x', currentSummary: '', nextAction: '', entities: [], findings: [], round: 1, maxRounds: 3 };
  const dec = buildInvestigateUserMessage({ ...base, matterType: 'decision' });
  assert.match(dec, /决策信息包指引/);
  assert.match(dec, /各方立场/);
  assert.match(dec, /不要替用户做决定/);
  const fu = buildInvestigateUserMessage({ ...base, matterType: 'follow_up' });
  assert.ok(!/决策信息包指引/.test(fu), '非决策类不注入');
});

// MVP65 unknown 退避：刚查回真实 unknown → 冷却 ×MULT；有意义结论/退化哨兵 → 原冷却
import { effectiveCooldownMs, UNKNOWN_COOLDOWN_MULT } from '../src/investigation/investigationDispatcher.js';

test('MVP65 effectiveCooldownMs：最近真实 unknown → 拉长冷却', () => {
  const base = 6 * 3600_000;
  // 最近一次真实 unknown → ×MULT
  assert.equal(effectiveCooldownMs([u(0.3)], base), base * UNKNOWN_COOLDOWN_MULT);
  assert.equal(effectiveCooldownMs([u(0.3), v('progressed', 0.8)], base), base * UNKNOWN_COOLDOWN_MULT);
  // 最近是有意义结论 → 原冷却
  assert.equal(effectiveCooldownMs([v('progressed', 0.8), u(0.3)], base), base);
  assert.equal(effectiveCooldownMs([v('resolved', 0.9)], base), base);
  // 只有 conf=0 退化哨兵(空转/工具报错) → 不算查不清 → 原冷却(别误退避从没真查过的)
  assert.equal(effectiveCooldownMs([u(0), u(0)], base), base);
  // 退化哨兵在前、真实 unknown 在后 → 取最近真实=unknown → 退避
  assert.equal(effectiveCooldownMs([u(0), u(0.3)], base), base * UNKNOWN_COOLDOWN_MULT);
  // 空历史 → 原冷却
  assert.equal(effectiveCooldownMs([], base), base);
});

// ============ MVP66 信噪比：无新证据门 + 死胡同止损 ============
import { shouldSkipNoNewEvidence, isStuckDeadEnd } from '../src/investigation/investigationDispatcher.js';

test('MVP66 shouldSkipNoNewEvidence：从没查过→放行；查过无新证据→跳过；有新证据→放行', () => {
  // 从没查过（lastAt=null）→ 首查必放行
  assert.equal(shouldSkipNoNewEvidence(null, () => false), false);
  assert.equal(shouldSkipNoNewEvidence(null, () => true), false);
  // 查过 + 此后无新外部证据 → 跳过
  assert.equal(shouldSkipNoNewEvidence('2026-06-15T07:58:00.000Z', () => false), true);
  // 查过 + 有新外部证据 → 放行重查
  assert.equal(shouldSkipNoNewEvidence('2026-06-16T17:00:00.000Z', () => true), false);
  // seam 精确性：hasNewSince 必须以 lastAt 原样调用（防 off-by-one）
  let seen = '';
  shouldSkipNoNewEvidence('2026-06-15T07:58:00.000Z', (s) => { seen = s; return false; });
  assert.equal(seen, '2026-06-15T07:58:00.000Z');
});

test('MVP66 isStuckDeadEnd：blocked 也算死胡同（修 48a55ea3 振荡漏止损）', () => {
  // 旧 isStuckOnUnknowns 此处为 false（blocked 不算）；新口径 → true
  assert.equal(isStuckDeadEnd([v('blocked', 0.7), v('blocked', 0.85)]), true);
  assert.equal(isStuckDeadEnd([u(0.6), v('blocked', 0.85)]), true, 'unknown+blocked 混合也止损');
  // progressed 打断死胡同（确实有进展不该止损）
  assert.equal(isStuckDeadEnd([v('progressed', 0.7), v('blocked', 0.8)]), false);
  // conf=0 哨兵剔除后不足 n（保 MVP45：从没真查过不背刺）
  assert.equal(isStuckDeadEnd([u(0), v('blocked', 0.7)]), false);
  // resolved 不算死胡同
  assert.equal(isStuckDeadEnd([v('resolved', 0.9), v('blocked', 0.7)]), false);
});

test('MVP66 effectiveCooldownMs：blocked 也触发 ×退避（不止 unknown）', () => {
  const base = 6 * 3600_000;
  assert.equal(effectiveCooldownMs([v('blocked', 0.8)], base), base * UNKNOWN_COOLDOWN_MULT);
  assert.equal(effectiveCooldownMs([v('progressed', 0.8)], base), base, 'progressed 不退避');
});

test('MVP66 isStuckOnUnknowns 别名 === isStuckDeadEnd（旧调用兼容）', () => {
  assert.equal(isStuckOnUnknowns, isStuckDeadEnd);
});
