/**
 * MVP71 支柱C 集成 — owned_by_other 经 writeback 全路径升「需要你帮忙」卡（确定性、零 LLM）：
 * LLM 没给 needFromUser，但 matter 是「我委派给具名他人、AI 查不到进展」→ deriveNeedFromUser 兜底
 * → config 门放行 owned_by_other → raiseMatterNeedHelpProposal。验证「修 100% 依赖 LLM 自觉」的根因。
 *
 * Run: npx tsx --test apps/server/test/mvp71-ownedbyother-integration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp71obo-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const ms = await import('../src/matter/matterStore.js');
const clf = await import('../src/investigation/needHelpClassifier.js');
const { applyInvestigationResult } = await import('../src/investigation/investigationWriteback.js');
const { MATTER_NEEDHELP_PROPOSAL_PREFIX, MATTER_PROGRESS_PROPOSAL_PREFIX } = await import('../src/matter/matterResolveProposal.js');

const SELF = 'self-' + randomUUID();
function mkPerson(id: string, name: string, attrs?: Record<string, unknown>) {
  const now = new Date().toISOString();
  db.insertContextEntity({ id, type: 'person', name, aliases_json: '[]', source: 'test', confidence: 0.9, created_at: now, updated_at: now, attributes_json: attrs ? JSON.stringify(attrs) : null } as any);
}
function reset() {
  db.db.exec(`DELETE FROM attention_items; DELETE FROM matters; DELETE FROM context_units; DELETE FROM matter_context_links; DELETE FROM audit_logs; DELETE FROM matter_entities; DELETE FROM context_entities;`);
  mkPerson(SELF, '用户X', { larkLocalizedName: '刘昕明', larkOpenId: 'ou_self' });
  db.setSetting('self_person_entity_id', SELF);
  clf.invalidateSelfEntityCache();
}
function liveNeedHelp(matterId: string) {
  return db.db.prepare(`SELECT status, title, why FROM attention_items WHERE input_hash=? AND status='live'`).get(`${MATTER_NEEDHELP_PROPOSAL_PREFIX}${matterId}`) as { status: string; title: string; why: string } | undefined;
}
function liveProgress(matterId: string) {
  return db.db.prepare(`SELECT 1 FROM attention_items WHERE input_hash=? AND status='live'`).get(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${matterId}`);
}

const unkNoNeed = { verdict: 'unknown' as const, confidence: 0.6, factSummary: '未查到黄炜深就此修复的进展', evidence: [] };

test('MVP71 支柱C：我委派给具名他人(黄炜深) + 我是 requester + LLM 没给 needFromUser → 兜底升 owned_by_other 求助卡', () => {
  reset();
  const other = 'e-' + randomUUID();
  mkPerson(other, '黄炜深');
  const m = ms.createMatter({
    scope: 'work', type: 'follow_up', title: '跟进公式计算修复排期',
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: 'u-' + randomUUID(),
    currentSummary: '', nextAction: '跟进黄炜深修复进展',
    entities: [{ entityId: other, role: 'executor' }, { entityId: SELF, role: 'requester' }],
  });
  const r = applyInvestigationResult({ matterId: m.id, conclusion: unkNoNeed });
  assert.equal(r.ok, true);
  const card = liveNeedHelp(m.id);
  assert.ok(card, '应升 owned_by_other needhelp 卡');
  assert.match(card!.title, /需要你/);
  assert.match(card!.why, /黄炜深/, 'ask 应点名具名他人');
  assert.equal(liveProgress(m.id), undefined, '不应同时落 progress 卡（needhelp 优先且顶替）');
});

test('MVP71 支柱C：我也是 executor（互斥）→ 不升 owned_by_other（归 dangling 领域）', () => {
  reset();
  const other = 'e-' + randomUUID();
  mkPerson(other, '黄炜深');
  const m = ms.createMatter({
    scope: 'work', type: 'follow_up', title: '跟进公式修复',
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: 'u-' + randomUUID(),
    currentSummary: '', nextAction: 'x',
    entities: [{ entityId: other, role: 'executor' }, { entityId: SELF, role: 'executor' }, { entityId: SELF, role: 'requester' }],
  });
  const r = applyInvestigationResult({ matterId: m.id, conclusion: unkNoNeed });
  assert.equal(liveNeedHelp(m.id), undefined, '我是 executor → 不升 owned_by_other');
});
