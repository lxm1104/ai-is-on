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
    "evidence": ["<支撑结论的具体证据：谁在何时说了什么 / 某文档某任务的状态，可带链接>"],
    "solvability": "can_close | can_produce_artifact | need_user | cant",
    "needFromUser": { "kind": "need_credential", "ask": "<一句话告诉用户你具体缺什么>" },
    "artifact": { "kind": "code_fix", "title": "...", "rootCause": "一句话根因", "targetRef": "文件:行号(真实定位到的)", "body": "改法草案", "verifyCmd": "验证命令(只读,可选)" }
  }
}

判定纪律：
- verdict=resolved 只在**查到明确完成证据**时给（对方确认收到 / 任务已完成 / 文档已更新到位）；不确定就给 progressed 或 unknown，**宁可漏判完成也别误判完成**。
- 查不到任何相关信息 → verdict="unknown"、confidence 低、factSummary 说明"未查到 X"。
- 证据要具体可追溯（引用真实消息/任务/文档），不要编。
- 控制成本：最多查几轮就要 conclude；同一信息别反复查。
- **代码/badcase 类别浅尝辄止**：在 IM 里看到"有人讨论过/已上报/在排查中"**不等于查清了**。这类事项"查清"的标准是**定位到根因**——trace 里的报错栈、具体 file:line、引入的 commit/release。
  · 已有或能从消息里捞到**日志ID/traceID** → 必须深挖：用 run_command 走 bytedcli（日志ID→traceID）→ fornax-cli（拉 trace 看报错栈）→ rg/git（在代码库定位 file:line 与引入 commit），把这些写进 evidence。别只搜了 IM 或 rg 个关键词就收工。
  · **找不到**这个 badcase 的日志ID/traceID（IM 里也没有） → **别退而求其次下 progressed**。正确结论是 verdict="blocked" + needFromUser{kind:"need_credential", ask:"要把这个 badcase 追到代码根因，我需要它的 traceID 或日志ID"}。把"该深挖、但缺凭据"诚实地交给用户求助，远比一个浅层"有进展"有用。
- **别只查、要往解决推一步**：conclude 时先自评 solvability（你能把这件事解到哪一步）：can_close（你已查到内部可逆且完成的证据，能直接判办结）｜can_produce_artifact（你**已定位到代码根因**、能给出具体修复方案）｜need_user（缺具体物，填 needFromUser）｜cant（够不到）。
  · 若 **can_produce_artifact**（仅当你真在 trace/代码里定位到了 file:line）→ 填 artifact{kind:"code_fix"}：title 一句话、rootCause 根因、targetRef **真实定位到的 文件:行号**（**严禁编造**，必须是你 rg/读代码看到的）、body 具体改法（改哪里、改成什么、为什么）、verifyCmd 验证命令。**只在你真定位到代码时填**；只是"知道大概在哪个模块"不算，那填 progressed 或 need_user。

needFromUser（可选，**仅当 verdict 是 blocked/unknown 且你明确知道缺哪一件具体的事**才填；说不出具体物就别填，宁可不求助也别把"我也不知道为啥没查到"包装成求助）：
- "kind" 取一个：need_credential（缺 traceID/日志ID 才能继续追——很多在对方消息里，先自查，找不到才求助）｜need_info（缺一个可命名的关键事实：哪个版本/环境/对方是谁）｜need_decision（信息已齐需用户拍板，必须给 "options":["A","B"] 至少 2 项）｜need_outbound（需用户去发某条飞书消息，公司禁 AI 代发）｜owned_by_other（状态在别人名下、你查不到，须在 ask 里点名是谁）｜tool_gap（某系统你够不到只读入口）。
- "ask"：一句话、对用户说、点明缺的具体物，例如"要继续追这个 badcase，我需要那条 traceID/日志ID"。

