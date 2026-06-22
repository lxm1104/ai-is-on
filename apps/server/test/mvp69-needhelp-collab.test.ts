/**
 * MVP69 — 人机协作中枢 P0 闭环：AI 卡住→结构化求助卡→用户补一手→落外部证据→自动解封重查。
 * 覆盖三轮对抗审查发现的全部 load-bearing 断点：
 *  - 闭环「新证据半」+「skip 门翻转半」（P0-3/4/6）
 *  - since=startedAt 覆盖 in-flight 回填（P0-5）
 *  - 多轮回填不覆盖（P0-7）
 *  - 分流重排 + 互斥顶替（P0-2）、防焦虑 N-cap（P0-9）、schema 向后兼容（P0-1）
 *
 * Run: npx tsx --test apps/server/test/mvp69-needhelp-collab.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp69-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const ms = await import('../src/matter/matterStore.js');
const prompt = await import('../src/investigation/investigationPrompt.js');
const mrp = await import('../src/matter/matterResolveProposal.js');
const { applyInvestigationResult } = await import('../src/investigation/investigationWriteback.js');
const { applyCardAction } = await import('../src/cards/cardsService.js');
const { isStuckDeadEnd } = await import('../src/investigation/investigationDispatcher.js');

const NEEDHELP = mrp.MATTER_NEEDHELP_PROPOSAL_PREFIX;
const PROGRESS = 'proposal:matter-progress:';

function resetDb() {
  db.db.exec(`DELETE FROM attention_items; DELETE FROM matters; DELETE FROM context_units; DELETE FROM matter_context_links; DELETE FROM audit_logs; DELETE FROM action_proposals;`);
}

let n = 0;
function mkMatter() {
  n += 1;
  return ms.createMatter({
    scope: 'work', type: 'follow_up', title: `排查 badcase ${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: 'u-' + randomUUID(),
    currentSummary: '', nextAction: '跟进进展并确认结果',
  });
}

function liveCard(prefix: string, matterId: string): { id: string; status: string; title: string } | undefined {
  return db.db.prepare(`SELECT id, status, title FROM attention_items WHERE input_hash=?`).get(`${prefix}${matterId}`) as any;
}
const NEED_CRED = { kind: 'need_credential' as const, ask: '要继续追这个 badcase，我需要那条 traceID' };

// ============ P0-1 schema 解析 + 校验 ============
test('MVP69 P0-1：parse needFromUser（合法→保留 / 非法→降级 undefined，向后兼容）', () => {
  const ok = prompt.parseInvestigationStep(JSON.stringify({ action: 'conclude', conclusion: { verdict: 'blocked', confidence: 0.6, factSummary: 'x', evidence: [], needFromUser: NEED_CRED } }));
  assert.equal(ok.action, 'conclude');
  assert.equal((ok as any).conclusion.needFromUser?.kind, 'need_credential');
  // 无字段 → undefined（旧行为）
  const none = prompt.parseInvestigationStep(JSON.stringify({ action: 'conclude', conclusion: { verdict: 'unknown', confidence: 0.3, factSummary: 'x', evidence: [] } }));
  assert.equal((none as any).conclusion.needFromUser, undefined);
  // 非法 kind → undefined
  const bad = prompt.parseInvestigationStep(JSON.stringify({ action: 'conclude', conclusion: { verdict: 'blocked', confidence: 0.6, factSummary: 'x', evidence: [], needFromUser: { kind: 'nonsense', ask: 'x' } } }));
  assert.equal((bad as any).conclusion.needFromUser, undefined);
  // need_decision 缺 options → 非法
  assert.equal(prompt.isValidNeedFromUser({ kind: 'need_decision', ask: 'A 还是 B', options: ['A'] } as any), false);
  assert.equal(prompt.isValidNeedFromUser({ kind: 'need_decision', ask: 'A 还是 B', options: ['A', 'B'] } as any), true);
  assert.equal(prompt.isValidNeedFromUser({ kind: 'need_credential', ask: '' } as any), false);
  assert.equal(prompt.isValidNeedFromUser(NEED_CRED), true);
});

// ============ P0-2 分流：blocked+need_credential → needhelp，不撞 progress；顶替 ============
test('MVP69 P0-2：blocked+合法 need_credential → 升 needhelp，不升 progress', () => {
  resetDb();
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'blocked', confidence: 0.7, factSummary: '定位到上报但缺 traceID', evidence: ['鲁升纲 06-12 上报'], needFromUser: NEED_CRED } });
  assert.equal(r.proposalRaised, true);
  assert.ok(liveCard(NEEDHELP, m.id), '应升 needhelp 卡');
  assert.equal(liveCard(PROGRESS, m.id), undefined, '不应升 progress 卡');
});

test('MVP69 P0-2：needhelp 顶替在场 progress/dangling 卡', () => {
  resetDb();
  const m = mkMatter();
  // 先有一张 progress 卡
  mrp.raiseMatterProgressProposal(ms.getMatterById(m.id)!, { verdict: 'blocked', factSummary: '受阻', evidence: [], confidence: 0.7 });
  assert.equal(liveCard(PROGRESS, m.id)?.status, 'live');
  // 升 needhelp → 顶掉 progress
  mrp.raiseMatterNeedHelpProposal(ms.getMatterById(m.id)!, { needFromUser: NEED_CRED, factSummary: 'x' });
  assert.equal(liveCard(NEEDHELP, m.id)?.status, 'live');
  assert.equal(liveCard(PROGRESS, m.id)?.status, 'superseded', 'progress 被顶替');
});

test('MVP69 P0-2：非 P0 kind（need_info 不在白名单）→ 回落 progress，不升 needhelp', () => {
  resetDb();
  const m = mkMatter();
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'blocked', confidence: 0.7, factSummary: '缺版本号', evidence: ['x'], needFromUser: { kind: 'need_info', ask: '哪个版本' } } });
  assert.equal(liveCard(NEEDHELP, m.id), undefined, 'need_info 首轮不升 needhelp');
  assert.ok(liveCard(PROGRESS, m.id), '回落 progress 兜底');
});

// ============ P0-3 hasLiveMatterProposal 认 needhelp ============
test('MVP69 P0-3：live needhelp 卡 → hasLiveMatterProposal=true；acted 后=false', () => {
  resetDb();
  const m = mkMatter();
  mrp.raiseMatterNeedHelpProposal(ms.getMatterById(m.id)!, { needFromUser: NEED_CRED });
  assert.equal(db.hasLiveMatterProposal(m.id), true, 'live needhelp 应挡重查');
  const card = liveCard(NEEDHELP, m.id)!;
  db.db.prepare(`UPDATE attention_items SET status='acted' WHERE id=?`).run(card.id);
  assert.equal(db.hasLiveMatterProposal(m.id), false, 'acted 后放行重查');
});

// ============ P0-9 防焦虑 N-cap（MVP71：合并「待你处理」配额，默认 3）============
test('MVP69/71 P0-9：合并「待你处理」配额（默认 3）—— 第 4 件不升', () => {
  resetDb();
  const a = mkMatter(), b = mkMatter(), c = mkMatter(), d = mkMatter();
  assert.equal(mrp.raiseMatterNeedHelpProposal(ms.getMatterById(a.id)!, { needFromUser: NEED_CRED }), true);
  assert.equal(mrp.raiseMatterNeedHelpProposal(ms.getMatterById(b.id)!, { needFromUser: NEED_CRED }), true);
  assert.equal(mrp.raiseMatterNeedHelpProposal(ms.getMatterById(c.id)!, { needFromUser: NEED_CRED }), true);
  assert.equal(mrp.raiseMatterNeedHelpProposal(ms.getMatterById(d.id)!, { needFromUser: NEED_CRED }), false, '超合并配额不升');
  assert.equal(db.countLivePendingUserProposals(), 3);
});

// ============ P0-4 isStuckDeadEnd 逃生门（building blocks）============
test('MVP69 P0-4：死胡同 + 无新证据→该跳过；挂 card_action 新证据→解封（逃生门逻辑）', async () => {
  resetDb();
  const m = mkMatter();
  // 模拟近 2 次死胡同
  const stuck = isStuckDeadEnd([{ verdict: 'unknown', confidence: 0.5 }, { verdict: 'blocked', confidence: 0.6 }]);
  assert.equal(stuck, true);
  // 写一条排查时刻
  const since = new Date(Date.now() - 60_000).toISOString();
  db.insertAuditLog({ id: randomUUID(), agent_run_id: null, card_id: null, rule_id: null, action: 'investigation_written_back', reason: 'x', payload_json: JSON.stringify({ matterId: m.id, verdict: 'unknown', confidence: 0.5, startedAt: since }), created_at: since });
  // 无新证据：skip 门 = stuck && !hasNew = true（该跳过）
  assert.equal(stuck && !db.hasNewExternalEvidenceSince(m.id, db.getLastInvestigatedAt(m.id) ?? ''), true);
  // 用户补一手 → card_action 证据 unit
  const cs = await import('../src/context/contextStore.js');
  const { unit } = cs.upsertContextUnit({ kind: 'action_result', origin: { kind: 'card_action', refId: 'x' }, title: 't', content: '这是 traceID abc', scope: 'work', actionability: 'record', confidence: 1, mergeHint: 'k' + randomUUID(), silent: true });
  ms.attachMatterContextLink({ matterId: m.id, contextUnitId: unit.id, relation: 'evidence', effect: 'no_change', confidence: 1, reason: 't' });
  // 有新证据：逃生门翻转 → 不跳过
  assert.equal(stuck && !db.hasNewExternalEvidenceSince(m.id, db.getLastInvestigatedAt(m.id) ?? ''), false, '新证据让死胡同解封');
});

// ============ P0-6/7 + P0-5：回填闭环（最关键）============
test('MVP69 闭环：mark_done needhelp 支路 → acted + card_action 证据(不办结) + 解封 + 多轮不覆盖', async () => {
  resetDb();
  const m = mkMatter();
  // 上次排查时刻（startedAt 早于回填）
  const started = new Date(Date.now() - 120_000).toISOString();
  db.insertAuditLog({ id: randomUUID(), agent_run_id: null, card_id: null, rule_id: null, action: 'investigation_written_back', reason: 'x', payload_json: JSON.stringify({ matterId: m.id, verdict: 'blocked', confidence: 0.7, startedAt: started }), created_at: new Date(Date.now() - 110_000).toISOString() });
  mrp.raiseMatterNeedHelpProposal(ms.getMatterById(m.id)!, { needFromUser: NEED_CRED, factSummary: 'x' });
  const card = liveCard(NEEDHELP, m.id)!;

  // 用户补一手
  const r1 = await applyCardAction(card.id, 'mark_done', { note: 'traceID 是 2fd12bef42492086' });
  assert.equal(r1.ok, true);
  // 卡置 acted
  assert.equal((db.db.prepare(`SELECT status FROM attention_items WHERE id=?`).get(card.id) as any).status, 'acted');
  // 落了 card_action 证据 unit 挂该 matter
  const links = db.db.prepare(`SELECT cu.origin_kind ok, cu.content, mcl.relation, mcl.effect FROM matter_context_links mcl JOIN context_units cu ON cu.id=mcl.context_unit_id WHERE mcl.matter_id=?`).all(m.id) as any[];
  const backfill = links.find((l) => l.ok === 'card_action');
  assert.ok(backfill, '应落 card_action 证据 unit');
  assert.equal(backfill.relation, 'evidence');
  assert.equal(backfill.effect, 'no_change', '只补证据，不办结');
  assert.match(backfill.content, /2fd12bef/);
  // matter 未被办结
  assert.notEqual(ms.getMatterById(m.id)!.status, 'resolved');
  // 闭环：用 since=startedAt（P0-5）能看到回填新证据
  assert.equal(db.hasNewExternalEvidenceSince(m.id, db.getLastInvestigatedAt(m.id) ?? ''), true, '回填即新证据，自动解封');
  // skip 门翻转：卡 acted → hasLiveMatterProposal=false
  assert.equal(db.hasLiveMatterProposal(m.id), false);

  // 多轮：第二次补（同卡）→ 落新 unit，不覆盖第一手
  const r2 = await applyCardAction(card.id, 'mark_done', { note: '另外环境是 PPE' });
  assert.equal(r2.ok, true);
  const cardActionUnits = (db.db.prepare(`SELECT cu.content FROM matter_context_links mcl JOIN context_units cu ON cu.id=mcl.context_unit_id WHERE mcl.matter_id=? AND cu.origin_kind='card_action'`).all(m.id) as any[]);
  assert.equal(cardActionUnits.length, 2, '两手补位各落一条，不互相覆盖');
});

// ============ MVP72：factSummary 内容信号兜底 → need_credential（修代码 badcase 漏求助）============
test('MVP72 deriveCredentialNeed：blocked + "缺日志ID/traceID" 内容 → 合成 need_credential', async () => {
  const { deriveCredentialNeed } = await import('../src/investigation/investigationWriteback.js');
  // dacd120c 实证文案
  const n = deriveCredentialNeed('blocked', 0.7, '已定位功能层根因，但未能在 IM 中捞到那两个待排查的日志 ID，无法下钻到代码级根因');
  assert.ok(n, '应合成 need_credential');
  assert.equal(n!.kind, 'need_credential');
  // traceID 措辞
  assert.ok(deriveCredentialNeed('unknown', 0.4, '缺 traceID 无法继续追'));
  assert.ok(deriveCredentialNeed('blocked', 0.6, '需要这个 badcase 的日志ID才能 fornax 拉 trace'));
  // 负例：没提缺凭据 → 不合成
  assert.equal(deriveCredentialNeed('blocked', 0.7, '对方还没回复，等他确认'), undefined);
  // 负例：已用日志ID追到（positive 语境）→ 不合成
  assert.equal(deriveCredentialNeed('progressed', 0.7, '已用日志ID追到 file:line'), undefined, 'progressed 不合成');
  assert.equal(deriveCredentialNeed('blocked', 0, '缺日志ID', ), undefined, 'conf=0 哨兵不合成');
});

test('MVP72 端到端：blocked 但模型没填 needFromUser + factSummary 说缺日志ID → 升 needhelp 卡', () => {
  resetDb();
  const m = mkMatter();
  // 模型没给 needFromUser（实测常态），但 factSummary 自陈缺日志ID
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'blocked', confidence: 0.7, factSummary: '已定位功能层根因，但未能捞到那两个待排查的日志 ID，无法下钻代码', evidence: ['功能层根因：定时触发不带用户信息'] } });
  assert.equal(r.proposalRaised, true);
  assert.ok(liveCard(NEEDHELP, m.id), '内容信号兜底 → 升 needhelp 求助卡');
  assert.equal(liveCard(PROGRESS, m.id), undefined, '不再退而求其次升 progress');
});

test('MVP72：同事项已有 dangling 卡 → needhelp 可升级顶替它（不被合并配额挡）', async () => {
  resetDb();
  const { insertAttentionItem } = await import('../src/attention/attentionStore.js');
  // 占满 3 个 pending 槽（dangling，用真实 insert 助手填默认列）
  const fillers = [mkMatter(), mkMatter(), mkMatter()];
  for (const f of fillers) {
    insertAttentionItem({
      id: randomUUID(), generation: 0, llmRunId: null,
      inputHash: `proposal:matter-dangling:${f.id}`,
      llmItem: { priority: 'P2', title: '待你处理', why: 'x', suggestedAction: 'x', signalIds: [], matterId: f.id },
      now: new Date().toISOString(),
    });
  }
  assert.equal(db.countLivePendingUserProposals(), 3, '3 槽占满');
  // 其中一件 dangling 的 matter 现在要升 needhelp（更具体）→ 应允许（升级顶替，不被配额挡）
  const upgradeMatter = fillers[0];
  const ok = mrp.raiseMatterNeedHelpProposal(ms.getMatterById(upgradeMatter.id)!, { needFromUser: NEED_CRED, factSummary: 'x' });
  assert.equal(ok, true, '同事项 dangling→needhelp 升级豁免配额');
  assert.equal(liveCard(NEEDHELP, upgradeMatter.id)?.status, 'live');
  assert.equal(db.db.prepare(`SELECT status FROM attention_items WHERE input_hash=?`).get(`proposal:matter-dangling:${upgradeMatter.id}`)?.status, 'superseded', 'dangling 被顶替');
  assert.equal(db.countLivePendingUserProposals(), 3, '净额仍 3（升级不新增）');
});
