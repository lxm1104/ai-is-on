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
  stakeholdersCount: number;
  preferencesCount: number;
  boundaryRulesCount: number;
  liveAttentionCount: number;    // 进入 packet 的 <currentAttention> 数量
  tokenEstimate: number;
};
