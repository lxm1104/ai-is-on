/**
 * MVP74 吞吐修复 —— opencode 模型熔断：某模型连续失败 N 次 → 冷却窗内跳过、直奔下一个，
 * 避免每轮白等 90s 超时（实测 glm-5.2 间歇超时）。冷却后半开探活，成则恢复；永不全跳。
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
const COOL = config.opencodeModelCircuitCooldownMs; // 默认 120000
function failN(model: string, n: number, now: number) { for (let i = 0; i < n; i++) recordModelResult(model, false, now); }

test('熔断：无失败 → 全链照旧', () => {
  _resetModelCircuit();
  assert.deepEqual(selectEffectiveChain(CHAIN, T), CHAIN);
});

test('熔断：连续达阈值失败 → 跳过该模型直奔下一个', () => {
  _resetModelCircuit();
  failN('m-a', K - 1, T);
  assert.deepEqual(selectEffectiveChain(CHAIN, T), CHAIN, '不到阈值不熔断');
  recordModelResult('m-a', false, T); // 第 K 次
  assert.deepEqual(selectEffectiveChain(CHAIN, T + 1), ['m-b', 'm-c'], '达阈值 → 跳过 m-a（不再每轮等它超时）');
});

test('熔断：冷却内仍跳，冷却后半开回链探活', () => {
  _resetModelCircuit();
  failN('m-a', K, T);
  assert.deepEqual(selectEffectiveChain(CHAIN, T + COOL - 1), ['m-b', 'm-c'], '冷却内跳过');
  assert.deepEqual(selectEffectiveChain(CHAIN, T + COOL + 1), CHAIN, '冷却后回链探活（半开）');
});

test('熔断：半开探活成功 → 完全恢复', () => {
  _resetModelCircuit();
  failN('m-a', K, T);
  recordModelResult('m-a', true, T + COOL + 1); // 探活成功
  assert.deepEqual(selectEffectiveChain(CHAIN, T + COOL + 2), CHAIN, '成功恢复 → 全链');
  assert.equal(getModelCircuitState().find((s) => s.model === 'm-a')?.fails, 0, 'fails 清零');
});

test('熔断：半开探活再失败 → 再开一个冷却窗', () => {
  _resetModelCircuit();
  failN('m-a', K, T);
  recordModelResult('m-a', false, T + COOL + 1); // 探活失败
  assert.deepEqual(selectEffectiveChain(CHAIN, T + COOL + 2), ['m-b', 'm-c'], '探活失败 → 继续跳');
  assert.deepEqual(selectEffectiveChain(CHAIN, T + 2 * COOL + 3), CHAIN, '下个冷却后再探活');
});

test('熔断：永不全跳——所有模型都熔断 → 仍返回链尾兜底', () => {
  _resetModelCircuit();
  for (const m of CHAIN) failN(m, K, T);
  assert.deepEqual(selectEffectiveChain(CHAIN, T + 1), ['m-c'], '全熔断也绝不返回空，留最后一个兜底');
});

test('熔断：单模型链不跳过（无意义，仍试）', () => {
  _resetModelCircuit();
  failN('m-a', K + 2, T);
  assert.deepEqual(selectEffectiveChain(['m-a'], T + 1), ['m-a']);
});

test('熔断：一个模型熔断不影响别的模型', () => {
  _resetModelCircuit();
  failN('m-a', K, T);
  recordModelResult('m-b', true, T);
  assert.deepEqual(selectEffectiveChain(CHAIN, T + 1), ['m-b', 'm-c'], '只跳 m-a，m-b/m-c 不受影响');
});
