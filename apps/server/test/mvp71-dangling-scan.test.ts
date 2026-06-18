/**
 * MVP71 §11.1 — dangling 独立静态扫描（修真因）：被 MVP66 正确停查的存量自我承诺，
 * 不再依赖"又跑一次排查"才浮出。scanDanglingCommitments 确定性遍历 → 升「待你处理」卡。
 *
 * Run: npx tsx --test apps/server/test/mvp71-dangling-scan.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp71ds-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const ms = await import('../src/matter/matterStore.js');
const clf = await import('../src/investigation/needHelpClassifier.js');
const { scanDanglingCommitments } = await import('../src/investigation/investigationWriteback.js');
const { MATTER_DANGLING_PROPOSAL_PREFIX } = await import('../src/matter/matterResolveProposal.js');
const { writeAudit } = await import('../src/boundary/auditLog.js');

const DAY = 86_400_000;
const SELF = 'self-' + randomUUID();

function reset() {
  db.db.exec(`DELETE FROM attention_items; DELETE FROM matters; DELETE FROM context_units; DELETE FROM matter_context_links; DELETE FROM audit_logs; DELETE FROM matter_entities;`);
  db.setSetting('self_person_entity_id', SELF);
  clf.invalidateSelfEntityCache();
}

let n = 0;
function mkCommitment(opts: { ageDays?: number; title?: string }) {
  n += 1;
  return ms.createMatter({
    scope: 'work', type: 'follow_up', title: opts.title ?? `排查授权超时（对高虎伟承诺）${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: 'u-' + randomUUID(),
    ownerEntityId: null, // ★ owner 空（真实库 88% 如此）——靠标题信号识别
    currentSummary: '', nextAction: '跟进进展并确认结果',
    now: new Date(Date.now() - (opts.ageDays ?? 6) * DAY).toISOString(),
  });
}
function recordUnknownInvestigation(matterId: string, conf = 0.6) {
  writeAudit({ action: 'investigation_written_back', reason: 'x', payload: { matterId, verdict: 'unknown', confidence: conf } });
}
function danglingCard(matterId: string) {
  return db.db.prepare(`SELECT status FROM attention_items WHERE input_hash=?`).get(`${MATTER_DANGLING_PROPOSAL_PREFIX}${matterId}`) as { status: string } | undefined;
}

test('MVP71 扫描：停查存量自我承诺（标题信号 + 够旧 + 曾被查 unknown）→ 升 dangling', () => {
  reset();
  const m = mkCommitment({ ageDays: 6 });
  recordUnknownInvestigation(m.id); // AI 查过、unknown（之后被 MVP66 停查）
  const raised = scanDanglingCommitments();
  assert.equal(raised, 1, '应升 1 张');
  assert.equal(danglingCard(m.id)?.status, 'live');
});

test('MVP71 扫描：从没被排查过的承诺 → 不升（先别催，等排查）', () => {
  reset();
  const m = mkCommitment({ ageDays: 6 });
  // 不写任何 investigation 记录
  const raised = scanDanglingCommitments();
  assert.equal(raised, 0);
  assert.equal(danglingCard(m.id), undefined);
});

test('MVP71 扫描：非自我承诺（中性标题、无 self 信号）→ 不升', () => {
  reset();
  const m = ms.createMatter({
    scope: 'work', type: 'follow_up', title: '跟进黄炜深的修复进展',
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: 'u-' + randomUUID(),
    ownerEntityId: null, currentSummary: '', nextAction: 'x',
    now: new Date(Date.now() - 6 * DAY).toISOString(),
  });
  recordUnknownInvestigation(m.id);
  assert.equal(scanDanglingCommitments(), 0);
  assert.equal(danglingCard(m.id), undefined);
});

test('MVP71 扫描：幂等——已有 live dangling 再扫不重升', () => {
  reset();
  const m = mkCommitment({ ageDays: 6 });
  recordUnknownInvestigation(m.id);
  assert.equal(scanDanglingCommitments(), 1);
  assert.equal(scanDanglingCommitments(), 0, '第二次扫描幂等不重升');
});
