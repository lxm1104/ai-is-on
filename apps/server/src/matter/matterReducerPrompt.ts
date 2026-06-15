/**
 * MVP27 §6.5 — Matter Reducer LLM 判定的 prompt + 解析。
 *
 * 输入：一条新 ContextUnit + top-K 候选 Matter（含最近 evidence）。
 * 输出：单个 MatterReduceDecision JSON（create / attach / ignore + effect + confidence）。
 *
 * system prompt 通过 opencode agent 文件物化（见 opencode/agents.ts 注册 'aiisn-matter-reducer'），
 * 这里只导出常量 + user message 构造 + 鲁棒解析。Reducer 负责按阈值落地裁决（§6.5）。
 */
import { jsonrepair } from 'jsonrepair';
import type {
  MatterContextEffect,
  MatterReduceAction,
  MatterReduceDecision,
  MatterStatus,
} from './matterTypes.js';

export const MATTER_REDUCE_SYSTEM_PROMPT = `你是「事项状态」收拢器。系统已有一批正在进行的「事项」(Matter)，每个 Matter 把同一件正在发生的事的多条证据收拢成一个状态。现在来了一条新的 context（承诺 / 已发生动作 / 决定 / 不确定 / 意图），请判断它如何影响事项。

你只做一次判断，输出**单个合法 JSON 对象**，不要 Markdown、不要多余文字。

判断动作 action：
- "attach"：这条 context 属于某个已有候选 Matter（推进 / 完成 / 阻塞 / 重开它）。必须给 matterId（候选里的 id）。
- "create"：这是一件**新的**事项，任何候选都不是同一件事。
- "ignore"：与任何事项都无关，或证据太弱不足以动状态。

attach 时给 effect：
- "progress"：有进展但没完成（如"已建任务""已发初稿"）。
- "resolve"：事项已完成 / 已进入不需提醒的状态（如"已拉群讨论上了""已确认时间""已交付且对方收到"）。
- "block"：被阻塞 / 出现明确不确定。
- "reopen"：一件**已 resolved** 的事又被明确再提 / 对方说没收到 / 需要重做。
- "no_change"：相关但不改变状态，只作为证据。

关键规则（务必遵守）：
1. action_result 不等于一定 resolve。"已提醒对方""已建任务"通常只是 progress；"已拉群讨论""已确认时间""已交付确认"才接近 resolve。结合候选 Matter 的 type 与 nextAction 判断。
2. resolve 的置信门槛要高于 progress：不确定是否真的完成时，给 progress 或 no_change，别轻易 resolve（误判已完成比漏提醒更伤用户信任）。
3. 同一个人、同一个项目下可能有多件不同的事。**只有动作短语 + 主对象都对得上**才 attach；只是"同一个人"或"同一个项目"不足以合并 → 倾向 create 或 ignore。
4. reopen 只在**明确**信号下给（对方再次催 / 说没收到 / 要求重做）；只是同一个人又出现、同项目有新消息，不要 reopen。
5. 不要输出 effect="drop"；放弃由用户手动决定。
6. confidence ∈ [0,1]，如实标定你对这次判断的把握。证据弱就给低分。
7. nextAction 是给用户看的「下一步最该做的一件事」，必须**具体、可执行**：带上动作 + 对象（谁/什么），≤40 字，别写"关注一下""持续跟进"这类空话。规则：
   - action=create，或 effect ∈ {progress, block, reopen} → **必须**给一句具体 nextAction（事项还没结，用户总有下一步）。
   - effect=resolve 或 action=ignore → nextAction 为 null（事已了，无需下一步）。
   - effect=no_change → 若你比该事项现有的下一步更清楚，就给出更新；否则省略（不要为了填而填）。

输出 schema：
{
  "action": "attach",
  "matterId": "<候选里的 id；create/ignore 时省略>",
  "effect": "resolve",
  "status": "resolved",
  "title": "<create 时给规范化标题；attach 可省略>",
  "summaryPatch": "<对该事项当前状态的一句话更新，可选>",
  "nextAction": "<下一步最该做的一件具体事，见规则 7；事已了或无关给 null>",
  "confidence": 0.82,
  "reason": "<一句话依据，≤80 字>"
}`;

export type MatterCandidateSketch = {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  currentSummary: string;
  entities: Array<{ type: string; name: string; role: string }>;
  spaces: string[];
  recentEvidence: Array<{ kind?: string; title?: string; effect?: string; at: string }>;
};

export type NewUnitSketch = {
  id: string;
  kind: string;
  title: string;
  content: string;
  actionability: string;
  scope: string;
  source: string;
  time?: { occurredAt?: string; dueAt?: string };
  entities: Array<{ type: string; name: string; role: string }>;
};

export function buildMatterReduceUserMessage(opts: {
  unit: NewUnitSketch;
  candidates: MatterCandidateSketch[];
}): string {
  const lines = [
    '新增 context unit：',
    '<newUnit>',
    JSON.stringify(opts.unit, null, 2),
    '</newUnit>',
    '',
    `候选 Matter（${opts.candidates.length} 个，已按相关性排序，含最近 evidence）：`,
    '<candidates>',
    JSON.stringify(opts.candidates, null, 2),
    '</candidates>',
    '',
    '请判断这条 context 如何影响事项，只输出一个 JSON 对象（MatterReduceDecision）。',
  ];
  return lines.join('\n');
}

// ---- 解析 ----

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {}
  try {
    return JSON.parse(jsonrepair(s));
  } catch {}
  return null;
}

function extractJson(s: string): unknown {
  const whole = tryParse(s);
  if (whole !== null) return whole;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inside = tryParse(fenced[1]);
    if (inside !== null) return inside;
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const sliced = tryParse(s.slice(first, last + 1));
    if (sliced !== null) return sliced;
  }
  throw new Error(`matter reduce 输出不是合法 JSON: ${s.slice(0, 200)}`);
}

const ACTIONS = new Set<MatterReduceAction>(['create', 'attach', 'ignore']);
const EFFECTS = new Set<MatterContextEffect>([
  'create',
  'progress',
  'resolve',
  'block',
  'reopen',
  'drop',
  'no_change',
]);
const STATUSES = new Set<MatterStatus>([
  'open',
  'acknowledged',
  'in_progress',
  'waiting',
  'blocked',
  'resolved',
  'dropped',
]);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** 解析并归一 LLM 输出为 MatterReduceDecision；非法时抛错（调用方降级为 ignore）。 */
export function parseMatterReduceDecision(text: string): MatterReduceDecision {
  const obj = extractJson(text) as Record<string, unknown>;
  const action = str(obj.action) as MatterReduceAction | undefined;
  if (!action || !ACTIONS.has(action)) {
    throw new Error(`matter reduce: 非法 action=${String(obj.action)}`);
  }
  const effectRaw = str(obj.effect) as MatterContextEffect | undefined;
  const statusRaw = str(obj.status) as MatterStatus | undefined;
  const nextActionRaw = obj.nextAction;
  return {
    action,
    matterId: str(obj.matterId),
    effect: effectRaw && EFFECTS.has(effectRaw) ? effectRaw : undefined,
    status: statusRaw && STATUSES.has(statusRaw) ? statusRaw : undefined,
    title: str(obj.title),
    summaryPatch: str(obj.summaryPatch),
    nextAction:
      nextActionRaw === null ? null : str(nextActionRaw) ?? undefined,
    confidence: clamp01(obj.confidence),
    reason: str(obj.reason) ?? '',
  };
}
