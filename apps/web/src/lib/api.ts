import type {
  ChatMessage,
  ChatTopic,
  CollectorStatus,
  ContextEntity,
  ContextUnit,
  CooccurrenceItem,
  RelationshipItem,
  SignalCard,
  TopicStatus,
} from '../types';

export async function fetchTopics(): Promise<ChatTopic[]> {
  const r = await fetch('/api/topics');
  if (!r.ok) throw new Error(`topics ${r.status}`);
  const j = await r.json();
  return j.topics ?? [];
}

export async function fetchMessages(topicId?: string): Promise<ChatMessage[]> {
  const qs = new URLSearchParams();
  if (topicId) qs.set('topicId', topicId);
  const r = await fetch(`/api/messages${qs.toString() ? `?${qs}` : ''}`);
  if (!r.ok) throw new Error(`messages ${r.status}`);
  const j = await r.json();
  return j.messages ?? [];
}

export async function sendChat(
  text: string,
  opts: { topicId?: string } = {}
): Promise<ChatTopic> {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, topicId: opts.topicId }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `chat ${r.status}`);
  }
  const j = await r.json();
  return j.topic as ChatTopic;
}

export type ManualEventScope = 'personal' | 'work';

export async function sendManualEvent(input: {
  text: string;
  scope: ManualEventScope;
  title?: string;
}): Promise<void> {
  const r = await fetch('/api/manual-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `manual-event ${r.status}`);
  }
}

export async function fetchCaringPaused(): Promise<boolean> {
  const r = await fetch('/api/caring/pause');
  if (!r.ok) throw new Error(`caring/pause ${r.status}`);
  const j = await r.json();
  return !!j.paused;
}

export async function postCaringPaused(paused: boolean): Promise<boolean> {
  const r = await fetch('/api/caring/pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `caring/pause POST ${r.status}`);
  }
  const j = await r.json();
  return !!j.paused;
}

export async function restartRuntime(): Promise<void> {
  const r = await fetch('/api/runtime/restart', { method: 'POST' });
  if (!r.ok) throw new Error(`restart ${r.status}`);
}

// MVP14: 中断当前 Claude turn（用户点 "停止" 按钮时）
// MVP18 Stage 1: 增加可选 topicId 参数；不传时后端退化为"中断所有 busy session"
export async function interruptRuntime(
  topicId?: string
): Promise<{ ok: boolean; method?: string; count?: number }> {
  const r = await fetch('/api/runtime/interrupt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(topicId ? { topicId } : {}),
  });
  if (!r.ok) throw new Error(`interrupt ${r.status}`);
  return (await r.json()) as { ok: boolean; method?: string; count?: number };
}

// MVP18 Stage 1: 启动 / WS 重连时拉一次全量 per-topic 状态快照（修复 R1 漂移）
export async function fetchTopicStatusSnapshot(): Promise<{
  topics: Array<{ topicId: string; status: TopicStatus }>;
}> {
  const r = await fetch('/api/runtime/topic-status');
  if (!r.ok) throw new Error(`topic-status ${r.status}`);
  return (await r.json()) as {
    topics: Array<{ topicId: string; status: TopicStatus }>;
  };
}

// MVP14 Step 4：attention 反馈通道（影响 L1，下次 tick 生效）
export type AttentionFeedbackType =
  | 'not_relevant'
  | 'wrong_space'
  | 'demote_entity'
  | 'add_preference';

export type AttentionFeedbackResult = {
  applied: boolean;
  tier: 'low' | 'medium' | 'high';
  requiresConfirm: boolean;
  journal?: { id: string; correction_type: string; target_kind: string };
  preview: Record<string, unknown>;
};

