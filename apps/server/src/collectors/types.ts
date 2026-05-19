export type RawSignal = {
  /** stable de-dup id within source */
  sourceId: string;
  source: 'calendar' | 'im' | 'mail' | 'drive';
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
};

export type Collector = {
  name: string;
  intervalMs: number;
  collect(since: Date | null): Promise<RawSignal[]>;
};
