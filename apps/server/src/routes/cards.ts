import { Router } from 'express';
import { applyCardAction, listCards } from '../cards/cardsService.js';
import { projectCardContext } from '../cards/contextProjection.js';

export const cardsRouter = Router();

cardsRouter.get('/cards', (_req, res) => {
  res.json({ cards: listCards() });
});

cardsRouter.post('/cards/:id/action', async (req, res) => {
  const cardId = req.params.id;
  const actionId = typeof req.body?.actionId === 'string' ? req.body.actionId : '';
  // MVP11.0-b：前端 ask_agent / draft_reply 可附带自由文本指令覆盖默认 prompt。
  const extraPrompt =
    typeof req.body?.extraPrompt === 'string' ? req.body.extraPrompt : undefined;
  if (!actionId) {
    res.status(400).json({ error: 'actionId is required' });
    return;
  }
  const result = await applyCardAction(cardId, actionId, { extraPrompt });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ card: result.card });
});

cardsRouter.get('/cards/:id/context', (req, res) => {
  const proj = projectCardContext(req.params.id);
  res.json(proj);
});
