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
import { db, countLivePendingUserProposals, wasProposalRecentlyDismissed } from '../db.js';
import { config } from '../config.js';
import { insertAttentionItem, markAttentionItemsSupersededByHash } from '../attention/attentionStore.js';
import { broadcast } from '../ws.js';
import type { Matter } from './matterTypes.js';
import type { AttentionPriority } from '../attention/attentionTypes.js';
import type { NeedFromUser } from '../investigation/investigationPrompt.js';

export const MATTER_RESOLVE_PROPOSAL_PREFIX = 'proposal:matter-resolve:';
export const MATTER_PROGRESS_PROPOSAL_PREFIX = 'proposal:matter-progress:';
export const MATTER_AUTORESOLVED_PREFIX = 'proposal:matter-autoresolved:'; // MVP55：AI 已主动办结回执（可重开）
export const MATTER_DANGLING_PROPOSAL_PREFIX = 'proposal:matter-dangling:'; // MVP67：你自己欠的承诺，AI 查无跟进痕迹
export const MATTER_NEEDHELP_PROPOSAL_PREFIX = 'proposal:matter-needhelp:'; // MVP69：AI 卡住，结构化求助（你补一手→自动接着查）

function hasLiveProposal(prefix: string, matterId: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM attention_items WHERE status='live' AND input_hash = ? LIMIT 1`)
    .get(`${prefix}${matterId}`);
}

/** MVP71 降噪 P0-3：该 matter 同类「待你处理」卡近 cooldown 天内被 dismiss 过 → 不重升（防反复打扰）。 */
function blockedByReRaiseCooldown(prefix: string, matterId: string): boolean {
  const days = config.investigationPendingReRaiseCooldownDays;
  if (!days || days <= 0) return false;
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  return wasProposalRecentlyDismissed(`${prefix}${matterId}`, sinceIso);
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
 * MVP67 — 「你欠的承诺，查无跟进」提醒卡。AI 排查自己欠下的承诺（owner=自己），多轮查证仍找不到
 * 任何跟进痕迹（verdict=unknown）→ 与其把这次 unknown 静默丢弃，不如把它变成一张可处理的待办：
 * 提醒你这件你承诺过的事疑似一直没动。低噪：仅 owner=自己 + 够旧 + 无在场办结/进展提案才升；一次性。
 * 不替你做任何对外动作——你来决定跟进/办结/不再跟进。
 */
export function raiseMatterDanglingCommitmentProposal(
  matter: Matter,
  opts: { ageDays: number; factSummary?: string }
): boolean {
  // 已有办结/进展/求助提案在场 → 不叠（那些是更高信号的结论，别拿"查无跟进"盖过）。
  if (hasLiveProposal(MATTER_RESOLVE_PROPOSAL_PREFIX, matter.id)) return false;
  if (hasLiveProposal(MATTER_PROGRESS_PROPOSAL_PREFIX, matter.id)) return false;
  if (hasLiveProposal(MATTER_NEEDHELP_PROPOSAL_PREFIX, matter.id)) return false; // MVP69：needhelp 顶 dangling
  // MVP71 降噪：被 dismiss 过冷却期内不重升（P0-3）；合并「待你处理」配额（P0-1，dangling 不再裸奔无闸）。
  if (blockedByReRaiseCooldown(MATTER_DANGLING_PROPOSAL_PREFIX, matter.id)) return false;
  if (!hasLiveProposal(MATTER_DANGLING_PROPOSAL_PREFIX, matter.id) && countLivePendingUserProposals() >= config.investigationNeedHelpMaxLive) {
    return false;
  }
  const fact = (opts.factSummary ?? '').trim().slice(0, 140);
  return raiseMatterProposal(matter, {
    prefix: MATTER_DANGLING_PROPOSAL_PREFIX,
    priority: 'P2', // 低噪：不与催办/attention 抢
    title: `待你处理：${matter.title.slice(0, 40)}`,
    why: `这是你欠下的承诺，但 AI 多轮查证后找不到任何跟进痕迹（已约 ${opts.ageDays} 天）。${fact ? `\n排查：${fact}` : ''}\n要不要现在推进，或它其实已不需要了？`,
    suggestedAction: '我来跟进 / 标记办结 / 不再跟进',
  });
}

/**
 * MVP69 — 「需要你帮忙」求助卡。AI 排查到 blocked/unknown 且明确知道缺哪件具体的事（needFromUser）→
 * 把卡点结构化交给用户：你补一手（贴 traceID / 答一句 / 拍板）→ 回填落成挂该 matter 的外部证据 →
 * MVP66 下一 tick 自动解封重查，AI 带新证据接着干。互斥：办结优先；needhelp 顶在场的 progress/dangling。
 */
export function raiseMatterNeedHelpProposal(
  matter: Matter,
  opts: { needFromUser: NeedFromUser; factSummary?: string; evidence?: string[] }
): boolean {
  if (hasLiveProposal(MATTER_RESOLVE_PROPOSAL_PREFIX, matter.id)) return false; // 办结已在场，不叠
  // MVP71 降噪：被 dismiss 过冷却期内不重升（P0-3，否则升→dismiss→下轮又升）。
  if (blockedByReRaiseCooldown(MATTER_NEEDHELP_PROPOSAL_PREFIX, matter.id)) return false;
  // 防焦虑闸：已有同事项 needhelp 卡走幂等更新；否则受**合并「待你处理」配额**约束（needhelp+dangling 总数，P0-1）。
  if (!hasLiveProposal(MATTER_NEEDHELP_PROPOSAL_PREFIX, matter.id) && countLivePendingUserProposals() >= config.investigationNeedHelpMaxLive) {
    return false;
  }
  const now = new Date().toISOString();
  // needhelp > progress/dangling：顶掉在场的进展/查无跟进卡，避免同事项并存多卡。
  markAttentionItemsSupersededByHash(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${matter.id}`, now);
  markAttentionItemsSupersededByHash(`${MATTER_DANGLING_PROPOSAL_PREFIX}${matter.id}`, now);
  const fact = (opts.factSummary ?? '').trim().slice(0, 140);
  const evLines = (opts.evidence ?? [])
    .slice(0, 3)
    .map((e) => `· ${e.trim().slice(0, 120)}`)
    .filter((l) => l.length > 2);
  return raiseMatterProposal(matter, {
    prefix: MATTER_NEEDHELP_PROPOSAL_PREFIX,
    priority: 'P2', // 低噪：不与催办抢；防焦虑闸另在 writeback 侧把关
    title: `🙋 需要你：${matter.title.slice(0, 38)}`,
    why: `${opts.needFromUser.ask.trim()}${fact ? `\n排查：${fact}` : ''}${evLines.length ? '\n证据：\n' + evLines.join('\n') : ''}`,
    suggestedAction: '补充给我接着查 / 不用了',
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