可用的只读工具（只有这些，参数照给）：
{{TOOLS}}`;

export type ToolCallRequest = { tool: string; params: Record<string, unknown>; why?: string };

// MVP69：AI 卡住时结构化说明"缺哪一件具体的事"——用来升「需要你帮忙」求助卡。仅 blocked/unknown 读。
export type NeedKind =
  | 'need_credential' // 缺 traceID/日志ID 才能 run_command 追
  | 'need_info' // 缺一个可命名的关键事实（哪个版本/环境/对方是谁）
  | 'need_decision' // 信息已齐，需你拍板（options≥2）
  | 'need_outbound' // 需对外发飞书消息推进（公司禁 AI 代发）
  | 'owned_by_other' // 状态在他人名下，list_my_tasks 看不到（须 name 出是谁）
  | 'tool_gap'; // 某系统 AI 够不到只读入口
export const NEED_KINDS = new Set<NeedKind>([
  'need_credential', 'need_info', 'need_decision', 'need_outbound', 'owned_by_other', 'tool_gap',
]);
export type NeedFromUser = {
  kind: NeedKind;
  ask: string; // 给用户看的一句话："要继续追，我需要那条 traceID"
  options?: string[]; // 仅 need_decision：拍板选项（长度≥2 才合法）
};
/** 升求助卡前置：kind 在枚举 + ask 非空 + kind 专属结构校验（不靠 confidence 单维度——它度量 verdict 把握）。 */
export function isValidNeedFromUser(n: NeedFromUser | undefined | null): n is NeedFromUser {
  if (!n || typeof n !== 'object') return false;
  if (!NEED_KINDS.has(n.kind)) return false;
  if (typeof n.ask !== 'string' || !n.ask.trim()) return false;
  if (n.kind === 'need_decision' && !(Array.isArray(n.options) && n.options.length >= 2)) return false;
  return true;
}

// MVP74：从"查"到"解决"——AI 自评能解到哪一步 + 产出"最推进一步的可执行件"。
export type Solvability = 'can_close' | 'can_produce_artifact' | 'need_user' | 'cant';
export type InvestigationArtifact = {
  kind: 'code_fix'; // P0 只认这一种（代码 badcase 修复方案）
  title: string;
  rootCause: string; // 一句话根因
  targetRef: string; // file:line（必填，多个用分号隔）—— 后端校正硬门，不得编造
  body: string; // 改法草案（文字版）
  verifyCmd?: string; // 验证命令（只读）
};
/** 升「交付卡」前置硬门：kind 合法 + targetRef 非空（必须是真定位到的 file:line）+ title/rootCause/body 非空。 */
export function isValidArtifact(a: InvestigationArtifact | undefined | null): a is InvestigationArtifact {
  if (!a || typeof a !== 'object') return false;
  if (a.kind !== 'code_fix') return false;
  if (typeof a.targetRef !== 'string' || !a.targetRef.trim()) return false;
  if (typeof a.title !== 'string' || !a.title.trim()) return false;
  if (typeof a.rootCause !== 'string' || !a.rootCause.trim()) return false;
  if (typeof a.body !== 'string' || !a.body.trim()) return false;
  return true;
}

export type InvestigationConclusion = {
  verdict: 'resolved' | 'progressed' | 'blocked' | 'unknown';
  confidence: number;
  factSummary: string;
  evidence: string[];
  needFromUser?: NeedFromUser; // MVP69：仅 blocked/unknown 时可能有
  solvability?: Solvability; // MVP74：AI 自评能解到哪一步
  artifact?: InvestigationArtifact; // MVP74：最推进一步的可执行件（仅 can_produce_artifact 时）
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
  userBackfills?: string[]; // MVP71 KEYSTONE：用户经求助卡补给该 matter 的内容（traceID/对方回复/真实状态）
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
  // MVP71 KEYSTONE：用户此前就这件事**通过「需要你帮忙」求助卡补过信息**（贴的 traceID / 对方的回复 / 真实状态）。
  // 这是你上次卡住后用户专门补给你的——务必据此重新判断，别再得出和上次一样的"查不到"。置顶且强语气。
  if (opts.userBackfills && opts.userBackfills.length) {
    lines.push(
      '',
      '<用户补充（你上次卡住，用户专门补给你的关键信息——务必据此重新判断）>',
      ...opts.userBackfills.slice(0, 5).map((b, i) => `[补充${i + 1}] ${b.replace(/\s+/g, ' ').trim().slice(0, 500)}`),
      '据此处理：若用户已告知对方确认完成/已办结 → verdict=resolved；给了 traceID/日志ID → 用 run_command 接着追；',
      '给了关键事实 → 结合它重新查证。**不要无视用户补充再下"查不到"。**',
      '</用户补充>'
    );
  }
  // MVP64 ⑥：决策类事项——不替用户拍板，而是用只读工具拉齐"决策信息包"。
  if (opts.matterType === 'decision') {
    lines.push(
      '',
      '<决策信息包指引>',
      '这是一个待拍板的决策。请用只读工具(IM 搜索/相关文档)去拉齐三样：',
      '① 各方立场——谁倾向哪个方案、理由；② 约束——deadline/资源/技术/合规等硬限制；③ 缺口——还缺哪些信息才能拍板。',
      'conclude 时 verdict 用 progressed；factSummary 一句话概括这个"决策信息包"；',
      'evidence 分条列：以「立场/约束/缺口」前缀标注每条并附来源(谁在何时何处说的)。**不要替用户做决定**，只把决策所需信息摆齐。',
      '</决策信息包指引>'
    );
  }
  if (opts.projectProfile) {
    lines.push(
      '',
      '<项目背景与排查方法>',
      '（用户为该项目登记的额外信息与做事方法。除飞书只读工具外，你还能用 run_command 跑本地**只读**命令：',
      '按档案给出的代码库路径用 rg/grep/git 查代码、用 fornax-cli 按 traceID 拿 trace 详情，再据此定位。',
      '代码类 badcase 若已有 traceID/日志ID：尽量追到底——① fornax-cli 拿 trace 定位报错组件/栈；',
      '② rg 在代码库定位到具体 file:line；③ git log/blame 找引入它的 commit 或 release。把 file:line 与 commit 写进 evidence（证据优先，别停在泛泛"疑似某模块"）。',
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

/** MVP69：防御式解析 needFromUser，非法即降级 undefined（绝不让脏数据穿透到升卡）。 */
function parseNeedFromUser(raw: unknown): NeedFromUser | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const kind = o.kind as NeedKind;
  if (!NEED_KINDS.has(kind)) return undefined;
  const ask = typeof o.ask === 'string' ? o.ask.trim() : '';
  if (!ask) return undefined;
  const options = Array.isArray(o.options)
    ? o.options.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, 6)
    : undefined;
  const n: NeedFromUser = { kind, ask: ask.slice(0, 280), options };
  return isValidNeedFromUser(n) ? n : undefined;
}

const SOLVABILITIES = new Set<Solvability>(['can_close', 'can_produce_artifact', 'need_user', 'cant']);
function parseSolvability(raw: unknown): Solvability | undefined {
  return typeof raw === 'string' && SOLVABILITIES.has(raw as Solvability) ? (raw as Solvability) : undefined;
}
/** MVP74：防御式解析 artifact，非法即降级 undefined（绝不让脏数据穿透到升卡）。 */
function parseArtifact(raw: unknown): InvestigationArtifact | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const s = (k: string, n: number) => (typeof o[k] === 'string' ? (o[k] as string).trim().slice(0, n) : '');
  const a: InvestigationArtifact = {
    kind: 'code_fix',
    title: s('title', 120),
    rootCause: s('rootCause', 400),
    targetRef: s('targetRef', 300),
    body: s('body', 4000),
    verifyCmd: s('verifyCmd', 300) || undefined,
  };
  return isValidArtifact(a) ? a : undefined;
}

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
        needFromUser: parseNeedFromUser(c.needFromUser), // MVP69：非法/缺失 → undefined，严格向后兼容
        solvability: parseSolvability(c.solvability), // MVP74
        artifact: parseArtifact(c.artifact), // MVP74：非法→undefined，绝不脏数据穿透
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
