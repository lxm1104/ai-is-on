import { randomUUID } from 'node:crypto';
import {
  type ActionProposalRow,
  type CardRow,
  type EventRow,
  getCard,
  insertCard,
  insertUserRule,
  listOpenCards,
  updateCardStatus,
} from '../db.js';
import { evaluateCard, type CardCandidate } from '../boundary/boundaryEvaluator.js';
import { writeAudit } from '../boundary/auditLog.js';
import { createRule } from '../boundary/boundaryStore.js';
import type { CardSourceKey, Priority } from '../boundary/BoundaryRule.js';
import { broadcast } from '../ws.js';
import { recordUserMessage } from '../messageBus.js';
import { claudeRuntime } from '../claude/ClaudeRuntime.js';
import type {
  CardAction,
  CardActionKind,
  CardStatus,
  SignalCard,
} from '../claude/protocol.js';
import type { TriageItem } from '../triage/parseTriage.js';

function rowToCard(row: CardRow): SignalCard {
  let actions: CardAction[] = [];
  try {
    actions = JSON.parse(row.actions_json) as CardAction[];
  } catch {}
  return {
    id: row.id,
    triageId: row.triage_id ?? undefined,
    priority: row.priority as SignalCard['priority'],
    source: row.source as SignalCard['source'],
    title: row.title,
    summary: row.summary,
    reason: row.reason,
    suggestedAction: row.suggested_action ?? undefined,
    draftReply: row.draft_reply ?? undefined,
    status: row.status as CardStatus,
    actions,
    rawEventId: row.raw_event_id ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    sourceKind: (row.source_kind as SignalCard['sourceKind']) ?? 'triage',
    sourceRefId: row.source_ref_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultActionsForSource(source: string): CardAction[] {
  const ack: CardAction = { id: 'ack', label: '知道了', kind: 'ack' };
  const snooze: CardAction = { id: 'snooze', label: '稍后提醒', kind: 'snooze' };
  const dismiss: CardAction = { id: 'dismiss', label: '忽略这类', kind: 'dismiss' };
  const auto: CardAction = {
    id: 'auto_henceforth',
    label: '以后自动',
    kind: 'auto_henceforth',
  };
  const askAgent: CardAction = {
    id: 'ask_agent',
    label: '帮我处理',
    kind: 'ask_agent',
  };
  if (source === 'im') {
    return [
      { id: 'draft_reply', label: '生成回复草稿', kind: 'draft_reply' },
      askAgent,
      ack,
      auto,
      dismiss,
    ];
  }
  return [askAgent, ack, snooze, auto, dismiss];
}

export function createCardsFromTriage(ev: EventRow, item: TriageItem, triageId: string) {
  const candidate: CardCandidate = {
    priority: item.priority,
    source: ev.source,
  };
  const decision = evaluateCard(candidate);
  if (decision.decision === 'block') {
    writeAudit({
      action: 'card_blocked',
      reason: decision.reason,
      ruleId: decision.matchedRule.id,
      payload: { eventId: ev.id, triageId, title: item.title, priority: item.priority },
    });
    return;
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const actions = item.cardActions?.length
    ? item.cardActions
    : defaultActionsForSource(ev.source);
  const status: SignalCard['status'] = decision.decision === 'soften' ? 'batched' : 'new';
  const row: CardRow = {
    id,
    triage_id: triageId,
    priority: item.priority,
    source: ev.source,
    title: item.title || ev.title || ev.text.slice(0, 30),
    summary: item.summary,
    reason: item.reason,
    suggested_action: item.suggestedAction ?? null,
    draft_reply: item.draftReply ?? null,
    status,
    actions_json: JSON.stringify(actions),
    raw_event_id: ev.id,
    source_url: ev.url,
    source_kind: 'triage',
    source_ref_id: triageId,
    created_at: now,
    updated_at: now,
  };
  insertCard(row);
  if (decision.decision === 'soften') {
    writeAudit({
      action: 'card_softened',
      reason: decision.reason,
      cardId: id,
      ruleId: decision.matchedRule.id,
      payload: { priority: item.priority, source: ev.source },
    });
  }
  broadcast({ type: 'card_created', card: rowToCard(row) });
}

export type ProposalCardInput = {
  proposal: ActionProposalRow;
  agentType: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  source: string;                     // 'agent' | 'calendar' | 'im' | ...
  reason: string;                     // 为什么生成这张卡
  suggestedAction?: string;
  draftReply?: string;
  rawEventId?: string;
  sourceUrl?: string;
  actions?: CardAction[];             // 默认走 defaultActionsForSource
};

/**
 * Project an ActionProposal into a SignalCard. source_kind='agent_run',
 * source_ref_id is the proposal id, so we can trace back through audit logs.
 */
export function createCardFromProposal(input: ProposalCardInput): SignalCard | null {
  const decision = evaluateCard({
    priority: input.priority,
    source: input.source,
  });
  if (decision.decision === 'block') {
    writeAudit({
      action: 'card_blocked',
      reason: decision.reason,
      ruleId: decision.matchedRule.id,
      payload: {
        proposalId: input.proposal.id,
        title: input.proposal.title,
        priority: input.priority,
        agentType: input.agentType,
      },
    });
    return null;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const actions = input.actions?.length ? input.actions : defaultActionsForSource(input.source);
  const status: SignalCard['status'] = decision.decision === 'soften' ? 'batched' : 'new';
  const row: CardRow = {
    id,
    triage_id: null,
    priority: input.priority,
    source: input.source,
    title: input.proposal.title,
    summary: input.proposal.body.slice(0, 120),
    reason: input.reason,
    suggested_action: input.suggestedAction ?? null,
    draft_reply: input.draftReply ?? null,
    status,
    actions_json: JSON.stringify(actions),
    raw_event_id: input.rawEventId ?? null,
    source_url: input.sourceUrl ?? null,
    source_kind: 'agent_run',
    source_ref_id: input.proposal.id,
    created_at: now,
    updated_at: now,
  };
  insertCard(row);
  if (decision.decision === 'soften') {
    writeAudit({
      action: 'card_softened',
      reason: decision.reason,
      cardId: id,
      ruleId: decision.matchedRule.id,
      payload: { priority: input.priority, source: input.source, agentType: input.agentType },
    });
  }
  const card = rowToCard(row);
  broadcast({ type: 'card_created', card });
  return card;
}

export function listCards(): SignalCard[] {
  return listOpenCards(100).map(rowToCard);
}

export type CardActionResult = { ok: boolean; card?: SignalCard; error?: string };

export async function applyCardAction(
  cardId: string,
  actionId: string
): Promise<CardActionResult> {
  const row = getCard(cardId);
  if (!row) return { ok: false, error: 'card not found' };

  // synthetic built-in: reopen — flip status back to 'new'，前端 UI 上用得到
  if (actionId === '__reopen') {
    const now = new Date().toISOString();
    const updated = updateCardStatus(cardId, 'new', now);
    if (!updated) return { ok: false, error: 'update failed' };
    const card = rowToCard(updated);
    broadcast({ type: 'card_updated', card });
    return { ok: true, card };
  }

  let actions: CardAction[] = [];
  try {
    actions = JSON.parse(row.actions_json) as CardAction[];
  } catch {}
  const action = actions.find((a) => a.id === actionId);
  if (!action) return { ok: false, error: `unknown action ${actionId}` };

  const now = new Date().toISOString();
  const newStatus = mapKindToStatus(action.kind, row.status as CardStatus);

  if (action.kind === 'dismiss') {
    insertUserRule({
      id: randomUUID(),
      rule_type: 'dismiss_like',
      description: `用户在卡片"${row.title}"上点了"忽略这类"。Source=${row.source} Reason=${row.reason}`,
      source_card_id: row.id,
      active: 1,
      created_at: now,
    });
  }

  if (action.kind === 'auto_henceforth') {
    // MVP6: infer a structured boundary_rule from the card's current shape.
    const rule = createRule({
      scope: 'work',
      condition: {
        source: [row.source as CardSourceKey],
        priorityAtMost: row.priority as Priority,
      },
      allowedAction: 'record',
      requiresApproval: false,
      confidence: 0.75,
      source: 'card_action',
      learnedFromCardId: row.id,
      active: true,
    });
    writeAudit({
      action: 'rule_learned',
      reason: `用户在卡片"${row.title}"上选择"以后自动处理"`,
      cardId: row.id,
      ruleId: rule.id,
      payload: { priority: row.priority, source: row.source },
    });
  }

  if (action.kind === 'ask_agent' || action.kind === 'draft_reply') {
    const prompt = action.prompt?.trim() || buildDefaultPrompt(row, action.kind);
    recordUserMessage(prompt);
    try {
      // MVP2.2: 卡片动作的内部 prompt 已经把卡片自身 context 嵌进去了，
      // 不再额外 prepend active_context summary，避免重复并节省 token。
      await claudeRuntime.sendUserMessage(prompt, { skipContext: true });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const updated = updateCardStatus(cardId, newStatus, now);
  if (!updated) return { ok: false, error: 'update failed' };
  const card = rowToCard(updated);
  broadcast({ type: 'card_updated', card });
  return { ok: true, card };
}

function mapKindToStatus(kind: CardActionKind, prev: CardStatus): CardStatus {
  switch (kind) {
    case 'ack':
      return 'acknowledged';
    case 'snooze':
      return 'snoozed';
    case 'dismiss':
    case 'auto_henceforth':
      // 学了规则后，这张卡片本身也算"以后不需要看了"
      return 'dismissed';
    case 'mark_done':
      return 'done';
    case 'ask_agent':
    case 'draft_reply':
      // 触发后台 Claude，但保留为 new/ack，让用户能继续看到
      return prev === 'new' ? 'acknowledged' : prev;
    case 'open_source':
      return prev;
    default:
      return prev;
  }
}

function buildDefaultPrompt(row: CardRow, kind: 'ask_agent' | 'draft_reply'): string {
  const base = [
    `请处理这条来自卡片的请求。`,
    `来源：${row.source}`,
    `标题：${row.title}`,
    `摘要：${row.summary}`,
    row.suggested_action ? `建议动作：${row.suggested_action}` : '',
    row.source_url ? `链接：${row.source_url}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (kind === 'draft_reply') {
    return `${base}\n\n请只生成一份适合用飞书消息回复的草稿，不要发送、不要调用任何写操作工具。`;
  }
  return `${base}\n\n请按你的判断给出下一步建议或必要的查询结果，不要调用任何写操作工具。`;
}
