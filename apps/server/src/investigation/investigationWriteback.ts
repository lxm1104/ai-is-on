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
import { attachMatterContextLink, getMatterById, saveMatter } from '../matter/matterStore.js';
import { userResolveMatter } from '../matter/matterActions.js';
import { raiseMatterResolveProposal, raiseMatterProgressProposal, raiseMatterAutoResolvedReceipt, raiseMatterDanglingCommitmentProposal } from '../matter/matterResolveProposal.js';
import { scheduleMatterResolveVerification } from '../matter/matterVerifyService.js';
import { getSetting } from '../db.js';
import { resolveAliased } from '../context/entityResolver.js';
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
    payload: { matterId: matter.id, verdict: c.verdict, confidence: c.confidence, resultUnitId },
  });

  // MVP39：resolved 高置信 → 把"AI 查到这件事疑似已完成"浮成「确认办结」提案卡（不再埋在摘要里）。
  // 用户一键确认 = 一次"用户认可的自主完成"；不自动改 status（仍归用户裁决）。
  const proposalMatter = { ...matter, currentSummary: newSummary, nextAction: newNextAction, version: matter.version + 1, updatedAt: now };
  let proposalRaised = false;
  let autoResolved = false;
  // 自主办结的额外护栏（对抗审查）：必须有证据（杜绝裸口说"已完成"）、且不碰 P0（高风险事项永远走人确认提案）。
  const autoResolveEligible =
    c.verdict === 'resolved' &&
    config.investigationAutoResolveEnabled &&
    c.confidence >= config.investigationAutoResolveMinConfidence &&
    c.evidence.length >= 1 &&
    matter.priority !== 'P0';
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
    proposalRaised = raiseMatterResolveProposal(proposalMatter, {
      why: `AI 自主排查发现这件事疑似已完成：${clip(factLine, 100)}。确认后该事项标记为已解决、相关催办卡自动清除。`,
      suggestedAction: '确认办结，或忽略保持跟进',
    });
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

/**
 * MVP67：把"你自己欠的承诺被查得 unknown（查无跟进）"变成一张可处理的待办提醒。
 * 高精度低噪门（实测：13 个被反复空查的元凶里仅 2 个 owner=自己，正是"对X承诺"的 dangling commitment）：
 *  - owner=自己（你欠的，才由你处理；他人名下的不归你催）；
 *  - 够旧：已过期 或 创建满阈值（避免刚承诺就被催）；
 *  - 无在场办结/进展提案（raiseMatterDanglingCommitmentProposal 内部再兜一层）。
 * 一次性：升后 MVP66「无新外部证据不重查」门会挡住后续重查 → 不复发。
 */
function maybeRaiseDanglingCommitment(matter: ReturnType<typeof getMatterById>, factLine: string): boolean {
  if (!matter) return false;
  if (!config.investigationDanglingReminderEnabled) return false;
  const selfRaw = getSetting('self_person_entity_id') ?? '';
  if (!selfRaw) return false;
  const self = resolveAliased(selfRaw);
  if (!matter.ownerEntityId || resolveAliased(matter.ownerEntityId) !== self) return false; // 仅你自己欠的
  const ageMs = Date.now() - new Date(matter.createdAt).getTime();
  const overdue = matter.dueAt ? new Date(matter.dueAt).getTime() < Date.now() : false;
  if (!overdue && !(ageMs >= config.investigationDanglingMinAgeMs)) return false; // 够旧才提醒
  const ageDays = Math.max(1, Math.round(ageMs / 86_400_000));
  return raiseMatterDanglingCommitmentProposal(matter, { ageDays, factSummary: factLine });
}
