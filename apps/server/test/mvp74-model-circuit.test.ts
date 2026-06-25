/**
 * MVP74 吞吐修复 —— opencode 模型熔断（滑动窗口）：最近 window 次里失败 ≥ threshold 次 → 冷却窗内跳过、
 * 直奔下一个，避免每轮白等 90s 超时（实测 glm-5.2 间歇超时，连续计数会漏，故按近 N 次失败率判）。
 * 冷却后半开探活，窗口失败累积清零则恢复；永不全跳。
 *
 * Run: npx tsx --test apps/server/test/mvp74-model-circuit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.COLLECTOR_ENABLED = 'false';
process.env.SQLITE_PATH = '/tmp/mvp74-circuit-test.sqlite';

const { config } = await import('../src/config.js');
const { selectEffectiveChain, recordModelResult, _resetModelCircuit, getModelCircuitState } = await import('../src/triage/backgroundRuntime.js');

const CHAIN = ['m-a', 'm-b', 'm-c'];
const T = 1_000_000;
const K = config.opencodeModelCircuitThreshold; // 默认 2
const W = config.opencodeModelCircuitWindow; // 默认 4
const COOL = config.opencodeModelCircuitCooldownMs; // 默认 120000
function rec(model: string, ok: boolean, now = T) { recordModelResult(model, ok, now); }
const recentFails = (model: string) => getModelCircuitState().find((s) => s.model === model)?.recentFails ?? 0;

test('熔断：无失败 → 全链照旧', () => {
  _resetModelCircuit();
  assert.deepEqual(selectEffectiveChain(CHAIN, T), CHAIN);
});

test('熔断：窗口内达阈值（连续）失败 → 跳过该模型', () => {
  _resetModelCircuit();
  for (let i = 0; i < K - 1; i++) rec('m-a', false);
  assert.deepEqual(selectEffectiveChain(CHAIN, T), CHAIN, '不到阈值不熔断');
  rec('m-a', false); // 第 K 次
  assert.deepEqual(selectEffectiveChain(CHAIN, T + 1), ['m-b', 'm-c'], '达阈值 → 跳过 m-a');
});

test('熔断：间歇失败（fail/success 交替）也能熔断——这是连续计数漏掉、本设计的关键', () => {
  _resetModelCircuit();
  // 近 3 次：F, T, F —— 窗口内 2 次失败 ≥ 阈值2 → 熔断（连续计数会漏）
  rec('m-a', false); rec('m-a', true); rec('m-a', false);
  assert.deepEqual(selectEffectiveChain(CHAIN, T + 1), ['m-b', 'm-c'], '间歇 2/3 失败 → 跳过');
});

test('熔断：冷却内仍跳，冷却到点回链探活（半开）', () => {
  _resetModelCircuit();
  rec('m-a', false); rec('m-a', false);
  assert.deepEqual(selectEffectiveChain(CHAIN, T + COOL - 1), ['m-b', 'm-c'], '冷却内跳过');
  assert.deepEqual(selectEffectiveChain(CHAIN, T + COOL + 1), CHAIN, '冷却到点回链探活');
});

test('熔断：半开后持续成功（窗口失败清零）→ 恢复', () => {
  _resetModelCircuit();
  rec('m-a', false); rec('m-a', false); // 熔断
  for (let i = 0; i < W; i++) rec('m-a', true, T + COOL + 1 + i); // 窗口次成功把 fail 挤出
  assert.equal(recentFails('m-a'), 0, '窗口失败清零');
  assert.equal(getModelCircuitState().find((s) => s.model === 'm-a')?.open, false, '熔断关闭');
  assert.deepEqual(selectEffectiveChain(CHAIN, T + COOL + 10), CHAIN, '完全恢复');
});

test('熔断：半开探活再失败 → 再开一个冷却窗', () => {
  _resetModelCircuit();
  rec('m-a', false); rec('m-a', false); // 熔断到 T+COOL
  rec('m-a', false, T + COOL + 1); // 探活失败 → 窗口仍 ≥ 阈值 → 再熔断
  assert.deepEqual(selectEffectiveChain(CHAIN, T + COOL + 2), ['m-b', 'm-c'], '探活失败 → 继续跳');
  assert.deepEqual(selectEffectiveChain(CHAIN, T + 2 * COOL + 3), CHAIN, '下个冷却到点再探活');
});

test('熔断：永不全跳——所有模型都熔断 → 仍返回链尾兜底', () => {
  _resetModelCircuit();
  for (const m of CHAIN) { rec(m, false); rec(m, false); }
  assert.deepEqual(selectEffectiveChain(CHAIN, T + 1), ['m-c'], '全熔断也绝不返回空，留最后一个兜底');
});

test('熔断：单模型链不跳过（无意义，仍试）', () => {
  _resetModelCircuit();
  for (let i = 0; i < K + 2; i++) rec('m-a', false);
  assert.deepEqual(selectEffectiveChain(['m-a'], T + 1), ['m-a']);
});

test('熔断：一个模型熔断不影响别的模型', () => {
  _resetModelCircuit();
  rec('m-a', false); rec('m-a', false);
  rec('m-b', true);
  assert.deepEqual(selectEffectiveChain(CHAIN, T + 1), ['m-b', 'm-c'], '只跳 m-a');
});
