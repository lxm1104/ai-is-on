/**
 * MVP80「助理工作日志」—— listAiActivity 重做：用户实锤"面板都是没用的信息"。
 * 覆盖：同事项建议/产出去重取最新+重复计数、批量清理按批次聚合一行、征询/回复互动纳入、
 * 命令与征询模式的 notify_reply_handled 防双计、日报/提醒/空标题行彻底剔除、tally 加 sweptCount。
 *
 * Run: npx tsx --test apps/server/test/mvp80-activity-feed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp80-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { writeAudit } = await import('../src/boundary/auditLog.js');
type AuditAction = Parameters<typeof writeAudit>[0]['action'];

function resetDb() {
  db.db.exec(`DELETE FROM audit_logs; DELETE FROM matters; DELETE FROM action_proposals;`);
}
function mkMatterRow(title: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.db
    .prepare(
      `INSERT INTO matters (id, scope, type, title, canonical_key, status, priority, current_summary, created_from_context_unit_id, version, created_at, updated_at)
       VALUES (?, 'work', 'follow_up', ?, ?, 'open', 'P2', '', ?, 1, ?, ?)`
    )
    .run(id, title, `k-${id}`, `cu-${id}`, now, now);
  return id;
}
function audit(action: AuditAction, reason: string, payload: Record<string, unknown>, atIso?: string) {
  writeAudit({ action, reason, payload });
  if (atIso) {
    db.db
      .prepare(`UPDATE audit_logs SET created_at=? WHERE id=(SELECT id FROM audit_logs ORDER BY rowid DESC LIMIT 1)`)
      .run(atIso);
  }
}
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

test('MVP80 去重：同事项 3 条建议 → 1 行最新 + repeatCount=3；不同事项互不影响', () => {
  resetDb();
  const mA = mkMatterRow('Analysis Agent 读公式失败');
  const mB = mkMatterRow('另一个事项');
  audit('investigation_recommended', '建议1（旧）', { matterId: mA }, at(300));
  audit('investigation_recommended', '建议2（中）', { matterId: mA }, at(200));
  audit('investigation_recommended', '建议3（最新）', { matterId: mA }, at(100));
  audit('investigation_recommended', 'B 的建议', { matterId: mB }, at(150));
  const rows = db.listAiActivity(60);
  const aRows = rows.filter((r) => r.matterId === mA && r.action === 'investigation_recommended');
  assert.equal(aRows.length, 1, '同事项只留一行');
  assert.equal(aRows[0].reason, '建议3（最新）');
  assert.equal(aRows[0].repeatCount, 3);
  assert.equal(rows.filter((r) => r.matterId === mB).length, 1);
});

test('MVP80 批次聚合：同 batchId 的 backlog_swept 合成一行（含件数与标题）', () => {
  resetDb();
  const t1 = mkMatterRow('日志已上传');
  const t2 = mkMatterRow('审批已通过');
  const t3 = mkMatterRow('直播定档6月23日');
  for (const [i, mid] of [t1, t2, t3].entries()) {
    audit('backlog_swept', `批量清理：x`, { matterId: mid, verdict: 'likely_done', batchId: 'batch-1' }, at(60 + i));
  }
  audit('backlog_swept', `批量清理：y`, { matterId: mkMatterRow('另一批的事'), verdict: 'obsolete', batchId: 'batch-2' }, at(3000));
  const rows = db.listAiActivity(60);
  const batches = rows.filter((r) => r.action === 'backlog_swept_batch');
  assert.equal(batches.length, 2, '两个批次两行');
  const b1 = batches.find((b) => b.reason.includes('3 件'))!;
  assert.ok(b1, '批次1 合成一行且计数正确');
  assert.match(b1.reason, /日志已上传/);
  assert.equal(b1.repeatCount, 3);
});

test('MVP80 互动纳入与防双计：consult_choice/回填模式进；command:*/consult_choice 模式的 reply_handled 不进', () => {
  resetDb();
  const m = mkMatterRow('帮王爽排查');
  audit('consult_choice', '你对「帮王爽排查」的处理选择：investigate', { matterId: m, choice: 'investigate' }, at(50));
  audit('notify_reply_handled', '飞书回复已回填事项（引用路由）', { mode: 'quote_backfill', matterId: m }, at(40));
  audit('notify_reply_handled', '飞书命令「确认清理」已执行', { mode: 'command:apply' }, at(30));
  audit('notify_reply_handled', '飞书征询答复（裸编号）已处理', { mode: 'consult_choice', matterId: m }, at(20));
  const rows = db.listAiActivity(60);
  assert.equal(rows.filter((r) => r.action === 'consult_choice').length, 1);
  const handled = rows.filter((r) => r.action === 'notify_reply_handled');
  assert.equal(handled.length, 1, '只有回填类进；命令与征询模式防双计');
  assert.match(handled[0].reason, /引用路由/);
});

