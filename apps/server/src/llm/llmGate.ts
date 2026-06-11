// 全局 LLM 闸门（从 triage/backgroundRuntime.ts 抽出，2026-06-11）。
//
// coding-plan 类 provider 对单账号近似串行处理；多调用方并发直发会在 provider 端
// 互相挤兑排队 → 集体超时（2026-06-09 实测 87% 失败）。闸门把排队留在本地，
// timeout 只度量真实 LLM 耗时。
//
// 双级队列：high 给用户可感知引擎（attention），normal 给后台批处理。
// 同级 FIFO；release 时 high 队列优先出闸。
export type LlmGate = {
  acquire(priority: boolean): Promise<void>;
  release(): void;
  stats(): { active: number; queuedHigh: number; queued: number };
};

export function createLlmGate(maxConcurrency: number): LlmGate {
  const max = Math.max(1, maxConcurrency);
  const waitersHigh: Array<() => void> = [];
  const waiters: Array<() => void> = [];
  let active = 0;

  return {
    acquire(priority: boolean): Promise<void> {
      if (active < max) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        (priority ? waitersHigh : waiters).push(() => {
          active += 1;
          resolve();
        });
      });
    },
    release(): void {
      active -= 1;
      const next = waitersHigh.shift() ?? waiters.shift();
      if (next) next();
    },
    stats() {
      return { active, queuedHigh: waitersHigh.length, queued: waiters.length };
    },
  };
}