export async function postAttentionFeedback(input: {
  attentionId: string;
  type: AttentionFeedbackType;
  payload: Record<string, unknown>;
  confirm?: boolean;
}): Promise<AttentionFeedbackResult> {
  const r = await fetch(
    `/api/attention/${encodeURIComponent(input.attentionId)}/feedback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: input.type, payload: input.payload, confirm: input.confirm }),
    }
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `attention feedback ${r.status}`);
  return j as AttentionFeedbackResult;
}

export async function transcribeAudio(
  blob: Blob,
  filename = 'recording.webm'
): Promise<string> {
  const form = new FormData();
  form.append('audio', blob, filename);
  const r = await fetch('/api/speech/transcribe', { method: 'POST', body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `transcribe ${r.status}`);
  return j.text as string;
}

// MVP14 Step 3: 唯一的卡片来源 — L2 attention engine 投影。
// /api/cards 服务端已统一改为代理 attention 投影；/api/attention/cards 是同语义新名字。
export async function fetchAttentionCards(): Promise<SignalCard[]> {
  const r = await fetch('/api/attention/cards');
  if (!r.ok) throw new Error(`attention/cards ${r.status}`);
  const j = await r.json();
  return (j.cards ?? []) as SignalCard[];
}

// MVP11.1：会议 ask 卡片专用确认通道
export async function postActionItemsConfirm(
  cardId: string,
  accept: 'all' | 'none'
): Promise<{ ok: boolean; accepted: number; unitIds?: string[] }> {
  const r = await fetch(
    `/api/cards/${encodeURIComponent(cardId)}/action-items/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept }),
    }
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `action-items confirm ${r.status}`);
  return j;
}

export async function postCardAction(
  cardId: string,
  actionId: string,
  opts?: { extraPrompt?: string }
): Promise<{ card: SignalCard; topic?: ChatTopic }> {
  const body: Record<string, unknown> = { actionId };
  if (opts?.extraPrompt && opts.extraPrompt.trim()) {
    body.extraPrompt = opts.extraPrompt.trim();
  }
  const r = await fetch(`/api/cards/${encodeURIComponent(cardId)}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `card action ${r.status}`);
  return { card: j.card as SignalCard, topic: j.topic as ChatTopic | undefined };
}

export type LarkTaskCreateResult = {
  ok: boolean;
  task: {
    guid: string;
    url?: string;
    summary: string;
  };
  commitmentUnitId: string;
  resultUnitId: string;
  bindingId: string;
  card?: SignalCard;
  reused: boolean;
};

export async function postCardLarkTask(input: {
  cardId: string;
  summary?: string;
  description?: string;
  dueAt?: string;
  tasklistId?: string;
  optionId?: string;
}): Promise<LarkTaskCreateResult> {
  const body: Record<string, unknown> = { confirm: true };
  if (input.summary?.trim()) body.summary = input.summary.trim();
  if (input.description?.trim()) body.description = input.description.trim();
  if (input.dueAt?.trim()) body.dueAt = input.dueAt.trim();
  if (input.tasklistId?.trim()) body.tasklistId = input.tasklistId.trim();
  if (input.optionId?.trim()) body.optionId = input.optionId.trim();
  const r = await fetch(`/api/cards/${encodeURIComponent(input.cardId)}/lark-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `lark-task ${r.status}`);
  return j as LarkTaskCreateResult;
}

export async function fetchCollectors(): Promise<CollectorStatus[]> {
  const r = await fetch('/api/collectors');
  if (!r.ok) throw new Error(`collectors ${r.status}`);
  const j = await r.json();
  return j.collectors ?? [];
}

export type RunOnceResult = {
  name: string;
  collected: number;
  newEvents: number;
  error?: string;
};

export type ContextUnitFilter = {
  limit?: number;
  kind?: string;
  origin?: string;
  actionability?: string;
};

