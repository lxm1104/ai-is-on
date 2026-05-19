import { registerUpsertHook } from '../context/contextStore.js';
import {
  evaluateAndPersistForUnit,
  evaluateActiveUnitsForPullPath,
} from './triggerEvaluator.js';
import { enqueueAgentRunForTrigger } from '../agents/AgentRunQueue.js';

const PULL_INTERVAL_MS = 60_000;

let pullTimer: NodeJS.Timeout | null = null;

export function startTriggerScheduler() {
  // Push path: context upsert immediately evaluates the new/updated unit.
  registerUpsertHook((unit) => {
    const ids = evaluateAndPersistForUnit(unit);
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
