import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { SYSTEM_PROMPT } from './prompts.js';
import type { RuntimeEvent, RuntimeStatus } from './protocol.js';
import { buildActiveContext } from '../context/activeContext.js';
import { buildClaudeChildEnv } from './childEnv.js';

export type SendUserMessageOptions = {
  /** If true, do NOT prepend active context summary to the message. Used for
   *  card-action triggered internal prompts that already carry context. */
  skipContext?: boolean;
};

export class ClaudeRuntime extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private status: RuntimeStatus = 'idle';
  private stdoutBuf = '';
  private stderrBuf = '';

  getStatus(): RuntimeStatus {
    return this.status;
  }

  private setStatus(s: RuntimeStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.setStatus('starting');

    const args: string[] = [
      config.claudeCli,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--tools',
      config.claudeTools,
      '--allowedTools',
      config.claudeAllowedTools,
      '--append-system-prompt',
      SYSTEM_PROMPT,
    ];
    if (config.claudeUseBare) args.splice(1, 0, '--bare');

    const child = spawn('node', args, {
      cwd: process.cwd(),
      env: buildClaudeChildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuf += chunk;
      // keep last 64KB
      if (this.stderrBuf.length > 65536) this.stderrBuf = this.stderrBuf.slice(-65536);
      process.stderr.write(`[claude stderr] ${chunk}`);
    });

    child.on('error', (err) => {
      this.emitEvent({ type: 'runtime_error', error: `spawn error: ${err.message}` });
      this.setStatus('error');
    });

    child.on('exit', (code, signal) => {
      this.emitEvent({
        type: 'runtime_error',
        error: `claude exited code=${code} signal=${signal ?? ''} tail=${this.stderrBuf.slice(-2000)}`,
      });
      this.child = null;
      this.setStatus('stopped');
    });

    this.setStatus('ready');
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try {
      child.stdin.end();
    } catch {}
    child.kill('SIGTERM');
    this.setStatus('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    await new Promise((r) => setTimeout(r, 200));
    await this.start();
  }

  async sendUserMessage(text: string, opts: SendUserMessageOptions = {}): Promise<void> {
    if (!this.child) await this.start();
    if (!this.child) throw new Error('claude runtime not running');

    // MVP2.2: prepend active context summary as part of user message
    // (not system prompt) so the UI can be transparent about what AI is bringing in.
    let content = text;
    if (!opts.skipContext) {
      try {
        const snap = buildActiveContext();
        if (snap.summary) {
          content = `${snap.summary}\n\n${text}`;
        }
      } catch (err) {
        console.warn(
          '[claude] buildActiveContext failed, sending without context:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
    };
    this.setStatus('busy');
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        // not protocol JSON, log and continue
        process.stderr.write(`[claude non-json] ${line}\n`);
        continue;
      }
      this.handleProtocol(json);
    }
  }

  private emitEvent(e: RuntimeEvent) {
    this.emit('runtime_event', e);
  }

  private handleProtocol(msg: unknown) {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    const t = m.type as string | undefined;

    switch (t) {
      case 'system': {
        const subtype = (m.subtype as string | undefined) ?? '';
        if (subtype === 'init') {
          this.emitEvent({
            type: 'system_info',
            text: 'Claude runtime initialized',
            raw: msg,
          });
        }
        return;
      }
      case 'assistant': {
        const message = m.message as { content?: unknown[] } | undefined;
        const content = message?.content;
        if (!Array.isArray(content)) return;
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          const p = part as Record<string, unknown>;
          if (p.type === 'text' && typeof p.text === 'string') {
            this.emitEvent({ type: 'assistant_text', text: p.text, raw: part });
          } else if (p.type === 'tool_use' && typeof p.name === 'string') {
            this.emitEvent({
              type: 'tool_start',
              toolName: p.name,
              input: p.input,
              raw: part,
            });
          }
        }
        return;
      }
      case 'user': {
        // tool_result echo
        const message = m.message as { content?: unknown[] } | undefined;
        const content = message?.content;
        if (!Array.isArray(content)) return;
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          const p = part as Record<string, unknown>;
          if (p.type === 'tool_result') {
            this.emitEvent({
              type: 'tool_result',
              toolName: (p.tool_name as string | undefined) ?? 'tool',
              output: p.content,
              isError: Boolean(p.is_error),
              raw: part,
            });
          }
        }
        return;
      }
      case 'result': {
        const result =
          typeof m.result === 'string'
            ? (m.result as string)
            : typeof (m as { text?: string }).text === 'string'
              ? ((m as { text: string }).text)
              : undefined;
        this.emitEvent({ type: 'turn_done', result, raw: msg });
        this.setStatus('ready');
        return;
      }
      case 'stream_event':
      default:
        // ignore for MVP0
        return;
    }
  }
}

export const claudeRuntime = new ClaudeRuntime();
