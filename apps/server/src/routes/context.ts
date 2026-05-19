import { Router } from 'express';
import {
  addContextFeedback,
  getContextUnitById,
  listActiveContextUnits,
  listAllEntities,
  listAllFeedback,
  listAllRelations,
  listLinksFor,
} from '../context/contextStore.js';
import { buildActiveContext } from '../context/activeContext.js';

export const contextRouter = Router();

contextRouter.get('/context/units', (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const kind = stringOrUndef(req.query.kind);
  const originKind = stringOrUndef(req.query.origin);
  const actionability = stringOrUndef(req.query.actionability);
  const items = listActiveContextUnits({ limit, kind, originKind, actionability });
  res.json({ items });
});

contextRouter.get('/context/units/:id', (req, res) => {
  const unit = getContextUnitById(req.params.id);
  if (!unit) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const links = listLinksFor(unit.id);
  res.json({ unit, links });
});

contextRouter.get('/context/entities', (_req, res) => {
  const items = listAllEntities(500);
  res.json({ items });
});

contextRouter.get('/context/relations', (_req, res) => {
  const items = listAllRelations(500);
  res.json({ items });
});

contextRouter.get('/context/active', (req, res) => {
  const budget = clampInt(req.query.budget, 1500, 100, 8000);
  const snap = buildActiveContext({ budgetTokens: budget });
  res.json({
    items: snap.items,
    summary: snap.summary,
    tokenEstimate: snap.tokenEstimate,
  });
});

contextRouter.get('/context/feedback', (_req, res) => {
  res.json({ items: listAllFeedback() });
});

contextRouter.post('/context/feedback', (req, res) => {
  const body = req.body ?? {};
  const reason = typeof body.reason === 'string' ? body.reason : '';
  if (!reason) {
    res.status(400).json({ error: 'reason is required' });
    return;
  }
  const row = addContextFeedback({
    contextUnitId: typeof body.contextUnitId === 'string' ? body.contextUnitId : undefined,
    cardId: typeof body.cardId === 'string' ? body.cardId : undefined,
    reason,
    comment: typeof body.comment === 'string' ? body.comment : undefined,
  });
  res.json({ feedback: row });
});

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}
