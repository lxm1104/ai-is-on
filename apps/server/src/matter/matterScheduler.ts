/**
 * MVP27 §6.1 / §10.1 — Matter tracker：把 reducer 挂到 contextStore 的 upsert hook。
 *
 * 注册顺序要求（index.ts）：startMatterTracker() 在 startTriggerScheduler / startAttentionScheduler
 * **之前**调用，让 Matter 先归并好「已完成 / 已推进 / 已阻塞」，trigger/attention 再决定是否提醒。
 *
 * §6.1 实现注意：Matter hook 跑在 trigger hook 之前，不能假设新 unit 已完成 Space routing，
 * 所以 hook 开头主动 resolveUnitToSpaces(rehydrated unit) 一次（幂等）。reduce 是异步（LLM），
 * hook 是 sync，所以 fire-and-forget，错误只记日志、不影响其他 hook。
 */
import { getContextUnitById, registerUpsertHook } from '../context/contextStore.js';
import { resolveUnitToSpaces } from '../spaces/contextSpaceService.js';
import { reduceMatterForContextUnit } from './matterReducer.js';

let registered = false;

export function startMatterTracker(): void {
  if (registered) return;
  registered = true;
  registerUpsertHook((unit, changeContext) => {
    try {
      const hydrated = getContextUnitById(unit.id) ?? unit;
      resolveUnitToSpaces(hydrated);
    } catch (err) {
      console.warn(
        '[matter] resolveUnitToSpaces failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
    void reduceMatterForContextUnit(unit, changeContext).catch((err) => {
      console.warn(
        '[matter] reduce failed:',
        err instanceof Error ? err.message : String(err)
      );
    });
  });
  console.log('[matter] tracker started; upsert hook registered before trigger/attention');
}

export function stopMatterTracker(): void {
  // registerUpsertHook 目前不支持注销；保留对称 API 供 index.ts shutdown 调用（no-op）。
  // 进程退出时 hook 数组随之销毁；`registered` 守卫防止重复注册。
}