export async function fetchContextUnits(filter: ContextUnitFilter = {}): Promise<ContextUnit[]> {
  const qs = new URLSearchParams();
  if (filter.limit) qs.set('limit', String(filter.limit));
  if (filter.kind) qs.set('kind', filter.kind);
  if (filter.origin) qs.set('origin', filter.origin);
  if (filter.actionability) qs.set('actionability', filter.actionability);
  const r = await fetch(`/api/context/units${qs.toString() ? `?${qs}` : ''}`);
  if (!r.ok) throw new Error(`context/units ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as ContextUnit[];
}

export async function fetchContextEntities(): Promise<ContextEntity[]> {
  const r = await fetch('/api/context/entities');
  if (!r.ok) throw new Error(`context/entities ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as ContextEntity[];
}

// REMOVED in MVP14 Phase 1c: fetchContextRelations。用 fetchRelationships()
// + fetchCooccurrences() 替代。

export async function fetchRelationships(limit = 100): Promise<RelationshipItem[]> {
  const r = await fetch(`/api/context/relationships?limit=${limit}`);
  if (!r.ok) throw new Error(`context/relationships ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as RelationshipItem[];
}

export async function fetchCooccurrences(opts: {
  limit?: number;
  minCount?: number;
} = {}): Promise<CooccurrenceItem[]> {
  const limit = opts.limit ?? 50;
  const minCount = opts.minCount ?? 2;
  const r = await fetch(
    `/api/context/relationships/cooccurrences?limit=${limit}&minCount=${minCount}`
  );
  if (!r.ok) throw new Error(`context/relationships/cooccurrences ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as CooccurrenceItem[];
}

export type ActiveContextSnapshot = {
  items: ContextUnit[];
  summary: string;
  tokenEstimate: number;
};

export async function fetchActiveContext(budget = 1500): Promise<ActiveContextSnapshot> {
  const r = await fetch(`/api/context/active?budget=${budget}`);
  if (!r.ok) throw new Error(`context/active ${r.status}`);
  const j = await r.json();
  return {
    items: (j.items ?? []) as ContextUnit[],
    summary: j.summary ?? '',
    tokenEstimate: j.tokenEstimate ?? 0,
  };
}

export type CardContextProjection = {
  cardId: string;
  eventContextUnitId: string | null;
  relatedUnits: ContextUnit[];
};

export async function fetchCardContext(cardId: string): Promise<CardContextProjection> {
  const r = await fetch(`/api/cards/${encodeURIComponent(cardId)}/context`);
  if (!r.ok) throw new Error(`cards/${cardId}/context ${r.status}`);
  const j = await r.json();
  return {
    cardId: j.cardId,
    eventContextUnitId: j.eventContextUnitId,
    relatedUnits: (j.relatedUnits ?? []) as ContextUnit[],
  };
}

// "查看原始信息"：列出 attention 卡片背后的原始 signal（带飞书原文链接）
export type AttentionSignalDetail = {
  signalId: string;
  kind: 'event' | 'context_unit' | 'card' | 'unknown';
  source?: string;
  title: string;
  occurredAt?: string;
  url?: string;
  excerpt?: string;
  text?: string;
};

export type ParsedImMessage = {
  time: string;
  sender: string;
  content: string;
  isFocus: boolean;
};

export type AttentionConversation = {
  groupKey: string;
  source: 'im';
  chatName: string;
  url?: string;
  latestAt?: string;
  messages: ParsedImMessage[];
  signalIds: string[];
};

export type AttentionOriginItem =
  | { kind: 'conversation'; conversation: AttentionConversation; sortKey: string }
  | { kind: 'signal'; signal: AttentionSignalDetail; sortKey: string };

export async function fetchAttentionSignals(
  attentionId: string
): Promise<AttentionSignalDetail[]> {
  const r = await fetch(`/api/attention/${encodeURIComponent(attentionId)}/signals`);
  if (!r.ok) throw new Error(`attention/${attentionId}/signals ${r.status}`);
  const j = await r.json();
  return (j.signals ?? []) as AttentionSignalDetail[];
}

// 新前端用：一次拉到混排 items（conversation + signal，按"最新动静"时间倒序）
// 同时附带扁平 signals，给"为什么相关"通过 signalId 查 url 用。
export async function fetchAttentionOriginItems(
  attentionId: string
): Promise<{ items: AttentionOriginItem[]; signals: AttentionSignalDetail[] }> {
  const r = await fetch(`/api/attention/${encodeURIComponent(attentionId)}/signals`);
  if (!r.ok) throw new Error(`attention/${attentionId}/signals ${r.status}`);
  const j = await r.json();
  return {
    items: (j.items ?? []) as AttentionOriginItem[],
    signals: (j.signals ?? []) as AttentionSignalDetail[],
  };
}

export type ContextSpace = {
  id: string;
  type: 'project' | 'topic';
  name: string;
  description: string | null;
  owner_subject_id: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type ContextSpaceDetail = {
  space: ContextSpace;
  entityLinks: Array<{
    target_id: string;
    target_type: string;
    link_type: string;
  }>;
  commitments: ContextUnit[];
  goals: ContextUnit[];
  decisions: unknown[];
  risks: ContextUnit[];
  state: ContextUnit[];
  recentEvents: ContextUnit[];
  allUnitCount: number;
};

export async function fetchContextSpaces(): Promise<ContextSpace[]> {
  const r = await fetch('/api/context-spaces');
  if (!r.ok) throw new Error(`context-spaces ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as ContextSpace[];
}

export async function fetchContextSpaceDetail(id: string): Promise<ContextSpaceDetail> {
  const r = await fetch(`/api/context-spaces/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`context-spaces/${id} ${r.status}`);
  return (await r.json()) as ContextSpaceDetail;
}

export async function createContextSpace(input: {
  name: string;
  type: 'project' | 'topic';
  description?: string;
}): Promise<ContextSpace> {
  const r = await fetch('/api/context-spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `context-spaces POST ${r.status}`);
  }
  const j = await r.json();
  return j.space as ContextSpace;
}

export async function reconcileContextSpaces(): Promise<{ scanned: number; linked: number }> {
  const r = await fetch('/api/context-spaces/reconcile', { method: 'POST' });
  if (!r.ok) throw new Error(`reconcile ${r.status}`);
  return (await r.json()) as { scanned: number; linked: number };
}

// -------- MVP12 Phase 2/3 suggestions --------

export type SpaceSuggestion = {
  id: string;
  target_type: string;
  target_id: string;
  space_id: string;
  suggestion_type: 'chat_affinity' | 'person_co_occur';
  score: number;
  evidence: {
    unitsInChat?: number;
    directHits?: number;
    personOverlap?: number;
    docOverlap?: number;
    distinctSenders?: number;
    chatName?: string;
    chatAliases?: string[];
    coOccurCount?: number;
    chatId?: string;
    recentDays?: number;
  } | null;
  status: string;
  cooldown_until: string | null;
  created_at: string;
  updated_at: string;
};

export async function fetchSpaceSuggestions(
  spaceId: string,
  status: 'suggested' | 'confirmed' | 'rejected' = 'suggested'
): Promise<SpaceSuggestion[]> {
  const r = await fetch(
    `/api/context-spaces/${encodeURIComponent(spaceId)}/suggestions?status=${status}`
  );
  if (!r.ok) throw new Error(`suggestions ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as SpaceSuggestion[];
}

export type SpaceConfirmReason =
  | 'exact_project_chat'
  | 'useful_context_source'
  | 'name_match'
  | 'people_match'
  | 'doc_match'
  | 'other';

export type SpaceRejectReason =
  | 'wrong_space'
  | 'chat_too_broad'
  | 'only_incidental_mention'
  | 'obsolete'
  | 'duplicate_seed'
  | 'private_or_noise'
  | 'permanent_not_relevant'
  | 'other';

export async function confirmSpaceSuggestion(
  spaceId: string,
  sid: string,
  opts: { reasonCode?: SpaceConfirmReason; comment?: string } = {}
): Promise<{ ok: boolean; reconciled?: { scanned: number; linked: number } }> {
  const r = await fetch(
    `/api/context-spaces/${encodeURIComponent(spaceId)}/suggestions/${encodeURIComponent(sid)}/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    }
  );
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `confirm ${r.status}`);
  }
  return (await r.json()) as { ok: boolean; reconciled?: { scanned: number; linked: number } };
}

