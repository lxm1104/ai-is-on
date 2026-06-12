// 2026-06-12 采集挂死事故的防回归测试：
//   - runLarkCli：子进程挂死必须被硬超时杀掉（事故根因：无超时 await 永久占住互斥锁）
//   - shouldForceRelease：互斥锁卡死强制释放决策
//   - evaluateFreshness：采集整体停滞（沉默失明）判定
//
// 注意：env 必须在 import config 之前设置（config 在模块加载时读 env），
// 所以这里全部用动态 import。
process.env.LARK_CLI_BIN = '/bin/sleep';
process.env.LARK_CLI_TIMEOUT_MS = '300';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runLarkCli } = await import('../src/util/larkCli.js');
const { shouldForceRelease } = await import('../src/collectors/scheduler.js');
const { evaluateFreshness } = await import('../src/collectors/freshnessWatchdog.js');

// ---------- runLarkCli 硬超时 ----------

test('runLarkCli: 挂死子进程被超时终止，按失败 resolve', async () => {
  const t0 = Date.now();
  const r = await runLarkCli(['5']); // /bin/sleep 5 —— 模拟挂死
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2_000, `应在超时(300ms)附近返回，实际 ${elapsed}ms`);
  assert.equal(r.code, -1);
  assert.match(r.stderr, /timeout after 300ms/);
});

test('runLarkCli: 正常退出不受超时影响', async () => {
  const r = await runLarkCli(['0']); // /bin/sleep 0 —— 立即正常退出
  assert.equal(r.code, 0);
  assert.ok(!/timeout/.test(r.stderr));
});

test('runLarkCli: per-call timeoutMs 覆盖生效', async () => {
  const t0 = Date.now();
  const r = await runLarkCli(['5'], undefined, { timeoutMs: 100 });
  assert.ok(Date.now() - t0 < 1_000);
  assert.match(r.stderr, /timeout after 100ms/);
});

// ---------- shouldForceRelease ----------

test('forceRelease: 无 runningSince 不释放', () => {
  assert.equal(shouldForceRelease(undefined, Date.now(), 180_000), false);
});

test('forceRelease: 短间隔 collector 卡 16min 触发（下限 15min）', () => {
  const now = 1_000_000_000;
  assert.equal(shouldForceRelease(now - 16 * 60_000, now, 180_000), true);
  assert.equal(shouldForceRelease(now - 10 * 60_000, now, 180_000), false);
});

test('forceRelease: 长间隔 collector 用 3×interval（10min 间隔 → 30min）', () => {
  const now = 1_000_000_000;
  assert.equal(shouldForceRelease(now - 16 * 60_000, now, 600_000), false);
  assert.equal(shouldForceRelease(now - 31 * 60_000, now, 600_000), true);
});

// ---------- evaluateFreshness ----------

const NOW = Date.parse('2026-06-12T04:00:00Z');
const THRESHOLD = 30 * 60_000;

function iso(minAgo: number): string {
  return new Date(NOW - minAgo * 60_000).toISOString();
}

test('freshness: 空快照（collector 未启用）不告警', () => {
  assert.deepEqual(evaluateFreshness([], NOW, THRESHOLD), { stale: false });
});

test('freshness: 全新库（从未成功过）不告警', () => {
  assert.deepEqual(
    evaluateFreshness([{ name: 'im' }, { name: 'calendar' }], NOW, THRESHOLD),
    { stale: false }
  );
});

test('freshness: 最新成功在阈值内 → fresh', () => {
  const v = evaluateFreshness(
    [
      { name: 'im', lastSuccessAt: iso(10) },
      { name: 'calendar', lastSuccessAt: iso(120) },
    ],
    NOW,
    THRESHOLD
  );
  assert.equal(v.stale, false);
});

test('freshness: 全部成功记录都超过阈值 → stale，报告最新者', () => {
  const v = evaluateFreshness(
    [
      { name: 'im', lastSuccessAt: iso(45) },
      { name: 'calendar', lastSuccessAt: iso(1200) },
    ],
    NOW,
    THRESHOLD
  );
  assert.ok(v.stale);
  if (v.stale) {
    assert.equal(v.staleMinutes, 45);
    assert.equal(v.freshestName, 'im');
  }
});

test('freshness: 无效时间串被忽略', () => {
  const v = evaluateFreshness(
    [
      { name: 'im', lastSuccessAt: 'not-a-date' },
      { name: 'calendar', lastSuccessAt: iso(5) },
    ],
    NOW,
    THRESHOLD
  );
  assert.equal(v.stale, false);
});