test('MVP80 噪声剔除：daily_digest/reminder/meeting 空标题 proposal 一律不再出现', () => {
  resetDb();
  const now = new Date().toISOString();
  const insP = db.db.prepare(
    `INSERT INTO action_proposals (id, proposal_type, title, body, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)`
  );
  insP.run(randomUUID(), 'daily_digest', '', now, now);
  insP.run(randomUUID(), 'reminder', '', now, now);
  insP.run(randomUUID(), 'meeting_action_items', '', now, now);
  const m = mkMatterRow('真结果');
  audit('matter_auto_resolved', 'AI 自主办结：真结果已完成', { matterId: m }, at(10));
  const rows = db.listAiActivity(60);
  assert.equal(rows.length, 1, '只剩真结果一行');
  assert.equal(rows[0].action, 'matter_auto_resolved');
});

test('MVP80 扩展结果观：征询/求助送达/待确认送达/清单待确认/恢复照办 都是结果行', () => {
  resetDb();
  const m = mkMatterRow('有人请我办的事');
  audit('consult_asked', '王爽请你处理，已发飞书征询', { matterId: m, requesters: ['王爽'] }, at(50));
  audit('notify_pushed', '已推送到你的飞书（needhelp）：🙋 需要你补一手', { kind: 'needhelp', refId: m, idempotencyKey: 'k1', messageId: 'om1' }, at(40));
  audit('notify_pushed', '已推送到你的飞书（resolve_proposal）：✋ 待你确认', { kind: 'resolve_proposal', refId: m, idempotencyKey: 'k2', messageId: 'om2' }, at(30));
  // 其它推送 kind 不合成行（reco 已有自己的结果行；daily_report 是例行）
  audit('notify_pushed', '已推送到你的飞书（reco）', { kind: 'reco', refId: m, idempotencyKey: 'k3', messageId: 'om3' }, at(25));
  audit('notify_pushed', '已推送到你的飞书（daily_report）', { kind: 'daily_report', idempotencyKey: 'k4', messageId: 'om4' }, at(24));
  audit('backlog_sweep_proposed', '大扫除甄别出 5/40 件，清单已发飞书待确认', { batchId: 'b9', scanned: 40, cleanable: 5 }, at(20));
  audit('backlog_sweep_restored', '恢复被批量清理的事项：X', { matterId: m }, at(10));
  const actions = db.listAiActivity(60).map((r) => r.action);
  assert.ok(actions.includes('consult_asked'), '征询=等你拍板也是结果');
  assert.ok(actions.includes('asked_for_help'), '求助送达=需要你帮忙也是结果');
  assert.ok(actions.includes('asked_confirm'), '待确认送达=让你确认也是结果');
  assert.ok(actions.includes('backlog_sweep_proposed'), '清单待确认也是结果');
  assert.ok(actions.includes('backlog_sweep_restored'), '恢复照办也是结果');
  assert.equal(actions.filter((a) => a === 'asked_for_help' || a === 'asked_confirm').length, 2, 'reco/daily_report 推送不合成行');
});

test('MVP80 学习照做归因：followedYourPlaybook/usedYourBackfill 透出到结果行', () => {
  resetDb();
  const m = mkMatterRow('按你教的方法查的事');
  audit('investigation_recommended', 'AI 给你一条建议（do）：X', { matterId: m, stance: 'do', followedYourPlaybook: true, usedYourBackfill: true }, at(10));
  const rows = db.listAiActivity(60);
  const row = rows.find((r) => r.matterId === m)!;
  assert.equal(row.followedYourPlaybook, 1, 'json_extract true→1');
  assert.equal(row.usedYourBackfill, 1);
});

test('MVP80 tally：sweptCount 统计近 7 天批量清理件数', () => {
  resetDb();
  const m1 = mkMatterRow('a');
  const m2 = mkMatterRow('b');
  audit('backlog_swept', '批量清理：a', { matterId: m1, batchId: 'bx' }, at(10));
  audit('backlog_swept', '批量清理：b', { matterId: m2, batchId: 'bx' }, at(9));
  const tally = db.getAiActivityTally();
  assert.equal(tally.sweptCount, 2);
});