export async function rejectSpaceSuggestion(
  spaceId: string,
  sid: string,
  opts: {
    reasonCode?: SpaceRejectReason;
    comment?: string;
    cooldownDays?: number;
  } = {}
): Promise<{ ok: boolean; cooldownUntil?: string }> {
  const r = await fetch(
    `/api/context-spaces/${encodeURIComponent(spaceId)}/suggestions/${encodeURIComponent(sid)}/reject`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    }
  );
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `reject ${r.status}`);
  }
  return (await r.json()) as { ok: boolean; cooldownUntil?: string };
}

export type SpaceWorkerStats = {
  chatsScanned: number;
  chatsBigSkipped: number;
  chatAffinityInserted: number;
  chatAffinityUpdated: number;
  personCoOccurInserted: number;
  personCoOccurUpdated: number;
  candidateGenerated?: number;
  candidateRanked?: number;
  llmAccepted?: number;
  llmRejected?: number;
  llmFailed?: number;
  rankerCacheHit?: number;
  fallbackSuggested?: number;
};

export async function runSpaceSuggestionWorker(): Promise<{
  ok: boolean;
  stats?: SpaceWorkerStats;
}> {
  const r = await fetch('/api/context-spaces/run-suggestion-worker', {
    method: 'POST',
  });
  if (!r.ok) throw new Error(`worker ${r.status}`);
  return (await r.json()) as {
    ok: boolean;
    stats?: {
      chatsScanned: number;
      chatsBigSkipped: number;
      chatAffinityInserted: number;
      chatAffinityUpdated: number;
      personCoOccurInserted: number;
      personCoOccurUpdated: number;
    };
  };
}

