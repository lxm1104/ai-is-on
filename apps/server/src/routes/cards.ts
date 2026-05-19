import { Router } from 'express';
import { applyCardAction, listCards } from '../cards/cardsService.js';

export const cardsRouter = Router();

cardsRouter.get('/cards', (_req, res) => {
  res.json({ cards: listCards() });
});

cardsRouter.post('/cards/:id/action', async (req, res) => {
  const cardId = req.params.id;
  const actionId = typeof req.body?.actionId === 'string' ? req.body.actionId : '';
  if (!actionId) {
    res.status(400).json({ error: 'actionId is required' });
    return;
  }
  const result = await applyCardAction(cardId, actionId);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ card: result.card });
});
