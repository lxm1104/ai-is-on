/**
 * MVP36 — 自主排查执行循环（后端中介式）。
 *
 * 模型(aiisn-investigate)不碰 shell：每轮输出 JSON（请求只读工具 或 给结论），后端执行白名单只读工具、
 * 回喂结果，循环到 conclude 或轮数上限。LLM 调用数严格 ≤ maxRounds（每次过单并发 gate，成本可控）。
 *
 * judge 与 runTool 均可注入 → 可在不打真 LLM/lark-cli 的前提下确定性单测。
 */
import { runOneShot } from '../triage/backgroundRuntime.js';
import {
  listReadTools,
  runReadTool,
  compactToolData,
  type ReadToolName,
  type ReadToolResult,
} from './readTools.js';
import {
  buildInvestigateUserMessage,
  parseInvestigationStep,
  type InvestigationConclusion,
} from './investigationPrompt.js';

export type InvestigationInput = {
  matterTitle: string;
  matterType: string;
  currentSummary: string;
  nextAction: string;
  entities: Array<{ type: string; name: string; role?: string }>;
  maxRounds?: number;
  /** 默认 false（背景排查让位 attention）。手动验证可设 true 走 high 队列尽快拿 gate。 */
  priority?: boolean;
  /** MVP37 召回：这类任务已学/用户教过的做法，注入每轮 prompt 让 AI 照此排查。 */
  playbookHint?: string;
  /** MVP38 项目排查档案：所属项目的代码库路径/trace 方法/术语等。 */
  projectProfile?: string;
};

export type InvestigationToolLogEntry = {
  round: number;
  tool: string;
  params: Record<string, unknown>;
  ok: boolean;
  summary: string;
  error?: string;
};

export type InvestigationResult = {
  conclusion: InvestigationConclusion;
  rounds: number;
  toolLog: InvestigationToolLogEntry[];
};

export type InvestigationDeps = {
  /** 默认 runOneShot('aiisn-investigate')。注入可单测。 */
  judge?: (userMessage: string) => Promise<string>;
  /** 默认 runReadTool（硬只读）。注入可单测。 */
  runTool?: (name: ReadToolName, params: Record<string, unknown>) => Promise<ReadToolResult>;
};

const DEFAULT_MAX_ROUNDS = 3;
const FINDING_TRUNC = 600;
// run_command 回的是 trace / 代码内容，是定位根因的实质材料 —— 给更大预算才看得到东西
// （600 字对 trace/代码片段太小）。仍有界（命令层 stdout 已 cap 16KB），模型可再用 rg/jq 精取。
const RUN_COMMAND_FINDING_TRUNC = 2400;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + ' …' : s;
}

function shortParams(p: Record<string, unknown>): string {
  return truncate(
    Object.entries(p)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(','),
    80
  );
}

async function defaultJudge(userMessage: string, priority: boolean): Promise<string> {
  const r = await runOneShot(userMessage, {
    agentName: 'aiisn-investigate',
    priority,
    lane: 'investigation', // 独立车道：不被主道挂死的 attention 阻塞
  });
  return r.text;
}

const KNOWN_TOOLS = new Set<string>(listReadTools().map((t) => t.name));

/** 跑一次自主排查。LLM 调用数 ≤ maxRounds。绝不可能产生任何写操作（runTool 只走只读工具层）。 */
export async function runInvestigation(
  input: InvestigationInput,
  deps: InvestigationDeps = {}
): Promise<InvestigationResult> {
  const maxRounds = Math.max(1, Math.min(input.maxRounds ?? DEFAULT_MAX_ROUNDS, 5));
  const judge = deps.judge ?? ((msg: string) => defaultJudge(msg, input.priority ?? false));
  const runTool = deps.runTool ?? runReadTool;

  const findings: string[] = [];
  const toolLog: InvestigationToolLogEntry[] = [];
  let concluded: InvestigationConclusion | null = null;
  let round = 0;

  while (round < maxRounds && !concluded) {
    round += 1;
    const userMessage = buildInvestigateUserMessage({
      matterTitle: input.matterTitle,
      matterType: input.matterType,
      currentSummary: input.currentSummary,
      nextAction: input.nextAction,
      entities: input.entities,
      findings,
      round,
      maxRounds,
      playbookHint: input.playbookHint,
      projectProfile: input.projectProfile,
    });

    let step;
    try {
      step = parseInvestigationStep(await judge(userMessage));
    } catch {
      // MVP52：模型偶发夹说理散文/误发原生 tool-call 致这一轮无合法 JSON → **重试一次**（实测模型能出对的，
      // 一次格式打嗝不该让整个排查归零、再被止损放弃）。重试仍败才降级 unknown，不空转。
      try {
        const retryMsg = `${userMessage}\n\n⚠️ 上一次没有输出合法 JSON（不要写任何说理散文、不要尝试调用工具）。现在**只**输出那一个 JSON 对象。`;
        step = parseInvestigationStep(await judge(retryMsg));
      } catch (err2) {
        concluded = {
          verdict: 'unknown',
          confidence: 0,
          factSummary: `排查器输出无法解析（重试后仍失败）：${err2 instanceof Error ? err2.message : String(err2)}`,
          evidence: [],
        };
        break;
      }
    }

    if (step.action === 'conclude') {
      concluded = step.conclusion;
      break;
    }

    // investigate：执行模型请求的只读工具（未知工具名直接记失败，不执行）
    for (const call of step.toolCalls) {
      if (!KNOWN_TOOLS.has(call.tool)) {
        toolLog.push({ round, tool: call.tool, params: call.params, ok: false, summary: '', error: '未知工具' });
        findings.push(`${call.tool} 不是可用工具`);
        continue;
      }
      const res = await runTool(call.tool as ReadToolName, call.params);
      toolLog.push({ round, tool: call.tool, params: call.params, ok: res.ok, summary: res.summary, error: res.error });
      // run_command：把实质 stdout（trace/代码内容）按更大预算回喂，而非截 JSON 包壳；其它工具沿用 600。
      let detail: string;
      if (call.tool === 'run_command' && res.data && typeof res.data === 'object') {
        const d = res.data as { stdout?: unknown; code?: unknown };
        const out = typeof d.stdout === 'string' ? d.stdout : '';
        detail = truncate(out, RUN_COMMAND_FINDING_TRUNC) || `(exit ${String(d.code)}，无输出)`;
      } else {
        // MVP70：列表类结果（IM 消息/任务）压成可读紧凑文本——否则模型只看到被 600 字截断的 verbose
        // JSON 信封（一堆 chat_id 元数据、看不到正文），等于瞎查。非列表回落原 JSON。
        const compact = compactToolData(res.data);
        detail = compact ? truncate(compact, RUN_COMMAND_FINDING_TRUNC) : truncate(JSON.stringify(res.data ?? ''), FINDING_TRUNC);
      }
      findings.push(
        res.ok
          ? `${call.tool}(${shortParams(call.params)}) → ${res.summary}｜${detail}`
          : `${call.tool}(${shortParams(call.params)}) 查询失败：${res.error}`
      );
    }
  }

  if (!concluded) {
    // 用满轮数仍未 conclude → 基于已查到的综合一个保守 unknown（不再多打一次 LLM，控成本）
    concluded = {
      verdict: 'unknown',
      confidence: findings.length ? 0.3 : 0,
      factSummary: findings.length
        ? `已查 ${findings.length} 处但未形成明确结论`
        : '未查到与该事项相关的信息',
      evidence: findings.slice(0, 3),
    };
  }

  return { conclusion: concluded, rounds: round, toolLog };
}
