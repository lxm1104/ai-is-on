import { Router } from 'express';
import { applyCorrection } from '../correction/correctionWriter.js';
import { listCorrectionJournalForCard, listCorrectionJournalRecent } from '../db.js';
import type { CorrectionType } from '../correction/feedbackInterpreter.js';

export const correctionRouter = Router();

const VALID_TYPES: CorrectionType[] = [
  'wrong_priority',
  'wrong_meaning',
  'wrong_actionability',
  'wrong_entity',
  'wrong_kind',
];

correctionRouter.post('/cards/:id/correction', (req, res) => {
  const cardId = req.params.id;
  const body = req.body ?? {};
  const type = body.type;
  if (typeof type !== 'string' || !VALID_TYPES.includes(type as CorrectionType)) {
    res.status(400).json({ error: `invalid correction type: ${type}` });
    return;
  }
  const payload = (body.payload as Record<string, unknown> | undefined) ?? {};
  const confirm = body.confirm === true;
  try {
    const result = applyCorrection({
      cardId,
      type: type as CorrectionType,
      payload,
      confirm,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

correctionRouter.get('/cards/:id/corrections', (req, res) => {
  const rows = listCorrectionJournalForCard(req.params.id);
  res.json({ items: rows });
});

correctionRouter.get('/corrections/recent', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const rows = listCorrectionJournalRecent(limit);
  res.json({ items: rows });
});
