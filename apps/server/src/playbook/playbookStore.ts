/**
 * MVP37 — task_traces / task_playbooks 存取。
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import type { TaskTrace, TaskPlaybook, TraceStep, PlaybookStep, PlaybookTier } from './PlaybookTypes.js';

type TraceRow = {
  id: string;
  task_type_key: string;
  matter_id: string | null;
  source: string;
  title: string;
  steps_json: string;
  outcome: string | null;
  created_at: string;
};

function rowToTrace(r: TraceRow): TaskTrace {
  let steps: TraceStep[] = [];
  try {
    steps = JSON.parse(r.steps_json) as TraceStep[];
  } catch {}
  return {
    id: r.id,
    taskTypeKey: r.task_type_key,
    matterId: r.matter_id,
    source: r.source as TaskTrace['source'],
    title: r.title,
    steps,
    outcome: r.outcome,
    createdAt: r.created_at,
  };
}

export function insertTaskTrace(input: {
  taskTypeKey: string;
  matterId?: string | null;
  source: TaskTrace['source'];
  title: string;
  steps: TraceStep[];
  outcome?: string | null;
  now?: string;
}): TaskTrace {
  const row: TraceRow = {
    id: randomUUID(),
    task_type_key: input.taskTypeKey,
    matter_id: input.matterId ?? null,
    source: input.source,
    title: input.title.slice(0, 200),
    steps_json: JSON.stringify(input.steps),
    outcome: input.outcome ?? null,
    created_at: input.now ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO task_traces (id, task_type_key, matter_id, source, title, steps_json, outcome, created_at)
     VALUES (@id, @task_type_key, @matter_id, @source, @title, @steps_json, @outcome, @created_at)`
  ).run(row);
  return rowToTrace(row);
}

export function listTracesByType(taskTypeKey: string, limit = 20): TaskTrace[] {
  return (
    db
      .prepare(`SELECT * FROM task_traces WHERE task_type_key = ? ORDER BY created_at DESC LIMIT ?`)
      .all(taskTypeKey, limit) as TraceRow[]
  ).map(rowToTrace);
}

export function countTracesByType(taskTypeKey: string): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM task_traces WHERE task_type_key = ?`)
    .get(taskTypeKey) as { n: number };
  return r.n;
}

// ---- playbooks ----

type PlaybookRow = {
  id: string;
  task_type_key: string;
  title: string;
  steps_json: string;
  tier: string;
  trace_count: number;
  success_count: number;
  correction_count: number;
  confidence: number;
  active: number;
  created_at: string;
  updated_at: string;
};

function rowToPlaybook(r: PlaybookRow): TaskPlaybook {
  let steps: PlaybookStep[] = [];
  try {
    steps = JSON.parse(r.steps_json) as PlaybookStep[];
  } catch {}
  return {
    id: r.id,
    taskTypeKey: r.task_type_key,
    title: r.title,
    steps,
    tier: r.tier as PlaybookTier,
    traceCount: r.trace_count,
    successCount: r.success_count,
    correctionCount: r.correction_count,
    confidence: r.confidence,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getPlaybookByType(taskTypeKey: string): TaskPlaybook | null {
  const r = db
    .prepare(`SELECT * FROM task_playbooks WHERE task_type_key = ?`)
    .get(taskTypeKey) as PlaybookRow | undefined;
  return r ? rowToPlaybook(r) : null;
}

export function listPlaybooks(opts: { activeOnly?: boolean } = {}): TaskPlaybook[] {
  const sql = opts.activeOnly
    ? `SELECT * FROM task_playbooks WHERE active = 1 ORDER BY updated_at DESC`
    : `SELECT * FROM task_playbooks ORDER BY updated_at DESC`;
  return (db.prepare(sql).all() as PlaybookRow[]).map(rowToPlaybook);
}

/** 按 taskTypeKey upsert（蒸馏出新版流程时覆盖 steps + 刷新计数）。 */
export function upsertPlaybook(input: {
  taskTypeKey: string;
  title: string;
  steps: PlaybookStep[];
  tier?: PlaybookTier;
  traceCount: number;
  confidence: number;
  now?: string;
}): TaskPlaybook {
  const now = input.now ?? new Date().toISOString();
  const existing = getPlaybookByType(input.taskTypeKey);
  if (existing) {
    db.prepare(
      `UPDATE task_playbooks SET title=@title, steps_json=@steps_json, trace_count=@trace_count,
         confidence=@confidence, updated_at=@updated_at WHERE task_type_key=@task_type_key`
    ).run({
      task_type_key: input.taskTypeKey,
      title: input.title.slice(0, 200),
      steps_json: JSON.stringify(input.steps),
      trace_count: input.traceCount,
      confidence: input.confidence,
      updated_at: now,
    });
    return getPlaybookByType(input.taskTypeKey)!;
  }
  const row: PlaybookRow = {
    id: randomUUID(),
    task_type_key: input.taskTypeKey,
    title: input.title.slice(0, 200),
    steps_json: JSON.stringify(input.steps),
    tier: input.tier ?? 'suggest',
    trace_count: input.traceCount,
    success_count: 0,
    correction_count: 0,
    confidence: input.confidence,
    active: 1,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO task_playbooks
       (id, task_type_key, title, steps_json, tier, trace_count, success_count, correction_count, confidence, active, created_at, updated_at)
     VALUES (@id, @task_type_key, @title, @steps_json, @tier, @trace_count, @success_count, @correction_count, @confidence, @active, @created_at, @updated_at)`
  ).run(row);
  return rowToPlaybook(row);
}
