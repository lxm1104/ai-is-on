/**
 * MVP78「回复闭环 + 积压大扫除」
 * 覆盖：bot 会话消息 tick（水位/去重/跳过 app 消息）、引用回复→KEYSTONE 回填、命令（确认清理/保留/忽略/恢复）、
 * 兜底路由与引导、大扫除甄别解析（宽容/保守）、批次应用映射与 TTL、chat_id 持久化。
 *
 * Run: npx tsx --test apps/server/test/mvp78-reply-sweep.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp78-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const notify = await import('../src/lark/larkNotifyService.js');
const loop = await import('../src/lark/botReplyLoop.js');
const sweeper = await import('../src/matter/backlogSweeper.js');
const { raiseMatterNeedHelpProposal } = await import('../src/matter/matterResolveProposal.js');
const db = await import('../src/db.js');

const SELF = 'self-' + randomUUID();
function resetDb() {
  db.db.exec(
    `DELETE FROM attention_items; DELETE FROM matters; DELETE FROM context_units;
     DELETE FROM matter_context_links; DELETE FROM audit_logs; DELETE FROM matter_entities;
     DELETE FROM matter_transitions; DELETE FROM settings; DELETE FROM attention_interactions;`
  );
  db.setSetting('self_person_entity_id', SELF);
  notify.__disarmNotifyServiceForTest();
}

let n = 0;
function mkMatter(opts: { title?: string; summary?: string } = {}) {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment', title: `事项${n}`, content: `内容 ${n}`,
    scope: 'work', origin: { kind: 'manual', refId: `u-${n}` }, silent: true,
  }).unit;
  const m = ms.createMatter({
    scope: 'work', type: 'follow_up', title: opts.title ?? `测试事项${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id, ownerEntityId: SELF,
    currentSummary: opts.summary ?? '', nextAction: '跟进',
  });
  return m;
}
/** 把 matter 及其挂链证据整体回拨到 daysAgo 天前（制造停滞） */
function backdate(matterId: string, daysAgo: number) {
  const iso = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  db.db.prepare(`UPDATE matters SET updated_at=? WHERE id=?`).run(iso, matterId);
  db.db
    .prepare(
      `UPDATE context_units SET updated_at=? WHERE id IN (SELECT context_unit_id FROM matter_context_links WHERE matter_id=?)`
    )
    .run(iso, matterId);
}

type Sent = { args: string[] };
function armSender() {
  const sent: Sent[] = [];
  notify.__setNotifySenderForTest(async (args: string[]) => {
    sent.push({ args });
    return { ok: true, data: { message_id: `om_${sent.length}`, chat_id: 'oc_test_chat' } };
  });
  return sent;
}
function mkReplyDeps() {
  const acks: Array<{ messageId: string; md: string }> = [];
  const deps = {
    replyFn: async (args: string[]) => {
      acks.push({ messageId: args[args.indexOf('--message-id') + 1], md: args[args.indexOf('--markdown') + 1] });
      return { ok: true };
    },
  };
  return { acks, deps };
}
function userMsg(over: Partial<loop.BotChatMessage> = {}): loop.BotChatMessage {
  n += 1;
  return {
    message_id: `om_user_${n}`,
    content: '补充信息',
    create_time: '2026-07-03 16:30',
    msg_type: 'text',
    sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' },
    ...over,
  };
}

// ---- 工具函数 ----
test('MVP78 extractText/parseCreateTime：JSON 信封与分钟精度时间', () => {
  assert.equal(loop.extractText('{"text":"贴 traceID: abc"}'), '贴 traceID: abc');
  assert.equal(loop.extractText('纯文本'), '纯文本');
  assert.equal(loop.extractText(undefined), '');
  assert.ok(loop.parseCreateTime('2026-07-03 15:10')! > 0);
  assert.ok(loop.parseCreateTime('2026-07-03T15:10:00.000Z')! > 0);
  assert.equal(loop.parseCreateTime('garbage'), null);
});

