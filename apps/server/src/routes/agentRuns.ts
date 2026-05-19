import { Router } from 'express';
import {
  getActionProposal,
  getAgentRun,
  listActionProposals,
  listAgentRuns,
} from '../db.js';

export const agentRunsRouter = Router();

agentRunsRouter.get('/agent-runs', (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  res.json({ items: listAgentRuns(limit) });
});

agentRunsRouter.get('/agent-runs/:id', (req, res) => {
  const row = getAgentRun(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ run: row });
});

agentRunsRouter.get('/action-proposals', (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  res.json({ items: listActionProposals(limit) });
});

agentRunsRouter.get('/action-proposals/:id', (req, res) => {
  const row = getActionProposal(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ proposal: row });
});

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
