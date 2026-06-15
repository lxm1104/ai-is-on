import { Router } from 'express';
import { getContextEntityById, listEvents, listTriageResults, matchMatterId } from '../db.js';
import { backfillUnitRouting } from '../bootstrap/backfillUnitRouting.js';
import { listInducers } from '../structure/inducerRegistry.js';
import { getMatterById, listMatterEntities } from '../matter/matterStore.js';
import { runInvestigation } from '../investigation/investigationLoop.js';
import { applyInvestigationResult } from '../investigation/investigationWriteback.js';
import { runInvestigationDispatchTick } from '../investigation/investigationDispatcher.js';
import { captureInvestigationTrace } from '../playbook/playbookCapture.js';
import { config } from '../config.js';

export const debugRouter = Router();

// MVP36：查自主排查 dispatcher 状态（确认试运行是否开启）。
debugRouter.get('/debug/investigation/status', (_req, res) => {
  res.json({
    enabled: config.investigationDispatchEnabled,
    tickMs: config.investigationTickMs,
    cooldownMs: config.investigationCooldownMs,
    maxRounds: config.investigationMaxRounds,
  });
});

// MVP36：手动立即跑一次 dispatcher tick（不等定时器；试运行验证用）。
debugRouter.post('/debug/investigation/tick', async (_req, res) => {
  try {
    const dispatched = await runInvestigationDispatchTick();
    res.json({ ok: true, dispatched });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// MVP36：在真实 matter 上跑一次「自主排查」（硬只读，安全）。手动验证用。
debugRouter.post('/debug/investigation/run', async (req, res) => {
  const body = req.body ?? {};
  if (typeof body.matterId !== 'string') return res.status(400).json({ error: 'matterId required' });
  const matterId = matchMatterId(body.matterId) ?? body.matterId;
  const m = getMatterById(matterId);
  if (!m) return res.status(404).json({ error: `matter ${matterId} not found` });
  const entities = listMatterEntities(matterId)
    .map((l) => {
      const e = getContextEntityById(l.entityId);
      return e ? { type: e.type, name: e.name, role: String(l.role) } : null;
    })
    .filter((x): x is { type: string; name: string; role: string } => x !== null)
    .slice(0, 8);
  try {
    const result = await runInvestigation({
      matterTitle: m.title,
      matterType: m.type,
      currentSummary: m.currentSummary,
      nextAction: m.nextAction ?? '确认该事项的当前进展',
      entities,
      maxRounds: typeof body.maxRounds === 'number' ? body.maxRounds : 3,
      priority: true, // 手动验证：走 high 队列尽快拿 gate，不被 attention 饿死
    });
    let writeback;
    if (body.apply === true) {
      const toolSummary = result.toolLog.map((l) => `${l.tool}:${l.ok ? l.summary : '失败'}`).join('；');
      writeback = applyInvestigationResult({ matterId, conclusion: result.conclusion, toolSummary });
      try {
        captureInvestigationTrace(m, result);
      } catch {}
    }
    res.json({ ok: true, matter: { id: matterId, title: m.title, nextAction: m.nextAction }, ...result, writeback });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

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