// ---- 引用回复 → KEYSTONE 回填 ----
test('MVP78 引用回复：按被引消息路由到 matter，落 card_action 证据 + 收求助卡 + ack', async () => {
  resetDb();
  armSender();
  const m = mkMatter({ title: '提醒触发器 bug' });
  // 升一张求助卡（未 arm 时不推送，卡照升）——用真实卡验证"回填后被收起"
  notify.__disarmNotifyServiceForTest();
  assert.equal(
    raiseMatterNeedHelpProposal(m, { needFromUser: { kind: 'need_credential', ask: '请贴 traceID' } }),
    true
  );
  // 模拟这张卡曾推送过：审计里留底 messageId=om_push_1
  const { writeAudit } = await import('../src/boundary/auditLog.js');
  writeAudit({
    action: 'notify_pushed',
    reason: 'test',
    payload: { kind: 'needhelp', refId: m.id, idempotencyKey: 'k', messageId: 'om_push_1' },
  });
  const { acks, deps } = mkReplyDeps();
  const mode = await loop.handleUserReply(
    userMsg({ content: 'traceID 是 abc123，用这个查', parent_id: 'om_push_1' }),
    deps
  );
  assert.equal(mode, 'quote_backfill');
  // 证据落库且挂链（origin card_action，KEYSTONE 可读）
  const backfills = db.listUserBackfillUnitsForMatter(m.id, 5);
  assert.equal(backfills.length, 1);
  assert.match(backfills[0].content, /abc123/);
  // 求助卡已收起（acted）
  const card = db.db
    .prepare(`SELECT status FROM attention_items WHERE input_hash=?`)
    .get(`proposal:matter-needhelp:${m.id}`) as { status: string };
  assert.equal(card.status, 'acted');
  // ack 回给原消息
  assert.equal(acks.length, 1);
  assert.match(acks[0].md, /已把这句补进/);
});

// ---- 兜底路由与引导 ----
test('MVP78 普通回复：唯一在场求助卡兜底路由；无候选时回引导', async () => {
  resetDb();
  const m = mkMatter({ title: '唯一求助事项' });
  raiseMatterNeedHelpProposal(m, { needFromUser: { kind: 'need_credential', ask: '给一下日志ID' } });
  const { acks, deps } = mkReplyDeps();
  const mode = await loop.handleUserReply(userMsg({ content: '日志ID 20260703xyz' }), deps);
  assert.equal(mode, 'fallback_backfill');
  assert.equal(db.listUserBackfillUnitsForMatter(m.id, 5).length, 1);
  assert.match(acks[0].md, /唯一求助事项/);
  // 无候选 → 引导
  resetDb();
  const r2 = mkReplyDeps();
  const mode2 = await loop.handleUserReply(userMsg({ content: '随便说点什么' }), r2.deps);
  assert.equal(mode2, 'guidance');
  assert.match(r2.acks[0].md, /引用/);
});

// ---- tick：水位 / 去重 / 跳过 app 消息 ----
test('MVP78 tick：跳过 app 消息、id 环去重、水位推进', async () => {
  resetDb();
  db.setSetting('notify:botChatId', 'oc_test_chat');
  const seen: string[][] = [];
  const msgs: loop.BotChatMessage[] = [
    userMsg({ message_id: 'om_a', content: '第一条', create_time: '2026-07-03 16:00' }),
    { ...userMsg({ message_id: 'om_bot', create_time: '2026-07-03 16:01' }), sender: { id: 'cli_x', id_type: 'app_id', sender_type: 'app' } },
    userMsg({ message_id: 'om_b', content: '第二条', create_time: '2026-07-03 16:02' }),
  ];
  const { deps } = mkReplyDeps();
  const listFn = async (args: string[]) => {
    seen.push(args);
    return { ok: true, data: { messages: msgs } };
  };
  const p1 = await loop.tickBotReplyLoop({ ...deps, listFn });
  assert.equal(p1, 2, '两条用户消息被处理，app 消息跳过');
  // 第二轮同一批消息 → 环去重，0 处理
  const p2 = await loop.tickBotReplyLoop({ ...deps, listFn });
  assert.equal(p2, 0);
  // 水位已推进到最大 create_time
  const wm = db.getSetting('notify:botReplyWatermark')!;
  assert.ok(Date.parse(wm) >= Date.parse('2026-07-03T16:02:00'));
});

