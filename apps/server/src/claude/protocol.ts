// MVP18 Stage 1: RuntimeStatus 收窄为"runtime 进程健康度"，不再含 'busy'。
// per-topic 的忙闲态走 TopicStatus + topic_status 事件。
export type RuntimeStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'stopped'
  | 'error';

// MVP18 Stage 1: per-topic 状态。'error' 不持久化——turn 失败时 emit runtime_error
// 后立即回 'idle'，前端以系统消息表达错误。
export type TopicStatus = 'idle' | 'busy';

// MVP18 Stage 1: RuntimeEvent.topicId 由可选改为必填——所有 runtime 事件都属于某个 topic。
// 编译期保证 TopicSession 内部 emit 时一定带上 this.topicId。
export type RuntimeEvent =
  | { type: 'assistant_text'; topicId: string; text: string; raw: unknown }
  | { type: 'tool_start'; topicId: string; toolName: string; input: unknown; raw: unknown }
  | { type: 'tool_result'; topicId: string; toolName: string; output: unknown; isError: boolean; raw: unknown }
  | { type: 'turn_done'; topicId: string; result?: string; raw: unknown }
  | { type: 'system_info'; topicId: string; text: string; raw: unknown }
  | { type: 'runtime_error'; topicId: string; error: string; raw?: unknown };

// MVP18 Stage 1: ChatMessage.topicId 保持可选——纯粹是反序列化 legacy
// `runtime_messages.raw_json` 时的兜底（早期版本写过无 topicId 的消息行，迁移到
// 'legacy-global-chat'）。所有新写入路径都会填 topicId。
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
  | 'auto_henceforth'
  | 'create_task';   // MVP23 M2：处理角度的结构化执行器，前端路由到建任务通道

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
  // MVP18 Stage 1: 新增 per-topic 状态广播
  | { type: 'topic_status'; topicId: string; status: TopicStatus }
  | { type: 'message_added'; message: ChatMessage }
  | { type: 'message_updated'; message: ChatMessage }
  | { type: 'topic_created'; topic: unknown }
  | { type: 'topic_updated'; topic: unknown }
  | { type: 'card_created'; card: SignalCard }
  | { type: 'card_updated'; card: SignalCard }
  | { type: 'collector_status'; collector: CollectorStatus }
  | { type: 'attention_updated'; generation: number; itemsEmitted: number }
  | { type: 'matter_updated'; matterId: string }
  | { type: 'error'; message: string };
