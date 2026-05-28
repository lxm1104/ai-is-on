import { Router } from 'express';
import {
  addContextFeedback,
  getContextUnitById,
  listActiveContextUnits,
  listAllEntities,
  listAllFeedback,
  listLinksFor,
} from '../context/contextStore.js';
import { buildActiveContext } from '../context/activeContext.js';
import { listRelationships } from '../context/relationshipsService.js';
import { listCooccurrences } from '../structure/derived/cooccurrenceService.js';
import { classifyContextUnit } from '../context/layerClassifier.js';
import type { ContextUnit } from '../context/ContextUnit.js';

export const contextRouter = Router();

// MVP21 S1 §4.3：把 layer 分类挂到 unit 上，给前端 ContextPanel 显示来源 chip 用。
// 派生字段，不进 DB；前端按 _layerHint.source 显示视觉区分。
function attachLayerHint<T extends ContextUnit>(u: T): T & { _layerHint: ReturnType<typeof classifyContextUnit> } {
  return { ...u, _layerHint: classifyContextUnit(u) };
}

contextRouter.get('/context/units', (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const kind = stringOrUndef(req.query.kind);
  const originKind = stringOrUndef(req.query.origin);
  const actionability = stringOrUndef(req.query.actionability);
  const items = listActiveContextUnits({ limit, kind, originKind, actionability }).map(attachLayerHint);
  res.json({ items });
});

contextRouter.get('/context/units/:id', (req, res) => {
  const unit = getContextUnitById(req.params.id);
  if (!unit) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const links = listLinksFor(unit.id);
  res.json({ unit: attachLayerHint(unit), links });
});

contextRouter.get('/context/entities', (_req, res) => {
  const items = listAllEntities(500);
  res.json({ items });
});

// MVP14 Phase 1a: explicit relationships read model（kind='relationship' units
// 的 enriched 视图）。详见 apps/server/src/context/relationshipsService.ts。
contextRouter.get('/context/relationships', (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const items = listRelationships({ limit });
  res.json({ items });
});

// MVP14 Phase 1b: entity 共现推测信号（"Observed together"）。与 explicit
// relationships 严格分区。详见 apps/server/src/structure/derived/cooccurrenceService.ts。
contextRouter.get('/context/relationships/cooccurrences', (req, res) => {
  const limit = clampInt(req.query.limit, 50, 1, 200);
  const minCount = clampInt(req.query.minCount, 2, 1, 100);
  const items = listCooccurrences({ limit, minCount });
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