// ---- 大扫除：甄别解析（宽容 + 保守） ----
test('MVP78 大扫除甄别：候选查询 + LLM JSON 宽容解析 + 批次落库 + 清单 DM', async () => {
  resetDb();
  const sent = armSender();
  const mA = mkMatter({ title: '审批已通过（企业自建应用发布）', summary: '标题即完成态' });
  const mB = mkMatter({ title: '直播定档6月23日', summary: '时间点已过' });
  const mC = mkMatter({ title: '孔恩培交付 CLI POC', summary: '仍需跟进' });
  [mA, mB, mC].forEach((m) => backdate(m.id, 20));
  const rows = db.listStaleOpenMatters(14, 40);
  assert.equal(rows.length, 3, '三件都是候选');
  // 同 stale 天数时按 id 排序（顺序不定）——按行序动态生成判定，模拟 LLM 按编号作答
  const verdictByTitle = (title: string) =>
    title.includes('审批已通过')
      ? 'likely_done'
      : title.includes('直播定档')
        ? 'event_passed'
        : 'still_pending';
  const verdicts = rows.map((r, idx) => ({
    i: idx + 1,
    verdict: verdictByTitle(r.title),
    because: '按标题判定',
  }));
  const oneShot = async () => ({ text: `甄别结果如下：\n${JSON.stringify(verdicts)}` });
  const outcome = await sweeper.runBacklogSweep(new Date(), { oneShot });
  assert.equal(outcome, 'sent');
  const batch = sweeper.getPendingSweepBatch()!;
  assert.equal(batch.items.length, 2, 'still_pending 不进清单');
  assert.ok(batch.items.every((it) => it.matterId !== mC.id));
  // 清单 DM 已发（sweep_list 不占即时配额）
  const joined = sent.map((s) => s.args.join(' ')).join('\n');
  assert.match(joined, /积压大扫除/);
  assert.match(joined, /确认清理/);
  // 有未决批次时不叠加
  assert.equal(await sweeper.runBacklogSweep(new Date(), { oneShot }), 'pending_exists');
});

test('MVP78 甄别解析防御：坏 JSON→空；非法 verdict→still_pending 不清', () => {
  resetDb();
  const mA = mkMatter({ title: 'A' });
  backdate(mA.id, 20);
  // 直接测内部解析行为——通过 runBacklogSweep 的坏输出路径
  const cases = [
    { text: '完全不是 JSON', expect: 'nothing_cleanable' as const },
    { text: '[{"i":1,"verdict":"delete_it_all","because":"x"}]', expect: 'nothing_cleanable' as const },
    { text: '[{"i":99,"verdict":"likely_done","because":"越界"}]', expect: 'nothing_cleanable' as const },
  ];
  return (async () => {
    for (const c of cases) {
      db.setSetting('sweep:pendingBatch', '');
      const r = await sweeper.runBacklogSweep(new Date(), { oneShot: async () => ({ text: c.text }) });
      assert.equal(r, c.expect, `text=${c.text.slice(0, 30)}`);
    }
  })();
});

