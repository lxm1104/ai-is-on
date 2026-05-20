import { listActiveBoundaryRules } from './boundaryStore.js';
import { PRIORITY_RANK } from './BoundaryRule.js';
import type { BoundaryRule, Priority } from './BoundaryRule.js';

/**
 * MVP6 BoundaryEvaluator. Sits in front of card creation:
 *
 *   - 'block'   → don't render a card at all (audit log explains why)
 *   - 'soften'  → render the card but mark it as batched / lower priority
 *   - 'allow'   → no rule matches; behave as before
 *
 * For MVP6.0 every active boundary_rule with allowedAction='record' implies
 * "the user already said this kind doesn't need an immediate card" — so a
 * matching rule turns into 'soften' (the card goes into the digest queue).
 * 'execute_reversible' etc. are not yet honored at card creation time;
 * they'll matter when MVP6.x lets the boundary actually act for the user.
 */

export type CardCandidate = {
  priority: Priority;
  source: string;                // 'calendar' | 'im' | 'agent' | ...
  scope?: string;                // 'work' | 'personal' | 'team'
  kind?: string;                 // ContextUnit kind, when known
  triggerType?: string;          // for agent-run cards
  entities?: Array<{ type: string; name: string }>;
};

export type BoundaryDecision =
  | { decision: 'allow'; matchedRule?: undefined; reason?: undefined }
  | { decision: 'block' | 'soften'; matchedRule: BoundaryRule; reason: string };

export function evaluateCard(card: CardCandidate): BoundaryDecision {
  for (const rule of listActiveBoundaryRules()) {
    if (rule.migrated) continue; // unstructured rule — don't apply automatically
    if (!matches(rule, card)) continue;
    // record-style rule → soften into digest
    const decision = rule.allowedAction === 'record' ? 'soften' : 'block';
    return {
      decision,
      matchedRule: rule,
      reason: describeMatch(rule, card),
    };
  }
  return { decision: 'allow' };
}

function matches(rule: BoundaryRule, card: CardCandidate): boolean {
  const c = rule.condition;
  if (c.triggerType && card.triggerType && !c.triggerType.includes(card.triggerType as never)) {
    return false;
  }
  if (c.source && !c.source.includes(card.source as never)) return false;
  if (c.priorityAtMost) {
    if (PRIORITY_RANK[card.priority] < PRIORITY_RANK[c.priorityAtMost]) return false;
  }
  if (c.scope && card.scope && !c.scope.includes(card.scope as never)) return false;
  if (c.kind && card.kind && !c.kind.includes(card.kind as never)) return false;
  if (c.entityRef && card.entities) {
    const want = c.entityRef;
    const hit = card.entities.some((e) => {
      if (want.type && e.type !== want.type) return false;
      if (want.nameLike) {
        const re = new RegExp(want.nameLike, 'i');
        if (!re.test(e.name)) return false;
      }
      return true;
    });
    if (!hit) return false;
  }
  return true;
}

function describeMatch(rule: BoundaryRule, card: CardCandidate): string {
  const parts: string[] = [];
  const c = rule.condition;
  if (c.priorityAtMost) parts.push(`优先级 ≤${c.priorityAtMost}`);
  if (c.source) parts.push(`来源 ${c.source.join('/')}`);
  if (c.scope) parts.push(`scope ${c.scope.join('/')}`);
  if (c.kind) parts.push(`kind ${c.kind.join('/')}`);
  if (c.triggerType) parts.push(`trigger ${c.triggerType.join('/')}`);
  return `匹配规则：${parts.join('、') || rule.id.slice(0, 8)}（card=${card.priority}/${card.source}）`;
}
