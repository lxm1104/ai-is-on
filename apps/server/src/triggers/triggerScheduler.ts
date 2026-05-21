import { registerUpsertHook } from '../context/contextStore.js';
import {
  evaluateAndPersistForUnit,
  evaluateActiveUnitsForPullPath,
} from './triggerEvaluator.js';
import { enqueueAgentRunForTrigger } from '../agents/AgentRunQueue.js';
import { resolveUnitToSpaces } from '../spaces/contextSpaceService.js';

const PULL_INTERVAL_MS = 60_000;

let pullTimer: NodeJS.Timeout | null = null;

export function startTriggerScheduler() {
  // Push path: context upsert immediately evaluates the new/updated unit
  // and routes it into any matching Spaces.
  registerUpsertHook((unit, changeContext) => {
    // MVP8.1: 先把 unit 路由到 Space，再 evaluate + enqueue。
    // 原因：enqueueAgentRunForTrigger 内部的 void drain() 会同步跑到 assembler
    // 才让出 microtask；assembler 读 Space links 时若 link 还没建立，就拿不到。
    try {
      resolveUnitToSpaces(unit);
    } catch (err) {
      console.warn(
        '[spaces] resolveUnitToSpaces failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
    const ids = evaluateAndPersistForUnit(unit, Date.now(), changeContext);
    for (const triggerId of ids) {
      enqueueAgentRunForTrigger(triggerId);
    }
  });

  // Pull path: every 60s, re-scan active ContextUnits for time-based triggers
  // (commitment_due / meeting_prepare windows can become true purely from
  // clock progress without any new context).
  const tick = () => {
    try {
      const ids = evaluateActiveUnitsForPullPath();
      for (const triggerId of ids) enqueueAgentRunForTrigger(triggerId);
    } catch (err) {
      console.warn(
        '[triggers] pull tick failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
  };
  // Stagger first run by 10s so server boot doesn't fight with collector tick.
  setTimeout(tick, 10_000);
  pullTimer = setInterval(tick, PULL_INTERVAL_MS);
  console.log('[triggers] scheduler started; push hook + 60s pull worker');
}

export function stopTriggerScheduler() {
  if (pullTimer) clearInterval(pullTimer);
  pullTimer = null;
}
