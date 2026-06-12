import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';

export type CliResult = { code: number; stdout: string; stderr: string };

function buildLarkCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  // lark-cli auto-detects agent workspaces from these variables. ai-is-on is a
  // standalone app and should use the user's normal local lark-cli profile even
  // when launched from OpenClaw/Hermes/Lark Channel.
  delete env.OPENCLAW_HOME;
  delete env.HERMES_HOME;
  delete env.LARK_CHANNEL;

  return env;
}

// 2026-06-12 事故：lark-cli 子进程成批挂死（0 CPU、不可中断内核等待），无超时的
// await 把 collector 互斥锁永久占住 —— 系统失明 19 小时且无任何告警。
// 防线：① 每次调用硬超时（超时即按失败 resolve，附带 SIGTERM→SIGKILL）；
// ② 进程退出时收割全部 in-flight 子进程，防止 tsx watch 重启后僵尸累积。
const inflight = new Set<ChildProcess>();
let reaperHooked = false;
function hookReaper() {
  if (reaperHooked) return;
  reaperHooked = true;
  process.once('exit', () => {
    for (const c of inflight) {
      try {
        c.kill('SIGKILL');
      } catch {
        // 进程可能已死
      }
    }
  });
}

export function runLarkCli(
  args: string[],
  stdin?: string,
  opts?: { timeoutMs?: number }
): Promise<CliResult> {
  return new Promise((resolve) => {
    hookReaper();
    const child = spawn(config.larkCliBin, args, {
      stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: buildLarkCliEnv(),
    });
    inflight.add(child);
    let stdout = '';
    let stderr = '';
    let done = false;
    const timeoutMs = opts?.timeoutMs ?? config.larkCliTimeoutMs;

    const finish = (r: CliResult) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      inflight.delete(child);
      resolve(r);
    };

    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
      // 5s 宽限后补刀。挂死在内核态的进程连 SIGKILL 都吃不进，但我们不再等它。
      const hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 5_000);
      hardKill.unref();
      finish({
        code: -1,
        stdout,
        stderr:
          stderr +
          `\nlark-cli timeout after ${timeoutMs}ms: ${args.slice(0, 2).join(' ')}`,
      });
    }, timeoutMs);
    killTimer.unref();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr?.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (err) => finish({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('exit', (code) => finish({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined && child.stdin) child.stdin.end(stdin);
  });
}

export async function runLarkCliJson<T = unknown>(
  args: string[],
  stdin?: string
): Promise<T> {
  const { code, stdout, stderr } = await runLarkCli(args, stdin);
  if (code !== 0) {
    throw new Error(`lark-cli exit ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`);
  }
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`lark-cli non-JSON output: ${stdout.slice(0, 400)}`);
  }
}
