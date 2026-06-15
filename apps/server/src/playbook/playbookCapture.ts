/**
 * MVP37 — 从真实处理采集操作轨迹(TaskTrace)。一期只接最干净的来源：自主排查的 toolLog
 * （已结构化、全保真，比聊天路径被截断的 messageBus 强）。执行动作/聊天来源后续再接。
 *
 * 纯采集，零放权风险——只把"这类任务这次是怎么一步步做的"落库，供后续蒸馏。
 */
import { insertTaskTrace } from './playbookStore.js';
import { deriveTaskTypeKey, type TraceStep, type TaskTrace } from './PlaybookTypes.js';
import { maybeDistillPlaybook } from './playbookDistillService.js';
import type { InvestigationResult } from '../investigation/investigationLoop.js';

/** 把一次排查的 toolLog 转成有序 TraceStep（read 类）。 */
export function investigationToSteps(result: InvestigationResult): TraceStep[] {
  return result.toolLog.map((entry, i) => ({
    order: i + 1,
    kind: 'read' as const,
    tool: entry.tool,
    summary: entry.ok ? entry.summary : `（失败：${entry.error ?? '未知'}）`,
    params: entry.params,
  }));
}

/** 采集一次自主排查的操作轨迹。无工具调用（直接 conclude）则不记（没有"流程"可学）。 */
export function captureInvestigationTrace(
  matter: { id: string; type: string; title: string; nextAction?: string | null },
  result: InvestigationResult
): TaskTrace | null {
  const steps = investigationToSteps(result);
  if (steps.length === 0) return null;
  const taskTypeKey = deriveTaskTypeKey(matter);
  const trace = insertTaskTrace({
    taskTypeKey,
    matterId: matter.id,
    source: 'investigation',
    title: matter.title,
    steps,
    outcome: `${result.conclusion.verdict}（置信 ${result.conclusion.confidence.toFixed(2)}）：${result.conclusion.factSummary.slice(0, 120)}`,
  });
  // 攒够同类轨迹 → fire-and-forget 蒸馏一份 suggest 草稿（失败静默，不影响主流程）。
  void maybeDistillPlaybook(taskTypeKey).catch(() => {});
  return trace;
}
