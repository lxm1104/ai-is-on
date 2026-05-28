import { Router } from 'express';
import { listEvents, listTriageResults } from '../db.js';
import { backfillUnitRouting } from '../bootstrap/backfillUnitRouting.js';
import { listInducers } from '../structure/inducerRegistry.js';

export const debugRouter = Router();

debugRouter.get('/debug/events', (_req, res) => {
  res.json({ events: listEvents(50) });
});

debugRouter.get('/debug/triage-results', (_req, res) => {
  res.json({ triage_results: listTriageResults(50) });
});

// MVP21 S5: inducer 注册表快照。返回所有 import-time 登记过的 inducer 元数据
// 和上次运行的耗时 / 错误。前端可以做"Structure Health"轻量观测面板。
debugRouter.get('/debug/inducers', (_req, res) => {
  res.json({ inducers: listInducers() });
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
