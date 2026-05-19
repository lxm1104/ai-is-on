import { config } from '../config.js';
import {
  type EventRow,
  insertTriageResult,
  listActiveUserRules,
  markEventProcessed,
} from '../db.js';
import { randomUUID } from 'node:crypto';
import { buildTriageUserMessage } from './triagePrompt.js';
import { runTriageOnce } from './backgroundRuntime.js';
import { parseTriageResult, type TriageItem } from './parseTriage.js';
import { createCardsFromTriage } from '../cards/cardsService.js';

type QueueItem = { events: EventRow[] };

const queue: QueueItem[] = [];
let running = false;

export function enqueueEvents(events: EventRow[]) {
  if (events.length === 0) return;
  const batchSize = Math.max(1, config.triageBatchSize);
  for (let i = 0; i < events.length; i += batchSize) {
    queue.push({ events: events.slice(i, i + batchSize) });
  }
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        await processBatch(item.events);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[triage] batch failed (${item.events.length} events). prompt~${Math.round(estimatePromptBytes(item.events) / 1024)}KB. error:\n${msg}`
        );
        // still mark as processed so we don't spin forever
        for (const ev of item.events) markEventProcessed(ev.id, new Date().toISOString());
      }
    }
  } finally {
    running = false;
  }
}

function estimatePromptBytes(events: EventRow[]): number {
  let n = 0;
  for (const e of events) n += (e.text?.length ?? 0) + (e.title?.length ?? 0) + 64;
  return n;
}

const RETRYABLE_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /fetch failed/i,
  /rate.?limit/i,
  /overloaded/i,
  /529/i, // anthropic overloaded
  /502 Bad Gateway/i,
  /503 Service Unavailable/i,
];

function shouldRetry(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE_PATTERNS.some((re) => re.test(msg));
}

async function processBatch(events: EventRow[]) {
  const rules = listActiveUserRules();
  const user = buildTriageUserMessage({
    signals: events.map((e) => ({
      id: e.id,
      source: e.source,
      kind: e.kind,
      occurredAt: e.occurred_at,
      title: e.title,
      text: e.text,
      actor: e.actor,
      url: e.url,
    })),
    userRules: rules.map((r) => ({ description: r.description })),
  });

  let text: string;
  try {
    text = (await runTriageOnce(user)).text;
  } catch (err) {
    if (!shouldRetry(err)) throw err;
    console.warn(
      `[triage] retrying once after transient error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`
    );
    await new Promise((r) => setTimeout(r, 1500));
    text = (await runTriageOnce(user)).text;
  }

  let parsed: ReturnType<typeof parseTriageResult>;
  try {
    parsed = parseTriageResult(text);
  } catch (err) {
    console.error(
      '[triage] parse failed:',
      err instanceof Error ? err.message : String(err),
      '\n--- raw ---\n',
      text.slice(0, 1000)
    );
    for (const ev of events) markEventProcessed(ev.id, new Date().toISOString());
    return;
  }

  const eventById = new Map<string, EventRow>();
  for (const ev of events) eventById.set(ev.id, ev);

  for (const item of parsed.items) {
    const ev = eventById.get(item.sourceEventId);
    if (!ev) continue;
    persistOne(ev, item);
  }
  for (const ev of events) markEventProcessed(ev.id, new Date().toISOString());
}

function persistOne(ev: EventRow, item: TriageItem) {
  const triageId = randomUUID();
  const now = new Date().toISOString();
  insertTriageResult({
    id: triageId,
    event_id: ev.id,
    priority: item.priority,
    title: item.title,
    summary: item.summary,
    reason: item.reason,
    suggested_action: item.suggestedAction ?? null,
    draft_reply: item.draftReply ?? null,
    confidence: item.confidence,
    raw_json: JSON.stringify(item),
    created_at: now,
  });
  if (item.relevant && item.shouldCreateCard) {
    createCardsFromTriage(ev, item, triageId);
  }
}
