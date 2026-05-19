import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// apps/server/src -> repo root
export const REPO_ROOT = path.resolve(__dirname, '../../..');

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: envInt('PORT', 8787),
  webOrigin: envStr('WEB_ORIGIN', 'http://127.0.0.1:5173'),
  sqlitePath: path.resolve(REPO_ROOT, envStr('SQLITE_PATH', 'data/ai-is-on.sqlite')),
  claudeCli: envStr(
    'CLAUDE_CODE_CLI',
    '/Users/xinming/MyProject/claude-code-research/package/cli.js'
  ),
  claudeTools: envStr('CLAUDE_TOOLS', 'Bash,WebSearch,WebFetch'),
  claudeAllowedTools: envStr('CLAUDE_ALLOWED_TOOLS', 'Bash(lark-cli:*)'),
  claudeUseBare: envBool('CLAUDE_USE_BARE', false),
  speechMaxSeconds: envInt('SPEECH_MAX_SECONDS', 60),
  ffmpegBin: envStr('FFMPEG_BIN', 'ffmpeg'),
  larkCliBin: envStr('LARK_CLI_BIN', 'lark-cli'),

  collectorEnabled: envBool('COLLECTOR_ENABLED', true),
  calendarIntervalMs: envInt('CALENDAR_COLLECTOR_INTERVAL_MS', 300_000),
  imIntervalMs: envInt('IM_COLLECTOR_INTERVAL_MS', 180_000),
  // MVP5 drive collector — Lark docs/Wiki edited recently. Default 10 min;
  // page-size capped at 20 by API. First scan looks back driveFirstScanDays.
  driveEnabled: envBool('DRIVE_COLLECTOR_ENABLED', true),
  driveIntervalMs: envInt('DRIVE_COLLECTOR_INTERVAL_MS', 600_000),
  driveFirstScanDays: envInt('DRIVE_FIRST_SCAN_DAYS', 7),
  drivePageSize: envInt('DRIVE_PAGE_SIZE', 20),
  // First-run lookback window (没有 last_scan 时往回看多少小时)
  imFirstScanHours: envInt('IM_FIRST_SCAN_HOURS', 2),
  // 单 chat 在一轮里新消息超过此阈值时，聚合成 1 条 "群 X 有 N 条新消息" 信号，避免 triage 爆量
  imAggregateThreshold: envInt('IM_AGGREGATE_THRESHOLD', 3),
  // 每轮 IM 扫描产出的信号上限（超过的丢弃，并打日志）
  imMaxSignalsPerScan: envInt('IM_MAX_SIGNALS_PER_SCAN', 30),
  // 每个 chat 拉取消息的 page size
  imPerChatPageSize: envInt('IM_PER_CHAT_PAGE_SIZE', 50),
  // chat-list 拉群最多翻多少页（page-size 100）
  imChatListMaxPages: envInt('IM_CHAT_LIST_MAX_PAGES', 5),
  // 并发拉取 chat 数（避免一次起几十个 lark-cli 进程）
  imChatFetchConcurrency: envInt('IM_CHAT_FETCH_CONCURRENCY', 4),
  // Triage queue concurrency. Keep at 1 (each round spawns a fresh Claude process).
  triageQueueConcurrency: envInt('TRIAGE_QUEUE_CONCURRENCY', 1),
  // Per-round triage timeout (one-shot Claude subprocess)
  triageTimeoutMs: envInt('TRIAGE_TIMEOUT_MS', 90_000),
  // How many signals to batch into one triage call
  triageBatchSize: envInt('TRIAGE_BATCH_SIZE', 6),
};
