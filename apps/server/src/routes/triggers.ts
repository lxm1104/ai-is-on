import { Router } from 'express';
import { getTrigger, listTriggers } from '../db.js';
import {
  evaluateActiveUnitsForPullPath,
} from '../triggers/triggerEvaluator.js';
import { enqueueAgentRunForTrigger } from '../agents/AgentRunQueue.js';

export const triggersRouter = Router();

triggersRouter.get('/triggers', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const items = listTriggers({ status, limit });
  res.json({ items });
});

triggersRouter.get('/triggers/:id', (req, res) => {
  const t = getTrigger(req.params.id);
  if (!t) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ trigger: t });
});

/**
 * Re-run the pull-path evaluator on demand. Useful for debugging window
 * boundaries (e.g. "this commitment should have triggered by now").
 */
triggersRouter.post('/triggers/run-once', (_req, res) => {
  const ids = evaluateActiveUnitsForPullPath();
  for (const id of ids) enqueueAgentRunForTrigger(id);
  res.json({ ok: true, newTriggerIds: ids });
});

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
