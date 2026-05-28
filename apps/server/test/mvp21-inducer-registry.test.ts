/**
 * MVP21 S5 §8.2 — Inducer 注册表单测。
 *
 * 覆盖：
 *   1. registerInducer 幂等（重复 register 同 name 不重置 stats）
 *   2. reportInducerRun 更新 lastRunAt / lastDurationMs / lastError / runCount
 *   3. reportInducerRun 对未 register 的 name 静默忽略
 *   4. listInducers 返回拷贝（消费方修改不影响内部状态）
 *   5. 集成：import graphInducer / suggestionWorker 后两个 inducer 自动出现在 list 里
 *
 * 运行：npx tsx --test apps/server/test/mvp21-inducer-registry.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp21-inducer-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const {
  registerInducer,
  reportInducerRun,
  listInducers,
  _resetRegistryForTest,
} = await import('../src/structure/inducerRegistry.js');

// ---------- 基本 API ----------

test('registerInducer 幂等：重复同 name 不重置 stats', () => {
  _resetRegistryForTest();
  registerInducer('foo', 'derived_signal', 'tick');
  reportInducerRun('foo', 123, null);
  registerInducer('foo', 'derived_signal', 'tick'); // 重复登记
  const list = listInducers();
  const foo = list.find((x) => x.name === 'foo')!;
  assert.equal(foo.runCount, 1, '重复 register 不应重置 runCount');
  assert.equal(foo.lastDurationMs, 123);
});

test('registerInducer 允许更新 layer/trigger（dev hot-reload 场景）', () => {
  _resetRegistryForTest();
  registerInducer('bar', 'derived_signal', 'tick');
  reportInducerRun('bar', 50);
  registerInducer('bar', 'pending_inference', 'manual'); // 改 layer/trigger
  const bar = listInducers().find((x) => x.name === 'bar')!;
  assert.equal(bar.layer, 'pending_inference');
  assert.equal(bar.trigger, 'manual');
  assert.equal(bar.runCount, 1, '统计字段仍保留');
});

test('reportInducerRun 更新所有 stats 字段', () => {
  _resetRegistryForTest();
  registerInducer('foo', 'derived_signal', 'tick');
  const before = listInducers().find((x) => x.name === 'foo')!;
  assert.equal(before.lastRunAt, null);
  assert.equal(before.lastDurationMs, null);
  assert.equal(before.lastError, null);
  assert.equal(before.runCount, 0);

  reportInducerRun('foo', 250);
  const a1 = listInducers().find((x) => x.name === 'foo')!;
  assert.ok(a1.lastRunAt, 'lastRunAt 应填上 ISO');
  assert.equal(a1.lastDurationMs, 250);
  assert.equal(a1.lastError, null);
  assert.equal(a1.runCount, 1);

  reportInducerRun('foo', 300, 'oops');
  const a2 = listInducers().find((x) => x.name === 'foo')!;
  assert.equal(a2.lastDurationMs, 300);
  assert.equal(a2.lastError, 'oops');
  assert.equal(a2.runCount, 2);
});

test('reportInducerRun 对未 register 的 name 静默忽略', () => {
  _resetRegistryForTest();
  // 不抛错
  reportInducerRun('nonexistent', 100);
  const list = listInducers();
  assert.equal(list.length, 0, '未 register 的 name 不会被自动登记');
});

test('reportInducerRun error 超长会被截断到 200 字', () => {
  _resetRegistryForTest();
  registerInducer('foo', 'derived_signal', 'tick');
  const longErr = 'X'.repeat(500);
  reportInducerRun('foo', 1, longErr);
  const foo = listInducers().find((x) => x.name === 'foo')!;
  assert.equal(foo.lastError?.length, 200);
});

test('reportInducerRun durationMs 负值会被夹到 0', () => {
  _resetRegistryForTest();
  registerInducer('foo', 'derived_signal', 'tick');
  reportInducerRun('foo', -10);
  const foo = listInducers().find((x) => x.name === 'foo')!;
  assert.equal(foo.lastDurationMs, 0);
});

test('listInducers 返回拷贝：消费方修改不影响内部状态', () => {
  _resetRegistryForTest();
  registerInducer('foo', 'derived_signal', 'tick');
  reportInducerRun('foo', 100);
  const list = listInducers();
  list[0].runCount = 9999;
  list[0].lastDurationMs = 9999;
  const after = listInducers().find((x) => x.name === 'foo')!;
  assert.equal(after.runCount, 1, 'consumer 改不影响内部');
  assert.equal(after.lastDurationMs, 100);
});

// ---------- 集成：import 两个生产 inducer 后自动出现在 list ----------

test('import graphInducer 后 graph_inducer 自动注册', async () => {
  _resetRegistryForTest();
  // 故意延迟到这里 import，触发模块顶部 registerInducer 副作用
  await import('../src/context/graphInducer.js');
  const list = listInducers();
  const graph = list.find((x) => x.name === 'graph_inducer');
  assert.ok(graph, 'graphInducer 应已注册');
  assert.equal(graph!.layer, 'derived_signal');
  assert.equal(graph!.trigger, 'tick');
});

test('import suggestionWorker 后 space_suggestion_worker 自动注册', async () => {
  _resetRegistryForTest();
  await import('../src/spaces/suggestionWorker.js');
  const sw = listInducers().find((x) => x.name === 'space_suggestion_worker');
  assert.ok(sw);
  assert.equal(sw!.layer, 'pending_inference');
  assert.equal(sw!.trigger, 'tick');
});
