/**
 * Smoke test MVP3 trigger → agent → card pipeline.
 * Usage:
 *   npx tsx apps/server/scripts/smoke-mvp3.ts due-soon       # commitment 2h 后到期
 *   npx tsx apps/server/scripts/smoke-mvp3.ts overdue        # commitment 6h 前已到期
 *   npx tsx apps/server/scripts/smoke-mvp3.ts meeting        # 45 分钟后评审会议
 *   npx tsx apps/server/scripts/smoke-mvp3.ts all
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
  const wantDueSoon = mode === 'due-soon' || mode === 'both' || mode === 'all';
  const wantOverdue = mode === 'overdue' || mode === 'both' || mode === 'all';
  const wantMeeting = mode === 'meeting' || mode === 'all';

  if (wantDueSoon) {
    const due = new Date(now + 2 * 3600_000).toISOString();
    const mergeHint = `smoke-due-soon-${now}`;
    const { unit } = upsertContextUnit({
      kind: 'commitment',
      title: '周三前补 MVP2 方案',
      content: `[smoke] dueAt=${due}`,
      entities: [
        { type: 'person', name: '小李', role: 'target' },
        { type: 'project', name: 'AI is ON', role: 'about' },
      ],
      time: { dueAt: due },
      actionability: 'ask',
      confidence: 0.9,
      mergeHint,
      scope: 'work',
      origin: { kind: 'manual', refId: `smoke:${mergeHint}` },
    });
    console.log(`[smoke] inserted commitment ${unit.id}: "${unit.title}" due ${due}`);
  }

  if (wantOverdue) {
    const due = new Date(now - 6 * 3600_000).toISOString();
    const mergeHint = `smoke-overdue-${now}`;
    const { unit } = upsertContextUnit({
      kind: 'commitment',
      title: '昨天答应给小李的反馈',
      content: `[smoke] dueAt=${due}`,
      entities: [
        { type: 'person', name: '小李', role: 'target' },
        { type: 'project', name: 'AI is ON', role: 'about' },
      ],
      time: { dueAt: due },
      actionability: 'ask',
      confidence: 0.9,
      mergeHint,
      scope: 'work',
      origin: { kind: 'manual', refId: `smoke:${mergeHint}` },
    });
    console.log(`[smoke] inserted commitment ${unit.id}: "${unit.title}" due ${due}`);
  }

  if (wantMeeting) {
    // 45 分钟后的会议，title 含关键字 "评审" → 命中 meeting_prepare evaluator window
    const startsAt = new Date(now + 45 * 60_000).toISOString();
    const mergeHint = `smoke-meeting-${now}`;
    const { unit } = upsertContextUnit({
      kind: 'event',
      title: 'MVP2 设计评审',
      content: `[smoke] 评审 MVP2 落地方案；与 @小李 @阿杨 同步进展`,
      entities: [
        { type: 'person', name: '小李', role: 'attendee' },
        { type: 'person', name: '阿杨', role: 'organizer' },
        { type: 'project', name: 'AI is ON', role: 'about' },
      ],
      time: { startsAt, occurredAt: startsAt },
      actionability: 'notify',
      confidence: 0.95,
      mergeHint,
      scope: 'work',
      origin: { kind: 'manual', refId: `smoke:${mergeHint}` },
    });
    console.log(`[smoke] inserted meeting event ${unit.id}: "${unit.title}" starts ${startsAt}`);
  }

  // Wait for queue to drain. prepare_meeting calls LLM, give it ~120s.
  const waitMs = wantMeeting ? 120_000 : 3_000;
  console.log(`[smoke] waiting ${waitMs}ms for agent runs to complete...`);
  await new Promise((r) => setTimeout(r, waitMs));
  console.log('[smoke] done.');
}

main().catch((err) => {
  console.error('[smoke] crashed:', err);
  process.exit(1);
});
