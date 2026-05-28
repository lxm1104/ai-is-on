/**
 * MVP21 S5 §8.2 — Inducer 注册表。
 *
 * 故意做得很薄：**只共享注册表 + 观测元数据**（name / layer / trigger / 上次运行
 * 时点与耗时），**不强加统一调度 / TTL / 落表**。原因（MVP21 §13）：
 *
 *   - graphInducer 是 throttled in-memory cache（5min throttle）
 *   - suggestionWorker 是受用户反馈冷却（feedback-cooldown）
 *   - selfRoleOnUnit 是 on-read 现算（不落表）
 *
 * 三种生命周期差异太大，强行抽象会损失现有优化。注册表只回答
 * "我是谁、我属于哪个 layer、我什么时候跑过"。
 *
 * 使用方式：
 *   - 在 inducer 模块顶部 import-time 调 `registerInducer(...)` 一次
 *   - 在 inducer 主入口的 finally 块里调 `reportInducerRun(name, durationMs, error?)`
 *   - 前端 GET /api/debug/inducers 拿快照
 */
import type { ContextLayer } from '../context/layerClassifier.js';

/** Inducer 产出落到哪一层（MVP21 §3.1 layer 分类的子集）。 */
export type InducerLayer = Extract<ContextLayer, 'derived_signal' | 'pending_inference'>;

/** 触发方式。仅元数据，注册表不据此真去触发。 */
export type InducerTrigger = 'on_unit_upsert' | 'tick' | 'manual';

export type InducerInfo = {
  name: string;
  layer: InducerLayer;
  trigger: InducerTrigger;
  /** 上次开始运行的 ISO 时间；从未跑过为 null。 */
  lastRunAt: string | null;
  /** 上次运行耗时（毫秒）；从未跑过为 null。 */
  lastDurationMs: number | null;
  /** 上次运行的错误信息（< 200 字）；成功为 null。 */
  lastError: string | null;
  /** 累计运行次数（含失败）。 */
  runCount: number;
};

const registry = new Map<string, InducerInfo>();

/**
 * 在模块顶部 import-time 调一次，登记 inducer 元数据。
 * 重复调用同 name 会更新 layer/trigger（dev hot-reload 友好），其它统计字段保留。
 */
export function registerInducer(
  name: string,
  layer: InducerLayer,
  trigger: InducerTrigger
): void {
  const existing = registry.get(name);
  if (existing) {
    existing.layer = layer;
    existing.trigger = trigger;
    return;
  }
  registry.set(name, {
    name,
    layer,
    trigger,
    lastRunAt: null,
    lastDurationMs: null,
    lastError: null,
    runCount: 0,
  });
}

/**
 * Inducer 主入口跑完后调一次。durationMs 由调用方自己计时（Date.now() 差）。
 * error 字符串过长会截断到 200 字。
 *
 * 注：reportInducerRun 不阻塞 / 不抛错。如果 name 未先 register，会静默忽略
 * （防 typo 拖垮 inducer 主路径）。
 */
export function reportInducerRun(
  name: string,
  durationMs: number,
  error?: string | null
): void {
  const info = registry.get(name);
  if (!info) {
    // 静默忽略（注册表是观测层，不该因 missing-register 影响主流程）
    return;
  }
  info.lastRunAt = new Date().toISOString();
  info.lastDurationMs = Math.max(0, Math.round(durationMs));
  info.lastError = error ? error.slice(0, 200) : null;
  info.runCount += 1;
}

/** GET /api/debug/inducers 直接 JSON.stringify 这个结果。 */
export function listInducers(): InducerInfo[] {
  // 拷贝以防消费方修改
  return Array.from(registry.values()).map((x) => ({ ...x }));
}

/** 仅测试用。 */
export function _resetRegistryForTest(): void {
  registry.clear();
}
