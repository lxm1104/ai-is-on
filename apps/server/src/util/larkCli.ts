import { spawn } from 'node:child_process';
import { config } from '../config.js';

export type CliResult = { code: number; stdout: string; stderr: string };

export function runLarkCli(args: string[], stdin?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(config.larkCliBin, args, {
      stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr?.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
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
