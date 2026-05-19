/**
 * Smoke test MVP3 trigger → agent → card pipeline.
 * Usage:
 *   npx tsx apps/server/scripts/smoke-mvp3.ts due-soon       # commitment 2h 后到期
 *   npx tsx apps/server/scripts/smoke-mvp3.ts overdue        # commitment 6h 前已到期
 *   npx tsx apps/server/scripts/smoke-mvp3.ts both
 *
 * Inserts ContextUnit directly via contextStore (which fires the push hook).
 * No HTTP — runs against the same SQLite db the live server uses.
 *
 * IMPORTANT: run with the dev server STOPPED, since both processes would
 * contend on the SQLite WAL and the push hook only fires in the process
 * that calls upsertContextUnit.
 */
import { upsertContextUnit } from '../src/context/contextStore.js';
import { bootstrapAgents } from '../src/agents/index.js';
import { registerUpsertHook } from '../src/context/contextStore.js';
import {
  evaluateAndPersistForUnit,
} from '../src/triggers/triggerEvaluator.js';
import { enqueueAgentRunForTrigger } from '../src/agents/AgentRunQueue.js';

async function main() {
  const mode = process.argv[2] ?? 'due-soon';
  bootstrapAgents();
  registerUpsertHook((unit) => {
    const ids = evaluateAndPersistForUnit(unit);
    console.log(`[smoke] evaluator produced ${ids.length} triggers for unit ${unit.id}`);
    for (const t of ids) enqueueAgentRunForTrigger(t);
  });

  const now = Date.now();
  const cases: Array<{ title: string; dueAt: string; mergeHint: string }> = [];
  if (mode === 'due-soon' || mode === 'both') {
    const due = new Date(now + 2 * 3600_000).toISOString();
    cases.push({
      title: '周三前补 MVP2 方案',
      dueAt: due,
      mergeHint: `smoke-due-soon-${now}`,
    });
  }
  if (mode === 'overdue' || mode === 'both') {
    const due = new Date(now - 6 * 3600_000).toISOString();
    cases.push({
      title: '昨天答应给小李的反馈',
      dueAt: due,
      mergeHint: `smoke-overdue-${now}`,
    });
  }

  for (const c of cases) {
    const { unit } = upsertContextUnit({
      kind: 'commitment',
      title: c.title,
      content: `[smoke] ${c.title} dueAt=${c.dueAt}`,
      entities: [
        { type: 'person', name: '小李', role: 'target' },
        { type: 'project', name: 'AI is ON', role: 'about' },
      ],
      time: { dueAt: c.dueAt },
      actionability: 'ask',
      confidence: 0.9,
      mergeHint: c.mergeHint,
      scope: 'work',
      origin: { kind: 'manual', refId: `smoke:${c.mergeHint}` },
    });
    console.log(`[smoke] inserted commitment ${unit.id}: "${unit.title}" due ${c.dueAt}`);
  }

  // Wait for queue to drain
  await new Promise((r) => setTimeout(r, 3000));
  console.log('[smoke] done.');
}

main().catch((err) => {
  console.error('[smoke] crashed:', err);
  process.exit(1);
});
