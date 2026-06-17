/**
 * MVP36 — 排查结论回写 matter（安全：补证据+更新摘要，绝不自动改 status）。
 *
 * Run: npx tsx --test apps/server/test/mvp36-investigation-writeback.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp36-wb-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { applyInvestigationResult } = await import('../src/investigation/investigationWriteback.js');
const { db, markAttentionSupersededForResolvedMatters } = await import('../src/db.js');
const { config } = await import('../src/config.js');

function autoResolvedCard(matterId: string) {
  return db.prepare(`SELECT title FROM attention_items WHERE input_hash = ?`).get(`proposal:matter-autoresolved:${matterId}`) as { title: string } | undefined;
}
function cardStatus(prefix: string, matterId: string) {
  return (db.prepare(`SELECT status FROM attention_items WHERE input_hash = ?`).get(`${prefix}${matterId}`) as { status: string } | undefined)?.status;
}

let n = 0;
function mkMatter(opts?: { status?: string; summary?: string }) {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment', title: `承诺${n}`, content: `给鲁升纲发评测集 ${n}`,
    scope: 'work', origin: { kind: 'manual', refId: `u-${n}` }, silent: true,
  }).unit;
  const m = ms.createMatter({
    scope: 'work', type: 'follow_up', title: `确认评测集发送${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id,
    currentSummary: opts?.summary ?? '答应给鲁升纲发评测集', nextAction: '确认评测集是否已发给鲁升纲',
  });
  if (opts?.status) ms.saveMatter({ ...ms.getMatterById(m.id)!, status: opts.status as never });
  return m;
}

test('T1 progressed：挂证据 + 更新摘要，status 不变', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: '6/13 在群里发了初版，未见对方确认', evidence: ['om_abc 鲁升纲: 收到'] },
    toolSummary: 'search_im_messages:命中3条',
  });
  assert.equal(r.ok, true);
  assert.ok(r.resultUnitId);
  const after = ms.getMatterById(m.id)!;
  assert.equal(after.status, 'open', 'status 必须不变');
  assert.ok(after.currentSummary.includes('AI 排查'), '摘要并入排查结论');
  assert.ok(ms.listMatterContextLinks(m.id).some((l) => l.contextUnitId === r.resultUnitId && l.effect === 'no_change'), '证据 effect=no_change');
});

test('T2 resolved 提案档(0.75≤c<0.85)：nextAction 提示待确认，status 不变（不自动办结）', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'resolved', confidence: 0.8, factSummary: '对方已确认收到评测集', evidence: ['om_xyz'] },
  });
  assert.equal(r.ok, true);
  const after = ms.getMatterById(m.id)!;
  assert.equal(after.status, 'open', 'resolved 也绝不自动改 status');
  assert.match(after.nextAction || '', /待确认|疑似已完成/);
});

test('T3 blocked：nextAction 反映受阻', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'blocked', confidence: 0.6, factSummary: '评测集文件权限未开，对方打不开', evidence: [] },
  });
  assert.equal(r.ok, true);
  assert.match(ms.getMatterById(m.id)!.nextAction || '', /受阻/);
});

test('T4 unknown：仍挂证据记录"查了但没结论"，不动 nextAction/status', () => {
  const m = mkMatter({ summary: '原始摘要不该被污染' });
  const before = ms.getMatterById(m.id)!;
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'unknown', confidence: 0.2, factSummary: '未查到评测集相关消息', evidence: [] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.summaryUpdated, false, 'unknown 不更新摘要');
  const after = ms.getMatterById(m.id)!;
  assert.equal(after.nextAction, before.nextAction, 'unknown 不动 nextAction');
  assert.equal(after.currentSummary, before.currentSummary, 'unknown 不污染摘要（不塞「未查到」）');
  assert.equal(after.lastEvidenceAt, before.lastEvidenceAt, 'unknown 不刷新证据时钟（保陈旧度真实）');
  assert.ok(!(after.currentSummary || '').includes('AI 排查'), '摘要不含 AI 排查噪音');
});

test('T5b 多次有意义排查：不堆叠「[AI 排查]…」前缀（替换而非累加）', () => {
  const m = mkMatter({ summary: '本来的摘要' });
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: '第一次发现', evidence: [] } });
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: '第二次发现', evidence: [] } });
  const s = ms.getMatterById(m.id)!.currentSummary;
  assert.equal((s.match(/［AI 排查］/g) || []).length, 1, '只保留最新一条 AI 排查前缀');
  assert.ok(s.includes('第二次发现') && !s.includes('第一次发现'), '替换为最新发现');
  assert.ok(s.includes('本来的摘要'), '原摘要保留');
});

test('T5 matter 不存在 → ok:false 不抛', () => {
  const r = applyInvestigationResult({ matterId: 'nope', conclusion: { verdict: 'unknown', confidence: 0, factSummary: '', evidence: [] } });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /not found/);
});

// MVP39：resolved 高置信 → 升「确认办结」提案卡（浮出给用户，不再埋摘要）
const dbmod = await import('../src/db.js');
const attn = await import('../src/attention/attentionStore.js');

function liveResolveProposal(matterId: string) {
  return dbmod.db
    .prepare(`SELECT 1 FROM attention_items WHERE status='live' AND input_hash = ? LIMIT 1`)
    .get(`proposal:matter-resolve:${matterId}`);
}

test('T6 resolved 高置信(≥0.75) → 升办结提案卡 + proposalRaised', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'resolved', confidence: 0.8, factSummary: '对方已确认收到并点赞', evidence: ['om_x'] },
  });
  assert.equal(r.proposalRaised, true);
  assert.ok(liveResolveProposal(m.id), '应有在场办结提案');
  assert.equal(ms.getMatterById(m.id)!.status, 'open', '仍不自动改 status（待用户确认）');
});

test('T7 resolved 低置信(<0.75) → 不升提案', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'resolved', confidence: 0.6, factSummary: '可能完成了', evidence: [] },
  });
  assert.equal(r.proposalRaised, false);
  assert.ok(!liveResolveProposal(m.id));
});

test('T8 progressed → 不升「办结」提案（改升进展回执，见 T10）', () => {
  const m = mkMatter();
  applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'progressed', confidence: 0.9, factSummary: '有进展', evidence: [] },
  });
  assert.ok(!liveResolveProposal(m.id), 'progressed 不升办结卡');
});

test('T9 幂等：已有在场提案 → 再次 resolved 不重复升', () => {
  const m = mkMatter();
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'resolved', confidence: 0.8, factSummary: 'a', evidence: [] } });
  const before = attn.listLiveAttentionItems(200).filter((x) => x.inputHash === `proposal:matter-resolve:${m.id}`).length;
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'resolved', confidence: 0.82, factSummary: 'b', evidence: [] } });
  const after = attn.listLiveAttentionItems(200).filter((x) => x.inputHash === `proposal:matter-resolve:${m.id}`).length;
  assert.equal(before, 1);
  assert.equal(after, 1, '不重复升提案');
});

// MVP40：进展回执卡（progressed/blocked → P2「AI 已查清进展」卡）
function liveProgressProposal(matterId: string) {
  return dbmod.db
    .prepare(`SELECT 1 FROM attention_items WHERE status='live' AND input_hash = ? LIMIT 1`)
    .get(`proposal:matter-progress:${matterId}`);
}

test('T10 progressed ≥0.6 → 升进展回执卡', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: '已读到完整 PRD', evidence: ['doc xxx'] } });
  assert.equal(r.proposalRaised, true);
  assert.ok(liveProgressProposal(m.id));
  assert.equal(ms.getMatterById(m.id)!.status, 'open', '不自动改 status');
});

test('T11 blocked ≥0.6 → 升进展回执卡', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'blocked', confidence: 0.7, factSummary: '确认零进展', evidence: [] } });
  assert.equal(r.proposalRaised, true);
  assert.ok(liveProgressProposal(m.id));
});

test('T12 progressed 低置信(<0.6) → 不升卡', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.5, factSummary: 'x', evidence: [] } });
  assert.equal(r.proposalRaised, false);
  assert.ok(!liveProgressProposal(m.id));
});

test('T13 已有在场办结提案 → 不叠升进展卡（止损）', () => {
  const m = mkMatter();
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'resolved', confidence: 0.8, factSummary: '已完成', evidence: [] } });
  assert.ok(liveResolveProposal(m.id));
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.8, factSummary: '又有进展', evidence: [] } });
  assert.equal(r.proposalRaised, false, '办结已在场，不叠进展卡');
  assert.ok(!liveProgressProposal(m.id));
});

test('T14 升办结时顶掉在场进展卡（办结优先）', () => {
  const m = mkMatter();
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: '进展', evidence: [] } });
  assert.ok(liveProgressProposal(m.id), '先有进展卡');
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'resolved', confidence: 0.8, factSummary: '完成', evidence: [] } });
  assert.ok(liveResolveProposal(m.id), '办结卡升起');
  assert.ok(!liveProgressProposal(m.id), '进展卡被顶掉');
});

test('T15 进展卡幂等：同 matter 不重复升', () => {
  const m = mkMatter();
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: 'a', evidence: [] } });
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'blocked', confidence: 0.7, factSummary: 'b', evidence: [] } });
  const n = attn.listLiveAttentionItems(300).filter((x) => x.inputHash === `proposal:matter-progress:${m.id}`).length;
  assert.equal(n, 1, '不重复升进展卡');
});

test('MVP55 自主办结：resolved 高置信(≥0.85) → matter 办结 + autoResolved + 透明回执卡(可重开)', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'resolved', confidence: 0.9, factSummary: '已确认对方收到评测集', evidence: ['6/13 群里发了并 @ 了对方'] },
  });
  assert.equal(r.autoResolved, true);
  assert.equal(ms.getMatterById(m.id)?.status, 'resolved'); // 真办结了
  const card = autoResolvedCard(m.id);
  assert.ok(card && card.title.startsWith('✅ AI 已主动办结')); // 透明回执卡在场
  // 独立审计：Rules & Audit 可按 matter_auto_resolved 复查"AI 主动办了哪些"
  const audited = db.prepare(`SELECT 1 FROM audit_logs WHERE action='matter_auto_resolved' AND reason LIKE ? LIMIT 1`).get('%已确认对方收到评测集%');
  assert.ok(audited, '应写入 matter_auto_resolved 审计');
});

test('MVP55 自主办结：中置信(0.75≤c<0.85) → 不自动办，仍走「确认办结」提案', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'resolved', confidence: 0.78, factSummary: '疑似已发', evidence: [] },
  });
  assert.notEqual(r.autoResolved, true);
  assert.notEqual(ms.getMatterById(m.id)?.status, 'resolved'); // 没自动办
  assert.equal(autoResolvedCard(m.id), undefined);
  const prop = db.prepare(`SELECT 1 FROM attention_items WHERE input_hash = ?`).get(`proposal:matter-resolve:${m.id}`);
  assert.ok(prop); // 升了确认办结提案
});

test('MVP55 自主办结：config 关 → 高置信也不自动办，退回提案', () => {
  const saved = config.investigationAutoResolveEnabled;
  config.investigationAutoResolveEnabled = false;
  try {
    const m = mkMatter();
    const r = applyInvestigationResult({
      matterId: m.id,
      conclusion: { verdict: 'resolved', confidence: 0.95, factSummary: '已确认', evidence: [] },
    });
    assert.notEqual(r.autoResolved, true);
    assert.notEqual(ms.getMatterById(m.id)?.status, 'resolved');
  } finally {
    config.investigationAutoResolveEnabled = saved;
  }
});

test('MVP55 护栏：无证据的 resolved → 不自动办（退回提案，杜绝裸口说已完成）', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'resolved', confidence: 0.95, factSummary: '据说完成了', evidence: [] } });
  assert.notEqual(r.autoResolved, true);
  assert.notEqual(ms.getMatterById(m.id)?.status, 'resolved');
  assert.equal(autoResolvedCard(m.id), undefined);
});

test('MVP55 护栏：P0 事项即便高置信 resolved 也不自动办（永远走人确认）', () => {
  const m = mkMatter();
  ms.saveMatter({ ...ms.getMatterById(m.id)!, priority: 'P0' as never });
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'resolved', confidence: 0.95, factSummary: '完成', evidence: ['om_e'] } });
  assert.notEqual(r.autoResolved, true);
  assert.notEqual(ms.getMatterById(m.id)?.status, 'resolved');
});

test('MVP55 透明性：resolved-sweep 不清掉「AI 已主动办结」回执卡（否则自主办结既不可见也无法撤销）', () => {
  const m = mkMatter();
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'resolved', confidence: 0.95, factSummary: '对方已确认完成', evidence: ['om_e'] } });
  assert.equal(cardStatus('proposal:matter-autoresolved:', m.id), 'live', '回执卡已建且 live');
  // matter 此刻 resolved；跑 resolved-sweep（每 tick 都会跑）
  markAttentionSupersededForResolvedMatters(new Date().toISOString());
  assert.equal(cardStatus('proposal:matter-autoresolved:', m.id), 'live', 'sweep 后回执卡仍 live（可见+可重开）');
});
