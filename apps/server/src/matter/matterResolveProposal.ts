/**
 * 升「事项提案卡」的共享 helper（MVP31 起多处复用：聊天结论、自主排查结论…）。
 *
 * 两类提案：
 *  - **办结提案**（proposal:matter-resolve:）：AI 高置信判定"疑似已完成" → 用户一键确认 = userResolveMatter。
 *  - **进展回执**（proposal:matter-progress:，MVP40）：AI 自主排查查到 progressed/blocked 的**完整答复**
 *    （如"已读到 PRD/已定位 bug 上报/确认零进展"）→ 升一张回执卡，用户「知道了/办结/继续跟进」。
 *    这把原本只埋在 currentSummary 里、无人能按的有意义结论，转成"用户可认可的自主完成事件"。
 *
 * 幂等：同事项已有在场同类提案则跳过。办结 > 进展：升办结时顶掉在场进展卡；已有办结时不叠升进展卡。
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { insertAttentionItem, markAttentionItemsSupersededByHash } from '../attention/attentionStore.js';
import { broadcast } from '../ws.js';
import type { Matter } from './matterTypes.js';
import type { AttentionPriority } from '../attention/attentionTypes.js';

export const MATTER_RESOLVE_PROPOSAL_PREFIX = 'proposal:matter-resolve:';
export const MATTER_PROGRESS_PROPOSAL_PREFIX = 'proposal:matter-progress:';
export const MATTER_AUTORESOLVED_PREFIX = 'proposal:matter-autoresolved:'; // MVP55：AI 已主动办结回执（可重开）

function hasLiveProposal(prefix: string, matterId: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM attention_items WHERE status='live' AND input_hash = ? LIMIT 1`)
    .get(`${prefix}${matterId}`);
}

/** 参数化内核：幂等查在场 + insertAttentionItem + broadcast。各提案类型转调它。 */
function raiseMatterProposal(
  matter: Matter,
  opts: { prefix: string; priority: AttentionPriority; title: string; why: string; suggestedAction: string }
): boolean {
  if (matter.status === 'resolved' || matter.status === 'dropped') return false;
  if (hasLiveProposal(opts.prefix, matter.id)) return false;
  insertAttentionItem({
    id: randomUUID(),
    generation: 0, // 系统提案不参与 LLM 代际
    llmRunId: null,
    inputHash: `${opts.prefix}${matter.id}`,
    llmItem: {
      priority: opts.priority,
      title: opts.title,
      why: opts.why,
      suggestedAction: opts.suggestedAction,
      signalIds: [],
      matterId: matter.id,
    },
    now: new Date().toISOString(),
  });
  broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 1 });
  return true;
}

/** 升办结提案卡。已 resolved/dropped 或已有在场办结提案 → 跳过。会顶掉在场进展卡（办结优先）。返回是否真的升了。 */
export function raiseMatterResolveProposal(
  matter: Matter,
  opts: { why: string; suggestedAction?: string }
): boolean {
  // 办结 > 进展：同事项若有在场进展卡，办结升起时顶掉它（避免两卡并存）。
  markAttentionItemsSupersededByHash(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${matter.id}`, new Date().toISOString());
  return raiseMatterProposal(matter, {
    prefix: MATTER_RESOLVE_PROPOSAL_PREFIX,
    priority: 'P1',
    title: `确认办结：${matter.title.slice(0, 40)}`,
    why: opts.why,
    suggestedAction: opts.suggestedAction ?? '确认办结，或忽略保持跟进',
  });
}

/**
 * 升「进展回执」卡（MVP40）。progressed/blocked 的有意义结论 → P2 回执卡。
 * 止损（吸收对抗审查 #3）：已有在场办结提案则不叠升（结论已交用户裁决）。
 */
export function raiseMatterProgressProposal(
  matter: Matter,
  opts: { verdict: 'progressed' | 'blocked'; factSummary: string; evidence: string[]; confidence: number }
): boolean {
  if (hasLiveProposal(MATTER_RESOLVE_PROPOSAL_PREFIX, matter.id)) return false; // 办结已在场，不叠
  const fact = opts.factSummary.trim().slice(0, 140);
  const lead =
    opts.verdict === 'blocked'
      ? `AI 替你查证后发现该事项暂无进展 / 受阻：${fact}`
      : `AI 替你查到新进展：${fact}`;
  const evLines = opts.evidence
    .slice(0, 3)
    .map((e) => `· ${e.trim().slice(0, 120)}`)
    .filter((l) => l.length > 2);
  return raiseMatterProposal(matter, {
    prefix: MATTER_PROGRESS_PROPOSAL_PREFIX,
    priority: 'P2', // 让位 attention，不与催办抢
    title: `AI 已查清进展：${matter.title.slice(0, 40)}`,
    why: `${lead}${evLines.length ? '\n证据：\n' + evLines.join('\n') : ''}`,
    suggestedAction: '知道了 / 办结 / 继续跟进',
  });
}

/**
 * MVP55 — 「AI 已主动办结」回执卡。matter 此时**已被 userResolveMatter 办结**，故不走 raiseMatterProposal
 * （它会因 status=resolved 拒绝）；直接插一张透明回执，动作组 [知道了, 重开]，用户可一键撤销。
 */
export function raiseMatterAutoResolvedReceipt(
  matter: Matter,
  opts: { factSummary: string; evidence: string[]; confidence: number }
): boolean {
  if (hasLiveProposal(MATTER_AUTORESOLVED_PREFIX, matter.id)) return false;
  const fact = opts.factSummary.trim().slice(0, 140);
  const evLines = opts.evidence
    .slice(0, 3)
    .map((e) => `· ${e.trim().slice(0, 120)}`)
    .filter((l) => l.length > 2);
  insertAttentionItem({
    id: randomUUID(),
    generation: 0,
    llmRunId: null,
    inputHash: `${MATTER_AUTORESOLVED_PREFIX}${matter.id}`,
    llmItem: {
      priority: 'P2',
      title: `✅ AI 已主动办结：${matter.title.slice(0, 40)}`,
      why: `AI 自主排查高置信(${opts.confidence.toFixed(2)})判定这件事已完成，已替你办结：${fact}${evLines.length ? '\n证据：\n' + evLines.join('\n') : ''}\n如判断有误，点「重开」即可恢复跟进。`,
      suggestedAction: '知道了 / 重开',
      signalIds: [],
      matterId: matter.id,
    },
    now: new Date().toISOString(),
  });
  broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 1 });
  return true;
}
