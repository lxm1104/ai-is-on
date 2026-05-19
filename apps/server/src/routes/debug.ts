import { Router } from 'express';
import { listEvents, listTriageResults } from '../db.js';

export const debugRouter = Router();

debugRouter.get('/debug/events', (_req, res) => {
  res.json({ events: listEvents(50) });
});

debugRouter.get('/debug/triage-results', (_req, res) => {
  res.json({ triage_results: listTriageResults(50) });
});
