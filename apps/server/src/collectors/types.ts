import type {
  ContextActionability,
  ContextEntityRef,
  ContextScope,
} from '../context/ContextUnit.js';

export type RawSignal = {
  /** stable de-dup id within source */
  sourceId: string;
  source: 'calendar' | 'im' | 'mail' | 'drive' | 'minutes';
  /** sub-kind, e.g. "event" / "message" */
  kind: string;
  /** ISO time when the underlying thing happened */
  occurredAt: string;
  title?: string;
  /** plaintext-ish summary suitable for triage prompt */
  text: string;
  actor?: string;
  url?: string;
  /** raw upstream payload, for storage */
  raw: unknown;
  /** hash for change detection. Stable across re-pulls of unchanged content. */
  contentHash: string;

  // === MVP11.0-a：结构化扩展（全部 optional，老 collector 不动） ===
  /** ContextUnit 落地时直接挂的 entity 列表。优先级高于 collector 默认的 actor fallback。 */
  entities?: ContextEntityRef[];
  /** ContextUnit.mergeHint —— 不给则 fallback `event:<eventId>`。 */
  contextMergeHint?: string;
  /** 显式 scope；不给则按 source 兜底（scopeForSource）。 */
  scope?: ContextScope;
  /** 显式 actionability；不给则 'record'。 */
  actionability?: ContextActionability;
  /**
   * 结构化机器判定，例如 { signal_kind:'doc_comment', is_at_me:true }。
   * 通过 encodeSemanticTags 写入 ContextUnit.meaning 前缀，evaluator 读 meaning 解 tags。
   */
  semanticTags?: Record<string, string | boolean>;
  /**
   * true 时该事件不进 triage LLM 队列（已结构化的 collector 自行打 tag，避免双处理）。
   */
  skipTriage?: boolean;
};

// MVP33 U1：采集覆盖水位契约。
export type CollectResult = {
  signals: RawSignal[];
  /**
   * 覆盖水位（ISO）：调用方可以安全把游标推进到这里。
   * 铁律：凡 occurred_at ≤ coveredUntil 且属于本源职责范围的数据，要么已包含在本轮
   * （或历史轮）signals 中，要么永远不会存在。本轮没有完整消化的时间段，水位不得越过——
   * 分页截断/上限命中时水位停在被截处，下轮从水位续扫，停摆/洪峰后零静默丢失。
   * 快照式采集器（不依赖 since 游标）返回本轮扫描起点即可（行为与历史一致）。
   */
  coveredUntil: string;
};

export type Collector = {
  name: string;
  intervalMs: number;
  collect(since: Date | null): Promise<CollectResult>;
};
