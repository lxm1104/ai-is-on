/**
 * MVP10.1 smoke (doc §6.6 验收 #2 + §6.4 三级 autonomy)：
 *   - auto_henceforth 在 P0/P1 + im → external_always_confirm
 *   - auto_henceforth 在 P3 + calendar → local_auto
 *   - correction wrong_priority+learnRule → autonomy=local_auto
 *   - condition_hash 含 autonomy（同条件不同 autonomy 不被 dedup）
 *
 * 用法：SQLITE_PATH=$(mktemp -d)/mvp10-1.sqlite npx tsx apps/server/test/mvp10-1-smoke.ts
 */
import { randomUUID } from 'node:crypto';
import {
  type CardRow,
  db,
  insertCard,
} from '../src/db.js';
import { applyCardAction } from '../src/cards/cardsService.js';
import { applyCorrection } from '../src/correction/correctionWriter.js';
import { listActiveBoundaryRules, computeConditionHash } from '../src/boundary/boundaryStore.js';

function fail(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}

function insertTestCard(args: {
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  source: 'calendar' | 'im' | 'mail' | 'drive' | 'manual' | 'agent';
  title: string;
}): CardRow {
  const now = new Date().toISOString();
  const id = randomUUID();
  const row: CardRow = {
    id,
    triage_id: null,
    priority: args.priority,
    source: args.source,
    title: args.title,
    summary: 'mvp10-1',
    reason: 'mvp10-1',
    suggested_action: null,
    draft_reply: null,
    status: 'new',
    actions_json: JSON.stringify([
      { id: 'auto_henceforth', label: '以后自动', kind: 'auto_henceforth' },
    ]),
    raw_event_id: null,
    source_url: null,
    source_kind: 'manual',
    source_ref_id: null,
    created_at: now,
    updated_at: now,
  };
  insertCard(row);
  return row;
}

// ---- Phase 1: P3+calendar → local_auto ----
console.log('== Phase 1: P3 + calendar → local_auto ==');
const c1 = insertTestCard({ priority: 'P3', source: 'calendar', title: 'phase1-low' });
await applyCardAction(c1.id, 'auto_henceforth');
const rules1 = listActiveBoundaryRules().filter((r) => r.learnedFromCardId === c1.id);
if (rules1.length !== 1) fail(`phase1: expected 1 rule, got ${rules1.length}`);
const r1 = rules1[0];
console.log(`  rule autonomy=${r1.autonomy}, reversible=${r1.reversible}, impactScope=${r1.impactScope}`);
if (r1.autonomy !== 'local_auto') fail(`phase1: expected local_auto, got ${r1.autonomy}`);
if (!r1.reversible) fail('phase1: expected reversible=true');
if (r1.impactScope !== 'self') fail('phase1: expected impactScope=self');

// ---- Phase 2: P0+im → external_always_confirm ----
console.log('\n== Phase 2: P0 + im → external_always_confirm ==');
const c2 = insertTestCard({ priority: 'P0', source: 'im', title: 'phase2-critical' });
await applyCardAction(c2.id, 'auto_henceforth');
const rules2 = listActiveBoundaryRules().filter((r) => r.learnedFromCardId === c2.id);
if (rules2.length !== 1) fail(`phase2: expected 1 rule, got ${rules2.length}`);
const r2 = rules2[0];
console.log(`  rule autonomy=${r2.autonomy}, requiresApproval=${r2.requiresApproval}, impactScope=${r2.impactScope}`);
if (r2.autonomy !== 'external_always_confirm') fail(`phase2: expected external_always_confirm, got ${r2.autonomy}`);
if (!r2.requiresApproval) fail('phase2: external should require approval');
if (r2.impactScope !== 'shared') fail('phase2: expected impactScope=shared');

// ---- Phase 3: correction wrong_priority + learnRule → local_auto ----
console.log('\n== Phase 3: correction learns local_auto rule ==');
const c3 = insertTestCard({ priority: 'P1', source: 'im', title: 'phase3-correction' });
const r3 = applyCorrection({
  cardId: c3.id,
  type: 'wrong_priority',
  payload: { newPriority: 'P3', learnRule: true },
  confirm: true,
});
if (!r3.applied) fail('phase3: correction not applied');
const fwd3 = JSON.parse(r3.journal!.forward_patch_json);
const learnedRule = listActiveBoundaryRules().find((r) => r.id === fwd3.learnedRuleId);
if (!learnedRule) fail('phase3: learned rule not found');
console.log(`  rule autonomy=${learnedRule.autonomy}`);
if (learnedRule.autonomy !== 'local_auto') {
  fail(`phase3: correction-learned rule should be local_auto, got ${learnedRule.autonomy}`);
}

// ---- Phase 4: condition_hash 含 autonomy（不同 autonomy 同条件 不被 dedup） ----
console.log('\n== Phase 4: condition_hash distinguishes autonomy ==');
const hashLocal = computeConditionHash({
  condition: { source: ['im'], priorityAtMost: 'P3' },
  allowedAction: 'record',
  autonomy: 'local_auto',
  scopeOuter: 'work',
});
const hashExternal = computeConditionHash({
  condition: { source: ['im'], priorityAtMost: 'P3' },
  allowedAction: 'record',
  autonomy: 'external_always_confirm',
  scopeOuter: 'work',
});
console.log(`  local_auto hash=${hashLocal.slice(0, 12)}, external hash=${hashExternal.slice(0, 12)}`);
if (hashLocal === hashExternal) {
  fail('phase4: same hash for different autonomy — condition_hash 应该把 autonomy 计入');
}

// ---- Phase 5: 默认值（旧路径不传 autonomy） ----
console.log('\n== Phase 5: default values for legacy createRule ==');
import('../src/boundary/boundaryStore.js').then(({ createRule, listAllBoundaryRules }) => {
  // legacy 不传 autonomy/reversible/impactScope
  const legacy = createRule({
    scope: 'work',
    condition: { source: ['mail'], priorityAtMost: 'P2' },
    allowedAction: 'record',
    source: 'manual',
  });
  console.log(`  legacy rule autonomy=${legacy.autonomy}, reversible=${legacy.reversible}, impactScope=${legacy.impactScope}`);
  if (legacy.autonomy !== 'local_with_audit') fail('phase5: default autonomy should be local_with_audit');
  if (!legacy.reversible) fail('phase5: default reversible should be true');
  if (legacy.impactScope !== 'self') fail('phase5: default impactScope should be self');
  const _ = listAllBoundaryRules(); // smoke that listing works
  console.log('\nPASS MVP10.1 smoke');
});
