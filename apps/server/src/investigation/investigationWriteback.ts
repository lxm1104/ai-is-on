/**
 * MVP36 — 把自主排查结论安全回写到 Matter。
 *
 * 保守原则（与办结核实/observation 同philosophy）：**绝不自动改 status**——排查只"补事实+给判断"，
 * 真正的办结/重开仍由用户确认或既有保守通道决定（避免误判已完成伤信任）。本回写只做两件确定性的事：
 *   ① 把"AI 查到的事实 + 证据"落成一条 action_result ContextUnit，挂到 Matter 作证据（用户可见 AI 查了什么）；
 *   ② 把 factSummary 并进 Matter.currentSummary（让卡片直接显示排查结论）。
 * verdict=resolved 高置信时**只记一句提示**进 nextAction（"经排查疑似已完成，待确认"），不动 status。
 */
import { upsertContextUnit } from '../context/contextStore.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';
import { attachMatterContextLink, getMatterById, saveMatter, listMatterEntities, listMatters } from '../matter/matterStore.js';
import { userResolveMatter } from '../matter/matterActions.js';
import { raiseMatterResolveProposal, raiseMatterProgressProposal, raiseMatterAutoResolvedReceipt, raiseMatterDanglingCommitmentProposal, raiseMatterNeedHelpProposal, raiseMatterArtifactProposal, raiseMatterRecommendationProposal } from '../matter/matterResolveProposal.js';
import { isValidNeedFromUser, isValidArtifact, gradeRecommendation, type NeedFromUser } from './investigationPrompt.js';
import { classCompletionImpactOfResolving } from '../problemClass/problemClassStore.js';
import { getSelfEntityIds, deriveNeedFromUser, isSelfCommitment } from './needHelpClassifier.js';
import { scheduleMatterResolveVerification } from '../matter/matterVerifyService.js';
import { getContextEntityById, getRecentInvestigationVerdicts } from '../db.js';
import { config } from '../config.js';
import { writeAudit } from '../boundary/auditLog.js';
import { broadcast } from '../ws.js';
import type { InvestigationConclusion } from './investigationPrompt.js';

