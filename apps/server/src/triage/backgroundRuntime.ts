import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { createLlmGate } from '../llm/llmGate.js';
import { TRIAGE_SYSTEM_PROMPT } from './triagePrompt.js';
import type { OpencodeAgentName } from '../opencode/agents.js';

export type OneShotResult = {
  text: string;
  raw: unknown;
  /** 观测：闸门排队耗时与 LLM 实跑耗时（含 fallback 的串行总和）。 */
  timing: { waitMs: number; execMs: number };
};

/**
 * 一次性 LLM 调用（opencode CLI 后端）。
 *
 * - 模型默认 `config.opencodeModel`（GLM-5.2），失败后按 `config.opencodeFallbackModels`
 *   逐级降级（GLM-5.1 → GLM-5-turbo），整条链都失败才抛错。
 * - 系统 prompt 不在这里传，而是通过 `agentName` 指向 `.opencode/agent/<name>.md`
 *   预生成的 agent 文件（见 [opencode/agents.ts](opencode/agents.ts)）。
 * - opencode `run --format json` 输出 NDJSON 事件流；我们把所有 `text` 块
 *   按序拼接为最终结果。
 *
 * 兼容性提醒：本签名仍接受 `systemPrompt`，但 opencode CLI 没有等价 flag，
 * 该字段当前只用于本地日志/调试，**不会**真正送进 LLM。系统 prompt 的唯一
 * 来源是 agent 文件。
 */
export type OneShotOptions = {
  agentName: OpencodeAgentName;
  /** Legacy: kept for debugging only — see note above. */
  systemPrompt?: string;
  timeoutMs?: number;
  /** true = 闸门高优先级（用户可感知引擎用，如 attention），插到后台批处理前面。 */
  priority?: boolean;
  /** 覆盖主模型（默认 config.opencodeModel）。 */
  model?: string;
  /** 覆盖 fallback 模型链，按序降级（默认 config.opencodeFallbackModels）。 */
  fallbackModels?: string[];
  /**
   * 闸门车道（默认 'main'）。'investigation' 走**独立 gate**——不与 attention/triage/matter 抢同一条
   * 单并发道，因此一个挂死的 attention 调用不再阻塞自主排查（2026-06-15 实测主道被挂死 attention 占住
   * 数分钟，排查即便 priority 也饿死）。独立道自身仍限并发 1，避免 opencode 进程爆炸。
   */
  lane?: 'main' | 'investigation';
};

type OpencodePart = {
  type: string;
  text?: string;
  tool?: string;
  state?: { input?: unknown; output?: unknown; status?: string };
  reason?: string;
};

type OpencodeEvent = {
  type: string;
  part?: OpencodePart;
  sessionID?: string;
};

// --------------------------------------------------------------------------
// 全局 LLM 闸门：所有 opencode one-shot 调用共用一个双级 FIFO 信号量。
// 实现与原理见 llm/llmGate.ts；attention 走 high 队列插队
// （实测排在 triage 后要等 80-160s，插队后 wait≈0，2026-06-10）。
// --------------------------------------------------------------------------

const gate = createLlmGate(config.opencodeMaxConcurrency);
// MVP36：自主排查独立车道（并发 1），不与主道（attention/triage/matter）相互阻塞。
const investigationGate = createLlmGate(1);

function gateFor(lane: OneShotOptions['lane']) {
  return lane === 'investigation' ? investigationGate : gate;
}

/** 调试/监控用：当前闸门占用与排队深度。 */
export function getLlmGateStats(): { active: number; queuedHigh: number; queued: number } {
  return gate.stats();
}

// ───── 模型熔断（吞吐修复）─────
// 某模型连续失败 N 次 → 冷却窗内跳过它、直奔下一个，避免每轮白等 90s 超时；冷却后半开探活一次，成则恢复。
// 纯函数（now 注入、状态 module-level），可单测；永不全跳（至少留兜底）。
type ModelHealth = { fails: number; skipUntil: number };
const modelHealth = new Map<string, ModelHealth>();

/** 测试用：清空熔断状态。 */
export function _resetModelCircuit(): void {
  modelHealth.clear();
}
/** 观测用：当前各模型熔断状态快照。 */
export function getModelCircuitState(): Array<{ model: string; fails: number; skipUntil: number; open: boolean }> {
  const now = Date.now();
  return [...modelHealth.entries()].map(([model, h]) => ({ model, fails: h.fails, skipUntil: h.skipUntil, open: h.skipUntil > now }));
}

function isCircuitOpen(model: string, now: number): boolean {
  const h = modelHealth.get(model);
  return !!h && h.skipUntil > now;
}

/** 选本次实际尝试链：跳过熔断未恢复的模型；保证至少留一个兜底（永不全跳）。 */
export function selectEffectiveChain(modelChain: string[], now: number): string[] {
  if (!config.opencodeModelCircuitEnabled || modelChain.length <= 1) return modelChain;
  const usable = modelChain.filter((m) => !isCircuitOpen(m, now));
  // 全熔断 → 仍试最后一个（链尾通常是最稳的 turbo 兜底），绝不返回空。
  return usable.length > 0 ? usable : [modelChain[modelChain.length - 1]];
}