export type BoundaryRule = {
  id: string;
  scope: string;
  condition: {
    triggerType?: string[];
    source?: string[];
    priorityAtMost?: string;
    scope?: string[];
    entityRef?: { type: string; nameLike?: string };
    kind?: string[];
    rawDescription?: string;
  };
  allowedAction: string;
  requiresApproval: boolean;
  confidence: number;
  learnedFromCardId?: string;
  source: string;
  migrated: boolean;
  active: boolean;
  // MVP10.1
  autonomy: 'local_auto' | 'local_with_audit' | 'external_always_confirm';
  reversible: boolean;
  impactScope: 'self' | 'shared';
  createdAt: string;
  updatedAt: string;
};

export type AuditLog = {
  id: string;
  agent_run_id: string | null;
  card_id: string | null;
  rule_id: string | null;
  action: string;
  reason: string;
  payload_json: string | null;
  created_at: string;
};

export async function fetchBoundaryRules(activeOnly = false): Promise<BoundaryRule[]> {
  const url = activeOnly ? '/api/boundary/rules?active=1' : '/api/boundary/rules';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`boundary/rules ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as BoundaryRule[];
}

export async function patchBoundaryRule(id: string, active: boolean): Promise<BoundaryRule> {
  const r = await fetch(`/api/boundary/rules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `patch boundary rule ${r.status}`);
  }
  const j = await r.json();
  return j.rule as BoundaryRule;
}

