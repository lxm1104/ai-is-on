/**
 * MVP37 — 流程蒸馏服务：同一类任务攒够 N 条真实轨迹 → LLM 归纳成 suggest 档 playbook 草稿。
 *
 * 联动纪律：distillUpsertPlaybook 自身会**避让用户写的权威版**（skip 不覆盖）；这里再早退一层
 * （已有权威版直接不跑 LLM，省成本）。蒸馏只产 suggest 草稿，等用户在面板批准/编辑才升权威。
 * 由 captureInvestigationTrace 落轨迹后 fire-and-forget 触发；失败静默（纯增量，不影响主流程）。
 */
import {
  countTracesByType,
  listTracesByType,
  getPlaybookByType,
  distillUpsertPlaybook,
} from './playbookStore.js';
import { isAuthoritative, type PlaybookOrigin } from './PlaybookTypes.js';
import {
  PLAYBOOK_DISTILL_SYSTEM_PROMPT,
  buildDistillUserMessage,
  parseDistillOutput,
} from './playbookDistillPrompt.js';
import { runOneShot } from '../triage/backgroundRuntime.js';

const MIN_TRACES = 3;     // 攒够这么多同类轨迹才蒸馏（防单例过拟合）
const REFRESH_EVERY = 3;  // distilled 草稿每多 N 条新轨迹重蒸一次（吸收新做法）

export type DistillDeps = {
  judge?: (system: string, user: string) => Promise<string>;
};

async function defaultJudge(system: string, user: string): Promise<string> {
  const r = await runOneShot(user, { agentName: 'aiisn-playbook-distill', systemPrompt: system });
  return r.text;
}

/** 判断该不该蒸馏（纯函数，便于测试）。 */
export function shouldDistill(
  count: number,
  existing: { origin: PlaybookOrigin; approved: boolean; traceCount: number } | null
): boolean {
  if (count < MIN_TRACES) return false;
  if (existing && isAuthoritative(existing)) return false; // 人主导：有权威版不动
  if (!existing) return true; // 头一次攒够
  return count - existing.traceCount >= REFRESH_EVERY; // 又攒够一批新轨迹 → 重蒸
}

/** 某任务类型攒够轨迹后尝试蒸馏一份 suggest 草稿。返回是否真的产出/更新了草稿。 */
export async function maybeDistillPlaybook(taskTypeKey: string, deps: DistillDeps = {}): Promise<boolean> {
  const count = countTracesByType(taskTypeKey);
  const existing = getPlaybookByType(taskTypeKey);
  if (!shouldDistill(count, existing)) return false;

  const traces = listTracesByType(taskTypeKey, 8).filter((t) => t.steps.length > 0);
  if (traces.length < MIN_TRACES) return false;

  const judge = deps.judge ?? defaultJudge;
  let distilled;
  try {
    const text = await judge(PLAYBOOK_DISTILL_SYSTEM_PROMPT, buildDistillUserMessage({ taskTypeKey, traces }));
    distilled = parseDistillOutput(text);
  } catch (err) {
    console.warn('[playbook] 蒸馏失败:', err instanceof Error ? err.message : String(err));
    return false;
  }
  if (!distilled) return false;

  const r = distillUpsertPlaybook({
    taskTypeKey,
    title: distilled.title,
    steps: distilled.steps,
    traceCount: count,
    confidence: Math.min(0.4 + 0.1 * traces.length, 0.8), // 轨迹越多越自信（封顶 0.8，仍是草稿）
  });
  if (r.skipped) return false; // 被用户权威版避让
  console.log(`[playbook] 蒸馏出草稿 ${taskTypeKey}：${distilled.steps.length} 步（基于 ${traces.length} 条轨迹）`);
  return true;
}
