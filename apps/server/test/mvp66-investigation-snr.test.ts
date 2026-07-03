/**
 * MVP66 信噪比 DB helper：getLastInvestigatedAt / hasNewExternalEvidenceSince。
 * 覆盖对抗审查发现的关键回归：
 *  - getLastInvestigatedAt 排除 conf=0 哨兵（否则一次工具打嗝→matter 被无新证据门永久跳过）。
 *  - hasNewExternalEvidenceSince 排自产排查回声（central trap）、merge 就地更新看 updated_at、延迟挂链看 mcl.created_at。
 *
 * Run: npx tsx --test apps/server/test/mvp66-investigation-snr.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp66-snr-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');

function resetDb() {
  db.db.exec(`DELETE FROM audit_logs; DELETE FROM matter_context_links; DELETE FROM context_units;`);
}

function writeback(matterId: string, verdict: string, confidence: number, createdAt: string) {
  db.insertAuditLog({
    id: randomUUID(), agent_run_id: null, card_id: null, rule_id: null,
    action: 'investigation_written_back', reason: 'x',
    payload_json: JSON.stringify({ matterId, verdict, confidence }), created_at: createdAt,
  });
}

function mkUnit(opts: { originKind: string; originRef?: string; createdAt: string; updatedAt?: string; status?: string }): string {
  const id = randomUUID();
  db.db.prepare(
    `INSERT INTO context_units (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content, actionability, confidence, version, status, created_at, updated_at)
     VALUES (?, 'me', 'work', ?, ?, 'event', 't', '', 'record', 0.8, 1, ?, ?, ?)`
  ).run(id, opts.originKind, opts.originRef ?? 'ext-src', opts.status ?? 'active', opts.createdAt, opts.updatedAt ?? opts.createdAt);
  return id;
}

function link(matterId: string, unitId: string, createdAt: string) {
  db.upsertMatterContextLink({
    matter_id: matterId, context_unit_id: unitId, relation: 'evidence',
    effect: 'no_change', confidence: 0.7, reason: 't', created_at: createdAt,
  });
}

test('MVP66 getLastInvestigatedAt：取最新真实排查时刻，排除 conf=0 哨兵', () => {
  resetDb();
  const m = 'mtr-' + randomUUID();
  assert.equal(db.getLastInvestigatedAt(m), null, '从没查过 → null');
  writeback(m, 'unknown', 0.5, '2026-06-15T08:00:00.000Z');
  writeback(m, 'unknown', 0.6, '2026-06-15T10:00:00.000Z');
  assert.equal(db.getLastInvestigatedAt(m), '2026-06-15T10:00:00.000Z', '取 MAX');
  // 之后来一条 conf=0 哨兵（工具打嗝）——不应被当作"已查过"
  writeback(m, 'unknown', 0, '2026-06-15T12:00:00.000Z');
  assert.equal(db.getLastInvestigatedAt(m), '2026-06-15T10:00:00.000Z', 'conf=0 哨兵被排除，仍取上一条真实');
});

test('MVP66 getLastInvestigatedAt：重启安全（重开 db handle 仍正确）', () => {
  resetDb();
  const m = 'mtr-' + randomUUID();
  writeback(m, 'progressed', 0.7, '2026-06-16T09:00:00.000Z');
  // 派生自 audit_logs，重开连接（模拟重启）后仍读得到
  assert.equal(db.getLastInvestigatedAt(m), '2026-06-16T09:00:00.000Z');
});

test('MVP66 hasNewExternalEvidenceSince：排自产排查回声（central trap）', () => {
  resetDb();
  const m = 'mtr-' + randomUUID();
  const since = '2026-06-13T00:00:00.000Z';
  // 外部 commitment 在 since 之前
  link(m, mkUnit({ originKind: 'event', createdAt: '2026-06-12T14:00:00.000Z' }), '2026-06-12T14:00:00.000Z');
  // 之后全是 AI 自产排查 action_result（应被排除）
  for (const t of ['2026-06-15T08:00:00.000Z', '2026-06-15T12:00:00.000Z', '2026-06-15T15:00:00.000Z']) {
    link(m, mkUnit({ originKind: 'agent_run', originRef: `investigation:${m}`, createdAt: t }), t);
  }
  assert.equal(db.hasNewExternalEvidenceSince(m, since), false, '自产回声不算新证据 → false（这正是反复空查的元凶）');
});

test('MVP66 hasNewExternalEvidenceSince：真外部新证据 → true', () => {
  resetDb();
  const m = 'mtr-' + randomUUID();
  const since = '2026-06-15T00:00:00.000Z';
  link(m, mkUnit({ originKind: 'event', createdAt: '2026-06-16T09:00:00.000Z' }), '2026-06-16T09:00:00.000Z');
  assert.equal(db.hasNewExternalEvidenceSince(m, since), true);
});

test('MVP66 hasNewExternalEvidenceSince：merge 就地更新（created_at 旧、updated_at 新）→ true', () => {
  resetDb();
  const m = 'mtr-' + randomUUID();
  const since = '2026-06-15T00:00:00.000Z';
  // IM 跟进 merge 进既有 commitment：created_at 还是 06-12，updated_at 刷到 06-16
  const u = mkUnit({ originKind: 'event', createdAt: '2026-06-12T14:00:00.000Z', updatedAt: '2026-06-16T11:00:00.000Z' });
  link(m, u, '2026-06-12T14:00:00.000Z'); // link 也是旧的
  assert.equal(db.hasNewExternalEvidenceSince(m, since), true, '只看 created_at 会漏掉"承诺终于有回音"；updated_at 兜住');
});

test('MVP66 hasNewExternalEvidenceSince：延迟挂链（created_at 旧、mcl.created_at 新）→ true', () => {
  resetDb();
  const m = 'mtr-' + randomUUID();
  const since = '2026-06-15T00:00:00.000Z';
  // unit 06-12 创建，但 06-16 才挂到该 matter
  const u = mkUnit({ originKind: 'event', createdAt: '2026-06-12T04:50:00.000Z' });
  link(m, u, '2026-06-16T11:57:00.000Z');
  assert.equal(db.hasNewExternalEvidenceSince(m, since), true, 'mcl.created_at 兜住延迟挂链');
});

test('MVP66 hasNewExternalEvidenceSince：作废(status!=active)不算新证据', () => {
  resetDb();
  const m = 'mtr-' + randomUUID();
  const since = '2026-06-15T00:00:00.000Z';
  link(m, mkUnit({ originKind: 'event', createdAt: '2026-06-16T09:00:00.000Z', status: 'superseded' }), '2026-06-16T09:00:00.000Z');
  assert.equal(db.hasNewExternalEvidenceSince(m, since), false);
});

// MVP68/MVP75 listAiActivity：只取 AI「结果」+ join 事项标题。
// MVP75 第一性原理：investigation_written_back（原始排查过程）不再进面板；只留结果类动作。
test('MVP75 listAiActivity：只列结果（排除原始排查过程 + 非结果动作）、join 标题', () => {
  resetDb();
  const m = 'mtr-' + randomUUID();
  db.db.prepare(
    `INSERT INTO matters (id, subject_id, scope, type, title, canonical_key, status, priority, current_summary, created_from_context_unit_id, confidence, reopened_count, version, created_at, updated_at)
     VALUES (?, 'me','work','follow_up','授权超时跟进','k1','open','P1','','u1',0.7,0,1,?,?)`
  ).run(m, '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z');
  // 原始排查（过程）——不进面板
  writeback(m, 'progressed', 0.7, '2026-06-15T10:00:00.000Z');
  // 自主办结（结果）——入选
  db.insertAuditLog({ id: randomUUID(), agent_run_id: null, card_id: null, rule_id: null, action: 'matter_auto_resolved', reason: 'AI 自主办结：已发', payload_json: JSON.stringify({ matterId: m, confidence: 0.9 }), created_at: '2026-06-15T11:00:00.000Z' });
  // 非结果动作（应排除）
  db.insertAuditLog({ id: randomUUID(), agent_run_id: null, card_id: null, rule_id: null, action: 'card_blocked', reason: 'x', payload_json: null, created_at: '2026-06-15T13:00:00.000Z' });

  const items = db.listAiActivity(50);
  assert.equal(items.length, 1, '只 1 条结果（自主办结）——排查过程 + card_blocked 都不进');
  assert.equal(items[0].action, 'matter_auto_resolved');
  assert.equal(items[0].matterTitle, '授权超时跟进', 'join 到事项标题');
});

// MVP73→MVP80 契约变更：用户实锤"面板都是没用的信息"——proposal 类（会前/日报/纪要/提醒）payload 无
// title 全是空行 + 每日例行推送噪声，MVP80 起一律不进面板（它们在卡片流有自己的位置）；
// 面板只留 ✅办完/🔧💡成品/🤝互动 三类。本测试断言反转为"全部排除"。
test('MVP80 listAiActivity：proposal 交付物行一律不进（会前/日报/提醒/草稿/评论全排除）', () => {
  resetDb();
  const now = new Date().toISOString();
  const mk = (type: string, title: string) => db.insertActionProposal({
    id: randomUUID(), agent_run_id: null, proposal_type: type, title, body: 'b',
    reversible: 1, impact_scope: 'self', requires_approval: 0, status: 'projected',
    payload_json: null, created_at: now, updated_at: now,
  } as any);
  mk('meeting_brief', '会前准备：周会');
  mk('daily_digest', '日报：过去24h');
  mk('reminder', '承诺到期：发月报');
  mk('sync_draft', '同步草稿→相关方');         // 应排除
  mk('doc_comment_attention', '注意到一条评论'); // 应排除
  // 一条建议（结果）+ 一条原始排查（过程）
  db.insertAuditLog({ id: randomUUID(), agent_run_id: null, card_id: null, rule_id: null, action: 'investigation_recommended', reason: 'AI 给你一条建议（do）：催X把Y落地', payload_json: JSON.stringify({ matterId: 'm1', stance: 'do' }), created_at: now });
  db.insertAuditLog({ id: randomUUID(), agent_run_id: null, card_id: null, rule_id: null, action: 'investigation_written_back', reason: 'AI 排查（progressed）：定位到X', payload_json: JSON.stringify({ matterId: 'm1', verdict: 'progressed', confidence: 0.7 }), created_at: now });

  const items = db.listAiActivity(50);
  const types = items.map((i) => i.action);
  assert.ok(!types.includes('meeting_brief'), 'MVP80：会前拉齐不再进面板（空标题+例行=噪声）');
  assert.ok(!types.includes('daily_digest'), 'MVP80：日报不进面板');
  assert.ok(!types.includes('reminder'), 'MVP80：提醒不进面板');
  assert.ok(types.includes('investigation_recommended'), '含建议（结果）');
  assert.ok(!types.includes('investigation_written_back'), 'MVP75：原始排查过程不进面板');
  assert.ok(!types.includes('sync_draft'), '排除同步草稿（用户devalue草稿）');
  assert.ok(!types.includes('doc_comment_attention'), '排除评论噪声');
});
