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
  opencodeBin: envStr('OPENCODE_BIN', 'opencode'),
  opencodeModel: envStr('OPENCODE_MODEL', 'zai-coding-plan/glm-5.1'),
  opencodeFallbackModel: envStr(
    'OPENCODE_FALLBACK_MODEL',
    'zai-coding-plan/glm-5-turbo'
  ),
  opencodeAgentDir: path.resolve(
    REPO_ROOT,
    envStr('OPENCODE_AGENT_DIR', '.opencode/agent')
  ),
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
  // MVP16-A: master switch for ingesting me-side IM messages.
  //   true (default) → me-side msgs flow into events/raw_json, downstream uses is_me.
  //   false → all me-side msgs filtered in prepareMessages (回退到 MVP16-A 之前行为).
  imIncludeMyMessages: envBool('IM_INCLUDE_MY_MESSAGES', true),
  // MVP16-A: independent toggle for the extra messages-search --sender=me group fetch.
  //   Lark's chat-messages-list / messages-search(group) do NOT return me-side by default,
  //   so groups need a separate explicit search call. Set false to keep A-1 running
  //   without A-2 (single-chat 双向 only).
  imEnableMyGroupFetch: envBool('IM_ENABLE_MY_GROUP_FETCH', true),
  // MVP16-A: page-limit for the my-group messages-search call. page-size = 50,
  // so default 5 = 250 msgs/scan upper bound (well within a 3-minute window).
  imMyGroupMessagesPageLimit: envInt('IM_MY_GROUP_MESSAGES_PAGE_LIMIT', 5),
  // MVP24: 外部联系人单聊接入。messages-search --chat-type p2p 不返回跨租户单聊，
  //   需 chat-list --types=p2p 枚举 external + 逐个 chat-messages-list 拿双向。
  imEnableExternalP2p: envBool('IM_ENABLE_EXTERNAL_P2P', true),
  // MVP24: 单轮最多处理多少个外部单聊（按 ByActiveTimeDesc 取前 N），防止外部单聊过多打爆。
  imExternalP2pMaxChats: envInt('IM_EXTERNAL_P2P_MAX_CHATS', 20),
  // MVP11.0-b drive comment collector
  driveCommentEnabled: envBool('DRIVE_COMMENT_COLLECTOR_ENABLED', true),
  driveCommentIntervalMs: envInt('DRIVE_COMMENT_COLLECTOR_INTERVAL_MS', 300_000),
  driveCommentLookbackDays: envInt('DRIVE_COMMENT_LOOKBACK_DAYS', 14),
  driveCommentMaxDocsPerTick: envInt('DRIVE_COMMENT_MAX_DOCS_PER_TICK', 30),
  driveCommentMaxCommentsPerDoc: envInt('DRIVE_COMMENT_MAX_COMMENTS_PER_DOC', 100),

  // MVP5 飞书任务 collector — 采集 get-my-tasks ∪ get-related-tasks，落成 kind='commitment'。
  taskCollectorEnabled: envBool('TASK_COLLECTOR_ENABLED', true),
  taskIntervalMs: envInt('TASK_COLLECTOR_INTERVAL_MS', 300_000),
  taskMaxPerTick: envInt('TASK_MAX_PER_TICK', 200),

  // MVP11.1 meeting artifact collector
  meetingArtifactEnabled: envBool('MEETING_ARTIFACT_COLLECTOR_ENABLED', true),
  meetingArtifactIntervalMs: envInt('MEETING_ARTIFACT_COLLECTOR_INTERVAL_MS', 600_000),
  meetingArtifactLookbackDays: envInt('MEETING_ARTIFACT_LOOKBACK_DAYS', 3),
  meetingArtifactMaxPerTick: envInt('MEETING_ARTIFACT_MAX_PER_TICK', 50),
  meetingArtifactRawCapBytes: envInt('MEETING_ARTIFACT_RAW_CAP_BYTES', 256 * 1024),
  // Triage queue concurrency. Keep at 1 (each round spawns a fresh Claude process).
  triageQueueConcurrency: envInt('TRIAGE_QUEUE_CONCURRENCY', 1),
  // Per-round triage timeout (one-shot Claude subprocess)
  triageTimeoutMs: envInt('TRIAGE_TIMEOUT_MS', 90_000),
  // How many signals to batch into one triage call
  triageBatchSize: envInt('TRIAGE_BATCH_SIZE', 6),

  // ---------- MVP13 §S4 LLM chat_affinity ranker ----------
  mvp13RankerEnabled: envBool('MVP13_LLM_RANKER_ENABLED', true),
  mvp13RankerTimeoutMs: envInt('MVP13_LLM_RANKER_TIMEOUT_MS', 90_000),
  mvp13RankerMaxCandidates: envInt('MVP13_LLM_RANKER_MAX_CANDIDATES', 50),
  mvp13RankerBatchSize: envInt('MVP13_LLM_RANKER_BATCH_SIZE', 5),
  mvp13RankerCacheTtlHours: envInt('MVP13_LLM_RANKER_CACHE_TTL_HOURS', 24),
  mvp13RankerFewShotPerAction: envInt(
    'MVP13_LLM_RANKER_FEW_SHOT_PER_ACTION',
    5
  ),
  mvp13RankerFewShotGlobal: envInt('MVP13_LLM_RANKER_FEW_SHOT_GLOBAL', 3),
  mvp13RankerFewShotWindowDays: envInt(
    'MVP13_LLM_RANKER_FEW_SHOT_WINDOW_DAYS',
    30
  ),
  mvp13SurfaceFinalScore: Number(
    envStr('MVP13_LLM_RANKER_SURFACE_FINAL_SCORE', '0.62')
  ),
  mvp13SurfaceLlmConfidence: Number(
    envStr('MVP13_LLM_RANKER_SURFACE_LLM_CONFIDENCE', '0.55')
  ),
};
