import { randomUUID, createHash } from 'node:crypto';
import {
  type EventRow,
  markEventContextExtracted,
  tryInsertEvent,
} from '../db.js';
import { insertMinimalEventContextUnit } from '../context/contextStore.js';
import { enqueueEvents } from '../triage/triageQueue.js';
import type { ContextScope } from '../context/ContextUnit.js';

export type IngestInput = {
  source: string;              // 'manual' | 'calendar' | 'im' | ...
  sourceId?: string;
  kind: string;                // 'event' | 'p2p' | 'group_message' | 'note' | ...
  occurredAt?: string;
  title?: string | null;
  text: string;
  actor?: string | null;
  url?: string | null;
  raw?: unknown;
  scope?: ContextScope;        // 用于 minimal ContextUnit；未传时按 source 推
};

export type IngestResult =
  | { ok: true; event: EventRow; created: true }
  | { ok: true; created: false; reason: 'duplicate' };

function scopeForSource(source: string, override?: ContextScope): ContextScope {
  if (override) return override;
  switch (source) {
    case 'calendar':
    case 'im':
    case 'mail':
    case 'drive':
      return 'work';
    case 'manual':
      return 'personal';
    default:
      return 'work';
  }
}

/**
 * Single entry point for new raw signals — used by both collectors and the
 * MVP4 manual-event route. Writes events row, fires minimal ContextUnit,
 * enqueues triage. Idempotent via events.UNIQUE(source, source_id, content_hash).
 */
export function ingestSignal(input: IngestInput): IngestResult {
  const now = new Date();
  const sourceId = input.sourceId ?? `local-${now.getTime()}-${randomUUID().slice(0, 8)}`;
  const contentHash = createHash('sha1')
    .update([input.source, sourceId, input.text].join('|'))
    .digest('hex');
  const occurredAt = input.occurredAt ?? now.toISOString();

  const row: EventRow = {
    id: randomUUID(),
    source: input.source,
    source_id: sourceId,
    kind: input.kind,
    occurred_at: occurredAt,
    title: input.title ?? null,
    text: input.text,
    actor: input.actor ?? null,
    url: input.url ?? null,
    raw_json: JSON.stringify(input.raw ?? null),
    content_hash: contentHash,
    processed_at: null,
    created_at: now.toISOString(),
  };

  const inserted = tryInsertEvent(row);
  if (!inserted) {
    return { ok: true, created: false, reason: 'duplicate' };
  }

  const scope = scopeForSource(input.source, input.scope);
  try {
    insertMinimalEventContextUnit({
      eventId: row.id,
      scope,
      title: row.title ?? row.text.slice(0, 30),
      content: row.text,
      occurredAt: row.occurred_at,
      source: row.source,
      actor: row.actor ?? undefined,
      actorRole: 'actor',
    });
    markEventContextExtracted(row.id, now.toISOString());
  } catch (err) {
    console.warn(
      `[ingest] minimal ContextUnit failed for event ${row.id}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  enqueueEvents([row]);
  return { ok: true, event: row, created: true };
}
