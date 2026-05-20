export type RuntimeStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'stopped'
  | 'error';

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

// MVP2 Context
export type ContextUnit = {
  id: string;
  subjectId: string;
  scope: 'personal' | 'work' | 'team';
  origin: { kind: string; refId: string };
  kind: string;
  title: string;
  content: string;
  entities: Array<{ type: string; name: string; role?: string; confidence?: number }>;
  time?: { occurredAt?: string; dueAt?: string; startsAt?: string; endsAt?: string };
  emotion?: { valence?: string; labels?: string[]; intensity?: number };
  meaning?: string;
  actionability: 'none' | 'record' | 'notify' | 'ask' | 'act';
  confidence: number;
  mergeKey?: string;
  version: number;
  status: 'active' | 'archived' | 'superseded';
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ContextEntity = {
  id: string;
  type: string;
  name: string;
  confidence: number;
  created_at: string;
  updated_at: string;
};

export type ContextRelation = {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  context_unit_id: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
};

export type ServerEvent =
  | { type: 'runtime_status'; status: RuntimeStatus }
  | { type: 'message_added'; message: ChatMessage }
  | { type: 'message_updated'; message: ChatMessage }
  | { type: 'card_created'; card: SignalCard }
  | { type: 'card_updated'; card: SignalCard }
  | { type: 'collector_status'; collector: CollectorStatus }
  | { type: 'error'; message: string };
