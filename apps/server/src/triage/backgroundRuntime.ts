import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { TRIAGE_SYSTEM_PROMPT } from './triagePrompt.js';

export type OneShotResult = {
  text: string;
  raw: unknown;
};

/**
 * Spawn a one-shot Claude Code subprocess for background triage.
 * Per §5.6: a fresh process per round, no shared session with the chat runtime,
 * tools only Bash, output-format json (single JSON object on turn done).
 */
export function runTriageOnce(userMessage: string): Promise<OneShotResult> {
  return new Promise((resolve, reject) => {
    // §5.6: 一次性子进程读 stdin 纯文本 prompt，--output-format json 一次性吐结果对象
    const args: string[] = [
      config.claudeCli,
      '-p',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      '--tools',
      'Bash',
      '--allowedTools',
      config.claudeAllowedTools,
      '--append-system-prompt',
      TRIAGE_SYSTEM_PROMPT,
    ];
    if (config.claudeUseBare) args.splice(1, 0, '--bare');

    const child = spawn('node', args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
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
          `triage 超时 (${config.triageTimeoutMs}ms). stderr tail=${stderr.slice(-500)}`
        )
      );
    }, config.triageTimeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`spawn 失败: ${err.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      // Even on exit=1, Claude Code 通常会先打印一个合法 JSON result 事件，
      // 里头的 `subtype` + `result` 字段才说明了真正原因（OAuth、限流、token 超限、内部 bug 等）。
      // 先试着解析 stdout，再决定怎么报错。
      let parsedObj: Record<string, unknown> | null = null;
      try {
        parsedObj = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        // fallthrough, will report below
      }

      if (parsedObj) {
        const subtype = String(parsedObj.subtype ?? '');
        const isError = parsedObj.is_error === true;
        const resultText =
          typeof parsedObj.result === 'string'
            ? (parsedObj.result as string)
            : typeof (parsedObj as { text?: string }).text === 'string'
              ? ((parsedObj as { text: string }).text)
              : '';

        if (code === 0 && !isError && resultText) {
          resolve({ text: resultText, raw: parsedObj });
          return;
        }

        // Treat is_error:true OR exit!=0 with a result message as a structured failure
        const numTurns =
          typeof parsedObj.num_turns === 'number' ? (parsedObj.num_turns as number) : 'n/a';
        reject(
          new Error(
            `triage failed (exit=${code}, subtype=${subtype}, is_error=${isError}, num_turns=${numTurns})\n` +
              `--- Claude result text ---\n${resultText || '(empty)'}\n` +
              `--- stderr ---\n${stderr || '(empty)'}\n` +
              `--- full stdout ---\n${stdout.slice(0, 4000)}`
          )
        );
        return;
      }

      // stdout 不是 JSON：要么 CLI 本身崩了，要么权限/参数错误
      reject(
        new Error(
          `triage 子进程 exit=${code}, stdout 非 JSON\n--- stderr ---\n${stderr || '(empty)'}\n--- stdout (head) ---\n${stdout.slice(0, 2000)}`
        )
      );
    });

    // plain-text stdin
    child.stdin.end(userMessage);
  });
}
