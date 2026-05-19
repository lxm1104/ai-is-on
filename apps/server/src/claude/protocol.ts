export type RuntimeStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'stopped'
  | 'error';

export type RuntimeEvent =
  | { type: 'assistant_text'; text: string; raw: unknown }
  | { type: 'tool_start'; toolName: string; input: unknown; raw: unknown }
  | { type: 'tool_result'; toolName: string; output: unknown; isError: boolean; raw: unknown }
  | { type: 'turn_done'; result?: string; raw: unknown }
  | { type: 'system_info'; text: string; raw: unknown }
  | { type: 'runtime_error'; error: string; raw?: unknown };

export type ChatMessage =
  | { id: string; role: 'user'; text: string; createdAt: string }
  | { id: string; role: 'assistant'; text: string; createdAt: string }
  | {
      id: string;
      role: 'tool';
      toolName: string;
      summary: string;
      status: 'running' | 'done' | 'failed';
      createdAt: string;
    }
  | {
      id: string;
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
  | 'mark_done';

export type CardAction = {
  id: string;
  label: string;
  kind: CardActionKind;
  prompt?: string;
};

export type CardStatus = 'new' | 'acknowledged' | 'snoozed' | 'dismissed' | 'done';

export type SignalCard = {
  id: string;
  triageId?: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  source: 'calendar' | 'im' | 'mail' | 'drive' | 'manual';
  title: string;
  summary: string;
  reason: string;
  suggestedAction?: string;
  draftReply?: string;
  status: CardStatus;
  actions: CardAction[];
  rawEventId?: string;
  sourceUrl?: string;
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
  | { type: 'card_created'; card: SignalCard }
  | { type: 'card_updated'; card: SignalCard }
  | { type: 'collector_status'; collector: CollectorStatus }
  | { type: 'error'; message: string };
