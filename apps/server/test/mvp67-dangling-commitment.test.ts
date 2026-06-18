/**
 * MVP67 — 你自己欠的承诺被查得 unknown(查无跟进) → 升「待你处理」提醒（高精度低噪），而非静默丢弃。
 *
 * Run: npx tsx --test apps/server/test/mvp67-dangling-commitment.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp67-dangling-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { applyInvestigationResult } = await import('../src/investigation/investigationWriteback.js');
const { raiseMatterProgressProposal, MATTER_DANGLING_PROPOSAL_PREFIX } = await import('../src/matter/matterResolveProposal.js');
const db = await import('../src/db.js');

const DAY = 86_400_000;
const SELF = 'self-' + randomUUID();

function setSelf() { db.setSetting('self_person_entity_id', SELF); }

function danglingCard(matterId: string): { title: string; status: string } | undefined {
  return db.db.prepare(`SELECT title, status FROM attention_items WHERE input_hash = ?`)
    .get(`${MATTER_DANGLING_PROPOSAL_PREFIX}${matterId}`) as { title: string; status: string } | undefined;
}

let n = 0;
function mkMatter(opts: { owner?: string | null; ageDays?: number; dueAt?: string }) {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment', title: `承诺${n}`, content: `对高虎伟承诺调长授权超时 ${n}`,
    scope: 'work', origin: { kind: 'manual', refId: `u-${n}` }, silent: true,
  }).unit;
  const createdAt = new Date(Date.now() - (opts.ageDays ?? 5) * DAY).toISOString();
  return ms.createMatter({
    scope: 'work', type: 'follow_up', title: `排查授权超时（对高虎伟承诺）${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id,
    ownerEntityId: opts.owner === undefined ? SELF : opts.owner,
    dueAt: opts.dueAt ?? null,
    currentSummary: '', nextAction: '跟进进展并确认结果', now: createdAt,
  });
}

const unknownConcl = { verdict: 'unknown' as const, confidence: 0.6, factSummary: '未查到该承诺的任何后续进展', evidence: [] };

test('MVP67：owner=自己 + 够旧 + 真实 unknown → 升「待你处理」提醒', () => {
  setSelf();
  const m = mkMatter({ owner: SELF, ageDays: 5 });
  const r = applyInvestigationResult({ matterId: m.id, conclusion: unknownConcl });
  assert.equal(r.ok, true);
  assert.equal(r.proposalRaised, true, '应升提醒');
  const card = danglingCard(m.id);
  assert.ok(card, '应有 dangling 卡');
  assert.match(card!.title, /待你处理/);
  assert.equal(card!.status, 'live');
});

test('MVP67：owner≠自己（别人名下）→ 不升（不归你催）', () => {
  setSelf();
  const m = mkMatter({ owner: 'other-' + randomUUID(), ageDays: 5 });
  const r = applyInvestigationResult({ matterId: m.id, conclusion: unknownConcl });
  assert.equal(r.proposalRaised, false);
  assert.equal(danglingCard(m.id), undefined);
});

test('MVP67：owner 空 → 不升（归属不明，保守不噪）', () => {
  setSelf();
  const m = mkMatter({ owner: null, ageDays: 5 });
  const r = applyInvestigationResult({ matterId: m.id, conclusion: unknownConcl });
  assert.equal(r.proposalRaised, false);
  assert.equal(danglingCard(m.id), undefined);
});

test('MVP67：太新（1 天）且未过期 → 不升（别刚承诺就催）', () => {
  setSelf();
  const m = mkMatter({ owner: SELF, ageDays: 1 });
  const r = applyInvestigationResult({ matterId: m.id, conclusion: unknownConcl });
  assert.equal(r.proposalRaised, false);
  assert.equal(danglingCard(m.id), undefined);
});

test('MVP67：太新但已过期 → 升（overdue 优先于 age 阈值）', () => {
  setSelf();
  const m = mkMatter({ owner: SELF, ageDays: 1, dueAt: new Date(Date.now() - DAY).toISOString() });
  const r = applyInvestigationResult({ matterId: m.id, conclusion: unknownConcl });
  assert.equal(r.proposalRaised, true);
  assert.ok(danglingCard(m.id));
});

test('MVP67：conf=0 退化哨兵 → 不升（不是真查过）', () => {
  setSelf();
  const m = mkMatter({ owner: SELF, ageDays: 5 });
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'unknown', confidence: 0, factSummary: '排查器空转', evidence: [] } });
  assert.equal(r.proposalRaised, false);
  assert.equal(danglingCard(m.id), undefined);
});

test('MVP67：已有在场进展提案 → 不叠 dangling（更高信号优先）', () => {
  setSelf();
  const m = mkMatter({ owner: SELF, ageDays: 5 });
  raiseMatterProgressProposal(ms.getMatterById(m.id)!, { verdict: 'progressed', factSummary: '有进展', evidence: [], confidence: 0.7 });
  const r = applyInvestigationResult({ matterId: m.id, conclusion: unknownConcl });
  assert.equal(r.proposalRaised, false, '进展卡在场，dangling 不叠');
  assert.equal(danglingCard(m.id), undefined);
});
