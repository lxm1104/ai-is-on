export type RuntimeStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'stopped'
  | 'error';

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

export type ChatTopic = {
  id: string;
  title: string;
  sourceKind: string;
  sourceRefId?: string;
  opencodeSessionId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
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

// REMOVED in MVP14 Phase 1c: ContextRelation (旧 context_relations 表)。
// 用 RelationshipItem / CooccurrenceItem 替代。

// MVP14 Phase 1a · explicit relationships read model
export type RelationshipSource =
  | 'work_map'
  | 'extracted_from_event'
  | 'manual'
  | 'system'
  | 'agent'
  | 'other';

export type RelationshipPerson = {
  id: string;
  name: string;
};

export type RelationshipItem = {
  id: string;
  source: RelationshipSource;
  persons: RelationshipPerson[];
  summary: string;
  title: string;
  updatedAt: string;
};

// MVP14 Phase 1b · co-occurrence read model
export type CooccurrenceEndpoint = {
  id: string;
  type: string;
  name: string;
};

export type CooccurrenceItem = {
  left: CooccurrenceEndpoint;
  right: CooccurrenceEndpoint;
  count: number;
  lastSeenAt: string;
  evidenceUnit: { id: string; title: string };
};

export type ServerEvent =
  | { type: 'runtime_status'; status: RuntimeStatus }
  | { type: 'message_added'; message: ChatMessage }
  | { type: 'message_updated'; message: ChatMessage }
  | { type: 'topic_created'; topic: ChatTopic }
  | { type: 'topic_updated'; topic: ChatTopic }
  | { type: 'card_created'; card: SignalCard }
  | { type: 'card_updated'; card: SignalCard }
  | { type: 'collector_status'; collector: CollectorStatus }
  | { type: 'attention_updated'; generation: number; itemsEmitted: number }
  | { type: 'error'; message: string };