// ---- 大扫除：应用/保留/忽略/恢复 ----
test('MVP78 确认清理：verdict 映射（resolved/dropped）、保留序号、状态漂移跳过、恢复找回', async () => {
  resetDb();
  armSender();
  const m1 = mkMatter({ title: '已完成的事' });
  const m2 = mkMatter({ title: '已过时间点的事' });
  const m3 = mkMatter({ title: '不再相关的事' });
  const batch = {
    id: 'b1',
    createdAt: new Date().toISOString(),
    scanned: 3,
    items: [
      { matterId: m1.id, title: m1.title, verdict: 'likely_done' as const, because: '标题写明已完成' },
      { matterId: m2.id, title: m2.title, verdict: 'event_passed' as const, because: '时间已过' },
      { matterId: m3.id, title: m3.title, verdict: 'obsolete' as const, because: '已被取代' },
    ],
  };
  db.setSetting('sweep:pendingBatch', JSON.stringify(batch));
  // 保留 2 → m2 不动；m1 办结、m3 归档
  const r = sweeper.applyPendingSweepBatch([2]);
  assert.equal(r.ok, true);
  assert.equal(ms.getMatterById(m1.id)!.status, 'resolved');
  assert.equal(ms.getMatterById(m2.id)!.status, 'open');
  assert.equal(ms.getMatterById(m3.id)!.status, 'dropped');
  assert.match(r.message, /办结 1、归档 1/);
  // 批次已清空：再次确认 → 无清单
  assert.equal(sweeper.applyPendingSweepBatch().ok, false);
  // 恢复：按关键词找回归档的 m3
  const restore = sweeper.restoreSweptMatter('不再相关');
  assert.equal(restore.ok, true, restore.message);
  assert.ok(['open', 'in_progress'].includes(ms.getMatterById(m3.id)!.status), '恢复后回到跟进态');
  // 审计链完整
  const audits = db.db
    .prepare(`SELECT action, COUNT(*) c FROM audit_logs WHERE action LIKE 'backlog%' GROUP BY action`)
    .all() as Array<{ action: string; c: number }>;
  const byAction = Object.fromEntries(audits.map((a) => [a.action, a.c]));
  assert.equal(byAction['backlog_swept'], 2);
  assert.equal(byAction['backlog_sweep_restored'], 1);
});

test('MVP78 批次 TTL：超 3 天的清单作废不可应用', () => {
  resetDb();
  const m1 = mkMatter({ title: '旧批次里的事' });
  db.setSetting(
    'sweep:pendingBatch',
    JSON.stringify({
      id: 'old',
      createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      scanned: 1,
      items: [{ matterId: m1.id, title: m1.title, verdict: 'likely_done', because: 'x' }],
    })
  );
  const r = sweeper.applyPendingSweepBatch();
  assert.equal(r.ok, false);
  assert.equal(ms.getMatterById(m1.id)!.status, 'open', '过期批次绝不动事项');
});

// ---- 命令走 handleUserReply 全链路 ----
test('MVP78 命令回复：「确认清理」「忽略」「恢复」经 handleUserReply 正确分发', async () => {
  resetDb();
  const m1 = mkMatter({ title: '命令清理目标' });
  db.setSetting(
    'sweep:pendingBatch',
    JSON.stringify({
      id: 'b2',
      createdAt: new Date().toISOString(),
      scanned: 1,
      items: [{ matterId: m1.id, title: m1.title, verdict: 'likely_done', because: 'ok' }],
    })
  );
  const { acks, deps } = mkReplyDeps();
  assert.equal(await loop.handleUserReply(userMsg({ content: '确认清理' }), deps), 'command:apply');
  assert.equal(ms.getMatterById(m1.id)!.status, 'resolved');
  assert.match(acks[0].md, /已清理 1 件/);
  assert.equal(await loop.handleUserReply(userMsg({ content: '恢复 命令清理目标' }), deps), 'command:restore');
  assert.ok(['open', 'in_progress'].includes(ms.getMatterById(m1.id)!.status), '恢复后回到跟进态');
  assert.equal(await loop.handleUserReply(userMsg({ content: '忽略' }), deps), 'command:ignore');
});

// ---- chat_id 持久化（回复闭环的进水口） ----
test('MVP78 sendBotDm 成功后持久化 botChatId', async () => {
  resetDb();
  armSender();
  assert.equal(await notify.sendBotDm('hi', { kind: 'reco', idempotencyKey: `k-${randomUUID()}` }), true);
  assert.equal(db.getSetting('notify:botChatId'), 'oc_test_chat');
});
