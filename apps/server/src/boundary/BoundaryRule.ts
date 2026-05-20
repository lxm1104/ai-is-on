/**
 * MVP6 BoundaryRule model. Per §8.2 the condition MUST be structured —
 * free text alone cannot be reliably matched or audited. rawDescription
 * is kept only as a migration fallback for human review.
 */
import type { ContextScope, ContextUnitKind } from '../context/ContextUnit.js';

export type TriggerType =
  | 'commitment_due'
  | 'meeting_prepare'
  | 'context_conflict'
  | 'goal_blocked'
  | 'low_noise_batch'
  | 'check_in_due'
  | 'context_divergence';

export type CardSourceKey = 'calendar' | 'im' | 'mail' | 'drive' | 'manual' | 'agent';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export type BoundaryCondition = {
  // 所有顶层字段 AND；数组内 OR；缺省 = 不约束。
  triggerType?: TriggerType[];
  source?: CardSourceKey[];
  priorityAtMost?: Priority;          // 例 'P3' = 仅对 P3 命中
  scope?: ContextScope[];
  entityRef?: { type: string; nameLike?: string };
  kind?: ContextUnitKind[];
  // 不可结构化的兜底（仅展示，evaluator 不读）
  rawDescription?: string;
};

export type BoundaryAction = 'record' | 'notify' | 'draft' | 'execute_reversible';

export type BoundarySource = 'user_rule_migration' | 'card_action' | 'manual';

export type BoundaryRule = {
  id: string;
  scope: ContextScope;
  condition: BoundaryCondition;
  allowedAction: BoundaryAction;
  requiresApproval: boolean;
  confidence: number;
  learnedFromCardId?: string;
  source: BoundarySource;
  migrated: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export const PRIORITY_RANK: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};
