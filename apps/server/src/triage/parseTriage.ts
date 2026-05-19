import { jsonrepair } from 'jsonrepair';
import type { CardAction } from '../claude/protocol.js';
import type { ContextUnitDraft } from '../context/ContextUnit.js';

export type TriageItem = {
  sourceEventId: string;
  relevant: boolean;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  title: string;
  summary: string;
  reason: string;
  suggestedAction?: string;
  draftReply?: string;
  confidence: number;
  shouldCreateCard: boolean;
  cardActions: CardAction[];
  // MVP2.1: LLM 提取出的 context（最多 3 条，由 coerce 截断）
  contextUpdates: ContextUnitDraft[];
};

export type TriageResult = { items: TriageItem[] };

const MAX_CONTEXT_UPDATES_PER_ITEM = 3;

// LLM 提取的 contextUpdate kind 白名单。
// 注意：'event' 不在内 —— collector 已经为每条 raw event 写过一条 kind=event
// ContextUnit，再让 LLM 输出 event 类会让 mergeKey 跨 entity 命中、错误关联。
// 方案 §4.6 提取规则第 1 条对应。
const ALLOWED_KINDS = new Set([
  'state',
  'goal',
  'intent',
  'commitment',
  'relationship',
  'memory',
  'emotion',
  'constraint',
  'uncertainty',
  'action_result',
  'self_narrative',
  'routine',
  'decision',
  'preference',
]);

const ALLOWED_ACTIONABILITY = new Set(['none', 'record', 'notify', 'ask', 'act']);

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {}
  // jsonrepair handles common LLM JSON glitches: unescaped quotes inside strings,
  // trailing commas, single-quoted keys, etc.
  try {
    return JSON.parse(jsonrepair(s));
  } catch {}
  return null;
}

function extractJson(s: string): unknown {
  const whole = tryParse(s);
  if (whole !== null) return whole;
  // Strip ```json fences
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inside = tryParse(fenced[1]);
    if (inside !== null) return inside;
  }
  // First "{" to last "}"
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = s.slice(first, last + 1);
    const sliced = tryParse(slice);
    if (sliced !== null) return sliced;
  }
  throw new Error(`triage 输出不是合法 JSON: ${s.slice(0, 200)}`);
}

const ALLOWED_ACTION_KINDS = new Set([
  'ack',
  'snooze',
  'dismiss',
  'ask_agent',
  'draft_reply',
  'open_source',
  'mark_done',
]);

const ALLOWED_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

function coerceItem(raw: unknown): TriageItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const sourceEventId = typeof o.sourceEventId === 'string' ? o.sourceEventId : '';
  if (!sourceEventId) return null;
  const priorityRaw = typeof o.priority === 'string' ? o.priority.toUpperCase() : 'P2';
  const priority = (ALLOWED_PRIORITIES.has(priorityRaw) ? priorityRaw : 'P2') as TriageItem['priority'];
  const actionsRaw = Array.isArray(o.cardActions) ? (o.cardActions as unknown[]) : [];
  const cardActions: CardAction[] = [];
  for (const a of actionsRaw) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const label = typeof r.label === 'string' ? r.label : '';
    const kindRaw = typeof r.kind === 'string' ? r.kind : '';
    if (!id || !label || !ALLOWED_ACTION_KINDS.has(kindRaw)) continue;
    cardActions.push({
      id,
      label,
      kind: kindRaw as CardAction['kind'],
      prompt: typeof r.prompt === 'string' ? r.prompt : undefined,
    });
  }
  return {
    sourceEventId,
    relevant: o.relevant !== false,
    priority,
    title: String(o.title ?? ''),
    summary: String(o.summary ?? ''),
    reason: String(o.reason ?? ''),
    suggestedAction:
      typeof o.suggestedAction === 'string' && o.suggestedAction.trim()
        ? o.suggestedAction
        : undefined,
    draftReply:
      typeof o.draftReply === 'string' && o.draftReply.trim() ? o.draftReply : undefined,
    confidence: typeof o.confidence === 'number' ? o.confidence : 0.5,
    shouldCreateCard: o.shouldCreateCard !== false,
    cardActions,
    contextUpdates: coerceContextUpdates(o.contextUpdates),
  };
}

function coerceContextUpdates(raw: unknown): ContextUnitDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextUnitDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind : '';
    if (!ALLOWED_KINDS.has(kind)) continue;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (!title) continue;

    const entities = coerceEntities(o.entities);
    const time = coerceTime(o.time);
    const emotion = coerceEmotion(o.emotion);
    const actionabilityRaw = typeof o.actionability === 'string' ? o.actionability : 'record';
    const actionability = (ALLOWED_ACTIONABILITY.has(actionabilityRaw)
      ? actionabilityRaw
      : 'record') as ContextUnitDraft['actionability'];

    out.push({
      kind: kind as ContextUnitDraft['kind'],
      title,
      content: content || title,
      entities,
      time,
      emotion: emotion ?? undefined,
      meaning: typeof o.meaning === 'string' && o.meaning.trim() ? o.meaning : undefined,
      actionability,
      confidence:
        typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1
          ? o.confidence
          : 0.7,
      mergeHint:
        typeof o.mergeHint === 'string' && o.mergeHint.trim()
          ? o.mergeHint.trim()
          : undefined,
    });
    if (out.length >= MAX_CONTEXT_UPDATES_PER_ITEM) break;
  }
  return out;
}

function coerceEntities(raw: unknown): NonNullable<ContextUnitDraft['entities']> {
  if (!Array.isArray(raw)) return [];
  const out: NonNullable<ContextUnitDraft['entities']> = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type.trim() : '';
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!type || !name) continue;
    out.push({
      type,
      name,
      role: typeof o.role === 'string' && o.role.trim() ? o.role : undefined,
      confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
    });
  }
  return out;
}

function coerceTime(raw: unknown): ContextUnitDraft['time'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const pick = (k: string) =>
    typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string) : undefined;
  const time = {
    occurredAt: pick('occurredAt'),
    startsAt: pick('startsAt'),
    endsAt: pick('endsAt'),
    dueAt: pick('dueAt'),
    expiresAt: pick('expiresAt'),
  };
  return Object.values(time).some((v) => v !== undefined) ? time : undefined;
}

const ALLOWED_VALENCE = new Set(['positive', 'neutral', 'negative', 'mixed']);

function coerceEmotion(raw: unknown): ContextUnitDraft['emotion'] | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const valenceRaw = typeof o.valence === 'string' ? o.valence : undefined;
  const valence = valenceRaw && ALLOWED_VALENCE.has(valenceRaw)
    ? (valenceRaw as 'positive' | 'neutral' | 'negative' | 'mixed')
    : undefined;
  const labels = Array.isArray(o.labels)
    ? (o.labels.filter((x) => typeof x === 'string') as string[])
    : undefined;
  const intensity = typeof o.intensity === 'number' ? o.intensity : undefined;
  if (!valence && (!labels || labels.length === 0) && intensity === undefined) return undefined;
  return { valence, labels, intensity };
}

export function parseTriageResult(text: string): TriageResult {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object') throw new Error('triage 输出不是对象');
  const items = (obj as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error('triage 输出缺少 items 数组');
  const out: TriageItem[] = [];
  for (const raw of items) {
    const it = coerceItem(raw);
    if (it) out.push(it);
  }
  return { items: out };
}