export async function fetchAuditLogs(limit = 50): Promise<AuditLog[]> {
  const r = await fetch(`/api/audit-logs?limit=${limit}`);
  if (!r.ok) throw new Error(`audit-logs ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as AuditLog[];
}

// -------- MVP10 Correction --------

export type CorrectionType =
  | 'wrong_priority'
  | 'wrong_meaning'
  | 'wrong_actionability'
  | 'wrong_entity'
  | 'wrong_kind';

export type CorrectionApplyResult = {
  applied: boolean;
  tier: 'low' | 'medium' | 'high';
  requiresConfirm: boolean;
  journal?: {
    id: string;
    correction_type: string;
    target_kind: string;
    target_id: string;
    forward_patch_json: string;
    inverse_patch_json: string | null;
    inverse_lossy: number;
    applied_at: string;
  };
  preview: Record<string, unknown>;
};

export async function postCardCorrection(input: {
  cardId: string;
  type: CorrectionType;
  payload: Record<string, unknown>;
  confirm?: boolean;
}): Promise<CorrectionApplyResult> {
  const r = await fetch(`/api/cards/${encodeURIComponent(input.cardId)}/correction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: input.type, payload: input.payload, confirm: input.confirm }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `correction ${r.status}`);
  return j as CorrectionApplyResult;
}

export async function postContextFeedback(input: {
  contextUnitId?: string;
  cardId?: string;
  reason: string;
  comment?: string;
}): Promise<void> {
  const r = await fetch('/api/context/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `context feedback ${r.status}`);
  }
}

// -------- MVP7 Work Map --------

export type WorkMapBoundaryDraft = {
  description: string;
  triggerType?: string[];
  priorityAtMost?: 'P0' | 'P1' | 'P2' | 'P3';
  source?: Array<'calendar' | 'im' | 'mail' | 'drive' | 'manual' | 'agent'>;
  allowedAction?: 'record' | 'notify' | 'draft' | 'execute_reversible';
};

export type WorkMapProjectDraft = {
  name: string;
  description?: string;
  goals: string[];
  authoritativeDocs: string[];
  upcomingDeadlines: Array<{ title: string; dueAt?: string }>;
  risks: string[];
};

export type WorkMapDraft = {
  profile: {
    roleTitle?: string;
    teamName?: string;
    responsibilities: string[];
  };
  projects: WorkMapProjectDraft[];
  stakeholders: Array<{ name: string; note?: string }>;
  preferences: string[];
  boundaries: WorkMapBoundaryDraft[];
};

export type WorkMapWriteSummary = {
  unitsWritten: number;
  unitsUpdated: number;
  spacesWritten: number;
  rulesWritten: number;
  rulesTouched: number;
  bootstrapCompletedAt: string;
};

// MVP15 §4: 与服务端 PersonAttributes.orgRoleFromMe 对齐。'manager_of_me' /
// 'report_of_me' 是 Phase A.5 预留的取值，当前不会被填，但保留以减少未来的 schema 变更。
export type OrgRoleFromMe =
  | 'peer_same_dept'
  | 'same_business_cross_function'
  | 'cross_dept'
  | 'external'
  | 'manager_of_me'
  | 'report_of_me';

// MVP15 §4 (revision): stakeholder 的组织关系打包成对象，含 role + 解析后的业务/职能
export type StakeholderOrgInfo = {
  role: OrgRoleFromMe;
  business?: string;
  functionLabel?: string;
};

export type CurrentWorkMap = {
  bootstrapCompletedAt: string | null;
  role: ContextUnit | null;
  responsibilities: ContextUnit[];
  goals: ContextUnit[];
  commitments: ContextUnit[];
  risks: ContextUnit[];
  preferences: ContextUnit[];
  relationships: ContextUnit[];
  /**
   * MVP15 §4: 与 `relationships` 平行的 orgRole + 解析后业务/职能信息。key 为 person
   * entity name。key 缺失代表"未连接飞书 / 不可判定"，前端不渲染 chip。
   */
  stakeholderOrgRoles: Record<string, StakeholderOrgInfo>;
  spaces: Array<{
    id: string;
    name: string;
    description: string | null;
    docCount: number;
  }>;
  boundaryRules: BoundaryRule[];
};

export async function fetchWorkMapCurrent(): Promise<CurrentWorkMap> {
  const r = await fetch('/api/bootstrap/work-map/current');
  if (!r.ok) throw new Error(`work-map/current ${r.status}`);
  return (await r.json()) as CurrentWorkMap;
}

