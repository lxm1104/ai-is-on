import { createHash, randomUUID } from 'node:crypto';
import {
  type BoundaryRuleRow,
  getBoundaryRule,
  getBoundaryRuleByConditionHash,
  insertBoundaryRule,
  listBoundaryRules,
  touchBoundaryRule,
  updateBoundaryRuleActive,
} from '../db.js';
import type {
  BoundaryAction,
  BoundaryAutonomy,
  BoundaryCondition,
  BoundaryImpactScope,
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
    autonomy: (row.autonomy as BoundaryAutonomy) ?? 'local_with_audit',
    reversible: row.reversible === 1,
    impactScope: (row.impact_scope as BoundaryImpactScope) ?? 'self',
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

/**
 * MVP7 §4.3 condition_hash 计算：仅取**结构化**字段做稳定 JSON → sha1。
 * 显式排除 rawDescription 与 LLM 草稿措辞，确保用户写法差异不会破坏幂等。
 *
 * 数组在序列化前做去重 + 排序；object key 按字典序排序。
 *
 * 输入字段（doc §4.3）：
 *   triggerType, source, priorityAtMost, scope, kind, entityRef,
 *   allowedAction, autonomy, scope_outer
 *
 * - scope_outer = rule.scope 顶层字段（personal/work/team），与 condition.scope 区分
 * - autonomy 在 MVP10.1 才进 schema；MVP7.0 入参可缺省，序列化时按 null 处理
 */
export function computeConditionHash(input: {
  condition: BoundaryCondition;
  allowedAction: BoundaryAction;
  autonomy?: string | null;
  scopeOuter: ContextScope;
}): string {
  const c = input.condition;
  const normArr = <T extends string>(arr?: T[] | null): T[] | null =>
    arr && arr.length ? [...new Set(arr)].sort() : null;
  const normObj = (o: Record<string, unknown> | undefined | null) => {
    if (!o) return null;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      const v = o[k];
      if (v === undefined || v === null || v === '') continue;
      out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  };
  const payload = {
    triggerType: normArr(c.triggerType),
    source: normArr(c.source),
    priorityAtMost: c.priorityAtMost ?? null,
    scope: normArr(c.scope),
    kind: normArr(c.kind),
    entityRef: normObj(c.entityRef as unknown as Record<string, unknown> | undefined),
    allowedAction: input.allowedAction,
    autonomy: input.autonomy ?? null,
    scope_outer: input.scopeOuter,
  };
  // stable: keys already in fixed order in payload literal
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

export type CreateRuleInput = {
  scope: ContextScope;
  condition: BoundaryCondition;
  allowedAction: BoundaryAction;
  requiresApproval?: boolean;
  confidence?: number;
  source: BoundarySource;
  learnedFromCardId?: string;
  migrated?: boolean;
  active?: boolean;
  /** Optional override; computed from condition + allowedAction + scope if absent. */
  conditionHash?: string;
  // MVP10.1：autonomy/reversible/impactScope；缺省 local_with_audit / true / self。
  // autonomy 进入 condition_hash，让"同条件不同 autonomy"的规则不被错误 dedup。
  autonomy?: BoundaryAutonomy | null;
  reversible?: boolean;
  impactScope?: BoundaryImpactScope;
};

/**
 * MVP7 §4.3：condition_hash 命中 → touch + 返回老 rule，不新建行（幂等）。
 * 未命中 → 写新行。返回值统一是当前生效的 BoundaryRule。
 */
export function createRule(input: CreateRuleInput): BoundaryRule {
  // migrated=true 表示这是无法结构化、仅留 rawDescription 等人工 review 的 rule，
  // 多条会撞在同一个 hash 上（因为我们刻意排除 rawDescription），
  // 索性不参与 dedup —— UNIQUE 索引带 WHERE condition_hash IS NOT NULL，NULL 即跳过。
  const hash = input.migrated
    ? null
    : input.conditionHash ??
      computeConditionHash({
        condition: input.condition,
        allowedAction: input.allowedAction,
        autonomy: input.autonomy,
        scopeOuter: input.scope,
      });

  if (hash) {
    const existing = getBoundaryRuleByConditionHash(hash);
    if (existing) {
      touchBoundaryRule(existing.id);
      const refreshed = getBoundaryRule(existing.id);
      return rowToRule(refreshed ?? existing);
    }
  }

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
    condition_hash: hash ?? null,
    autonomy: input.autonomy ?? 'local_with_audit',
    reversible: input.reversible === false ? 0 : 1,
    impact_scope: input.impactScope ?? 'self',
    created_at: now,
    updated_at: now,
  };
  insertBoundaryRule(row);
  return rowToRule(row);
}
