/**
 * MVP75 —「输出结果而非过程」：conclude 长出 recommendation(直接建议)，防换壳硬门 gradeRecommendation，
 * 达标升「💡 我的建议」卡，结果率北极星。
 *
 * Run: npx tsx --test apps/server/test/mvp75-recommendation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp75-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.INVESTIGATION_AUTO_PUSH_ENABLED = 'false'; // 单测不真 spawn opencode（只测开会话+硬闸）

const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { applyInvestigationResult } = await import('../src/investigation/investigationWriteback.js');
const { gradeRecommendation } = await import('../src/investigation/investigationPrompt.js');
const { MATTER_RECO_PROPOSAL_PREFIX, MATTER_NEEDHELP_PROPOSAL_PREFIX, MATTER_PROGRESS_PROPOSAL_PREFIX } = await import('../src/matter/matterResolveProposal.js');
const db = await import('../src/db.js');

const SELF = 'self-' + randomUUID();
function resetDb() {
  db.db.exec(`DELETE FROM attention_items; DELETE FROM matters; DELETE FROM context_units; DELETE FROM matter_context_links; DELETE FROM audit_logs; DELETE FROM matter_entities;`);
  db.setSetting('self_person_entity_id', SELF);
}
let n = 0;
function mkMatter() {
  n += 1;
  const unit = cs.upsertContextUnit({ kind: 'commitment', title: `c${n}`, content: `内容${n}`, scope: 'work', origin: { kind: 'manual', refId: `u-${n}` }, silent: true }).unit;
  return ms.createMatter({ scope: 'work', type: 'follow_up', title: `跟进孙鑫交付${n}`, canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id, ownerEntityId: SELF, currentSummary: '', nextAction: 'x' });
}
function recoCard(matterId: string) {
  return db.db.prepare(`SELECT title, why FROM attention_items WHERE input_hash=?`).get(`${MATTER_RECO_PROPOSAL_PREFIX}${matterId}`) as { title: string; why: string } | undefined;
}

// ---- 防换壳硬门 gradeRecommendation ----
const FACT = '孙鑫今天再次承诺本周给，尚未交付，仍在窗口内，截止周五';
const EV = ['孙鑫 6/25 13:03 回复：本周给你哈，正常'];
const goodReco = { stance: 'wait' as const, advice: '先别催，等到周五截止前一天再提醒一次就行', because: '孙鑫已明确承诺本周给、仍在窗口内', nextStep: '我已起草一句周五提醒待你发' };

test('MVP75 grade：达标建议（动作/减法 + 引证据 + 增量信息）→ true', () => {
  assert.equal(gradeRecommendation(goodReco, FACT, EV), true);
  // drop 减法建议：无强动作动词也放行（仍须引证据+增量信息）
  assert.equal(gradeRecommendation({ stance: 'drop', advice: '这条可以放弃跟进了，已有更优先的事', because: '孙鑫承诺仍在窗口内、不紧急' }, FACT, EV), true);
});

test('MVP75 grade：事实复述（advice≈factSummary，无增量信息）→ false', () => {
  assert.equal(gradeRecommendation({ stance: 'do', advice: '孙鑫今天再次承诺本周给尚未交付', because: '孙鑫回复本周给' }, FACT, EV), false);
});

test('MVP75 grade：泛泛"建议继续跟进"（because 不引证据）→ false', () => {
  assert.equal(gradeRecommendation({ stance: 'do', advice: '建议继续跟进观察一下', because: '这件事还没完需要关注' }, FACT, EV), false);
});

test('MVP75 grade：完成态谎报"我已发催办"→ false（否决代执行动词）', () => {
  assert.equal(gradeRecommendation({ stance: 'do', advice: '我已发催办消息给孙鑫了', because: '孙鑫迟迟未交付本周给' }, FACT, EV), false);
});

test('MVP75 grade：do 无动作动词 → false；because 不引证据 → false', () => {
  assert.equal(gradeRecommendation({ stance: 'do', advice: '孙鑫这个情况吧', because: '孙鑫承诺本周给' }, FACT, EV), false, '无动作动词');
  assert.equal(gradeRecommendation({ stance: 'do', advice: '催孙鑫今天给个准信儿', because: '凭我的直觉该催了' }, FACT, EV), false, 'because 不引证据');
  assert.equal(gradeRecommendation(undefined, FACT, EV), false);
  assert.equal(gradeRecommendation({ stance: 'bogus' as any, advice: 'x', because: 'y' }, FACT, EV), false, '非法 stance');
});

// ---- writeback：达标建议升💡卡 + audit ----
test('MVP75 writeback：达标建议 → 升💡卡 + investigation_recommended 审计', () => {
  resetDb();
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: FACT, evidence: EV, recommendation: goodReco } });
  assert.equal(r.proposalRaised, true);
  const card = recoCard(m.id);
  assert.ok(card, '应升💡卡');
  assert.match(card!.title, /我的建议/);
  assert.match(card!.why, /先别催/);
  assert.match(card!.why, /依据/);
  assert.ok(!/排查：/.test(card!.why), '结果先行：卡里不再罗列排查过程');
  const audit = db.db.prepare(`SELECT payload_json FROM audit_logs WHERE action='investigation_recommended' LIMIT 1`).get() as { payload_json: string } | undefined;
  assert.ok(audit, '应写 investigation_recommended 审计');
  assert.equal(JSON.parse(audit!.payload_json).stance, 'wait');
});

test('MVP75 writeback：不达标建议（换壳）→ 不升💡卡，落回进展卡', () => {
  resetDb();
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: FACT, evidence: EV, recommendation: { stance: 'do', advice: '建议继续跟进', because: '还没完' } } });
  assert.equal(recoCard(m.id), undefined, '换壳建议不升💡卡');
  assert.ok(db.db.prepare(`SELECT 1 FROM attention_items WHERE input_hash=?`).get(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${m.id}`), '落回进展卡');
  void r;
});

test('MVP75 writeback：blocked+缺凭据 → needhelp 优先于💡卡（不抢求助）', () => {
  resetDb();
  const m = mkMatter();
  // blocked 缺 traceID → needhelp；即便带了达标建议，needhelp 在前
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'blocked', confidence: 0.6, factSummary: '要追代码根因但拿不到 traceID', evidence: ['IM 里没有日志ID'], solvability: 'need_user', recommendation: goodReco } });
  assert.ok(db.db.prepare(`SELECT 1 FROM attention_items WHERE input_hash=?`).get(`${MATTER_NEEDHELP_PROPOSAL_PREFIX}${m.id}`), '走求助卡');
  assert.equal(recoCard(m.id), undefined, '💡卡不抢 needhelp');
  void r;
});

test('MVP75 结果率：达标建议计入结果率分子', () => {
  resetDb();
  const m = mkMatter();
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: FACT, evidence: EV, recommendation: goodReco } });
  const t = db.getAiActivityTally();
  assert.equal(t.recommendedCount, 1);
  assert.ok(t.resultRate > 0, '结果率 > 0');
});

test('MVP75 向后兼容：无 recommendation → 等价今天（progressed 升进展卡，无💡）', () => {
  resetDb();
  const m = mkMatter();
  applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: FACT, evidence: EV } });
  assert.equal(recoCard(m.id), undefined);
  assert.ok(db.db.prepare(`SELECT 1 FROM attention_items WHERE input_hash=?`).get(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${m.id}`));
});

// ---- P1-5：自动开会话（只插消息、不起 turn） ----
const { maybeQueueAutoConversation } = await import('../src/chat/chatTopics.js');
const doReco = { stance: 'do' as const, advice: '催丘晓骁把图片预览落地，是阻塞评审收尾的关键项', because: '评审日报显示该项仍在丘晓骁名下未修复超10天', nextStep: '我可起草催办待你发' };
function clearChat() { db.db.exec(`DELETE FROM chat_topics; DELETE FROM runtime_messages;`); }
function mkP1Matter() { const m = mkMatter(); db.db.prepare(`UPDATE matters SET priority='P1' WHERE id=?`).run(m.id); return { ...m, priority: 'P1' as const }; }

test('MVP75 P1-5：达标建议+P1 matter → 自动开会话（只插 assistant 消息，不起 turn）', () => {
  resetDb(); clearChat();
  const m = mkP1Matter();
  assert.equal(maybeQueueAutoConversation(m as any, doReco, '评审仍在进行，图片预览项未修复'), true);
  const topic = db.db.prepare(`SELECT * FROM chat_topics WHERE source_kind='ai_push' AND source_ref_id=?`).get(m.id) as any;
  assert.ok(topic, '建了 ai_push topic');
  assert.equal(topic.opencode_session_id, null, '没起 turn（无 opencode session）');
  const msg = db.db.prepare(`SELECT * FROM runtime_messages WHERE topic_id=?`).get(topic.id) as any;
  assert.equal(msg.role, 'assistant', '只插一条 assistant 消息');
  assert.match(msg.text, /我建议你/);
  assert.ok(!/我查到/.test(msg.text), '结果先行：开头不再"我查到X"罗列过程');
});

test('MVP75 P1-5：同 matter 幂等 + 日配额满 + wait/P2 不开', () => {
  resetDb(); clearChat();
  const m = mkP1Matter();
  assert.equal(maybeQueueAutoConversation(m as any, doReco, 'x'), true);
  assert.equal(maybeQueueAutoConversation(m as any, doReco, 'x'), false, '同 matter 不重复开');
  // 日配额：已开 1（上面），再开 1 到上限 2，第 3 个被挡
  assert.equal(maybeQueueAutoConversation(mkP1Matter() as any, doReco, 'x'), true);
  assert.equal(maybeQueueAutoConversation(mkP1Matter() as any, doReco, 'x'), false, '日配额(2)满 → 不开');
  clearChat();
  assert.equal(maybeQueueAutoConversation(mkP1Matter() as any, { ...doReco, stance: 'wait' }, 'x'), false, 'wait 建议不开');
  const m2 = mkMatter(); db.db.prepare(`UPDATE matters SET priority='P2' WHERE id=?`).run(m2.id);
  assert.equal(maybeQueueAutoConversation({ ...m2, priority: 'P2' } as any, doReco, 'x'), false, 'P2 matter 不开');
});