export type WorkMapDraftResponse = {
  draft: WorkMapDraft;
  tokenEstimate: number;
  itemsConsidered: number;
  itemsTruncated: number;
  rawText: string;
};

export async function generateWorkMapDraft(input: {
  seedText?: string;
  lookbackDays?: number;
  mode?: 'full' | 'incremental';
}): Promise<WorkMapDraftResponse> {
  const r = await fetch('/api/bootstrap/work-map/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `work-map/draft ${r.status}`);
  return j as WorkMapDraftResponse;
}

export async function confirmWorkMap(draft: WorkMapDraft): Promise<{
  summary: WorkMapWriteSummary;
  current: CurrentWorkMap;
}> {
  const r = await fetch('/api/bootstrap/work-map/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `work-map/confirm ${r.status}`);
  return j as { summary: WorkMapWriteSummary; current: CurrentWorkMap };
}

export async function runCollectorsOnce(name?: string): Promise<RunOnceResult[]> {
  const r = await fetch('/api/collectors/run-once', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { name } : {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `collectors run ${r.status}`);
  return (j.results ?? []) as RunOnceResult[];
}

// ============================================================================
// MVP15A: graph API
// ============================================================================

export type DecisionRoleHint =
  | 'co_owner'
  | 'reviewer'
  | 'contributor'
  | 'observer'
  | null;

export type SelfCollaboratorEntry = {
  personEntityId: string;
  name: string;
  weight: number;
  orgRole?: OrgRoleFromMe;
  business?: string;
  functionLabel?: string;
  sharedProjectCanonicalNames: string[];
  decisionRoleHint: DecisionRoleHint;
  evidenceUnitIds: string[];
  lastSeenAt: string;
};

export type MyCollaboratorsResponse = {
  entries: SelfCollaboratorEntry[];
  inducerLastRunAt: string;
};

export async function fetchMyCollaborators(
  opts: { limit?: number } = {}
): Promise<MyCollaboratorsResponse> {
  const limit = opts.limit ?? 20;
  const r = await fetch(`/api/graph/my-collaborators?limit=${limit}`);
  if (!r.ok) throw new Error(`graph/my-collaborators ${r.status}`);
  return (await r.json()) as MyCollaboratorsResponse;
}

// ============================================================================
// MVP19 §M4 — project canonical proposals (审核入口最小版本)
// ============================================================================

export type ProjectProposal = {
  id: string;
  proposedName: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceEventId: string | null;
  sourceUnitIds: string[];
};

export async function fetchProjectProposals(): Promise<ProjectProposal[]> {
  const r = await fetch("/api/projects/proposals");
  if (!r.ok) throw new Error(`projects/proposals ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as ProjectProposal[];
}

export type ResolveProposalInput =
  | { action: "approve_new"; canonical?: string; parentCanonical?: string }
  | { action: "approve_alias"; target: string }
  | { action: "rejected" };

export async function resolveProjectProposal(
  id: string,
  input: ResolveProposalInput
): Promise<{ ok: boolean; error?: string; alias?: string; existingCanonical?: string }> {
  const r = await fetch(`/api/projects/proposals/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { ok: false, ...(j as Record<string, unknown>) };
  }
  return { ok: true };
}


// 「模仿」模块：语气画像读写。
export type ToneProfile = {
  md: string;
  customized: boolean;
  default: string;
};

export async function fetchToneProfile(): Promise<ToneProfile> {
  const r = await fetch('/api/tone-profile');
  if (!r.ok) throw new Error(`tone-profile ${r.status}`);
  return (await r.json()) as ToneProfile;
}

export async function saveToneProfile(md: string): Promise<ToneProfile> {
  const r = await fetch('/api/tone-profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ md }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `tone-profile ${r.status}`);
  return j as ToneProfile;
}
