import { Router } from 'express';
import { listEvents, listTriageResults } from '../db.js';
import { backfillUnitRouting } from '../bootstrap/backfillUnitRouting.js';

export const debugRouter = Router();

debugRouter.get('/debug/events', (_req, res) => {
  res.json({ events: listEvents(50) });
});

debugRouter.get('/debug/triage-results', (_req, res) => {
  res.json({ triage_results: listTriageResults(50) });
});

// MVP12 §4.1 P1.9：手动触发 unit_sources / unit_routing_cache backfill。
// 升级到 Phase 1 后跑一次即可；幂等。
debugRouter.post('/debug/backfill-unit-routing', (req, res) => {
  const eventLimit =
    typeof req.body?.eventLimit === 'number' ? req.body.eventLimit : undefined;
  try {
    const stats = backfillUnitRouting({ eventLimit });
    res.json({ ok: true, stats });
  } catch (err) {
    res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
