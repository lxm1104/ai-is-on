/**
 * MVP77「把结果送到你面前」—— 飞书 bot DM 推送通道。
 * 覆盖：armed 模式（未 arm 绝不发）、kind 过滤（只推结果/需要你，过程不推）、幂等、日配额、
 * 推送失败不破坏升卡路径、needhelp/dangling 显式 TTL 不被 24h 兜底扫蒸发、每日工作汇报组稿+幂等。
 *
 * Run: npx tsx --test apps/server/test/mvp77-notify.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp77-notify-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.NOTIFY_INSTANT_DAILY_MAX = '3';

const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { userResolveMatter } = await import('../src/matter/matterActions.js');
const notify = await import('../src/lark/larkNotifyService.js');
const {
  raiseMatterNeedHelpProposal,
  raiseMatterProgressProposal,
  raiseMatterDanglingCommitmentProposal,
  raiseMatterArtifactProposal,
  raiseMatterAutoResolvedReceipt,
  MATTER_NEEDHELP_PROPOSAL_PREFIX,
  MATTER_DANGLING_PROPOSAL_PREFIX,
  MATTER_ARTIFACT_PROPOSAL_PREFIX,
} = await import('../src/matter/matterResolveProposal.js');
const db = await import('../src/db.js');

const SELF = 'self-' + randomUUID();
function resetDb() {
  db.db.exec(
    `DELETE FROM attention_items; DELETE FROM matters; DELETE FROM context_units;
     DELETE FROM matter_context_links; DELETE FROM audit_logs; DELETE FROM matter_entities;
     DELETE FROM matter_transitions; DELETE FROM settings;`
  );
  db.setSetting('self_person_entity_id', SELF);
}

let n = 0;
function mkMatter(opts: { title?: string } = {}) {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment', title: `事项${n}`, content: `内容 ${n}`,
    scope: 'work', origin: { kind: 'manual', refId: `u-${n}` }, silent: true,
  }).unit;
  return ms.createMatter({
    scope: 'work', type: 'follow_up', title: opts.title ?? `测试事项${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id, ownerEntityId: SELF,
    currentSummary: '', nextAction: '跟进',
  });
}

const NEED = { kind: 'need_credential' as const, ask: '请贴一下 traceID' };
const ARTIFACT = {
  kind: 'code_fix' as const, title: '修复空参数漏判', rootCause: 'parseArgs 未判空',
  targetRef: 'src/a.ts:42', body: '加空判', verifyCmd: 'rg parseArgs',
};

type Sent = { args: string[] };
function arm(opts: { fail?: boolean } = {}) {
  const sent: Sent[] = [];
  notify.__setNotifySenderForTest(async (args: string[]) => {
    if (opts.fail) throw new Error('lark-cli 挂了');
    sent.push({ args });
    return { ok: true, data: { message_id: `om_${sent.length}` } };
  });
  return sent;
}
const flush = () => new Promise((r) => setTimeout(r, 30));

function countAudit(action: string): number {
  return (db.db.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action=?`).get(action) as { c: number }).c;
}

// ---- armed 模式：未 arm 一切 no-op（现有测试/脚本 import 升卡函数的默认安全态）----
test('MVP77 未 arm：升卡不触发任何推送、不写 notify audit', async () => {
  resetDb();
  notify.__disarmNotifyServiceForTest();
  const m = mkMatter();
  assert.equal(raiseMatterNeedHelpProposal(m, { needFromUser: NEED }), true, '升卡本身正常');
  await flush();
  assert.equal(countAudit('notify_pushed'), 0);
  assert.equal(countAudit('notify_failed'), 0);
});

// ---- kind 过滤：needhelp/artifact/autoresolved 推；progress/dangling 不推 ----
test('MVP77 kind 过滤：只推「结果/需要你」，过程类绝不推', async () => {
  resetDb();
  const sent = arm();
  const m1 = mkMatter();
  assert.equal(raiseMatterNeedHelpProposal(m1, { needFromUser: NEED }), true);
  const m2 = mkMatter();
  assert.equal(
    raiseMatterProgressProposal(m2, { verdict: 'progressed', factSummary: '有进展', evidence: ['ev'], confidence: 0.7 }),
    true
  );
  const m3 = mkMatter();
  assert.equal(raiseMatterDanglingCommitmentProposal(m3, { ageDays: 5 }), true);
  const m4 = mkMatter();
  assert.equal(raiseMatterArtifactProposal(m4, { artifact: ARTIFACT, evidence: ['ev'] }), true);
  const m5 = mkMatter();
  const resolved5 = userResolveMatter(m5.id, '测试办结', new Date().toISOString())!;
  assert.equal(raiseMatterAutoResolvedReceipt(resolved5, { factSummary: '已完成', evidence: ['ev'], confidence: 0.9 }), true);
  await flush();
  // needhelp + artifact + autoresolved = 3 条（quota 恰好 3）；progress/dangling 0 条
  assert.equal(sent.length, 3, `实际推送：${sent.map((s) => s.args.join(' ')).join(' | ')}`);
  assert.equal(countAudit('notify_pushed'), 3);
  const joined = sent.map((s) => s.args.join(' ')).join('\n');
  assert.match(joined, /需要你补一手/);
  assert.match(joined, /修复方案/);
  assert.match(joined, /已替你办结/);
  // 全部走 bot 身份发给本人
  for (const s of sent) {
    assert.equal(s.args[0], 'im');
    assert.ok(s.args.includes('--as') && s.args.includes('bot'));
    assert.ok(s.args.includes('--idempotency-key'));
  }
});

// ---- 幂等 + 日配额 ----
test('MVP77 sendBotDm：同幂等键只发一次；即时推送受日配额限制而日报豁免', async () => {
  resetDb();
  const sent = arm();
  const now = new Date();
  assert.equal(await notify.sendBotDm('m1', { kind: 'reco', idempotencyKey: 'k1', now }), true);
  assert.equal(await notify.sendBotDm('m1-again', { kind: 'reco', idempotencyKey: 'k1', now }), false, '同键第二次不发');
  assert.equal(await notify.sendBotDm('m2', { kind: 'reco', idempotencyKey: 'k2', now }), true);
  assert.equal(await notify.sendBotDm('m3', { kind: 'reco', idempotencyKey: 'k3', now }), true);
  assert.equal(await notify.sendBotDm('m4', { kind: 'reco', idempotencyKey: 'k4', now }), false, '第 4 条被日配额(3)拦截');
  assert.equal(await notify.sendBotDm('日报', { kind: 'daily_report', idempotencyKey: 'kd', now }), true, '日报不占配额');
  assert.equal(sent.length, 4);
});

// ---- 推送失败绝不破坏升卡路径 ----
test('MVP77 通道故障：sender 抛错 → 升卡照常、notify_failed 留底', async () => {
  resetDb();
  arm({ fail: true });
  const m = mkMatter();
  assert.equal(raiseMatterNeedHelpProposal(m, { needFromUser: NEED }), true, '升卡不受影响');
  await flush();
  const card = db.db.prepare(`SELECT status FROM attention_items WHERE input_hash=?`)
    .get(`${MATTER_NEEDHELP_PROPOSAL_PREFIX}${m.id}`) as { status: string } | undefined;
  assert.equal(card?.status, 'live');
  assert.equal(countAudit('notify_failed'), 1);
  assert.equal(countAudit('notify_pushed'), 0);
});

// ---- TTL：needhelp/dangling 有显式 expires_at 且豁免 24h 兜底扫 ----
test('MVP77 TTL：needhelp 7天/dangling 3天，24h 兜底扫不再蒸发它们', async () => {
  resetDb();
  notify.__disarmNotifyServiceForTest();
  const m1 = mkMatter();
  const m2 = mkMatter();
  const m3 = mkMatter();
  assert.equal(raiseMatterNeedHelpProposal(m1, { needFromUser: NEED }), true);
  assert.equal(raiseMatterDanglingCommitmentProposal(m2, { ageDays: 4 }), true);
  assert.equal(
    raiseMatterProgressProposal(m3, { verdict: 'progressed', factSummary: '有进展', evidence: ['ev'], confidence: 0.7 }),
    true
  );
  const get = (hash: string) =>
    db.db.prepare(`SELECT status, expires_at FROM attention_items WHERE input_hash=?`).get(hash) as
      | { status: string; expires_at: string | null }
      | undefined;
  const nh = get(`${MATTER_NEEDHELP_PROPOSAL_PREFIX}${m1.id}`)!;
  const dg = get(`${MATTER_DANGLING_PROPOSAL_PREFIX}${m2.id}`)!;
  assert.ok(nh.expires_at && new Date(nh.expires_at).getTime() > Date.now() + 6.5 * 86_400_000, 'needhelp ≈7天 TTL');
  assert.ok(dg.expires_at && new Date(dg.expires_at).getTime() > Date.now() + 2.5 * 86_400_000, 'dangling ≈3天 TTL');
  // 模拟 24h 兜底扫（cutoff 在未来 = 所有卡都"超过 24h"）：progress 被扫掉，needhelp/dangling 因豁免+自带 TTL 存活
  const future = new Date(Date.now() + 3_600_000).toISOString();
  db.markAttentionItemsExpired(future, new Date().toISOString());
  assert.equal(get(`${MATTER_NEEDHELP_PROPOSAL_PREFIX}${m1.id}`)!.status, 'live');
  assert.equal(get(`${MATTER_DANGLING_PROPOSAL_PREFIX}${m2.id}`)!.status, 'live');
  assert.equal(
    (db.db.prepare(`SELECT status FROM attention_items WHERE input_hash LIKE 'proposal:matter-progress:%'`).get() as { status: string }).status,
    'expired',
    'progress 卡仍走 24h 兜底'
  );
  // 自带 TTL 到点也会被扫（第二个子句）
  db.db.prepare(`UPDATE attention_items SET expires_at=? WHERE input_hash=?`)
    .run(new Date(Date.now() - 1000).toISOString(), `${MATTER_NEEDHELP_PROPOSAL_PREFIX}${m1.id}`);
  db.markAttentionItemsExpired(new Date(0).toISOString(), new Date().toISOString());
  assert.equal(get(`${MATTER_NEEDHELP_PROPOSAL_PREFIX}${m1.id}`)!.status, 'expired', 'TTL 到点正常过期');
});

// ---- 每日工作汇报：组稿 + 幂等 + 空日不发 ----
test('MVP77 日报：三段组稿（办结/成品/需要你），用户手动办结不计，空日不发，每天至多一条', async () => {
  resetDb();
  const sent = arm();
  // 素材①：AI 办结 1 件 + 用户手动 1 件（应被排除）
  const mA = mkMatter({ title: '日程工具返回值冗长' });
  const mB = mkMatter({ title: '用户手动办的事' });
  const ins = db.db.prepare(
    `INSERT INTO matter_transitions (id, matter_id, from_status, to_status, trigger_context_unit_id, effect, reason, confidence, created_at)
     VALUES (?, ?, 'open', 'resolved', 'cu-x', 'resolve', ?, 0.9, ?)`
  );
  const nowIso = new Date().toISOString();
  ins.run(randomUUID(), mA.id, 'AI 自主排查高置信办结：commit 8f44 已修复', nowIso);
  ins.run(randomUUID(), mB.id, '用户标记已处理', nowIso);
  // 素材②：成品（artifact）
  const mC = mkMatter({ title: '公式 agent badcase' });
  assert.equal(raiseMatterArtifactProposal(mC, { artifact: ARTIFACT, evidence: ['ev'] }), true);
  // 素材③：需要你（needhelp live）
  const mD = mkMatter({ title: '提醒触发器 bug' });
  assert.equal(raiseMatterNeedHelpProposal(mD, { needFromUser: NEED }), true);
  await flush();
  const instantCount = sent.length; // artifact+needhelp 的即时推送，与日报无关
  const md = notify.composeDailyWorkReport()!;
  assert.ok(md, '有素材必有日报');
  assert.match(md, /已替你办结 1 件/);
  assert.match(md, /日程工具返回值冗长/);
  assert.ok(!md.includes('用户手动办的事'), '用户手动办结不算 AI 功劳');
  assert.match(md, /产出方案\/建议 1 件/);
  assert.match(md, /需要你 1 件/);
  assert.match(md, /请贴一下 traceID/);
  // 发送 + 当天幂等
  const day = new Date();
  assert.equal(await notify.sendDailyWorkReportNow(day), 'sent');
  assert.equal(await notify.sendDailyWorkReportNow(day), 'already_sent');
  assert.equal(sent.length, instantCount + 1, '日报恰好一条');
  // 空日：清库换一天 → empty 且不发
  resetDb();
  const otherDay = new Date(Date.now() + 5 * 86_400_000);
  assert.equal(await notify.sendDailyWorkReportNow(otherDay), 'empty');
  assert.equal(sent.length, instantCount + 1);
});

// ---- MVP81：消息带「直达原始位置」深链（用户原话：能用链接定位就直接把链接发给我）----
const ORIGIN_LINK = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_link_test&position=42';
function mkMatterWithOriginUrl(url: string, opts: { title?: string } = {}) {
  n += 1;
  const nowIso = new Date().toISOString();
  const evId = `ev-${randomUUID()}`;
  db.tryInsertEvent({
    id: evId, source: 'im_message', source_id: `sid-${evId}`, kind: 'im_message',
    occurred_at: nowIso, title: null, text: `原话 ${n}`, actor: null,
    url, raw_json: '{}', content_hash: `h-${evId}`, processed_at: null, created_at: nowIso,
  });
  const unit = cs.upsertContextUnit({
    kind: 'commitment', title: `事项${n}`, content: `内容 ${n}`,
    scope: 'work', origin: { kind: 'event', refId: evId }, silent: true,
  }).unit;
  return ms.createMatter({
    scope: 'work', type: 'follow_up', title: opts.title ?? `测试事项${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id, ownerEntityId: SELF,
    currentSummary: '', nextAction: '跟进',
  });
}

test('MVP81 直达深链：有源头 events.url → 即时推送与日报逐条带可点链接；无 url 不硬塞', async () => {
  resetDb();
  const sent = arm();
  assert.equal(db.getMatterOriginUrl(randomUUID()), null, '不存在的 matter 返回 null');
  const m1 = mkMatterWithOriginUrl(ORIGIN_LINK, { title: '带深链的事项' });
  assert.equal(db.getMatterOriginUrl(m1.id), ORIGIN_LINK);
  assert.equal(raiseMatterNeedHelpProposal(m1, { needFromUser: NEED }), true);
  const m2 = mkMatter(); // manual 源头，无 events.url
  assert.equal(raiseMatterArtifactProposal(m2, { artifact: ARTIFACT, evidence: ['ev'] }), true);
  await flush();
  assert.equal(sent.length, 2);
  const mdOf = (s: Sent) => s.args[s.args.indexOf('--markdown') + 1];
  assert.ok(mdOf(sent[0]).includes(`📍 [直达原始位置](${ORIGIN_LINK})`), mdOf(sent[0]));
  assert.ok(!mdOf(sent[1]).includes('直达原始位置'), '无源头链接不出现空链接行');
  // 日报「需要你」段逐条带 [直达]
  const report = notify.composeDailyWorkReport()!;
  assert.ok(report.includes(`[直达](${ORIGIN_LINK})`), report);
});

test('MVP81 深链卫生：非 http(s) 或含 ) 的脏 url 一律不产出（防 markdown 链接被搞坏）', () => {
  resetDb();
  const dirty1 = mkMatterWithOriginUrl('lark://client/chat/open?x=1');
  assert.equal(db.getMatterOriginUrl(dirty1.id), null);
  const dirty2 = mkMatterWithOriginUrl('https://applink.feishu.cn/a)b');
  assert.equal(db.getMatterOriginUrl(dirty2.id), null);
});
