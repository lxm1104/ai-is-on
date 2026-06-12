import { Router } from 'express';
import { applyCardAction } from '../cards/cardsService.js';
import { projectCardContext } from '../cards/contextProjection.js';
import { listLiveAttentionItems } from '../attention/attentionStore.js';
import { projectAttentionItemToCard } from '../attention/attentionProjection.js';

export const cardsRouter = Router();

// MVP14 Step 3: /api/cards 现在统一返回 L2 attention 投影的 cards。
// 老的 cards 表（source_kind='triage' 或 'agent_run'）不再露给前端；
// applyCardAction 仍兼容老 cards 表的 id（专项 agent 的卡走老路）。
cardsRouter.get('/cards', (_req, res) => {
  const cards = listLiveAttentionItems(100).map(projectAttentionItemToCard);
  res.json({ cards });
});

cardsRouter.post('/cards/:id/action', async (req, res) => {
  const cardId = req.params.id;
  const actionId = typeof req.body?.actionId === 'string' ? req.body.actionId : '';
  // MVP11.0-b：前端 ask_agent / draft_reply 可附带自由文本指令覆盖默认 prompt。
  const extraPrompt =
    typeof req.body?.extraPrompt === 'string' ? req.body.extraPrompt : undefined;
  // MVP32：mark_done 可附带一句话处理说明（落 matter transition reason + action_result unit）。
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  if (!actionId) {
    res.status(400).json({ error: 'actionId is required' });
    return;
  }
  const result = await applyCardAction(cardId, actionId, { extraPrompt, note });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ card: result.card, topic: result.topic });
});

cardsRouter.get('/cards/:id/context', (req, res) => {
  const proj = projectCardContext(req.params.id);
  res.json(proj);
});
