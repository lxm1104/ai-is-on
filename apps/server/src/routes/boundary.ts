import { Router } from 'express';
import {
  createRule,
  listActiveBoundaryRules,
  listAllBoundaryRules,
  setRuleActive,
} from '../boundary/boundaryStore.js';
import { listRecentAudits } from '../boundary/auditLog.js';
import type {
  BoundaryAction,
  BoundaryCondition,
  BoundarySource,
} from '../boundary/BoundaryRule.js';
import type { ContextScope } from '../context/ContextUnit.js';

export const boundaryRouter = Router();

const VALID_ACTIONS: BoundaryAction[] = ['record', 'notify', 'draft', 'execute_reversible'];
const VALID_SCOPES: ContextScope[] = ['personal', 'work', 'team'];
const VALID_SOURCES: BoundarySource[] = ['user_rule_migration', 'card_action', 'manual'];

boundaryRouter.get('/boundary/rules', (req, res) => {
  const activeOnly = req.query.active === '1' || req.query.active === 'true';
  res.json({ items: activeOnly ? listActiveBoundaryRules() : listAllBoundaryRules() });
});

boundaryRouter.post('/boundary/rules', (req, res) => {
  const body = req.body ?? {};
  const scopeRaw = typeof body.scope === 'string' ? body.scope : 'work';
  const scope = (VALID_SCOPES as string[]).includes(scopeRaw)
    ? (scopeRaw as ContextScope)
    : 'work';
  const allowedActionRaw = typeof body.allowedAction === 'string' ? body.allowedAction : 'record';
  const allowedAction = (VALID_ACTIONS as string[]).includes(allowedActionRaw)
    ? (allowedActionRaw as BoundaryAction)
    : 'record';
  const sourceRaw = typeof body.source === 'string' ? body.source : 'manual';
  const source = (VALID_SOURCES as string[]).includes(sourceRaw)
    ? (sourceRaw as BoundarySource)
    : 'manual';
  const condition: BoundaryCondition =
    body.condition && typeof body.condition === 'object' ? body.condition : {};
  const rule = createRule({
    scope,
    condition,
    allowedAction,
    requiresApproval: body.requiresApproval !== false,
    confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
    source,
    learnedFromCardId: typeof body.learnedFromCardId === 'string' ? body.learnedFromCardId : undefined,
    active: body.active !== false,
  });
  res.json({ rule });
});

boundaryRouter.patch('/boundary/rules/:id', (req, res) => {
  const body = req.body ?? {};
  if (typeof body.active !== 'boolean') {
    res.status(400).json({ error: 'active (boolean) required' });
    return;
  }
  const rule = setRuleActive(req.params.id, body.active);
  if (!rule) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ rule });
});

boundaryRouter.get('/audit-logs', (req, res) => {
  const limit = clampInt(req.query.limit, 200, 1, 1000);
  res.json({ items: listRecentAudits(limit) });
});

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
