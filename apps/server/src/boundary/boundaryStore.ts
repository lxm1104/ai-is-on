import { randomUUID } from 'node:crypto';
import {
  type BoundaryRuleRow,
  getBoundaryRule,
  insertBoundaryRule,
  listBoundaryRules,
  updateBoundaryRuleActive,
} from '../db.js';
import type {
  BoundaryAction,
  BoundaryCondition,
  BoundaryRule,
  BoundarySource,
} from './BoundaryRule.js';
import type { ContextScope } from '../context/ContextUnit.js';

function rowToRule(row: BoundaryRuleRow): BoundaryRule {
  let condition: BoundaryCondition = {};
  try {
    condition = JSON.parse(row.condition_json) as BoundaryCondition;
  } catch {}
  return {
    id: row.id,
    scope: row.scope as ContextScope,
    condition,
    allowedAction: row.allowed_action as BoundaryAction,
    requiresApproval: row.requires_approval === 1,
    confidence: row.confidence,
    learnedFromCardId: row.learned_from_card_id ?? undefined,
    source: row.source as BoundarySource,
    migrated: row.migrated === 1,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listActiveBoundaryRules(): BoundaryRule[] {
  return listBoundaryRules({ activeOnly: true }).map(rowToRule);
}

export function listAllBoundaryRules(): BoundaryRule[] {
  return listBoundaryRules({ activeOnly: false }).map(rowToRule);
}

export function getRule(id: string): BoundaryRule | null {
  const row = getBoundaryRule(id);
  return row ? rowToRule(row) : null;
}

export function setRuleActive(id: string, active: boolean): BoundaryRule | null {
  const row = updateBoundaryRuleActive(id, active);
  return row ? rowToRule(row) : null;
}

export function createRule(input: {
  scope: ContextScope;
  condition: BoundaryCondition;
  allowedAction: BoundaryAction;
  requiresApproval?: boolean;
  confidence?: number;
  source: BoundarySource;
  learnedFromCardId?: string;
  migrated?: boolean;
  active?: boolean;
}): BoundaryRule {
  const now = new Date().toISOString();
  const row: BoundaryRuleRow = {
    id: randomUUID(),
    scope: input.scope,
    condition_json: JSON.stringify(input.condition),
    allowed_action: input.allowedAction,
    requires_approval: input.requiresApproval === false ? 0 : 1,
    confidence: input.confidence ?? 0.8,
    learned_from_card_id: input.learnedFromCardId ?? null,
    source: input.source,
    migrated: input.migrated ? 1 : 0,
    active: input.active === false ? 0 : 1,
    created_at: now,
    updated_at: now,
  };
  insertBoundaryRule(row);
  return rowToRule(row);
}
