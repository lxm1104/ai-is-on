// MVP18 Stage 1: 把原 ClaudeRuntime 的"单 turn 子进程 + 状态机"按 topic 实例化。
//
// 一个 TopicSession 绑死一个 topicId。它只负责：
//   - 维护 status (idle/busy) 和 activeChild（当前 turn 的 opencode 子进程）
//   - sendUserMessage：busy guard → fallback chain → runTurn
//   - interrupt：用户主动停止当前 turn（SIGINT → 1.5s 不响应升级 SIGTERM）
//   - forceKill：被动结束（restart/shutdown），解绑监听器避免迟到 stdout 写孤立 tool 消息
//
// 它 emit 两类事件给 ChatRuntimeManager：
//   - 'status'      → TopicStatus 变化
//   - 'runtime_event' → RuntimeEvent 透传（每条都带 this.topicId）
//
// 同一 topic 不允许并发跑两轮（opencode `-s` 的硬约束）：busy 时 sendUserMessage 同步 throw。

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import type { RuntimeEvent, TopicStatus } from './protocol.js';
import { buildActiveContext } from '../context/activeContext.js';

export type SendOptions = {
  /** 若 true 则不再 prepend active context summary。卡片动作专用（prompt 自带 context）。 */
  skipContext?: boolean;
  /** 已存在的 opencode session id；新 topic 传 null/undefined，turn 内部捕获回填。 */
  sessionId?: string | null;
  /** turn 内首次 session 事件触发时回调；用于把 sessionId 持久化到 chat_topics 行。 */
  onSessionId?: (sessionId: string) => void;
};

export class TopicSession extends EventEmitter {
  readonly topicId: string;
  private status: TopicStatus = 'idle';
  private activeChild: ChildProcess | null = null;

  constructor(topicId: string) {
    super();
    this.topicId = topicId;
  }

  getStatus(): TopicStatus {
    return this.status;
  }

  private setStatus(s: TopicStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s); // manager 转发为 ServerEvent topic_status
  }

  private emitEvent(e: RuntimeEvent) {
    // 编译器已保证 e.topicId 必填；这里只是透传
    this.emit('runtime_event', e);
  }

  async sendUserMessage(text: string, opts: SendOptions = {}): Promise<void> {
    // 同一 topic 不允许并发跑两轮（opencode -s 硬约束）。
    // 同步 throw 让调用方 .catch 转成 topic 内的 system 消息。
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
          `[opencode chat topic=${this.topicId}] buildActiveContext failed, sending without context:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    this.setStatus('busy');
    try {
      // 主模型 → 副模型 fallback：主失败仅 console.warn，只有副模型也失败才 emit runtime_error。
      try {
        await this.runTurn(content, config.opencodeModel, opts);
      } catch (primaryErr) {
        const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        console.warn(
          `[opencode chat topic=${this.topicId}] primary ${config.opencodeModel} failed, fallback: ${primaryMsg.slice(0, 300)}`
        );
        try {
          await this.runTurn(content, config.opencodeFallbackModel, opts);
        } catch (fallbackErr) {
          const fallbackMsg =
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          this.emitEvent({
            type: 'runtime_error',
            topicId: this.topicId,
            error: `opencode 两次调用均失败。\n[primary]: ${primaryMsg}\n[fallback]: ${fallbackMsg}`,
          });
        }
      }
    } finally {
      // runTurn 内部 child.exit 已经清空 activeChild；这里兜底状态翻转。
      this.setStatus('idle');
    }
  }

  /**
   * 用户主动中断当前 turn。
   * 1) 仅当 status='busy' 才有效
   * 2) 给活动子进程发 SIGINT；opencode 不响应则 1.5s 后 SIGTERM
   *
   * 与 forceKill 的本质区别：interrupt 保留 child 监听器，让事件流自然收尾（用户期望"我点了停止 → 它优雅退出"）。
   */
  async interrupt(): Promise<{ ok: boolean; method: 'sigint' | 'restart' | 'noop' }> {
    if (this.status !== 'busy' || !this.activeChild) {
      return { ok: false, method: 'noop' };
    }
    const child = this.activeChild;
    this.emitEvent({
      type: 'system_info',
      topicId: this.topicId,
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
          topicId: this.topicId,
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
    this.setStatus('idle');
    this.emitEvent({
      type: 'system_info',
      topicId: this.topicId,
      text: '已强制结束当前 turn（SIGINT 未生效）',
      raw: null,
    });
    return { ok: true, method: 'restart' };
  }

  /**
   * 被动结束（manager.restartAll / shutdown 触发）。
   * 与 interrupt 的关键差异：先解绑所有 child 监听器，丢弃 SIGTERM 之后子进程的迟到 stdout，
   * 避免在 messageBus 上写出孤立 tool 消息。
   */
  forceKill(reason: 'restart' | 'shutdown'): void {
    if (this.activeChild) {
      const c = this.activeChild;
      c.stdout?.removeAllListeners();
      c.stderr?.removeAllListeners();
      c.removeAllListeners('exit');
      c.removeAllListeners('error');
      try {
        c.kill('SIGTERM');
      } catch {}
      this.activeChild = null;
      this.emitEvent({
        type: 'system_info',
        topicId: this.topicId,
        text: reason === 'restart' ? 'Runtime 已重启，本轮被中止' : 'Runtime 关闭，本轮被中止',
        raw: null,
      });
    }
    this.setStatus('idle');
  }

  /**
   * 调一次 opencode CLI（一个 turn）。逻辑与原 ClaudeRuntime.runTurn 等价，仅把全局
   * activeChild / topicId 换成 this.activeChild / this.topicId。
   */
  private runTurn(content: string, model: string, opts: SendOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['run', '--agent', 'aiisn-chat', '-m', model, '--format', 'json'];
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
            process.stderr.write(`[opencode non-json topic=${this.topicId}] ${line}\n`);
            continue;
          }
          const turnTextDelta = this.handleOpencodeEvent(json, {
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
        process.stderr.write(`[opencode stderr topic=${this.topicId}] ${chunk}`);
      });

      child.on('error', (err) => {
        if (this.activeChild === child) this.activeChild = null;
        reject(new Error(`opencode spawn error: ${err.message}`));
      });

      child.on('exit', (code, signal) => {
        const wasActive = this.activeChild === child;
        if (wasActive) this.activeChild = null;
        if (signal === 'SIGINT' || signal === 'SIGTERM') interrupted = true;

        if (code === 0 || interrupted) {
          this.emitEvent({
            type: 'turn_done',
            topicId: this.topicId,
            result: lastTurnText || undefined,
            raw: { model, exitCode: code, signal },
          });
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

  /**
   * 把 opencode NDJSON 事件映射到 RuntimeEvent。返回本事件贡献的 assistant 文本（累积 turn 结果用）。
   */
  private handleOpencodeEvent(
    msg: unknown,
    opts: { onSessionId?: (sessionId: string) => void }
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
      this.emitEvent({
        type: 'assistant_text',
        topicId: this.topicId,
        text: part.text,
        raw: part,
      });
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
          topicId: this.topicId,
          toolName,
          input: state?.input,
          raw: part,
        });
      } else if (status === 'completed' || status === 'error') {
        this.emitEvent({
          type: 'tool_result',
          topicId: this.topicId,
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
