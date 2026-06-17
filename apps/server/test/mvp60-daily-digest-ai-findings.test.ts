/**
 * MVP60 — 日报带实证：dailyDigest 纳入「过去 24h AI 自主查清」结论。
 *
 * Run: npx tsx --test apps/server/test/mvp60-daily-digest-ai-findings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp60-digest-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const ms = await import('../src/matter/matterStore.js');
const { writeAudit } = await import('../src/boundary/auditLog.js');
const { dailyDigestHandler } = await import('../src/agents/dailyDigestAgent.js');
import type { TriggerRow } from '../src/db.js';

function resetDb() {
  db.db.exec(`
    DELETE FROM audit_logs;
    DELETE FROM matters;
    DELETE FROM action_proposals;
    DELETE FROM cards;
    DELETE FROM agent_runs;
    DELETE FROM settings WHERE key='last_digest_at';
  `);
}

function mkTrigger(): TriggerRow {
  return {
    id: `trig-${randomUUID()}`,
    trigger_type: 'daily_digest_due',
    context_unit_id: 'system',
    payload_json: '{}',
    status: 'pending',
    fire_at: new Date().toISOString(),
    fired_at: null,
    reasoning: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function run() {
  // dummy agent_run 供 action_proposals 外键
  db.db.prepare(
    `INSERT INTO agent_runs (id, agent_type, status, trigger_id, input_json, created_at)
     VALUES ('run60', 'daily_digest', 'running', 't', '{}', ?)`
  ).run(new Date().toISOString());
  return dailyDigestHandler({ trigger: mkTrigger(), unit: undefined as any, packet: {} as any, agentRunId: 'run60' });
}

function mkMatter(title: string) {
  return ms.createMatter({
    scope: 'work', type: 'follow_up', title, canonicalKey: 'k-' + randomUUID(),
    createdFromContextUnitId: 'u-' + randomUUID(), currentSummary: '', nextAction: null,
  });
}

test('MVP60：无低优卡、但有 AI 实证 → 不跳过，日报含「AI 当天自主查清」段', async () => {
  resetDb();
  const m = mkMatter('middleware 报错未返回 tool result');
  writeAudit({
    action: 'investigation_written_back',
    reason: `AI 排查结论回写 matter（progressed）：定位到 release-2026.6.3 引入的截断`,
    payload: { matterId: m.id, verdict: 'progressed', confidence: 0.8 },
  });

  const r = await run();
  assert.ok(!/skipped/.test(r.summary), '有 AI 实证就不该跳过');
  assert.equal(r.data?.aiFindingCount, 1);
  const proposal = db.db.prepare(`SELECT title, body FROM action_proposals WHERE id=?`).get(r.proposalIds[0]) as { title: string; body: string };
  assert.match(proposal.title, /AI 查清 1 件/, '标题反映实证条数');
  assert.match(proposal.body, /AI 当天自主查清/);
  assert.match(proposal.body, /有进展/, 'progressed → 有进展标签');
  assert.match(proposal.body, /release-2026\.6\.3/, '带上事实句');
});

test('MVP60：同一事项 自主办结 > 一般查清（去重取办结）', async () => {
  resetDb();
  const m = mkMatter('评测集是否已发送给鲁升纲');
  // 先写一条一般查清，再写一条自主办结（同一 matter）
  writeAudit({ action: 'investigation_written_back', reason: `回写（progressed）：查到已发初版`, payload: { matterId: m.id, verdict: 'progressed', confidence: 0.7 } });
  writeAudit({ action: 'matter_auto_resolved', reason: `AI 自主办结`, payload: { matterId: m.id, confidence: 0.9, factSummary: '6/16 已完整发送并确认收到' } });

  const r = await run();
  assert.equal(r.data?.aiFindingCount, 1, '同一事项去重为 1 条');
  const proposal = db.db.prepare(`SELECT body FROM action_proposals WHERE id=?`).get(r.proposalIds[0]) as { body: string };
  assert.match(proposal.body, /已自主办结/, '去重后保留「自主办结」而非「有进展」');
  assert.match(proposal.body, /6\/16 已完整发送/, '取 auto_resolved 的 factSummary');
});

test('MVP60：无低优卡且无 AI 实证 → 仍跳过', async () => {
  resetDb();
  const r = await run();
  assert.match(r.summary, /skipped/);
});
