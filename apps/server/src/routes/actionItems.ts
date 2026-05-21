import { Router } from 'express';
import {
  getActionProposal,
  getCard,
  updateCardStatus,
} from '../db.js';
import { upsertContextUnit } from '../context/contextStore.js';
import { writeAudit } from '../boundary/auditLog.js';
import { broadcast } from '../ws.js';
import { rowToCard } from '../cards/cardsService.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';

export const actionItemsRouter = Router();

type RecapPayload = {
  priority?: string;
  contextUnitId?: string;
  triggerId?: string;
  minuteToken?: string;
  summary?: string;
  actionItems?: Array<{
    owner: string;
    task: string;
    suggestedDueAt: string | null;
    confidence: number;
  }>;
  decisions?: string[];
  openQuestions?: string[];
};

/**
 * MVP11.1 §5.5：把 recap ask 卡片上的 actionItems 转 commitment unit。
 * 由前端在用户点「全部入库」时调用。
 * - accept='all'：每条 actionItem upsertContextUnit kind='commitment'
 * - accept='none'：只写 audit
 * 服务端把卡片标记成 done / dismissed。
 */
actionItemsRouter.post('/cards/:id/action-items/confirm', (req, res) => {
  const cardId = req.params.id;
  const accept = req.body?.accept === 'all' ? 'all' : 'none';

  const card = getCard(cardId);
  if (!card) {
    res.status(404).json({ error: 'card not found' });
    return;
  }
  if (card.source_kind !== 'agent_run' || !card.source_ref_id) {
    res.status(400).json({ error: 'card is not backed by an action_proposal' });
    return;
  }
  const proposal = getActionProposal(card.source_ref_id);
  if (!proposal) {
    res.status(404).json({ error: 'action_proposal not found' });
    return;
  }
  if (proposal.proposal_type !== 'meeting_action_items') {
    res.status(400).json({ error: `proposal_type=${proposal.proposal_type} is not meeting_action_items` });
    return;
  }
  let payload: RecapPayload;
  try {
    payload = JSON.parse(proposal.payload_json ?? '{}') as RecapPayload;
  } catch (err) {
    res.status(500).json({ error: 'invalid proposal payload_json' });
    return;
  }

  const now = new Date().toISOString();
  const minuteToken = payload.minuteToken ?? '';
  const items = payload.actionItems ?? [];
  const writtenIds: string[] = [];

  if (accept === 'all' && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const entities: ContextEntityRef[] = [];
      if (minuteToken) {
        entities.push({ type: 'meeting', name: minuteToken, role: 'about' });
      }
      if (it.owner && it.owner !== '待定' && it.owner !== '我') {
        entities.push({ type: 'person', name: it.owner, role: 'subject' });
      }
      const time = it.suggestedDueAt ? { dueAt: it.suggestedDueAt } : undefined;
      const r = upsertContextUnit({
        kind: 'commitment',
        title: it.task,
        content: `${it.owner}：${it.task}${it.suggestedDueAt ? `（建议 ${it.suggestedDueAt}）` : ''}`,
        entities,
        scope: 'work',
        origin: { kind: 'card_action', refId: card.id },
        time,
        actionability: 'act',
        confidence: it.confidence ?? 0.7,
        mergeHint: `action_item:${minuteToken}:${i}`,
      });
      writtenIds.push(r.unit.id);
    }
    writeAudit({
      action: 'action_items_confirmed',
      reason: `用户在卡片"${card.title}"上确认入库 ${items.length} 条 action item`,
      cardId: card.id,
      payload: { minuteToken, count: items.length, unitIds: writtenIds },
    });
    const updated = updateCardStatus(cardId, 'done', now);
    if (updated) {
      broadcast({ type: 'card_updated', card: rowToCard(updated) });
    }
    res.json({ ok: true, accepted: items.length, unitIds: writtenIds });
    return;
  }

  // accept === 'none' 或者本来没 item
  writeAudit({
    action: 'action_items_declined',
    reason: `用户在卡片"${card.title}"上选择"全都不要"`,
    cardId: card.id,
    payload: { minuteToken, declinedCount: items.length },
  });
  const updated = updateCardStatus(cardId, 'dismissed', now);
  if (updated) {
    broadcast({ type: 'card_updated', card: rowToCard(updated) });
  }
  res.json({ ok: true, accepted: 0 });
});
