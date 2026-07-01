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
import { db, countLivePendingUserProposals, countLiveArtifactProposals, countLiveRecoProposals, wasProposalRecentlyDismissed } from '../db.js';
import { config } from '../config.js';
import { insertAttentionItem, markAttentionItemsSupersededByHash } from '../attention/attentionStore.js';
import { broadcast } from '../ws.js';
import type { Matter } from './matterTypes.js';
import type { AttentionPriority } from '../attention/attentionTypes.js';
import type { NeedFromUser, InvestigationArtifact, Recommendation } from '../investigation/investigationPrompt.js';

export const MATTER_RESOLVE_PROPOSAL_PREFIX = 'proposal:matter-resolve:';
export const MATTER_PROGRESS_PROPOSAL_PREFIX = 'proposal:matter-progress:';
export const MATTER_AUTORESOLVED_PREFIX = 'proposal:matter-autoresolved:'; // MVP55：AI 已主动办结回执（可重开）
export const MATTER_DANGLING_PROPOSAL_PREFIX = 'proposal:matter-dangling:'; // MVP67：你自己欠的承诺，AI 查无跟进痕迹
export const MATTER_NEEDHELP_PROPOSAL_PREFIX = 'proposal:matter-needhelp:'; // MVP69：AI 卡住，结构化求助（你补一手→自动接着查）
export const MATTER_ARTIFACT_PROPOSAL_PREFIX = 'proposal:matter-artifact:'; // MVP74：AI 替你定位代码根因，给出修复方案（你一键复制/应用/办结）
export const MATTER_RECO_PROPOSAL_PREFIX = 'proposal:matter-reco:'; // MVP75：AI 给你一条直接建议/意见（结果层）

