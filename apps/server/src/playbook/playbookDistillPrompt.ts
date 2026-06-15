/**
 * MVP37 — 流程蒸馏 prompt：把同一类任务的多条真实操作轨迹归纳成一份可复用 playbook。
 * 物化为 opencode agent 'aiisn-playbook-distill'（READ_ONLY，纯文本进 JSON 出）。
 */
import { jsonrepair } from 'jsonrepair';
import type { PlaybookStep, TaskTrace } from './PlaybookTypes.js';

export const PLAYBOOK_DISTILL_SYSTEM_PROMPT = `你是「流程蒸馏器」。给你同一类任务的若干条**真实操作轨迹**（每条是处理这类任务时实际走过的有序步骤 + 结果）。请归纳出这类任务的**标准操作流程(playbook)**——一份有序、可复用、**去具体化**的步骤清单。

要求：
1. **去具体化**：步骤写通用意图，不要写死具体人名/会话 id/文档 token。例如把"搜 IM 关键词「评测集 鲁升纲」"归纳成"搜索与该事项相关的 IM 消息，确认是否提过/发过"。
2. 只保留**真正有信息量、反复出现**的步骤；偶发的、失败的、与任务无关的步骤丢掉。
3. 步骤按合理执行顺序排列；每步一句话意图，≤30 字。
4. 可选给 toolHint（这步倾向用哪个工具/来源，如 search_im_messages / 读文档 / 代码库 / fornax-cli）。
5. 步骤数 2-6 条为宜，别啰嗦。

只输出**一个合法 JSON 对象**，不要 Markdown、不要多余文字：
{
  "title": "<这类任务的标准做法，一句话>",
  "steps": [
    { "order": 1, "intent": "<这一步要达成什么>", "toolHint": "<可选>" }
  ]
}`;

export function buildDistillUserMessage(opts: { taskTypeKey: string; traces: TaskTrace[] }): string {
  const lines: string[] = [`任务类型：${opts.taskTypeKey}`, `共 ${opts.traces.length} 条真实轨迹：`, ''];
  opts.traces.forEach((t, i) => {
    lines.push(`<轨迹 ${i + 1}：${t.title}>`);
    for (const s of t.steps.slice().sort((a, b) => a.order - b.order)) {
      lines.push(`  ${s.order}. [${s.kind}] ${s.tool ?? ''} ${s.summary}`.trim());
    }
    if (t.outcome) lines.push(`  结果：${t.outcome}`);
    lines.push(`</轨迹 ${i + 1}>`, '');
  });
  lines.push('请归纳成一份去具体化的标准 playbook，只输出 JSON。');
  return lines.join('\n');
}

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {}
  try {
    return JSON.parse(jsonrepair(s));
  } catch {}
  return null;
}

export type DistilledPlaybook = { title: string; steps: PlaybookStep[] };

/** 解析蒸馏输出；非法/空步骤 → null（调用方不落地）。 */
export function parseDistillOutput(text: string): DistilledPlaybook | null {
  let obj = tryParse(text) as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) obj = tryParse(text.slice(first, last + 1)) as Record<string, unknown> | null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : '';
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
  const steps: PlaybookStep[] = [];
  rawSteps.forEach((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const intent = typeof o.intent === 'string' ? o.intent.trim() : '';
    if (!intent) return;
    const step: PlaybookStep = { order: typeof o.order === 'number' ? o.order : i + 1, intent };
    if (typeof o.toolHint === 'string' && o.toolHint.trim()) step.toolHint = o.toolHint.trim();
    steps.push(step);
  });
  if (!title || steps.length === 0) return null;
  return { title, steps };
}
