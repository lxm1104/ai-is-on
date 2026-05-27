import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import type { RuntimeEvent, RuntimeStatus } from './protocol.js';
import { buildActiveContext } from '../context/activeContext.js';

export type SendUserMessageOptions = {
  /** If true, do NOT prepend active context summary to the message. Used for
   *  card-action triggered internal prompts that already carry context. */
  skipContext?: boolean;
  /** Topic-scoped chat session. New topics pass null/undefined; existing topics pass their stored session id. */
  sessionId?: string | null;
  topicId?: string;
  onSessionId?: (sessionId: string) => void;
};

/**
 * AI is ON 主聊天 runtime（opencode CLI 后端）。
 *
 * 历史名 ClaudeRuntime 保留以减少调用方改动；实现已切换到 opencode：
 * - 不再维持长连接 stream-json；每个用户 turn 起一个新的 `opencode run` 子进程。
 * - 通过 sessionID（首轮响应中捕获，后续 turn `-s <id>` 复用）保留会话上下文。
 * - 主模型 `config.opencodeModel`，失败 fallback 到 `config.opencodeFallbackModel`。
 * - 系统 prompt 走 `.opencode/agent/aiisn-chat.md`（启动时由 syncOpencodeAgents 写入）。
 */
export class ClaudeRuntime extends EventEmitter {
  private status: RuntimeStatus = 'idle';
  /** Currently running turn child (for interrupt). */
  private activeChild: ChildProcess | null = null;

  getStatus(): RuntimeStatus {
    return this.status;
  }