function hasLiveProposal(prefix: string, matterId: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM attention_items WHERE status='live' AND input_hash = ? LIMIT 1`)
    .get(`${prefix}${matterId}`);
}

/**
 * MVP71 降噪 P0-3：该 matter 同类「待你处理」卡近 cooldown 天内被处理过 → 不重升（防反复打扰）。
 * includeActed：dangling 传 true（你刚说"我来跟进/补了进展"，别立刻又催）；needhelp 传 false（允许多轮补一手再求助）。
 */
function blockedByReRaiseCooldown(prefix: string, matterId: string, includeActed = false): boolean {
  const days = config.investigationPendingReRaiseCooldownDays;
  if (!days || days <= 0) return false;
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  return wasProposalRecentlyDismissed(`${prefix}${matterId}`, sinceIso, includeActed);
}

/** 参数化内核：幂等查在场 + insertAttentionItem + broadcast。各提案类型转调它。 */
function raiseMatterProposal(
  matter: Matter,
  opts: { prefix: string; priority: AttentionPriority; title: string; why: string; suggestedAction: string; expiresAt?: string }
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
      expiresAt: opts.expiresAt, // MVP74：交付卡设 7 天 TTL（且豁免 24h 兜底扫），高价值不蒸发
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
  // MVP71 降噪：被 dismiss/acted 冷却期内不重升（P0-3，含"我刚补了进展"——别立刻又催同一件）；
  // 合并「待你处理」配额（P0-1，dangling 不再裸奔无闸）。
  if (blockedByReRaiseCooldown(MATTER_DANGLING_PROPOSAL_PREFIX, matter.id, true)) return false;
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
  // 防焦虑闸：已占「待你处理」槽位的同事项（needhelp 幂等更新 / dangling 将被 needhelp 升级顶替）豁免配额——
  // 它不新增 pending 数（下面会 supersede 掉 dangling），净额不变。否则配额满时更具体的 needhelp 无法升级
  // 同事项已在场的泛 dangling（MVP72 实证：dacd120c 有 dangling，3 槽被 dangling 占满 → 求助卡升不上来）。
  const alreadyOccupiesPendingSlot =
    hasLiveProposal(MATTER_NEEDHELP_PROPOSAL_PREFIX, matter.id) || hasLiveProposal(MATTER_DANGLING_PROPOSAL_PREFIX, matter.id);
  if (!alreadyOccupiesPendingSlot && countLivePendingUserProposals() >= config.investigationNeedHelpMaxLive) {
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
 * MVP74 — 「交付提案卡」：AI 已替你定位到代码根因，给出具体修复方案（file:line + 改法 + 验证命令）。
 * 这是"从查到解决"的核心出口：不再停在"查到X"，而是把最推进一步的可执行件交到你手里，一键复制/办结。
 * 互斥序 resolve > artifact > needhelp > progress > dangling：办结在场不叠；升起时顶掉同事项的求助/进展/查无跟进卡
 *（artifact 比它们都更推进）。纳入「待你处理」配额（已占槽位的同事项豁免，允许从 needhelp/dangling 升级）。
 */
export function raiseMatterArtifactProposal(
  matter: Matter,
  opts: { artifact: InvestigationArtifact; factSummary?: string; evidence?: string[] }
): boolean {
  if (hasLiveProposal(MATTER_RESOLVE_PROPOSAL_PREFIX, matter.id)) return false; // 办结已在场，不叠
  if (blockedByReRaiseCooldown(MATTER_ARTIFACT_PROPOSAL_PREFIX, matter.id)) return false;
  // MVP74 审查 P1：交付卡用**独立**配额（countLiveArtifactProposals + investigationArtifactMaxLive），
  // 不挤占 needhelp/dangling 安全求助池——否则几张 7 天长寿交付卡会跨 matter 把求助卡饿死。
  // 同 matter 已有交付卡则幂等更新，豁免配额。
  const alreadyHasArtifact = hasLiveProposal(MATTER_ARTIFACT_PROPOSAL_PREFIX, matter.id);
  if (!alreadyHasArtifact && countLiveArtifactProposals() >= config.investigationArtifactMaxLive) {
    return false;
  }
  const now = new Date().toISOString();
  // artifact > needhelp/progress/dangling：顶掉同事项在场的它们（避免并存多卡；交付件最推进）。
  markAttentionItemsSupersededByHash(`${MATTER_NEEDHELP_PROPOSAL_PREFIX}${matter.id}`, now);
  markAttentionItemsSupersededByHash(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${matter.id}`, now);
  markAttentionItemsSupersededByHash(`${MATTER_DANGLING_PROPOSAL_PREFIX}${matter.id}`, now);
  const a = opts.artifact;
  const fact = (opts.factSummary ?? '').trim().slice(0, 120);
  const factLine = fact ? `\n排查：${fact}` : '';
  // P1-6：按 kind 渲染卡正文/标题。正文 body 不二次截（已在 parse 对齐 2000 上限，复制无损·审查 P2）。
  let title: string;
  let why: string;
  if (a.kind === 'task_spec') {
    title = `📋 待建任务：${(a.title || matter.title).slice(0, 36)}`;
    why = [
      'AI 查到这件事已拍板要做、但还没人建任务跟进，替你拟好了任务（你来一键建/指派）：',
      `📋 任务 ${a.title}`,
      `✍️ 内容 ${a.body}`,
      a.assignee ? `👤 建议负责人 ${a.assignee}` : '',
      factLine,
    ].filter((l) => l && l.length > 0).join('\n');
  } else if (a.kind === 'decision_brief') {
    title = `🧭 决策信息包：${(a.title || matter.title).slice(0, 34)}`;
    why = [
      'AI 把这个决策点的信息替你拉齐成一页（不替你拍板，你来定）：',
      `🧭 决策点 ${a.title}`,
      a.body,
      factLine,
    ].filter((l) => l && l.length > 0).join('\n');
  } else {
    // code_fix（默认）：审查 P2 已让 body 与 parse 上限对齐，复制无损。
    title = `🔧 修复方案：${matter.title.slice(0, 36)}`;
    why = [
      'AI 已替你定位到代码根因，给出修复方案（建议你核实后应用，AI 不会自动改代码）：',
      `📍 位置 ${a.targetRef}`,
      `🔧 根因 ${a.rootCause}`,
      `✍️ 改法 ${a.body}`,
      a.verifyCmd ? `✅ 验证 ${a.verifyCmd}` : '',
      factLine,
    ].filter((l) => l && l.length > 0).join('\n');
  }
  return raiseMatterProposal(matter, {
    prefix: MATTER_ARTIFACT_PROPOSAL_PREFIX,
    priority: 'P1', // 高价值信号：真有可执行件，置顶露出（别淹没在泛进展里）
    title,
    why,
    suggestedAction: '复制去用 / 办结',
    // 7 天 TTL：高价值交付件不该 24h 蒸发（实测泛进展卡 64% expired），又设有限期避免永占配额槽。
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
}

/**
 * MVP75 — 「💡 我的建议」卡。AI 不止陈述事实，给一条**直接可执行的建议/意见**（结果层）。
 * 已过 gradeRecommendation 防换壳硬门才会调到这里。独立小配额（不挤安全求助池）；互斥序
 * resolve > artifact > needhelp > 💡建议 > progress > dangling（在 needhelp 之后，不抢求助）。
 */
export function raiseMatterRecommendationProposal(
  matter: Matter,
  opts: { recommendation: Recommendation; factSummary?: string }
): boolean {
  if (hasLiveProposal(MATTER_RESOLVE_PROPOSAL_PREFIX, matter.id)) return false;
  if (hasLiveProposal(MATTER_ARTIFACT_PROPOSAL_PREFIX, matter.id)) return false; // 交付件更推进，不叠建议
  if (hasLiveProposal(MATTER_NEEDHELP_PROPOSAL_PREFIX, matter.id)) return false; // 求助在场不叠
  if (blockedByReRaiseCooldown(MATTER_RECO_PROPOSAL_PREFIX, matter.id)) return false;
  const alreadyHas = hasLiveProposal(MATTER_RECO_PROPOSAL_PREFIX, matter.id);
  if (!alreadyHas && countLiveRecoProposals() >= config.investigationRecoCardMaxLive) return false;
  const now = new Date().toISOString();
  // 建议 > progress/dangling：顶掉同事项的泛进展/查无跟进卡（建议比"查到X"更是结果）。
  markAttentionItemsSupersededByHash(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${matter.id}`, now);
  markAttentionItemsSupersededByHash(`${MATTER_DANGLING_PROPOSAL_PREFIX}${matter.id}`, now);
  const r = opts.recommendation;
  // 结果 + 成品同卡：建议 + 一句依据 + **AI 直接起草好的成品全文**（用户一键复制去发/去用）。不列排查过程。
  const why = [
    `💡 ${r.advice}`,
    `📎 依据 ${r.because}`,
    r.draft ? `\n📝 我替你起草好了${r.nextStep ? `（${r.nextStep}）` : ''}，复制就能用：\n${r.draft}` : (r.nextStep ? `👉 下一步：${r.nextStep}` : ''),
  ].filter((l) => l && l.length > 0).join('\n');
  return raiseMatterProposal(matter, {
    prefix: MATTER_RECO_PROPOSAL_PREFIX,
    priority: 'P1', // 直接结果，置顶露出
    title: `💡 我的建议：${matter.title.slice(0, 36)}`,
    why,
    suggestedAction: '按建议办 / 让AI接着推 / 知道了',
    expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), // 建议时效性强，3 天 TTL
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
