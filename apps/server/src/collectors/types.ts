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

export type Collector = {
  name: string;
  intervalMs: number;
  collect(since: Date | null): Promise<RawSignal[]>;
};
