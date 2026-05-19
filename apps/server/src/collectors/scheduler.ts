import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import {
  getCollectorState,
  tryInsertEvent,
  upsertCollectorState,
  type EventRow,
} from '../db.js';
import { broadcast } from '../ws.js';
import { calendarCollector } from './calendarCollector.js';
import { imCollector } from './imCollector.js';
import { enqueueEvents } from '../triage/triageQueue.js';
import type { Collector } from './types.js';
import { insertMinimalEventContextUnit } from '../context/contextStore.js';
import { markEventContextExtracted } from '../db.js';
import type { ContextScope } from '../context/ContextUnit.js';

function scopeForSource(source: string): ContextScope {
  // §4.6 默认规则：work / personal / team
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

type ScheduledCollector = {
  collector: Collector;
  timer?: NodeJS.Timeout;
  nextRunAt?: Date;
  /** Mutex so collector doesn't re-enter while previous run still in flight. */
  running: boolean;
};

const scheduled: ScheduledCollector[] = [];

export function startCollectorScheduler() {
  if (!config.collectorEnabled) {
    console.log('[collectors] disabled by COLLECTOR_ENABLED=false');
    return;
  }
  scheduled.push({ collector: calendarCollector, running: false });
  scheduled.push({ collector: imCollector, running: false });

  for (const s of scheduled) {
    // Kick off a first run after a short delay so server is fully up.
    setTimeout(() => void tick(s), 5_000);
    s.timer = setInterval(() => void tick(s), s.collector.intervalMs);
    s.nextRunAt = new Date(Date.now() + 5_000);
  }
  console.log(
    '[collectors] scheduled:',
    scheduled.map((s) => `${s.collector.name}@${s.collector.intervalMs}ms`).join(', ')
  );
}

export function stopCollectorScheduler() {
  for (const s of scheduled) {
    if (s.timer) clearInterval(s.timer);
    s.timer = undefined;
  }
}

export type RunOnceResult = {
  name: string;
  collected: number;
  newEvents: number;
  error?: string;
};

export async function runOnce(name?: string): Promise<RunOnceResult[]> {
  const targets = name ? scheduled.filter((s) => s.collector.name === name) : scheduled;
  const out: RunOnceResult[] = [];
  for (const s of targets) {
    const r = await tick(s);
    out.push({ name: s.collector.name, ...r });
  }
  return out;
}

async function tick(s: ScheduledCollector): Promise<{ collected: number; newEvents: number; error?: string }> {
  if (s.running) return { collected: 0, newEvents: 0, error: '上一轮还在跑，已跳过' };
  s.running = true;
  const now = new Date();
  const nameLabel = s.collector.name;
  try {
    const state = getCollectorState(nameLabel);
    const since = state?.last_success_at ? new Date(state.last_success_at) : null;

    const signals = await s.collector.collect(since);
    const newRows: EventRow[] = [];
    for (const sig of signals) {
      const id = randomUUID();
      const row: EventRow = {
        id,
        source: sig.source,
        source_id: sig.sourceId,
        kind: sig.kind,
        occurred_at: sig.occurredAt,
        title: sig.title ?? null,
        text: sig.text,
        actor: sig.actor ?? null,
        url: sig.url ?? null,
        raw_json: JSON.stringify(sig.raw ?? null),
        content_hash: sig.contentHash,
        processed_at: null,
        created_at: now.toISOString(),
      };
      if (tryInsertEvent(row)) {
        newRows.push(row);
        // MVP2.0: 同步直写一条最小 ContextUnit（kind=event，无 LLM）。
        // 失败不阻塞主链路。
        try {
          insertMinimalEventContextUnit({
            eventId: row.id,
            scope: scopeForSource(row.source),
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
            `[context] failed to insert minimal ContextUnit for event ${row.id}:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }

    upsertCollectorState({
      collector_name: nameLabel,
      last_scan_at: now.toISOString(),
      last_success_at: now.toISOString(),
      last_error: null,
    });
    s.nextRunAt = new Date(Date.now() + s.collector.intervalMs);

    broadcast({
      type: 'collector_status',
      collector: {
        name: nameLabel,
        lastScanAt: now.toISOString(),
        lastSuccessAt: now.toISOString(),
        nextRunAt: s.nextRunAt.toISOString(),
      },
    });

    if (newRows.length) {
      console.log(`[collectors] ${nameLabel}: ${newRows.length} new signal(s)`);
      enqueueEvents(newRows);
    }
    return { collected: signals.length, newEvents: newRows.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[collectors] ${nameLabel} failed:`, msg);
    upsertCollectorState({
      collector_name: nameLabel,
      last_scan_at: now.toISOString(),
      last_success_at: null,
      last_error: msg.slice(0, 500),
    });
    broadcast({
      type: 'collector_status',
      collector: {
        name: nameLabel,
        lastScanAt: now.toISOString(),
        lastError: msg.slice(0, 200),
        nextRunAt: new Date(Date.now() + s.collector.intervalMs).toISOString(),
      },
    });
    return { collected: 0, newEvents: 0, error: msg.slice(0, 200) };
  } finally {
    s.running = false;
  }
}

export function getCollectorSnapshot() {
  return scheduled.map((s) => {
    const st = getCollectorState(s.collector.name);
    return {
      name: s.collector.name,
      lastScanAt: st?.last_scan_at ?? undefined,
      lastSuccessAt: st?.last_success_at ?? undefined,
      lastError: st?.last_error ?? undefined,
      nextRunAt: s.nextRunAt?.toISOString(),
    };
  });
}
