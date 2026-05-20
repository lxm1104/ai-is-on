import {
  getSetting,
  listActiveUserRules,
  listBoundaryRules,
  setSetting,
} from '../db.js';
import { createRule } from './boundaryStore.js';
import type { BoundaryCondition, CardSourceKey, Priority } from './BoundaryRule.js';

const MIGRATION_KEY = 'boundary_rules_migrated_at';
const ALLOWED_SOURCES = new Set<CardSourceKey>([
  'calendar',
  'im',
  'mail',
  'drive',
  'manual',
  'agent',
]);
const PRIORITY_PATTERN = /\b(P[0-3])\b/;
const SOURCE_PATTERN = /Source=(\w+)/i;

/**
 * MVP6 §8.2.1 — one-shot migration of user_rules (MVP1 dismiss_like blob) into
 * structured boundary_rules. Idempotent via settings.boundary_rules_migrated_at.
 *
 * For each active user_rule:
 *   - rule_type='dismiss_like' → allowedAction='record', requiresApproval=false
 *   - parse Priority=Px and Source=… from description text
 *   - things we can't parse → migrated=true, active=false, rawDescription kept
 *     so the human can review them in /api/boundary/rules.
 *
 * Old user_rules table is NOT deleted; cardsService.applyCardAction still
 * writes there for back-compat. MVP7 will switch the write path over.
 */
export function migrateUserRulesIfNeeded(): { migrated: number; needsReview: number; skipped: boolean } {
  if (getSetting(MIGRATION_KEY)) {
    return { migrated: 0, needsReview: 0, skipped: true };
  }
  // If anyone has already inserted into boundary_rules, don't double-migrate
  if (listBoundaryRules({ activeOnly: false }).length > 0) {
    setSetting(MIGRATION_KEY, new Date().toISOString());
    return { migrated: 0, needsReview: 0, skipped: true };
  }

  const rows = listActiveUserRules();
  let migrated = 0;
  let needsReview = 0;
  for (const r of rows) {
    if (r.rule_type !== 'dismiss_like') {
      // unknown rule_type → preserve as needs-review
      createRule({
        scope: 'work',
        condition: { rawDescription: r.description },
        allowedAction: 'record',
        requiresApproval: false,
        source: 'user_rule_migration',
        learnedFromCardId: r.source_card_id ?? undefined,
        migrated: true,
        active: false,
      });
      needsReview++;
      continue;
    }

    const condition: BoundaryCondition = {};
    const pm = r.description.match(PRIORITY_PATTERN);
    if (pm) condition.priorityAtMost = pm[1] as Priority;
    const sm = r.description.match(SOURCE_PATTERN);
    if (sm) {
      const src = sm[1].toLowerCase() as CardSourceKey;
      if (ALLOWED_SOURCES.has(src)) condition.source = [src];
    }
    const structured = !!(condition.priorityAtMost || condition.source);
    condition.rawDescription = r.description;

    createRule({
      scope: 'work',
      condition,
      allowedAction: 'record',
      requiresApproval: false,
      source: 'user_rule_migration',
      learnedFromCardId: r.source_card_id ?? undefined,
      migrated: !structured,
      active: structured,
      confidence: structured ? 0.7 : 0.4,
    });
    if (structured) migrated++;
    else needsReview++;
  }

  setSetting(MIGRATION_KEY, new Date().toISOString());
  console.log(`[boundary] migrated user_rules: ${migrated} structured, ${needsReview} need review`);
  return { migrated, needsReview, skipped: false };
}