  private setStatus(s: RuntimeStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  async start(): Promise<void> {
    // opencode 是 per-turn 子进程，没有"启动持久 daemon"语义。
    // 仍保留方法签名以兼容老调用方。
    this.setStatus('ready');
  }

  async stop(): Promise<void> {
    if (this.activeChild) {
      try {
        this.activeChild.kill('SIGTERM');
      } catch {}
      this.activeChild = null;
    }
    this.setStatus('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    await new Promise((r) => setTimeout(r, 100));
    await this.start();
  }

  /**
   * 用户中断当前 turn。
   * 1) 仅当 status='busy' 才有效
   * 2) 给活动子进程发 SIGINT；opencode 不响应则 1.5s 后 SIGTERM
   */
  async interrupt(): Promise<{ ok: boolean; method: 'sigint' | 'restart' | 'noop' }> {
    if (this.status !== 'busy' || !this.activeChild) {
      return { ok: false, method: 'noop' };
    }
    const child = this.activeChild;
    this.emitEvent({
      type: 'system_info',
      text: '收到中断请求，正在停止当前回应…',
      raw: null,
    });
    try {
      child.kill('SIGINT');
    } catch {}

    const start = Date.now();
    while (Date.now() - start < 1500) {
      if (!this.activeChild) {
        this.emitEvent({
          type: 'system_info',
          text: '已中断当前回应',
          raw: null,
        });
        return { ok: true, method: 'sigint' };
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    try {
      child.kill('SIGTERM');
    } catch {}
    this.activeChild = null;
    this.setStatus('ready');
    this.emitEvent({
      type: 'system_info',
      text: '已强制结束当前 turn（SIGINT 未生效）',
      raw: null,
    });
    return { ok: true, method: 'restart' };
  }

  async sendUserMessage(text: string, opts: SendUserMessageOptions = {}): Promise<void> {
    // MVP18 Stage 0: 上一轮还在执行时拒绝再发。
    // 改造前 chatTopics.ts 整段 await，HTTP 层天然串行，不会出现并发；
    // 改造后 POST /api/chat 立即返回、turn 后台跑，前端有可能在 turn 跑着时再发。
    // 这里硬拒绝，由调用方 .catch 把错误转成 topic 内的 system 消息。
    // Stage 1 TopicSession 上线后这一拒绝下沉到 per-topic 维度。
    if (this.status === 'busy') {
      throw new Error('上一轮还在执行，请先中断或等待');
    }

    let content = text;
    if (!opts.skipContext) {
      try {
        const snap = buildActiveContext();
        if (snap.summary) {
          content = `${snap.summary}\n\n${text}`;
        }
      } catch (err) {
        console.warn(
          '[opencode chat] buildActiveContext failed, sending without context:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    this.setStatus('busy');
    try {
      await this.runTurn(content, config.opencodeModel, opts);
    } catch (primaryErr) {
      const primaryMsg =
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      console.warn(
        `[opencode chat] primary ${config.opencodeModel} failed, fallback：${primaryMsg.slice(0, 300)}`
      );
      try {
        await this.runTurn(content, config.opencodeFallbackModel, opts);
      } catch (fallbackErr) {
        const fallbackMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        this.emitEvent({
          type: 'runtime_error',
          topicId: opts.topicId,
          error: `opencode 两次调用均失败。\n[primary]: ${primaryMsg}\n[fallback]: ${fallbackMsg}`,
        });
        this.setStatus('ready');
      }
    }
  }

  private runTurn(content: string, model: string, opts: SendUserMessageOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        'run',
        '--agent',
        'aiisn-chat',
        '-m',
        model,
        '--format',
        'json',
      ];
      if (opts.sessionId) {
        args.push('-s', opts.sessionId);
      }
      args.push('--', content);

      const child = spawn(config.opencodeBin, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.activeChild = child;

      let stdoutBuf = '';
      let stderrBuf = '';
      let interrupted = false;
      let lastTurnText = '';
      let observedSessionId = opts.sessionId ?? null;

      const stdoutStream = child.stdout!;
      const stderrStream = child.stderr!;
      stdoutStream.setEncoding('utf8');
      stderrStream.setEncoding('utf8');

      stdoutStream.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let idx: number;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          let json: unknown;
          try {
            json = JSON.parse(line);
          } catch {
            process.stderr.write(`[opencode non-json] ${line}\n`);
            continue;
          }
          const turnTextDelta = this.handleOpencodeEvent(json, {
            topicId: opts.topicId,
            onSessionId: (sid) => {
              if (observedSessionId === sid) return;
              observedSessionId = sid;
              opts.onSessionId?.(sid);
            },
          });
          if (turnTextDelta) lastTurnText += turnTextDelta;
        }
      });

      stderrStream.on('data', (chunk: string) => {
        stderrBuf += chunk;
        if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-65536);
        process.stderr.write(`[opencode stderr] ${chunk}`);
      });

      child.on('error', (err) => {
        this.activeChild = null;
        reject(new Error(`opencode spawn error: ${err.message}`));
      });

      child.on('exit', (code, signal) => {
        const wasActive = this.activeChild === child;
        if (wasActive) this.activeChild = null;
        if (signal === 'SIGINT' || signal === 'SIGTERM') interrupted = true;

        if (code === 0 || interrupted) {
          this.emitEvent({
            type: 'turn_done',
            topicId: opts.topicId,
            result: lastTurnText || undefined,
            raw: { model, exitCode: code, signal },
          });
          this.setStatus('ready');
          resolve();
          return;
        }

        reject(
          new Error(
            `opencode chat turn exit=${code} signal=${signal ?? ''} stderr=${stderrBuf.slice(-2000)}`
          )
        );
      });
    });
  }

  private emitEvent(e: RuntimeEvent) {
    this.emit('runtime_event', e);
  }

  /**
   * 把 opencode NDJSON 事件映射到 RuntimeEvent。返回本事件贡献的 assistant 文本（用于累积 turn 结果）。
   *
   * opencode 事件结构（取需要的几种）：
   *  - { type: "session", sessionID, ... }   // 首次响应
   *  - { type: "text", part: { text, ... }, sessionID }
   *  - { type: "tool", part: { tool, state: { input, output, status } }, sessionID }
   *  - { type: "step_start" | "step_finish", ... }
   */
  private handleOpencodeEvent(
    msg: unknown,
    opts: { topicId?: string; onSessionId?: (sessionId: string) => void }
  ): string {
    if (!msg || typeof msg !== 'object') return '';
    const m = msg as Record<string, unknown>;

    const sid = m.sessionID;
    if (typeof sid === 'string') {
      opts.onSessionId?.(sid);
    }

    const t = m.type as string | undefined;
    const part = m.part as Record<string, unknown> | undefined;

    if (t === 'text' && part && typeof part.text === 'string') {
      this.emitEvent({ type: 'assistant_text', topicId: opts.topicId, text: part.text, raw: part });
      return part.text;
    }

    if (t === 'tool' && part) {
      const toolName = typeof part.tool === 'string' ? part.tool : 'tool';
      const state = part.state as
        | { status?: string; input?: unknown; output?: unknown }
        | undefined;
      const status = state?.status;
      if (status === 'running' || status === 'pending') {
        this.emitEvent({
          type: 'tool_start',
          topicId: opts.topicId,
          toolName,
          input: state?.input,
          raw: part,
        });
      } else if (status === 'completed' || status === 'error') {
        this.emitEvent({
          type: 'tool_result',
          topicId: opts.topicId,
          toolName,
          output: state?.output,
          isError: status === 'error',
          raw: part,
        });
      }
      return '';
    }

    return '';
  }
}

export const claudeRuntime = new ClaudeRuntime();
