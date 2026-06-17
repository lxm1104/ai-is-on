/**
 * MVP36 — 自主排查推理器的 prompt + 解析。
 *
 * 这是「后端中介式排查」的 LLM 侧：模型**不碰 shell、没有任何工具**，每轮只输出一个 JSON——
 * 要么请求执行若干**白名单只读工具**(action='investigate')，要么给出结论(action='conclude')。
 * 后端执行只读工具、把结果回喂，循环到模型 conclude 或到轮数上限。
 *
 * system prompt 经 opencode agent 文件物化(aiisn-investigate, 权限全 deny——纯文本进 JSON 出)。
 */
import { jsonrepair } from 'jsonrepair';

export const INVESTIGATE_SYSTEM_PROMPT = `你是「事项排查员」。系统给你一件正在跟进的事项(Matter)，以及它的"下一步"——其中有一部分需要去飞书各产品里**查证**才能判断进展(例如"确认评测集是否已发给鲁升纲""跟进某人排查进展")。

你**没有任何工具、不能执行任何动作、绝不发送任何消息或改任何东西**。你能做的只有一件事：每一轮**直接返回一个 JSON 对象作为你的回复文本**，告诉后端你想读取哪些信息；后端会用一组**只读**工具替你查，把结果回给你；你据此继续查或给出结论。

**严禁调用任何工具**（不要尝试 read / grep / bash / 文件读取 / 联网等任何 opencode 原生工具——你一个都没有，调用只会失败）。你**唯一**的表达方式就是把下面这个 JSON 当作回复正文输出。下面"可用的只读工具"是给你**写进 JSON 的 toolCalls 字段用的名字**，不是让你去调用——后端才负责执行。

每轮你只输出一个合法 JSON（不要 Markdown、不要多余文字），二选一：

A) 还需要查 → action="investigate"，给出 toolCalls（1-3 个，少而精；每个工具调用尽量一次问清，别一条一条试）：
{
  "action": "investigate",
  "reason": "<这一步想查清什么，≤40字>",
  "toolCalls": [
    { "tool": "<工具名>", "params": { ... }, "why": "<为什么查这个，≤30字>" }
  ]
}

B) 已能下结论 → action="conclude"：
{
  "action": "conclude",
  "conclusion": {
    "verdict": "resolved | progressed | blocked | unknown",
    "confidence": 0.0-1.0,
    "factSummary": "<查到的关键事实，一两句，给用户看>",
    "evidence": ["<支撑结论的具体证据：谁在何时说了什么 / 某文档某任务的状态，可带链接>"]
  }
}

判定纪律：
- verdict=resolved 只在**查到明确完成证据**时给（对方确认收到 / 任务已完成 / 文档已更新到位）；不确定就给 progressed 或 unknown，**宁可漏判完成也别误判完成**。
- 查不到任何相关信息 → verdict="unknown"、confidence 低、factSummary 说明"未查到 X"。
- 证据要具体可追溯（引用真实消息/任务/文档），不要编。
- 控制成本：最多查几轮就要 conclude；同一信息别反复查。

可用的只读工具（只有这些，参数照给）：
{{TOOLS}}`;

export type ToolCallRequest = { tool: string; params: Record<string, unknown>; why?: string };
export type InvestigationConclusion = {
  verdict: 'resolved' | 'progressed' | 'blocked' | 'unknown';
  confidence: number;
  factSummary: string;
  evidence: string[];
};
export type InvestigationStep =
  | { action: 'investigate'; reason?: string; toolCalls: ToolCallRequest[] }
  | { action: 'conclude'; conclusion: InvestigationConclusion };

export function renderToolsDoc(
  tools: Array<{ name: string; description: string; paramsHint: string }>
): string {
  return tools.map((t) => `- ${t.name}: ${t.description}\n    参数: ${t.paramsHint}`).join('\n');
}

