import { randomUUID } from 'node:crypto';
import {
  type ActionProposalRow,
  insertActionProposal,
} from '../db.js';
import { createCardFromProposal } from '../cards/cardsService.js';
import type { AgentHandler } from './agentRegistry.js';

/**
 * MVP3 track_commitment agent — pure local, no LLM.
 *
 * Input: trigger of type 'commitment_due' with a payload that already includes
 *   { commitmentTitle, dueAt, overdue, hoursAbs, entities }.
 *
 * Output: one action_proposal (kind='reminder'), projected into one SignalCard.
 *   - overdue → P1 "承诺逾期 — <title>"
 *   - 24h 内到期 → P1 "承诺将到期 — <title>"
 *   - >24h (shouldn't fire normally, see evaluator window) → P2
 *
 * MVP3 不做"是否已完成"判断 — 需要 action_result kind 的 ContextUnit 完整链路，
 * 留到 MVP3.x。这里默认每个 commitment_due 都出一张提醒卡。idempotency 已经
 * 由 triggers UNIQUE(type, unit, bucket=YYYY-MM-DD) 保证：同一天不会重触发。
 */
export const trackCommitmentHandler: AgentHandler = async ({ trigger, unit }) => {
  const payload = safeJSON(trigger.payload_json) as {
    commitmentTitle?: string;
    dueAt?: string;
    overdue?: boolean;
    hoursAbs?: number;
    entities?: Array<{ type: string; name: string }>;
  } | null;

  const title = payload?.commitmentTitle ?? unit?.title ?? '一项承诺';
  const overdue = payload?.overdue === true;
  const hours = payload?.hoursAbs ?? 0;
  const dueAt = payload?.dueAt ?? unit?.time?.dueAt;
  const entities = payload?.entities ?? unit?.entities?.map((e) => ({ type: e.type, name: e.name })) ?? [];

  const priority: 'P0' | 'P1' | 'P2' | 'P3' = overdue || hours < 24 ? 'P1' : 'P2';
  const cardTitle = overdue
    ? `承诺已逾期：${title}`
    : `承诺即将到期：${title}`;

  const bodyLines: string[] = [];
  bodyLines.push(overdue ? `已逾期约 ${hours} 小时。` : `还有 ${hours} 小时到期。`);
  if (dueAt) bodyLines.push(`原定时间：${formatLocal(dueAt)}`);
  if (entities.length) {
    const names = entities.map((e) => `${e.type === 'person' ? '@' : ''}${e.name}`).join('、');
    bodyLines.push(`相关：${names}`);
  }
  bodyLines.push(
    overdue
      ? '建议：检查是否已经完成；若未完成，向相关方说明并给新时间。'
      : '建议：今天内主动推进或确认进展。'
  );

  const body = bodyLines.join('\n');

  const now = new Date().toISOString();
  const proposalId = randomUUID();
  const proposal: ActionProposalRow = {
    id: proposalId,
    agent_run_id: null,                // queue 不把 run id 传进 handler；MVP3.x 可以加
    proposal_type: 'reminder',
    title: cardTitle,
    body,
    reversible: 1,
    impact_scope: 'self',
    requires_approval: 0,              // 这只是提醒，不向外做事
    status: 'projected',
    payload_json: JSON.stringify({
      priority,
      contextUnitId: unit?.id,
      triggerId: trigger.id,
      overdue,
      dueAt,
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
  });

  return {
    summary: `${overdue ? 'overdue' : 'due-soon'} reminder for "${title}" (P=${priority})`,
    proposalIds: [proposalId],
    cardIds: [card.id],
    data: { priority, overdue, hoursAbs: hours },
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

