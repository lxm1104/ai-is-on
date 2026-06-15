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
  // 核心断言是 code===-1 + stderr 含超时文案（只有超时真正触发才会出现，进程自然
  // 退出则 code=0 且无此文案），它们与 CPU 负载无关。
  // elapsed 断言只是“没有干等满子进程时长”的兜底守卫：把子进程拉长到 30s、阈值放到
  // 5s，既保留“远早于自然退出即返回”的语义（6× 余量），又能吸收全量并发跑时事件
  // 循环被饿导致的定时器迟发抖动（实测最坏 ~1.1s，留 >4× 余量），不再 flaky。
  const t0 = Date.now();
  const r = await runLarkCli(['30']); // /bin/sleep 30 —— 模拟挂死（超时会 SIGTERM 立刻杀掉）
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, `应因超时(300ms)远早于 30s 自然退出而返回，实际 ${elapsed}ms`);
  assert.equal(r.code, -1);
  assert.match(r.stderr, /timeout after 300ms/);
});

test('runLarkCli: 正常退出不受超时影响', async () => {
  // 用宽松 per-call 超时（30s），而非默认 300ms。本用例验证的是“正常退出的进程
  // 返回真实退出码、不被超时干扰”，与超时阈值无关。300ms 在全量并发跑（75 个 tsx
  // 工作进程争 8 核）时会输给 /bin/sleep 0 的 spawn→exit 延迟（实测可达 1100ms+），
  // 导致硬超时误杀、返回 code=-1 —— 这正是该用例历史性 flaky 的根因。给足超时即可
  // 解耦“正常退出”与“spawn 调度延迟恰好跑赢 300ms”这两件事，不削弱任何断言。
  // 需要超时真正触发的用例（sleep 30）仍用各自的短超时，见上/下两个用例。
  const r = await runLarkCli(['0'], undefined, { timeoutMs: 30_000 }); // /bin/sleep 0 —— 立即正常退出
  assert.equal(r.code, 0);
  assert.ok(!/timeout/.test(r.stderr));
});

test('runLarkCli: per-call timeoutMs 覆盖生效', async () => {
  // per-call 100ms 覆盖是否生效，由 stderr 的「timeout after 100ms」文案证明（默认是
  // 300ms，文案不同），与负载无关。elapsed 同上仅作兜底：sleep 30 + 阈值 5s，避免
  // 原 `< 1_000` 在并发跑时被定时器迟发顶破（实测曾达 1132ms）。
  const t0 = Date.now();
  const r = await runLarkCli(['30'], undefined, { timeoutMs: 100 });
  assert.ok(Date.now() - t0 < 5_000, `应因 100ms 超时远早于 30s 自然退出而返回，实际 ${Date.now() - t0}ms`);
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
