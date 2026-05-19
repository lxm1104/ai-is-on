import type { CardAction } from '../claude/protocol.js';

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
};

export type TriageResult = { items: TriageItem[] };

function extractJson(s: string): unknown {
  // First try whole-string parse
  try {
    return JSON.parse(s);
  } catch {}
  // Strip ```json fences
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  // First "{" to last "}"
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = s.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch {}
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
  };
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
