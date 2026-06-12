/**
 * MVP33 U1 — 采集覆盖水位：collector_state 列语义、水位滞后告警、
 * 最新锚定窗口覆盖（收缩重试）、发射过滤，以及把 2026-06-12 专利事故
 * 写成通例的「停摆回灌零丢失」验收测试。
 *
 * Run: npx tsx --test apps/server/test/mvp33-watermark.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp33-wm-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { upsertCollectorState, getCollectorState } = await import('../src/db.js');
const { evaluateWatermarkLag } = await import('../src/collectors/freshnessWatchdog.js');
const { coverNewestAnchoredWindow, dropBeyondWatermark, chatFailureClampDecision, noteChatFetchOk } =
  await import('../src/collectors/imCollector.js');
import type { ImMessage } from '../src/collectors/imCollector.js';

// ---- helpers ----

/** 生成 lark 风格的本地分钟时间串（parseCreateTime 按本地时区解析）。 */
function localMinute(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function mkMsg(id: string, atMs: number): ImMessage {
  return { message_id: id, chat_id: 'oc_test', content: `msg-${id}`, create_time: localMinute(atMs) };
}

/** 最新锚定 fetch 仿真：窗口内按时间取最新 cap 条，截断则 hasMore=true（messages-search 实测行为）。 */
function newestAnchoredFetch(all: ImMessage[], cap: number) {
  let calls = 0;
  const fetch = async (startMs: number, endMs: number) => {
    calls++;
    const inWindow = all
      .filter((m) => {
        const t = Date.parse(`${m.create_time!.replace(' ', 'T')}:00`);
        return t > startMs && t <= endMs;
      })
      .sort((a, b) => (a.create_time! < b.create_time! ? 1 : -1)); // desc
    return { msgs: inWindow.slice(0, cap), hasMore: inWindow.length > cap };
  };
  return { fetch, callCount: () => calls };
}

// ---- collector_state covered_until ----

test('collector_state：covered_until 写入与错误轮 COALESCE 保旧值', () => {
  upsertCollectorState({
    collector_name: 'wm-test',
    last_scan_at: '2026-06-12T10:00:00.000Z',
    last_success_at: '2026-06-12T10:00:00.000Z',
    last_error: null,
    covered_until: '2026-06-12T09:30:00.000Z',
  });
  let st = getCollectorState('wm-test')!;
  assert.equal(st.covered_until, '2026-06-12T09:30:00.000Z');

  // 错误轮：success/covered 都写 null → 双双保旧值（游标不被失败抹掉）
  upsertCollectorState({
    collector_name: 'wm-test',
    last_scan_at: '2026-06-12T10:03:00.000Z',
    last_success_at: null,
    last_error: 'boom',
    covered_until: null,
  });
  st = getCollectorState('wm-test')!;
  assert.equal(st.covered_until, '2026-06-12T09:30:00.000Z');
  assert.equal(st.last_success_at, '2026-06-12T10:00:00.000Z');
  assert.equal(st.last_error, 'boom');
});

// ---- 水位滞后告警 ----

test('evaluateWatermarkLag：扫描成功但覆盖落后 → 告警；停摆的 collector 不双报', () => {
  const now = Date.parse('2026-06-12T12:00:00.000Z');
  const HOUR = 3600_000;
  // 正常：覆盖只落后 1min
  assert.deepEqual(
    evaluateWatermarkLag(
      [{ name: 'im', lastSuccessAt: new Date(now - 60_000).toISOString(), coveredUntil: new Date(now - 60_000).toISOString() }],
      now,
      2 * HOUR,
      30 * 60_000
    ),
    { lagging: false }
  );
  // 滞后：扫描新鲜但水位落后 3h
  const v = evaluateWatermarkLag(
    [{ name: 'im', lastSuccessAt: new Date(now - 60_000).toISOString(), coveredUntil: new Date(now - 3 * HOUR).toISOString() }],
    now,
    2 * HOUR,
    30 * 60_000
  );
  assert.equal(v.lagging, true);
  if (v.lagging) {
    assert.equal(v.worstName, 'im');
    assert.equal(v.lagMinutes, 180);
  }
  // 停摆（lastSuccessAt 太旧）→ 这里不报（由停滞卡负责）
  assert.deepEqual(
    evaluateWatermarkLag(
      [{ name: 'im', lastSuccessAt: new Date(now - 5 * HOUR).toISOString(), coveredUntil: new Date(now - 5 * HOUR).toISOString() }],
      now,
      2 * HOUR,
      30 * 60_000
    ),
    { lagging: false }
  );
  // 没有 covered_until（旧库未迁移完）→ 不报
  assert.deepEqual(
    evaluateWatermarkLag(
      [{ name: 'im', lastSuccessAt: new Date(now - 60_000).toISOString() }],
      now,
      2 * HOUR,
      30 * 60_000
    ),
    { lagging: false }
  );
});

// ---- coverNewestAnchoredWindow ----

test('coverNewestAnchoredWindow：无截断一次覆盖全窗', async () => {
  const base = Date.parse('2026-06-11T04:00:00.000Z');
  const all = Array.from({ length: 10 }, (_, i) => mkMsg(`m${i}`, base + (i + 1) * 60_000));
  const { fetch, callCount } = newestAnchoredFetch(all, 100);
  const r = await coverNewestAnchoredWindow({
    sinceMs: base,
    endMs: base + 3600_000,
    minWindowMs: 5 * 60_000,
    fetch,
  });
  assert.equal(r.truncated, false);
  assert.equal(r.coveredUntilMs, base + 3600_000);
  assert.equal(r.msgs.length, 10);
  assert.equal(callCount(), 1);
});

test('coverNewestAnchoredWindow：has_more 且最老返回 > since → 收缩重试直至覆盖', async () => {
  const base = Date.parse('2026-06-11T04:00:00.000Z');
  const HOUR = 3600_000;
  // 6h 窗口里 60 条（每 6min 一条），cap 25：6h(60条)→3h(30条)→1.5h(15条≤25) 收敛
  const all = Array.from({ length: 60 }, (_, i) => mkMsg(`m${i}`, base + (i + 1) * 6 * 60_000));
  const { fetch, callCount } = newestAnchoredFetch(all, 25);
  const r = await coverNewestAnchoredWindow({
    sinceMs: base,
    endMs: base + 6 * HOUR,
    minWindowMs: 5 * 60_000,
    fetch,
  });
  assert.equal(r.truncated, false);
  assert.equal(r.coveredUntilMs, base + 1.5 * HOUR);
  // 覆盖段 (base, base+1.5h] 的消息一条不少
  const covered = all.filter((m) => {
    const t = Date.parse(`${m.create_time!.replace(' ', 'T')}:00`);
    return t <= r.coveredUntilMs;
  });
  assert.equal(r.msgs.length, covered.length);
  assert.equal(callCount(), 3);
});

test('coverNewestAnchoredWindow：收缩到 floor 仍超限 → 有界接受 + truncated 标记', async () => {
  const base = Date.parse('2026-06-11T04:00:00.000Z');
  // floor 窗口（5min）内塞 10 条同窗消息，cap 3 → 无法收敛
  const all = Array.from({ length: 10 }, (_, i) => mkMsg(`m${i}`, base + 60_000 + i * 10_000));
  const { fetch } = newestAnchoredFetch(all, 3);
  const r = await coverNewestAnchoredWindow({
    sinceMs: base,
    endMs: base + 5 * 60_000,
    minWindowMs: 5 * 60_000,
    fetch,
  });
  assert.equal(r.truncated, true);
  assert.equal(r.coveredUntilMs, base + 5 * 60_000);
});

// ---- 发射过滤 ----

test('dropBeyondWatermark：≤ 水位保留、> 水位丢弃', () => {
  const base = Date.parse('2026-06-11T04:00:00.000Z');
  const msgs = [mkMsg('a', base + 60_000), mkMsg('b', base + 120_000), mkMsg('c', base + 180_000)];
  const watermark = new Date(base + 120_000).toISOString();
  const kept = dropBeyondWatermark(msgs, watermark);
  assert.deepEqual(kept.map((m) => m.message_id), ['a', 'b']);
});

// ---- per-chat 失败 streak：有界重试后降级，防一个坏群卡死整源 ----

test('chatFailureClampDecision：前 2 次失败 clamp 重试，第 3 次起降级为 chat 级损失；成功清零', () => {
  const streaks = new Map<string, number>();
  assert.deepEqual(chatFailureClampDecision('oc_bad', 2, streaks), { shouldClamp: true, streak: 1 });
  assert.deepEqual(chatFailureClampDecision('oc_bad', 2, streaks), { shouldClamp: true, streak: 2 });
  assert.deepEqual(chatFailureClampDecision('oc_bad', 2, streaks), { shouldClamp: false, streak: 3 });
  assert.deepEqual(chatFailureClampDecision('oc_bad', 2, streaks), { shouldClamp: false, streak: 4 });
  // 别的 chat 互不影响
  assert.deepEqual(chatFailureClampDecision('oc_other', 2, streaks), { shouldClamp: true, streak: 1 });
  // 成功一次清零 → 重新获得重试窗口
  noteChatFetchOk('oc_bad', streaks);
  assert.deepEqual(chatFailureClampDecision('oc_bad', 2, streaks), { shouldClamp: true, streak: 1 });
});

// ---- 验收通例：停摆回灌零丢失（2026-06-12 专利事故的形态化） ----

test('停摆 24h 后回灌：有界追赶窗口 + 收缩重试，多轮排干零丢失', async () => {
  const HOUR = 3600_000;
  const t0 = Date.parse('2026-06-11T04:00:00.000Z'); // 停摆开始（最后水位）
  const nowMs = t0 + 24 * HOUR; // 恢复时刻
  // 24h 里 240 条消息（每 6min 一条）——含「最老段」（事故里被 page-limit 静默扔掉的那段）
  const all = Array.from({ length: 240 }, (_, i) => mkMsg(`m${i}`, t0 + (i + 1) * 6 * 60_000));
  const { fetch } = newestAnchoredFetch(all, 25); // 单轮分页上限 25 条（远小于积压）

  const MAX_WINDOW = 6 * HOUR;
  const collected = new Map<string, number>(); // message_id → 被发射次数
  let watermark = t0;
  let rounds = 0;
  while (watermark < nowMs && rounds < 100) {
    rounds++;
    const hardEnd = Math.min(nowMs, watermark + MAX_WINDOW);
    const cover = await coverNewestAnchoredWindow({
      sinceMs: watermark,
      endMs: hardEnd,
      minWindowMs: 5 * 60_000,
      fetch,
    });
    assert.equal(cover.truncated, false, '正常积压不应触发 floor 截断');
    // 发射不变量：只发 (since, coveredUntil] 内的消息
    const emitted = dropBeyondWatermark(cover.msgs, new Date(cover.coveredUntilMs).toISOString());
    for (const m of emitted) {
      collected.set(m.message_id!, (collected.get(m.message_id!) ?? 0) + 1);
    }
    assert.ok(cover.coveredUntilMs > watermark, '水位必须前进（无死循环）');
    watermark = cover.coveredUntilMs;
  }

  assert.equal(collected.size, 240, `应零丢失（实收 ${collected.size}/240，${rounds} 轮）`);
  const dup = [...collected.entries()].filter(([, c]) => c > 1);
  assert.equal(dup.length, 0, `跨轮窗口不相交 ⇒ 不应重复发射（重复: ${dup.length}）`);
  assert.ok(rounds < 40, `排干轮数应有界（实际 ${rounds}）`);
});