/** 记录某模型一次结果，更新熔断状态。 */
export function recordModelResult(model: string, ok: boolean, now: number): void {
  if (!config.opencodeModelCircuitEnabled) return;
  const h = modelHealth.get(model) ?? { fails: 0, skipUntil: 0 };
  if (ok) {
    if (h.fails > 0 || h.skipUntil > 0) console.log(`[opencode] 模型 ${model} 已恢复，熔断关闭`);
    modelHealth.set(model, { fails: 0, skipUntil: 0 });
    return;
  }
  h.fails += 1;
  if (h.fails >= config.opencodeModelCircuitThreshold) {
    const wasOpen = h.skipUntil > now;
    h.skipUntil = now + config.opencodeModelCircuitCooldownMs;
    if (!wasOpen) {
      console.warn(
        `[opencode] 模型 ${model} 连续失败 ${h.fails} 次 → 熔断 ${Math.round(config.opencodeModelCircuitCooldownMs / 1000)}s（期间跳过、直接用下一个），到点半开探活`
      );
    }
  }
  modelHealth.set(model, h);
}

function runOpencodeOnce(
  userMessage: string,
  agentName: string,
  model: string,
  timeoutMs: number
): Promise<{ text: string; raw: unknown }> {
  return new Promise((resolve, reject) => {
    const args = [
      'run',
      '--agent',
      agentName,
      '-m',
      model,
      '--format',
      'json',
      '--',
      userMessage,
    ];

    const child = spawn(config.opencodeBin, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new Error(
          `opencode one-shot 超时 (${timeoutMs}ms, model=${model}). stderr tail=${stderr.slice(-500)}`
        )
      );
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`opencode spawn 失败: ${err.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timer);

      const events: OpencodeEvent[] = [];
      const textParts: string[] = [];
      let finishReason: string | undefined;

      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt: OpencodeEvent | null = null;
        try {
          evt = JSON.parse(trimmed) as OpencodeEvent;
        } catch {
          continue;
        }
        events.push(evt);
        const part = evt.part;
        if (!part) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          textParts.push(part.text);
        } else if (part.type === 'step-finish' && typeof part.reason === 'string') {
          finishReason = part.reason;
        }
      }

      const text = textParts.join('').trim();

      if (code === 0 && text) {
        resolve({ text, raw: { events, finishReason, model } });
        return;
      }

      reject(
        new Error(
          `opencode one-shot failed (exit=${code}, model=${model}, finishReason=${finishReason ?? 'n/a'})\n` +
            `--- text head ---\n${text.slice(0, 500) || '(empty)'}\n` +
            `--- stderr ---\n${stderr.slice(-1000) || '(empty)'}\n` +
            `--- stdout head ---\n${stdout.slice(0, 1000)}`
        )
      );
    });
  });
}

export async function runOneShot(
  userMessage: string,
  opts: OneShotOptions
): Promise<OneShotResult> {
  const timeoutMs = opts.timeoutMs ?? config.triageTimeoutMs;
  const primaryModel = opts.model ?? config.opencodeModel;
  const fallbackModels = opts.fallbackModels ?? config.opencodeFallbackModels;
  // 按序尝试的模型链：主模型 → 各级 fallback（去重，保持优先级顺序）。
  const fullChain = [primaryModel, ...fallbackModels].filter(
    (m, i, arr) => arr.indexOf(m) === i
  );
  // 熔断：跳过近期连续失败、仍在冷却的模型（避免每轮白等 90s 超时）；永不全跳。
  const modelChain = selectEffectiveChain(fullChain, Date.now());

  const activeGate = gateFor(opts.lane);
  const waitStart = Date.now();
  await activeGate.acquire(opts.priority === true);
  const waitMs = Date.now() - waitStart;
  if (waitMs > 15_000) {
    const st = activeGate.stats();
    console.log(
      `[opencode] gate 排队 ${Math.round(waitMs / 1000)}s (agent=${opts.agentName}, 队列剩余 high=${st.queuedHigh} normal=${st.queued})`
    );
  }

  const execStart = Date.now();
  const withTiming = (r: { text: string; raw: unknown }): OneShotResult => ({
    ...r,
    timing: { waitMs, execMs: Date.now() - execStart },
  });

  try {
    const failures: string[] = [];
    for (let i = 0; i < modelChain.length; i++) {
      const model = modelChain[i];
      try {
        const r = withTiming(
          await runOpencodeOnce(userMessage, opts.agentName, model, timeoutMs)
        );
        recordModelResult(model, true, Date.now()); // 成功 → 关闭/重置该模型熔断
        return r;
      } catch (err) {
        recordModelResult(model, false, Date.now()); // 失败 → 累计，达阈值则熔断
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`[${model}]: ${msg}`);
        const next = modelChain[i + 1];
        if (next) {
          console.warn(
            `[opencode] model ${model} 失败，降级到 ${next}：${msg.slice(0, 300)}`
          );
        }
      }
    }
    throw new Error(
      `opencode 整条模型链（${modelChain.join(' > ')}）均失败。\n${failures.join('\n')}`
    );
  } finally {
    activeGate.release();
  }
}

/** Back-compat：triage 老调用点 */
export function runTriageOnce(userMessage: string): Promise<OneShotResult> {
  return runOneShot(userMessage, {
    agentName: 'aiisn-triage',
    systemPrompt: TRIAGE_SYSTEM_PROMPT,
    timeoutMs: config.triageTimeoutMs,
  });
}