export function buildInvestigateUserMessage(opts: {
  matterTitle: string;
  matterType: string;
  currentSummary: string;
  nextAction: string;
  entities: Array<{ type: string; name: string; role?: string }>;
  findings: string[]; // 已查到的（前几轮工具结果摘要）
  round: number;
  maxRounds: number;
  playbookHint?: string; // MVP37 召回：这类任务已学/用户教过的做法，优先照此排查
  projectProfile?: string; // MVP38 项目排查档案：代码库路径/trace 方法/术语等
}): string {
  const lines = [
    '<matter>',
    `标题：${opts.matterTitle}`,
    `类型：${opts.matterType}`,
    `当前摘要：${opts.currentSummary || '（无）'}`,
    `需排查的下一步：${opts.nextAction}`,
    opts.entities.length
      ? `涉及：${opts.entities.map((e) => `${e.type}:${e.name}${e.role ? `(${e.role})` : ''}`).join(', ')}`
      : '',
    '</matter>',
  ];
  if (opts.projectProfile) {
    lines.push(
      '',
      '<项目背景与排查方法>',
      '（用户为该项目登记的额外信息与做事方法。除飞书只读工具外，你还能用 run_command 跑本地**只读**命令：',
      '按档案给出的代码库路径用 rg/grep/git 查代码、用 fornax-cli 按 traceID 拿 trace 详情，再据此定位。',
      '只读：写/删/发布/凭证类命令会被拒绝；命令在你指定的 cwd 下执行、不能越出允许目录。',
      '若档案提到的来源连 run_command 也够不到，再在结论里告诉用户去哪查什么。）',
      opts.projectProfile,
      '</项目背景与排查方法>'
    );
  }
  if (opts.playbookHint) {
    lines.push('', '<已知做法>', opts.playbookHint, '</已知做法>');
  }
  lines.push(
    '',
    `这是第 ${opts.round}/${opts.maxRounds} 轮${opts.round >= opts.maxRounds ? '（最后一轮，请直接 conclude）' : ''}。`
  );
  if (opts.findings.length) {
    lines.push('', '<已查到>', ...opts.findings.map((f, i) => `[${i + 1}] ${f}`), '</已查到>');
  } else {
    lines.push('', '（还没查任何东西）');
  }
  lines.push('', '请输出一个 JSON：继续 investigate 或 conclude。');
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

/** 括号配平：抠出文本里所有顶层 {...} 片段（应对模型在 JSON 前后夹了说理散文）。 */
function balancedObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

function extractJson(s: string): Record<string, unknown> {
  // 1. 整串**严格** JSON.parse（纯 JSON 回复的快路径）。不在这步用 jsonrepair——它对"散文夹 JSON"
  //    会把整段散文"修"成一个乱对象，反而短路掉下面的精准抠取（实测 bug）。
  try {
    const w = JSON.parse(s);
    if (w && typeof w === 'object') return w as Record<string, unknown>;
  } catch {}
  // 2. 代码围栏
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inside = tryParse(fenced[1]);
    if (inside && typeof inside === 'object') return inside as Record<string, unknown>;
  }
  // 3. 模型常在 JSON 前后夹说理散文（"我先并行查 IM 和代码…{json}…"）→ 配平抠出每个 {...}，
  //    优先取含 action/toolCalls/conclusion 的那个（对每个**孤立片段**用 jsonrepair 是安全的）。
  const objs = balancedObjects(s);
  let fallback: Record<string, unknown> | null = null;
  for (const o of objs) {
    const parsed = tryParse(o);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if ('action' in obj || 'toolCalls' in obj || 'conclusion' in obj) return obj;
      if (!fallback) fallback = obj;
    }
  }
  if (fallback) return fallback;
  // 4. 兜底：整串 jsonrepair / 首尾大括号
  const repaired = tryParse(s);
  if (repaired && typeof repaired === 'object') return repaired as Record<string, unknown>;
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const sliced = tryParse(s.slice(first, last + 1));
    if (sliced && typeof sliced === 'object') return sliced as Record<string, unknown>;
  }
  throw new Error(`investigate 输出非合法 JSON: ${s.slice(0, 160)}`);
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

const VERDICTS = new Set(['resolved', 'progressed', 'blocked', 'unknown']);

/** 解析一步；非法或缺字段时按保守降级（解析失败→当作 unknown 结论，由调用方决定）。 */
export function parseInvestigationStep(text: string): InvestigationStep {
  const obj = extractJson(text);
  const action = typeof obj.action === 'string' ? obj.action : undefined;

  if (action === 'conclude' || obj.conclusion) {
    const c = (obj.conclusion ?? {}) as Record<string, unknown>;
    const verdictRaw = typeof c.verdict === 'string' ? c.verdict : 'unknown';
    return {
      action: 'conclude',
      conclusion: {
        verdict: (VERDICTS.has(verdictRaw) ? verdictRaw : 'unknown') as InvestigationConclusion['verdict'],
        confidence: clamp01(c.confidence),
        factSummary: typeof c.factSummary === 'string' ? c.factSummary : '',
        evidence: Array.isArray(c.evidence) ? c.evidence.filter((x) => typeof x === 'string') : [],
      },
    };
  }

  // investigate
  const rawCalls = Array.isArray(obj.toolCalls) ? obj.toolCalls : [];
  const toolCalls: ToolCallRequest[] = rawCalls
    .map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      const tool = typeof o.tool === 'string' ? o.tool : '';
      const params = o.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>) : {};
      const why = typeof o.why === 'string' ? o.why : undefined;
      return { tool, params, why };
    })
    .filter((c) => c.tool);
  if (toolCalls.length === 0) {
    // 既不是合法 conclude 也没有有效 toolCalls → 降级为 unknown 结论，避免空转
    return {
      action: 'conclude',
      conclusion: { verdict: 'unknown', confidence: 0, factSummary: '排查器未给出有效动作', evidence: [] },
    };
  }
  return {
    action: 'investigate',
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    toolCalls: toolCalls.slice(0, 3), // 每轮最多 3 个工具，控成本
  };
}
