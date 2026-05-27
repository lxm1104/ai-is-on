import { randomUUID } from 'node:crypto';
import {
  type ActionProposalRow,
  insertActionProposal,
} from '../db.js';
import { createCardFromProposal } from '../cards/cardsService.js';
import { recommendHandling } from '../context/agentContextAssembler.js';
import type { AgentHandler } from './agentRegistry.js';

/**
 * MVP3 → MVP8.1 升级版 track_commitment.
 *
 * 行为变化：
 *  - 读 packet.latestActionResult：若同 entity 已有 action_result，跳过提醒（doc §5.5.3）
 *  - 用 packet.subject.responsibilities + packet.spaces[*].priority 推 priority
 *  - 写 action_proposals 时填 agent_run_id（doc §5.3.2）
 *  - createCardFromProposal 透传 triggerType / kind / entities（doc §5.4）
 *
 * 仍然不调 LLM，纯本地。
 */
export const trackCommitmentHandler: AgentHandler = async ({
  trigger,
  unit,
  packet,
  agentRunId,
}) => {
  const payload = safeJSON(trigger.payload_json) as {
    commitmentTitle?: string;
    dueAt?: string;
    overdue?: boolean;
    hoursAbs?: number;
    entities?: Array<{ type: string; name: string }>;
  } | null;

  // ① already done？ packet.latestActionResult 指明同实体最近 action_result
  if (packet?.latestActionResult) {
    return {
      summary: `commitment skipped (latestActionResult ${packet.latestActionResult.id} present)`,
      proposalIds: [],
      cardIds: [],
      data: { skipped: 'already_done', actionResultId: packet.latestActionResult.id },
    };
  }

  const title = payload?.commitmentTitle ?? unit?.title ?? '一项承诺';
  const overdue = payload?.overdue === true;
  const hours = payload?.hoursAbs ?? 0;
  const dueAt = payload?.dueAt ?? unit?.time?.dueAt;
  const entities =
    payload?.entities ?? unit?.entities?.map((e) => ({ type: e.type, name: e.name })) ?? [];

  // ② priority：考虑 Space critical / subject 责任覆盖度
  let priority: 'P0' | 'P1' | 'P2' | 'P3' = overdue || hours < 24 ? 'P1' : 'P2';
  const criticalSpace = packet?.spaces?.find((s) => s.priority === 'critical');
  if (criticalSpace) priority = overdue ? 'P0' : 'P1';

  // ②.5 MVP15B M8 graphContext 调权（projectPhase 影响 priority）
  // 注意 commitmentAgent 入口 priority 已经是 P1/P2（overdue/hours 决定），
  // 不会是 P3；P3 分支也不展开。
  const gc = packet?.graphContext;
  if (gc?.projectPhase?.health === 'overdue') {
    // 项目整体已逾期 → 再升一档
    if (priority === 'P2') priority = 'P1';
    else if (priority === 'P1') priority = 'P0';
  } else if (gc?.projectPhase?.phase === 'frozen') {
    // frozen 项目降一档（用户暂停了的事不该被催）
    if (priority === 'P1') priority = 'P2';
    else if (priority === 'P2') priority = 'P3';
  }
  // at_risk 不动 — 已经是 P1/P2 不需再升

  const cardTitle = overdue ? `承诺已逾期：${title}` : `承诺即将到期：${title}`;

  const bodyLines: string[] = [];
  bodyLines.push(overdue ? `已逾期约 ${hours} 小时。` : `还有 ${hours} 小时到期。`);
  if (dueAt) bodyLines.push(`原定时间：${formatLocal(dueAt)}`);
  if (entities.length) {
    const names = entities.map((e) => `${e.type === 'person' ? '@' : ''}${e.name}`).join('、');
    bodyLines.push(`相关：${names}`);
  }
  if (criticalSpace) {
    bodyLines.push(`所属项目 ${criticalSpace.name}：本周关键 (${criticalSpace.priority})`);
  } else if (packet?.spaces?.length) {
    const names = packet.spaces.map((s) => s.name).join('、');
    bodyLines.push(`所属项目：${names}`);
  }
  if (packet?.subject?.responsibilities?.length) {
    // 让用户能看到 agent 已经知道我是谁；MVP8.1 先用最简单的方式：仅写 1 条最相关的
    bodyLines.push(`我的职责：${packet.subject.responsibilities[0]}`);
  }

  // MVP15B M8 graphContext 文案分支
  let suggestedActionHint: string | null = null;
  if (gc) {
    // (1) projectPhase 提示
    if (gc.projectPhase) {
      const phaseLabel = `${gc.projectPhase.phase}/${gc.projectPhase.health}`;
      bodyLines.push(
        `所属项目阶段：${phaseLabel}${gc.projectPhase.summary ? ` — ${gc.projectPhase.summary}` : ''}`
      );
    }
    // (2) decisionPath: 列出 decision_authority=high 的 owner（非 self），让用户知道找谁同步
    const topOwner = gc.decisionPath.find(
      (d) => (d.role === 'owner' || d.role === 'driver') && d.decisionAuthority === 'high'
    ) ?? gc.decisionPath.find((d) => d.role === 'owner' || d.role === 'driver');
    if (topOwner) {
      bodyLines.push(`该项目 owner：${topOwner.name}（建议同步给 TA）`);
    }
    // (3) expectedButMissing：suggestedAction 加抄送候选
    if (gc.expectedButMissing.persons.length > 0) {
      const names = gc.expectedButMissing.persons
        .slice(0, 2)
        .map((p) => p.name)
        .join('、');
      suggestedActionHint = `可考虑抄：${names}`;
    }
    // (4) activeBlockers 提示（如果有上游阻塞）
    if (gc.activeBlockers.length > 0) {
      const blocker = gc.activeBlockers[0];
      bodyLines.push(
        `可能上游 blocker：${blocker.blockerTitle}${blocker.blockerOwner ? `（owner=${blocker.blockerOwner}）` : ''}`
      );
    }
  }

  const baseSuggestion = overdue
    ? '建议：检查是否已经完成；若未完成，向相关方说明并给新时间。'
    : '建议：今天内主动推进或确认进展。';
  bodyLines.push(
    suggestedActionHint ? `${baseSuggestion} ${suggestedActionHint}` : baseSuggestion
  );

  // ③ handlingPolicy 推荐
  const handlingRec = packet ? recommendHandling(packet) : null;

  const body = bodyLines.join('\n');

  const now = new Date().toISOString();
  const proposalId = randomUUID();
  const proposal: ActionProposalRow = {
    id: proposalId,
    agent_run_id: agentRunId,           // MVP8.1 §5.3.2 必填
    proposal_type: 'reminder',
    title: cardTitle,
    body,
    reversible: 1,
    impact_scope: 'self',
    requires_approval: 0,
    status: 'projected',
    payload_json: JSON.stringify({
      priority,
      contextUnitId: unit?.id,
      triggerId: trigger.id,
      overdue,
      dueAt,
      spacePriority: criticalSpace?.priority ?? packet?.spaces?.[0]?.priority ?? null,
      recommendedHandling: handlingRec?.handling ?? null,
      handlingReason: handlingRec?.reason ?? null,
    }),
    created_at: now,
    updated_at: now,
  };
  insertActionProposal(proposal);

  const reason = trigger.reasoning ?? (overdue ? '承诺已逾期' : '承诺即将到期');
  const card = createCardFromProposal({
    proposal,
    agentType: 'track_commitment',
    priority,
    source: 'agent',
    reason,
    triggerType: trigger.trigger_type,
    kind: unit?.kind,
    entities,
    scope: 'work',
  });

  return {
    summary: `${overdue ? 'overdue' : 'due-soon'} reminder for "${title}" (P=${priority})${card ? '' : ' [boundary-blocked]'}`,
    proposalIds: [proposalId],
    cardIds: card ? [card.id] : [],
    data: {
      priority,
      overdue,
      hoursAbs: hours,
      boundaryBlocked: !card,
      recommendedHandling: handlingRec?.handling,
      spacePriority: criticalSpace?.priority ?? null,
    },
  };
};

function safeJSON(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function formatLocal(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}
