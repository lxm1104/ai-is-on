import 'dotenv/config';
import os from 'node:os';
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

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// 逗号分隔的列表，用于模型 fallback 链等。空段被丢弃；env 未设时用 fallback。
function envList(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return items.length > 0 ? items : fallback;
}

export const config = {
  port: envInt('PORT', 8787),
  webOrigin: envStr('WEB_ORIGIN', 'http://127.0.0.1:5173'),
  sqlitePath: path.resolve(REPO_ROOT, envStr('SQLITE_PATH', 'data/ai-is-on.sqlite')),
  opencodeBin: envStr('OPENCODE_BIN', 'opencode'),
  opencodeModel: envStr('OPENCODE_MODEL', 'zai-coding-plan/glm-5.2'),
  // 主模型失败后按序降级的 fallback 链（优先级 5.2 > 5.1 > 5-turbo）。
  opencodeFallbackModels: envList('OPENCODE_FALLBACK_MODELS', [
    'zai-coding-plan/glm-5.1',
    'zai-coding-plan/glm-5-turbo',
  ]),
  opencodeAgentDir: path.resolve(
    REPO_ROOT,
    envStr('OPENCODE_AGENT_DIR', '.opencode/agent')
  ),
  speechMaxSeconds: envInt('SPEECH_MAX_SECONDS', 60),
  ffmpegBin: envStr('FFMPEG_BIN', 'ffmpeg'),
  larkCliBin: envStr('LARK_CLI_BIN', 'lark-cli'),
  // 2026-06-12：lark-cli 子进程批量挂死（不可中断内核等待）导致 collector 互斥锁
  // 被永久占住、系统失明 19h。任何 spawn 都必须有硬超时。
  larkCliTimeoutMs: envInt('LARK_CLI_TIMEOUT_MS', 120_000),

  collectorEnabled: envBool('COLLECTOR_ENABLED', true),
  // 全部 collector 的最新 last_success_at 比现在旧超过此值 → 升「采集停滞」P0 系统卡
  collectorStaleAlarmMs: envInt('COLLECTOR_STALE_ALARM_MS', 1_800_000),
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
  // MVP26.5: 把「我」在 IM 里主动推进事项的消息升格成可 triage 的 im_self_action 信号
  //   （给 Matter Reducer 接上 action_result 输入）。kill switch，默认开。
  //   依赖 imIncludeMyMessages=true（否则 me-side 消息在 prepareMessages 就被滤掉）。
  imSelfActionEnabled: envBool('IM_SELF_ACTION_ENABLED', true),
  // MVP30: 渲染 IM 信号时回溯多少会话上下文，与"触发窗口"解耦。触发仍按 [since, now] 判"新增"，
  //   但渲染时带上更早的往来，让「我」在更早扫描窗口里的发言/提问重新可见——triage 才能判断
  //   "我主动发起 / 我早已回过"，不再把"我问、对方答完"当成需我处理的入站 burst（展弘单聊误催即此类）。
  //   ┌ 上下文深度是【按条数】而非按时间：每个 chat 取最近 N 条（与聊天节奏无关，比固定时长更稳）。
  imContextLookbackMsgs: envInt('IM_CONTEXT_LOOKBACK_MSGS', 20),
  //   └ 时间只是 fetch 的天花板（Lark search 只吃 start/end），不是上下文单位。fetch 回溯到 now-此值，
  //     再在内存里按条数裁剪。设大一点保证够 N 条可裁；过大只是多拉数据，不影响渲染/计数。默认 2h。
  imContextFetchHorizonMs: envInt('IM_CONTEXT_FETCH_HORIZON_MS', 7_200_000),
  // MVP30: 放大 p2p messages-search 的翻页上限（page-size≈50），防止 fetch 天花板窗口里的消息被
  //   page-limit 截断而漏掉新消息。默认 5（≈250 条/轮，p2p 量足够）。
  imP2pPageLimit: envInt('IM_P2P_PAGE_LIMIT', 5),
  // ---------- MVP33 U1 采集覆盖水位 ----------
  // 追赶窗口上限：单轮最多消化的时间跨度。停摆后积压按 6h/轮排干（24h ≈ 4 个 tick 追平），
  // 既限幅单轮负载，又让 messages-search 的分页上限在窗口内大概率够用。
  imMaxScanWindowMs: envInt('IM_MAX_SCAN_WINDOW_MS', 6 * 3600_000),
  // 收缩 floor：最新锚定搜索 has_more 时窗口减半重试的下限。到底仍超限 → 有界接受 + 大声报错
  // （病态：5min 内新增超过分页上限的 p2p 消息）。
  imMinScanWindowMs: envInt('IM_MIN_SCAN_WINDOW_MS', 5 * 60_000),
  // 水位滞后告警线：扫描在成功但 covered_until 落后实时超此值 → P1 系统卡（freshnessWatchdog）。
  collectorWatermarkLagAlarmMs: envInt('COLLECTOR_WATERMARK_LAG_ALARM_MS', 2 * 3600_000),
  // 保险丝：水位滞后超此值则跳水位（since 钳到 now-此值），大声丢弃，绝不静默。
  collectorWatermarkMaxLagMs: envInt('COLLECTOR_WATERMARK_MAX_LAG_MS', 7 * 86400_000),
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

  // MVP11.1 / MVP25 meeting artifact collector（MVP25 改 vc +search 发现入口）
  meetingArtifactEnabled: envBool('MEETING_ARTIFACT_COLLECTOR_ENABLED', true),
  meetingArtifactIntervalMs: envInt('MEETING_ARTIFACT_COLLECTOR_INTERVAL_MS', 600_000),
  // MVP25: 稳态 7 天——补上"距上次成功采集之间开过的会"，又把回填洪峰控制在小范围
  //   （见 docs/MVP25 §recentEvents 时序语义与首次回填）。一次性回填历史可临时调大。
  meetingArtifactLookbackDays: envInt('MEETING_ARTIFACT_LOOKBACK_DAYS', 7),
  meetingArtifactMaxPerTick: envInt('MEETING_ARTIFACT_MAX_PER_TICK', 50),
  meetingArtifactRawCapBytes: envInt('MEETING_ARTIFACT_RAW_CAP_BYTES', 256 * 1024),
  // MVP25: vc +search 分页上限（30/页），防极端用户失控
  meetingArtifactSearchMaxPages: envInt('MEETING_ARTIFACT_SEARCH_MAX_PAGES', 10),
  // MVP25: 仅采 display_info 标注"智能纪要"的会议（已确认）
  meetingArtifactOnlyWithMinutes: envBool('MEETING_ARTIFACT_ONLY_WITH_MINUTES', true),
  // Triage queue concurrency. Keep at 1 (each round spawns a fresh Claude process).
  triageQueueConcurrency: envInt('TRIAGE_QUEUE_CONCURRENCY', 1),
  // Per-round triage timeout (one-shot Claude subprocess)
  triageTimeoutMs: envInt('TRIAGE_TIMEOUT_MS', 90_000),
  // How many signals to batch into one triage call
  triageBatchSize: envInt('TRIAGE_BATCH_SIZE', 6),
  // 全局 opencode one-shot 并发上限。coding-plan 类 provider 实际近似串行处理，
  // 并发 >1 时所有调用互相挤兑排队 → 集体超时（2026-06-09 实测 87% 失败）。
  opencodeMaxConcurrency: envInt('OPENCODE_MAX_CONCURRENCY', 1),
  // attention 引擎单次 LLM 超时。实测 glm-5.1 单次 ~26k input 需要 ~104s，
  // 180s 贴着 p50 跑必然误杀，误杀后 fallback 重试又加倍 provider 负载。
  attentionTimeoutMs: envInt('ATTENTION_TIMEOUT_MS', 300_000),
  // attention 专用模型（2026-06-14 测试切到 glm-5.2，与主路径对齐）。
  // 历史：turbo + thinking-disabled（见 opencode.json）实测 13.4k chars 输入 15-94s，
  // vs glm-5.1 的 171-225s；现按 5.2 > 5.1 > 5-turbo 降级，turbo 作为最后兜底。
  attentionModel: envStr('ATTENTION_MODEL', 'zai-coding-plan/glm-5.2'),
  attentionFallbackModels: envList('ATTENTION_FALLBACK_MODELS', [
    'zai-coding-plan/glm-5.1',
    'zai-coding-plan/glm-5-turbo',
  ]),

  // ---------- MVP32 办结核实（mark_done 第二档） ----------
  // 总开关（第一档「已处理」无开关——它是核心语义）。
  // MVP36 自主排查 dispatcher：默认**关**（硬只读边界已就位，但自动派发会消耗 LLM/lark-cli，opt-in）。
  investigationDispatchEnabled: envBool('INVESTIGATION_DISPATCH_ENABLED', false),
  investigationTickMs: envInt('INVESTIGATION_TICK_MS', 600_000), // 10min 低频
  // 排查走 high 队列公平竞争 gate（默认 true）。频率极低（10min/6h 冷却），偶尔延后一次 attention 可接受；
  // 设 false 则让位 attention，但在繁忙环境下排查会被持续饿死、出不了数据。
  investigationPriority: envBool('INVESTIGATION_PRIORITY', true),
  investigationCooldownMs: envInt('INVESTIGATION_COOLDOWN_MS', 21_600_000), // 同 matter 6h 内不重查
  investigationMaxRounds: envInt('INVESTIGATION_MAX_ROUNDS', 3),
  // ---------- MVP49 run_command 本地只读命令工具 ----------
  // 自主排查可用的本地只读 CLI 白名单（逗号分隔，可配，不写死命令）。run_command 只放行这些可执行文件。
  // 安全模型见 investigation/runCommand.ts：argv 直 spawn 无 shell + 环境最小化 + 每 CLI 写面护栏 + 路径根限制。
  // 注意：**不含 lark-cli** —— 飞书读走专用硬只读工具（readTools.ts），不在这里重开 lark 写口子。
  // bytedcli 是庞大内部多功能 CLI，但 run_command 的 guardBytedcli 只放行 `log` 只读日志查询家族
  //（Chatbot 排查"run_log_id→traceID"的键石），deploy/release/tce/scm/env 等写/部署族一律拒。
  investigationReadClis: (process.env.INVESTIGATION_READ_CLIS ||
    'fornax-cli,bytedcli,git,grep,rg,cat,head,tail,ls,find,wc,jq,file,stat')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // run_command 总开关（kill-switch）。用户已授权本地只读取数，默认开；设 false 则该工具从排查工具集移除。
  investigationRunCommandEnabled: envBool('INVESTIGATION_RUN_COMMAND_ENABLED', true),
  // 单条本地命令硬超时（防 find / 大 repo grep 挂死占资源）。
  investigationCommandTimeoutMs: envInt('INVESTIGATION_COMMAND_TIMEOUT_MS', 30_000),
  // run_command 允许触达的根目录（cwd 与路径参数 realpath 后必须落在其中；os.tmpdir() 由代码自动追加）。
  // 默认 ~/MyProject 覆盖 ai-is-on 与 bitable-chatbot 等本地仓库。
  investigationAllowedRoots: envList('INVESTIGATION_ALLOWED_ROOTS', [path.join(os.homedir(), 'MyProject')]),
  // MVP50 项目路由 AI 兜底：确定性(primarySpaceId/canonical/标题)全落空时，是否打一次轻量 one-shot
  // 从候选项目里挑一个（按 matterId 缓存）。默认开（用户选了"允许 AI 判断"）；设 false 则只走确定性路由。
  projectRoutingAiEnabled: envBool('PROJECT_ROUTING_AI_ENABLED', true),
  matterVerifyEnabled: envBool('MATTER_VERIFY_ENABLED', true),
  // mark_done → 核实的延迟。≥ IM collector 一轮（imIntervalMs 默认 3min），
  // 让"刚回的消息"先经 collector → Reducer 挂到 matter_context_links，核实 agent 才看得到。
  matterVerifyDelayMs: envInt('MATTER_VERIFY_DELAY_MS', 300_000),
  // one-shot 超时，对齐 chat-conclusion 的 EXTRACT_TIMEOUT_MS。
  matterVerifyTimeoutMs: envInt('MATTER_VERIFY_TIMEOUT_MS', 90_000),

  // ---------- MVP33 U2 matter_observations 消费通路 ----------
  // 总开关：triage 产出的 lifecycle 观察（progress/block 等）经召回+判定落到 Matter 状态机。
  matterObsConsumeEnabled: envBool('MATTER_OBS_CONSUME_ENABLED', true),
  // 观察消费置信门槛：低于此值的观察只记录不消费（triage 的观察置信本身偏乐观，0.6 滤明显弱信号）。
  matterObsMinConfidence: envFloat('MATTER_OBS_MIN_CONFIDENCE', 0.6),

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
