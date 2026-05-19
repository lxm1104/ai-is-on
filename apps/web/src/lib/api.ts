import type {
  ChatMessage,
  CollectorStatus,
  ContextEntity,
  ContextRelation,
  ContextUnit,
  SignalCard,
} from '../types';

export async function fetchMessages(): Promise<ChatMessage[]> {
  const r = await fetch('/api/messages');
  if (!r.ok) throw new Error(`messages ${r.status}`);
  const j = await r.json();
  return j.messages ?? [];
}

export async function sendChat(text: string): Promise<void> {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `chat ${r.status}`);
  }
}

export async function restartRuntime(): Promise<void> {
  const r = await fetch('/api/runtime/restart', { method: 'POST' });
  if (!r.ok) throw new Error(`restart ${r.status}`);
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

export async function fetchCards(): Promise<SignalCard[]> {
  const r = await fetch('/api/cards');
  if (!r.ok) throw new Error(`cards ${r.status}`);
  const j = await r.json();
  return j.cards ?? [];
}

export async function postCardAction(
  cardId: string,
  actionId: string
): Promise<SignalCard> {
  const r = await fetch(`/api/cards/${encodeURIComponent(cardId)}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `card action ${r.status}`);
  return j.card as SignalCard;
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

export async function fetchContextRelations(): Promise<ContextRelation[]> {
  const r = await fetch('/api/context/relations');
  if (!r.ok) throw new Error(`context/relations ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as ContextRelation[];
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