export type InvestigationWritebackResult = {
  ok: boolean;
  matterId: string;
  resultUnitId?: string;
  summaryUpdated: boolean;
  proposalRaised?: boolean; // resolved 高置信时是否升了「确认办结」提案卡
  autoResolved?: boolean; // MVP55：是否触发了"AI 主动办结"（高置信，可逆）
  error?: string;
};

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 把排查结论安全回写到 matter（只补证据 + 更新摘要，不自动改 status）。 */
export function applyInvestigationResult(input: {
  matterId: string;
  conclusion: InvestigationConclusion;
  toolSummary?: string; // 用了哪些只读工具的一行摘要，便于追溯
  startedAt?: string; // MVP69 P0-5：本次排查派发起始时刻（写进 audit，供 getLastInvestigatedAt 当 since 用）
}): InvestigationWritebackResult {
  const matter = getMatterById(input.matterId);
  if (!matter) return { ok: false, matterId: input.matterId, summaryUpdated: false, error: 'matter not found' };

  const c = input.conclusion;
  const now = new Date().toISOString();
  const factLine = c.factSummary?.trim() || '（未得出明确结论）';
  // 只有"查到了有意义的东西"才动用户可见字段。unknown（没查到 / 排查器没出有效动作）一律**不污染**
  // 摘要/下一步/证据时钟——否则卡片首行变"没查到"、陈旧度失真、内部失败文案泄漏给用户（2026-06-15 实测）。
  const meaningful = c.verdict === 'resolved' || c.verdict === 'progressed' || c.verdict === 'blocked';

  // ① 仅有意义结论 → 落 silent action_result unit 挂 matter 作证据
  let resultUnitId: string | undefined;
  if (meaningful) {
    const entities: ContextEntityRef[] = [];
    try {
      const unit = upsertContextUnit({
        kind: 'action_result',
        title: clip(`AI 排查：${factLine}`, 60),
        content: [
          `AI 自主排查结论（${c.verdict}，置信 ${c.confidence.toFixed(2)}）：`,
          factLine,
          c.evidence.length ? '\n证据：' : '',
          ...c.evidence.slice(0, 6).map((e) => `· ${clip(e, 180)}`),
          input.toolSummary ? `\n（排查用：${clip(input.toolSummary, 120)}）` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        entities,
        scope: matter.scope,
        origin: { kind: 'agent_run', refId: `investigation:${matter.id}` },
        actionability: 'record',
        confidence: c.confidence,
        mergeHint: `investigation:${matter.id}:${clip(factLine, 40)}`,
        silent: true,
      }).unit;
      resultUnitId = unit.id;
      attachMatterContextLink({
        matterId: matter.id,
        contextUnitId: unit.id,
        relation: 'evidence',
        effect: 'no_change',
        confidence: c.confidence,
        reason: `AI 自主排查（${c.verdict}）`,
        now,
      });
    } catch (err) {
      return { ok: false, matterId: matter.id, summaryUpdated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ② 更新 currentSummary —— 只在有意义时；并**剥掉旧的「[AI 排查]…｜」前缀**避免多次排查无限堆叠。
  let newSummary = matter.currentSummary;
  if (meaningful) {
    const stripped = (matter.currentSummary || '').replace(/^［AI 排查］[^｜]*｜?/, '').trim();
    const addon = `［AI 排查］${factLine}`;
    newSummary = clip(stripped ? `${addon}｜${stripped}` : addon, 400);
  }
  const newNextAction = !meaningful
    ? matter.nextAction ?? null
    : c.verdict === 'resolved' && c.confidence >= 0.7
      ? '经 AI 排查疑似已完成，请确认是否办结'
      : c.verdict === 'blocked'
        ? clip(`排查发现受阻：${factLine}`, 60)
        : matter.nextAction ?? null;

  saveMatter({
    ...matter,
    currentSummary: newSummary,
    nextAction: newNextAction,
    lastEvidenceContextUnitId: resultUnitId ?? matter.lastEvidenceContextUnitId,
    lastEvidenceAt: meaningful ? now : matter.lastEvidenceAt, // unknown 不刷新证据时钟（保陈旧度真实）
    version: matter.version + 1,
    updatedAt: now,
  });

  writeAudit({
    action: 'investigation_written_back',
    reason: `AI 排查结论回写 matter（${c.verdict}）：${clip(factLine, 60)}`,
    payload: { matterId: matter.id, verdict: c.verdict, confidence: c.confidence, resultUnitId, startedAt: input.startedAt },
  });

  // MVP39：resolved 高置信 → 把"AI 查到这件事疑似已完成"浮成「确认办结」提案卡（不再埋在摘要里）。
  // 用户一键确认 = 一次"用户认可的自主完成"；不自动改 status（仍归用户裁决）。
  const proposalMatter = { ...matter, currentSummary: newSummary, nextAction: newNextAction, version: matter.version + 1, updatedAt: now };
  let proposalRaised = false;
  let autoResolved = false;
  // MVP71：needFromUser 一次性解析（LLM 合法值优先；否则确定性兜底推导）。供 needhelp 分流复用，不重复查 entities。
  const need = (c.verdict === 'blocked' || c.verdict === 'unknown') ? resolveNeedFromUser(matter, c) : undefined;
  // P1-4 级联护栏：若办结本 matter 会让其多成员问题类全部办结（→ syncClassStatusForResolvedMatter 把整类、含他人名下成员
  // 静默翻成已修复）——这种跨成员翻牌不该 AI 自动做，降级为人确认提案（仅 resolved 时才查，省开销）。
  const classImpact = (c.verdict === 'resolved' && config.problemClassEnabled) ? classCompletionImpactOfResolving(matter.id) : { willComplete: false as const };
  // 自主办结的额外护栏（对抗审查）：必须有证据（杜绝裸口说"已完成"）、且不碰 P0（高风险事项永远走人确认提案）。
  const autoResolveEligible =
    c.verdict === 'resolved' &&
    config.investigationAutoResolveEnabled &&
    c.confidence >= config.investigationAutoResolveMinConfidence &&
    c.evidence.length >= 1 &&
    matter.priority !== 'P0' &&
    c.solvability === 'can_close' && // 审查 P1-4：可逆性自评作硬门——AI 必须显式判"内部可逆可闭环"才自动办；
    // 对外/影响他人即便 LLM 误判 verdict=resolved+高置信，缺 can_close 也只降级人确认提案（守住"误判已完成"信任红线）。
    !classImpact.willComplete; // 级联护栏：会翻整问题类 → 不自动办
  if (autoResolveEligible) {
    // MVP55 放权第一档（内部可逆）：高置信 resolved → AI 直接办结（同 userResolveMatter 路径），
    // 浮一张「AI 已主动办结」透明回执卡（可一键重开）。办结失败则退回提案，不丢事件。
    const resolved = userResolveMatter(matter.id, `AI 自主排查高置信办结：${clip(factLine, 100)}`, now);
    if (resolved) {
      autoResolved = true;
      raiseMatterAutoResolvedReceipt(resolved, { factSummary: factLine, evidence: c.evidence, confidence: c.confidence });
      // 独立审计：便于在 Rules & Audit 面板按动作复查"AI 主动办了哪些"（区别于一般查清 investigation_written_back）。
      writeAudit({
        action: 'matter_auto_resolved',
        reason: `AI 自主办结（置信 ${c.confidence.toFixed(2)}）：${clip(factLine, 100)}`,
        payload: { matterId: matter.id, confidence: c.confidence, factSummary: factLine, evidence: c.evidence.slice(0, 3) },
      });
      // 与用户「已处理」同等待遇：排一次二档核实——若稍后查到矛盾证据，会浮「核实存疑」reopen 卡（该卡已豁免 resolved-sweep）。
      scheduleMatterResolveVerification({ matterId: matter.id, userNote: 'AI 自主办结（高置信），二档核实' });
    } else {
      proposalRaised = raiseMatterResolveProposal(proposalMatter, {
        why: `AI 自主排查发现这件事疑似已完成：${clip(factLine, 100)}。确认后该事项标记为已解决、相关催办卡自动清除。`,
        suggestedAction: '确认办结，或忽略保持跟进',
      });
    }
  } else if (c.verdict === 'resolved' && c.confidence >= 0.75) {
    // P1-4：被级联护栏拦下的"会翻整问题类"case 落这里——在提案里披露，让你知道确认的连带影响。
    const classNote = classImpact.willComplete
      ? `\n⚠️ 这是问题类「${classImpact.classLabel}」最后一个未办结的事项——为避免静默把整类（含他人名下成员）翻成已修复，AI 没有自动办结，请你确认。`
      : '';
    proposalRaised = raiseMatterResolveProposal(proposalMatter, {
      why: `AI 自主排查发现这件事疑似已完成：${clip(factLine, 100)}。确认后该事项标记为已解决、相关催办卡自动清除。${classNote}`,
      suggestedAction: '确认办结，或忽略保持跟进',
    });
  } else if (
    // MVP74「从查到解决」：AI 自评 can_produce_artifact 且**真定位到代码根因**（artifact 合法 + 有证据兜底）→
    // 升「修复方案」交付卡（不停在"查到X"）。互斥序 resolve > artifact > needhelp > progress > dangling：
    // 插在 needhelp 前；进入门比 needhelp 严（强制 targetRef + evidence≥1），缺则落到下面 needhelp/progress，
    // 绝不吞掉本该求助的 badcase（保护缺 traceID→need_credential 闭环）。verdict 无关（progressed/blocked 皆可）。
    c.solvability === 'can_produce_artifact' &&
    isValidArtifact(c.artifact) &&
    c.evidence.length >= 1 &&
    config.investigationArtifactEnabled
  ) {
    proposalRaised = raiseMatterArtifactProposal(proposalMatter, {
      artifact: c.artifact,
      factSummary: factLine,
      evidence: c.evidence,
    });
    if (proposalRaised) {
      // 诚实可审度量（对抗审查 P0-A）：payload 只落确定性可审字段。hasTargetRef 是 code_fix 质量标记（task_spec/decision_brief 无）。
      const ref = (c.artifact.targetRef ?? '').trim();
      writeAudit({
        action: 'matter_artifact_raised',
        reason: `AI 替你产出可执行件（${c.artifact.kind}）：${clip(c.artifact.title, 80)}${ref ? `（${ref.slice(0, 60)}）` : ''}`,
        payload: { matterId: matter.id, hasTargetRef: !!ref, artifactKind: c.artifact.kind },
      });
    } else if ((c.verdict === 'progressed' || c.verdict === 'blocked') && c.confidence >= 0.6) {
      // MVP74 审查 P2：交付卡因冷却/独立配额满没升起 → 别静默吞掉这次结论，落回进展卡兜底
      //（保留 pre-MVP74 行为：有进展就有可认可的回执）。
      proposalRaised = raiseMatterProgressProposal(proposalMatter, {
        verdict: c.verdict,
        factSummary: factLine,
        evidence: c.evidence,
        confidence: c.confidence,
      });
    }
  } else if (
    (c.verdict === 'blocked' || c.verdict === 'unknown') &&
    c.confidence >= 0.5 &&
    config.investigationNeedHelpEnabled &&
    isValidNeedFromUser(need) &&
    config.investigationNeedHelpKinds.includes(need.kind)
  ) {
    // MVP69/71：AI 卡住且明确知道缺哪件具体的事 → 升「需要你帮忙」求助卡。
    // MVP71：needFromUser 优先用 LLM 给的合法值；LLM 没给则**确定性兜底推导**（deriveNeedFromUser，零 LLM）。
    // 互斥顺序 resolve > needhelp > progress > dangling（插在 progress 前，否则 blocked 会被 progress 截胡）。
    // 降噪：config.investigationNeedHelpKinds 门控放哪些 kind（默认 need_credential + owned_by_other）。
    proposalRaised = raiseMatterNeedHelpProposal(proposalMatter, {
      needFromUser: need,
      factSummary: factLine,
      evidence: c.evidence,
    });
  } else if (
    // MVP75「输出结果而非过程」：AI 给了一条**达标的直接建议**（过防换壳硬门 + 引证据）→ 升「💡 我的建议」卡。
    // 互斥序 resolve > artifact > needhelp > 💡建议 > progress > dangling（在 needhelp 之后，不抢求助闭环）。
    config.investigationRecoCardEnabled &&
    gradeRecommendation(c.recommendation, c.factSummary, c.evidence) &&
    c.evidence.length >= 1
  ) {
    proposalRaised = raiseMatterRecommendationProposal(proposalMatter, {
      recommendation: c.recommendation!,
      factSummary: factLine,
    });
    if (proposalRaised) {
      // 结果率北极星：audit **只在真升💡卡分支写**（与 artifact/resolve 互斥，不重复计数虚高）。
      writeAudit({
        action: 'investigation_recommended',
        reason: `AI 给你一条建议（${c.recommendation!.stance}）：${clip(c.recommendation!.advice, 80)}`,
        payload: { matterId: matter.id, stance: c.recommendation!.stance },
      });
    } else if ((c.verdict === 'progressed' || c.verdict === 'blocked') && c.confidence >= 0.6) {
      // 配额满/冷却没升起 → 回落进展卡兜底（仿 artifact，别静默吞）。
      proposalRaised = raiseMatterProgressProposal(proposalMatter, {
        verdict: c.verdict, factSummary: factLine, evidence: c.evidence, confidence: c.confidence,
      });
    }
  } else if ((c.verdict === 'progressed' || c.verdict === 'blocked') && c.confidence >= 0.6) {
    // MVP40：progressed/blocked 是 AI 对"跟进进展"的完整答复 → 升「进展回执」卡（不再只埋摘要）。
    // 把可认可的自主完成事件从仅 resolved（~4%）扩到 ~32%。
    proposalRaised = raiseMatterProgressProposal(proposalMatter, {
      verdict: c.verdict,
      factSummary: factLine,
      evidence: c.evidence,
      confidence: c.confidence,
    });
  } else if (c.verdict === 'unknown' && c.confidence > 0) {
    // MVP67：真实 unknown（conf>0，AI 确实查了但查无跟进）——若这是**你自己欠的承诺**，
    // 别再静默丢弃这次排查，把它变成一张「待你处理」提醒（你欠的事疑似一直没动）。
    proposalRaised = maybeRaiseDanglingCommitment(matter, factLine);
  }

  try {
    broadcast({ type: 'matter_updated', matterId: matter.id });
  } catch {}

  return { ok: true, matterId: matter.id, resultUnitId, summaryUpdated: meaningful, proposalRaised, autoResolved };
}

/** MVP71：取该 matter 的实体（带 id/name/type/role），供确定性「需要你」分类器用。复用 dispatcher buildEntities 模式。 */
function buildMatterEntitiesForClassifier(matterId: string): Array<{ id: string; name: string; type: string; role: string }> {
  return listMatterEntities(matterId)
    .map((l) => {
      const e = getContextEntityById(l.entityId);
      return e ? { id: e.id, name: e.name, type: e.type, role: String(l.role) } : null;
    })
    .filter((x): x is { id: string; name: string; type: string; role: string } => x !== null);
}

/**
 * MVP71：解析 needFromUser——LLM 给的合法值优先；LLM 没给（实测常态）则**确定性兜底推导**（零 LLM）。
 * 这是让 needhelp 卡真正能触发的关键（修「100% 依赖 LLM 自觉、实测从不填」根因）。
 */
function resolveNeedFromUser(
  matter: ReturnType<typeof getMatterById>,
  c: InvestigationConclusion
): NeedFromUser | undefined {
  if (isValidNeedFromUser(c.needFromUser)) return c.needFromUser;
  if (!matter) return undefined;
  // MVP72：内容信号兜底——AI 在 factSummary 里说自己"缺日志ID/traceID"却没填结构化 needFromUser，
  // 实体分类器(deriveNeedFromUser)也只认 owned_by_other → 这类"该深挖代码却缺凭据"的 badcase 漏掉。
  // dacd120c 实证：blocked@0.7 + "未能捞到那两个日志 ID"，既不深挖也不求助。这里从内容识别并合成 need_credential。
  const credNeed = deriveCredentialNeed(c.verdict, c.confidence, c.factSummary);
  if (credNeed) return credNeed;
  const selfSet = getSelfEntityIds();
  const entities = buildMatterEntitiesForClassifier(matter.id);
  return deriveNeedFromUser({ verdict: c.verdict, confidence: c.confidence }, { entities, selfSet });
}

// MVP72：factSummary 里"缺(日志ID/traceID)"的内容信号——「missing 动词 + 凭据名词」近邻匹配。
// 只挡 missing 语境（已用/已拿到 不命中），下游又是 blocked/unknown + 待审卡，偶发过命中无害。
const MISSING_CRED_RE = /(?:需要|缺|未|无法|没有|找不到|拿不到)[^。；\n]{0,22}(?:日志\s*ID|日志号|trace\s*?id)/i;
/** 从结论内容识别"缺日志ID/traceID"→合成 need_credential（LLM 与实体分类器都漏的内容信号）。导出供测试。 */
export function deriveCredentialNeed(verdict: string, confidence: number, factSummary?: string): NeedFromUser | undefined {
  if (verdict !== 'blocked' && verdict !== 'unknown') return undefined;
  if (confidence <= 0) return undefined;
  if (!MISSING_CRED_RE.test((factSummary || '').trim())) return undefined;
  return {
    kind: 'need_credential',
    ask: '要把这个 badcase 追到代码根因，我需要它的 traceID 或日志ID——你有的话发我，我就用 bytedcli/fornax 拉 trace 接着追。',
  };
}

/**
 * MVP71 §11.1（修真因）：dangling 的**独立静态扫描**——不依赖"又跑了一次排查"。
 *
 * 真因（git+audit 实证）：dangling 浮出原本只在 writeback 的 unknown 分支触发，但需要浮出的 stuck 承诺
 * 恰恰被 MVP66「无新外部证据不重查」门正确地停查了——于是 dangling 代码出生后，对存量 stuck 件**从不被调用**。
 * 本扫描确定性遍历 open/in_progress matter：是你欠的承诺（isSelfCommitment 三信号）+ 够旧 +
 * AI 确实查过且查不清（近期有 unknown/blocked，conf>0）→ 升「待你处理」卡。零 LLM、零 gate、幂等+合并配额兜噪。
 */
export function scanDanglingCommitments(): number {
  if (!config.investigationDanglingReminderEnabled) return 0;
  const selfSet = getSelfEntityIds();
  if (selfSet.size === 0) return 0;
  let raised = 0;
  for (const m of listMatters({ statuses: ['open', 'in_progress'], limit: 300 })) {
    const execIds = listMatterEntities(m.id).filter((l) => String(l.role) === 'executor').map((l) => l.entityId);
    if (!isSelfCommitment(m, execIds, selfSet)) continue;
    const ageMs = Date.now() - new Date(m.createdAt).getTime();
    const overdue = m.dueAt ? new Date(m.dueAt).getTime() < Date.now() : false;
    if (!overdue && ageMs < config.investigationDanglingMinAgeMs) continue;
    // 必须 AI 真查过且查不清（近期 unknown/blocked，conf>0）——否则可能只是还没排查，先别催。
    const verdicts = getRecentInvestigationVerdicts(m.id, 3);
    if (!verdicts.some((v) => (v.verdict === 'unknown' || v.verdict === 'blocked') && v.confidence > 0)) continue;
    const ageDays = Math.max(1, Math.round(ageMs / 86_400_000));
    if (raiseMatterDanglingCommitmentProposal(m, { ageDays, factSummary: clip(m.currentSummary || '', 140) })) raised++;
  }
  if (raised > 0) console.log(`[dangling-scan] 升「待你处理」卡 ${raised} 张（停查存量承诺浮出）`);
  return raised;
}

/**
 * MVP67/71：把"你自己欠的承诺被查得 unknown（查无跟进）"变成一张可处理的待办提醒。
 * MVP71 修真因：判定从"只认 owner_entity_id"（88% 为空、永不命中）换成 isSelfCommitment 三信号
 * （标题「（对X承诺）」/ executor∈selfSet / owner∈selfSet），并用稳健 self 身份集绕开身份碎裂。
 * 其余门不动：够旧（overdue 或 创建满阈值）、无在场办结/进展/求助提案（helper 内兜）。
 * 注意：这是「新鲜 unknown 即时升」路径；停查后才够旧的存量由 scanDanglingCommitments 静态扫描兜（§11.1）。
 */
function maybeRaiseDanglingCommitment(matter: ReturnType<typeof getMatterById>, factLine: string): boolean {
  if (!matter) return false;
  if (!config.investigationDanglingReminderEnabled) return false;
  const selfSet = getSelfEntityIds();
  if (selfSet.size === 0) return false;
  const execIds = listMatterEntities(matter.id).filter((l) => String(l.role) === 'executor').map((l) => l.entityId);
  if (!isSelfCommitment(matter, execIds, selfSet)) return false; // 仅你自己欠的（三信号高精度）
  const ageMs = Date.now() - new Date(matter.createdAt).getTime();
  const overdue = matter.dueAt ? new Date(matter.dueAt).getTime() < Date.now() : false;
  if (!overdue && !(ageMs >= config.investigationDanglingMinAgeMs)) return false; // 够旧才提醒
  const ageDays = Math.max(1, Math.round(ageMs / 86_400_000));
  return raiseMatterDanglingCommitmentProposal(matter, { ageDays, factSummary: factLine });
}
