export type RuntimeStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'stopped'
  | 'error';

export type RuntimeEvent =
  | { type: 'assistant_text'; topicId?: string; text: string; raw: unknown }
  | { type: 'tool_start'; topicId?: string; toolName: string; input: unknown; raw: unknown }
  | { type: 'tool_result'; topicId?: string; toolName: string; output: unknown; isError: boolean; raw: unknown }
  | { type: 'turn_done'; topicId?: string; result?: string; raw: unknown }
  | { type: 'system_info'; topicId?: string; text: string; raw: unknown }
  | { type: 'runtime_error'; topicId?: string; error: string; raw?: unknown };

export type ChatMessage =
  | { id: string; topicId?: string; role: 'user'; text: string; createdAt: string }
  | { id: string; topicId?: string; role: 'assistant'; text: string; createdAt: string }
  | {
      id: string;
      topicId?: string;
      role: 'tool';
      toolName: string;
      summary: string;
      status: 'running' | 'done' | 'failed';
      createdAt: string;
    }
  | {
      id: string;
      topicId?: string;
      role: 'system';
      text: string;
      level: 'info' | 'warn' | 'error';
      createdAt: string;
    };

export type CardActionKind =
  | 'ack'
  | 'snooze'
  | 'dismiss'
  | 'ask_agent'
  | 'draft_reply'
  | 'open_source'
  | 'mark_done'
  | 'auto_henceforth';

export type CardAction = {
  id: string;
  label: string;
  kind: CardActionKind;
  prompt?: string;
};

export type CardStatus = 'new' | 'acknowledged' | 'snoozed' | 'dismissed' | 'done' | 'batched';

export type CardSourceKind = 'triage' | 'agent_run' | 'manual';

export type SignalCard = {
  id: string;
  triageId?: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  source: 'calendar' | 'im' | 'mail' | 'drive' | 'manual' | 'agent';
  title: string;
  summary: string;
  reason: string;
  suggestedAction?: string;
  draftReply?: string;
  status: CardStatus;
  actions: CardAction[];
  rawEventId?: string;
  sourceUrl?: string;
  sourceKind?: CardSourceKind;
  sourceRefId?: string;
  createdAt: string;
  updatedAt: string;
};

export type CollectorStatus = {
  name: string;
  lastScanAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  nextRunAt?: string;
};

export type ServerEvent =
  | { type: 'runtime_status'; status: RuntimeStatus }
  | { type: 'message_added'; message: ChatMessage }
  | { type: 'message_updated'; message: ChatMessage }
  | { type: 'topic_created'; topic: unknown }
  | { type: 'topic_updated'; topic: unknown }
  | { type: 'card_created'; card: SignalCard }
  | { type: 'card_updated'; card: SignalCard }
  | { type: 'collector_status'; collector: CollectorStatus }
  | { type: 'attention_updated'; generation: number; itemsEmitted: number }
  | { type: 'error'; message: string };
