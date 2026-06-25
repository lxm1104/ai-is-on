/**
 * P1-4 级联护栏 —— AI 自动办结若会让多成员问题类全部办结（→ 静默把整类、含他人名下成员翻成已修复），
 * 降级为人确认提案（并披露），不自动办。单成员类/其余成员未办结 → 正常自动办。
 *
 * Run: npx tsx --test apps/server/test/mvp74-cascade-guard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp74-cascade-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.PROBLEM_CLASS_ENABLED = 'true';

const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const pc = await import('../src/problemClass/problemClassStore.js');
const { applyInvestigationResult } = await import('../src/investigation/investigationWriteback.js');
const { MATTER_RESOLVE_PROPOSAL_PREFIX } = await import('../src/matter/matterResolveProposal.js');
const db = await import('../src/db.js');

let n = 0;
function mkMatter(opts: { priority?: string } = {}) {
  n += 1;
  const unit = cs.upsertContextUnit({ kind: 'commitment', title: `c${n}`, content: `内容${n}`, scope: 'work', origin: { kind: 'manual', refId: `u-${n}` }, silent: true }).unit;
  const m = ms.createMatter({ scope: 'work', type: 'follow_up', title: `事项${n}`, canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id, ownerEntityId: null, currentSummary: '', nextAction: 'x' });
  if (opts.priority) db.db.prepare(`UPDATE matters SET priority=? WHERE id=?`).run(opts.priority, m.id);
  return m;
}
function addToClass(matterId: string, classId: string) {
  pc.upsertMember({ matterId, spaceId: null, symptomBucket: 'b', diagnosticText: 'd', evidence: [], confidence: 0.8 });
  pc.setMemberAssigned(matterId, classId);
}
const resolvedConcl = { verdict: 'resolved' as const, confidence: 0.95, factSummary: '内部动作已完成', evidence: ['已更新文档到位'] };
function resolveProposalCard(matterId: string) {
  return db.db.prepare(`SELECT why FROM attention_items WHERE input_hash=?`).get(`${MATTER_RESOLVE_PROPOSAL_PREFIX}${matterId}`) as { why: string } | undefined;
}
function autoResolvedAudit(matterId: string) {
  return db.db.prepare(`SELECT 1 FROM audit_logs WHERE action='matter_auto_resolved' AND json_extract(payload_json,'$.matterId')=?`).get(matterId);
}

test('护栏：classCompletionImpactOfResolving 判定', () => {
  const cls = pc.createDistilledClass({ spaceId: null, label: '某系统性问题', rootCause: 'x' });
  const m1 = mkMatter(); const m2 = mkMatter();
  addToClass(m1.id, cls.id); addToClass(m2.id, cls.id);
  assert.equal(pc.classCompletionImpactOfResolving(m1.id).willComplete, false, '兄弟未办结 → 不会翻整类');
  db.db.prepare(`UPDATE matters SET status='resolved' WHERE id=?`).run(m2.id);
  const impact = pc.classCompletionImpactOfResolving(m1.id);
  assert.equal(impact.willComplete, true, 'm1 是最后一个未办结成员 → 会翻整类');
  assert.equal(impact.classLabel, '某系统性问题');
  // 单成员类
  const cls2 = pc.createDistilledClass({ spaceId: null, label: '单成员', rootCause: 'y' });
  const m3 = mkMatter(); addToClass(m3.id, cls2.id);
  assert.equal(pc.classCompletionImpactOfResolving(m3.id).willComplete, false, '单成员类无跨成员风险');
  // 无类
  assert.equal(pc.classCompletionImpactOfResolving(mkMatter().id).willComplete, false);
});

test('护栏：resolved 高置信但会翻整类 → 不自动办，降级人确认提案 + 披露', () => {
  const cls = pc.createDistilledClass({ spaceId: null, label: 'AAA类', rootCause: 'x' });
  const m1 = mkMatter(); const m2 = mkMatter();
  addToClass(m1.id, cls.id); addToClass(m2.id, cls.id);
  db.db.prepare(`UPDATE matters SET status='resolved' WHERE id=?`).run(m2.id); // m1 成最后一个
  const r = applyInvestigationResult({ matterId: m1.id, conclusion: resolvedConcl });
  assert.equal(r.autoResolved, false, '会翻整类 → 不自动办');
  assert.equal(r.proposalRaised, true);
  const card = resolveProposalCard(m1.id);
  assert.ok(card, '降级为办结提案卡');
  assert.match(card!.why, /AAA类/, '披露问题类');
  assert.match(card!.why, /最后一个未办结/);
  assert.equal(autoResolvedAudit(m1.id), undefined, '无自动办结审计');
});

test('护栏：resolved 高置信、其余成员未办结（不会翻整类）→ 正常自动办', () => {
  const cls = pc.createDistilledClass({ spaceId: null, label: 'BBB类', rootCause: 'x' });
  const m1 = mkMatter(); const m2 = mkMatter();
  addToClass(m1.id, cls.id); addToClass(m2.id, cls.id); // m2 仍 open
  const r = applyInvestigationResult({ matterId: m1.id, conclusion: resolvedConcl });
  assert.equal(r.autoResolved, true, '不会翻整类 → 正常自动办');
  assert.ok(autoResolvedAudit(m1.id), '有自动办结审计');
});

test('护栏：不属任何问题类的 resolved 高置信 → 正常自动办（不受影响）', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: resolvedConcl });
  assert.equal(r.autoResolved, true);
});
