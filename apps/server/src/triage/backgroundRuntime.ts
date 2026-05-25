import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { TRIAGE_SYSTEM_PROMPT } from './triagePrompt.js';
import type { OpencodeAgentName } from '../opencode/agents.js';

export type OneShotResult = {
  text: string;
  raw: unknown;
};

/**
 * 一次性 LLM 调用（opencode CLI 后端）。
 *
 * - 模型默认 `config.opencodeModel`（GLM-5.1），失败后自动 fallback 到
 *   `config.opencodeFallbackModel`（GLM-5-turbo）。
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
  try {
    return await runOpencodeOnce(
      userMessage,
      opts.agentName,
      config.opencodeModel,
      timeoutMs
    );
  } catch (primaryErr) {
    const primaryMsg =
      primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.warn(
      `[opencode] primary model ${config.opencodeModel} 失败，fallback 到 ${config.opencodeFallbackModel}：${primaryMsg.slice(0, 300)}`
    );
    try {
      return await runOpencodeOnce(
        userMessage,
        opts.agentName,
        config.opencodeFallbackModel,
        timeoutMs
      );
    } catch (fallbackErr) {
      const fallbackMsg =
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(
        `opencode 两次调用均失败。\n[primary ${config.opencodeModel}]: ${primaryMsg}\n[fallback ${config.opencodeFallbackModel}]: ${fallbackMsg}`
      );
    }
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
