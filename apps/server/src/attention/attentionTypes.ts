// MVP14 Attention Engine — shared domain types.
// 纯类型，不引外部模块（避免类型环依赖），不放任何逻辑。

export type AttentionPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type AttentionStatus =
  | 'live'         // 当前应该被前端展示
  | 'acted'        // 用户已处理（执行了 suggestedAction / mark done）
  | 'dismissed'    // 用户主动忽略（含负反馈）
  | 'superseded'   // 新一轮推理覆盖了它（同 input_hash 重跑、或被新 item 取代）
  | 'expired';     // 超过 expires_at

export type AttentionRunTrigger = 'tick' | 'manual' | 'upsert_hook';

export type AttentionRunStatus =
  | 'ok'
  | 'failed'
  | 'cache_hit'           // input_hash 在 TTL 内已成功跑过
  | 'skipped_no_change';  // 数据不足或 packet 与上次完全相同

// MVP23：处理角度的执行器。
//   'claude_topic'：把 directive 交给右侧 Claude 出草稿/分析（默认，不写库）；
//   'create_task'：M2 结构化执行器——点击后走既有 confirm-gated 建飞书任务通道。
export type ProcessingExecutor = 'claude_topic' | 'create_task';

// MVP23：单个「处理角度」。LLM 针对 P0/P1 item 产出 2–3 个，投影成卡片上的角度按钮。
// directive 在用户点击该角度时拼进 rich askAgent prompt；必须是自包含自然语言（禁含 S# 引用编号/id）。
export type ProcessingOption = {
  id: string;                    // 卡内稳定标识，如 'draft_reply' | 'summarize' | 'to_task'
  label: string;                 // 按钮文案，≤8 字，如 '起草回复'
  directive: string;             // 执行时拼进 prompt 的角度指令（后端持有，不下发前端）
  executor?: ProcessingExecutor; // 默认 'claude_topic'；M2 'create_task' 走建任务通道
};

// LLM 直出的单个 item（解析后的形状）。
// 写入 attention_items 前，由 attentionStore 补全 id/generation/llm_run_id/input_hash/timestamps。
export type AttentionLLMItem = {
  priority: AttentionPriority;
  title: string;
  why: string;
  suggestedAction?: string;
  signalIds?: string[];          // 引用 packet 内的 context_units.id / events.id
  relatedEntityIds?: string[];   // 引用 context_entities.id
  relatedSpaceIds?: string[];    // 引用 context_spaces.id
  recommendedAgent?: string;     // 'prepareMeeting' | 'commitmentDigest' | 'recapActionItems' | ...
  expiresAt?: string;            // ISO8601
  /** LLM 指明这条新 item 取代 <currentAttention> 里的哪些旧 item（按 id）。
   *  engine 写入新 item 后会把这些旧 id 批量标 'superseded'。 */
  supersedeIds?: string[];
  /** MVP23：仅 P0/P1 item 才生成；缺失/空 → 卡片退回单个「让 AI 处理」按钮。 */
  processingOptions?: ProcessingOption[];
  /** MVP28：这条 item 讲的是哪个 Matter（取 packet.matters[].id）；该 Matter resolved 后系统按此自动清卡。 */
  matterId?: string;
};

// 持久化后、对外提供的领域类型（attentionStore 将 AttentionItemRow 反序列化为此形状）。
export type AttentionItem = {
  id: string;
  generation: number;
  llmRunId: string | null;
  inputHash: string;
  priority: AttentionPriority;
  title: string;
  why: string;
  suggestedAction: string | null;
  signalIds: string[];
  relatedEntityIds: string[];
  relatedSpaceIds: string[];
  recommendedAgent: string | null;
  status: AttentionStatus;
  expiresAt: string | null;
  sourceKind: string;            // 默认 'attention'，后续可能扩展
  actionOptions: ProcessingOption[] | null;  // MVP23：处理角度；null = 未生成/已降级（禁止存 []）
  matterId: string | null;       // MVP28：绑定的 Matter id（null = 这条不是 Matter 投影）
  createdAt: string;
  updatedAt: string;
};

export type AttentionEngineRunSummary = {
  runId: string;
  generation: number;
  status: AttentionRunStatus;
  itemsEmitted: number;
  inputHash: string;
  startedAt: string;
  completedAt: string | null;
  error?: string;
};

// engine run 的可选 hint，用于在 ws / 日志中标注本次 tick 的形状。
export type AttentionInputSummary = {
  subjectPresent: boolean;
  spacesCount: number;
  goalsCount: number;
  commitmentsCount: number;
  uncertaintiesCount: number;
  recentEventsCount: number;
  topActiveCount: number;
  mattersCount: number;          // MVP28：进入 packet 的 active Matter 数量
  stakeholdersCount: number;
  preferencesCount: number;
  boundaryRulesCount: number;
  attentionInteractionsCount: number;
  liveAttentionCount: number;    // 进入 packet 的 <currentAttention> 数量
  tokenEstimate: number;
  // 观测字段（2026-06-10）：定位"慢在哪"——排队 vs LLM 实跑 vs 输入规模。
  inputChars?: number;           // buildAttentionUserMessage 产出的真实字符数
  llmWaitMs?: number;            // runOneShot 闸门排队耗时
  llmExecMs?: number;            // runOneShot LLM 实跑耗时（含 fallback 串行总和）
};
