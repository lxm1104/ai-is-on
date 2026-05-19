import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });

export const db = new Database(config.sqlitePath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS runtime_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  actor TEXT,
  url TEXT,
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source, source_id, content_hash)
);

CREATE TABLE IF NOT EXISTS triage_results (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  priority TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggested_action TEXT,
  draft_reply TEXT,
  confidence REAL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  triage_id TEXT,
  priority TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggested_action TEXT,
  draft_reply TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  actions_json TEXT NOT NULL DEFAULT '[]',
  raw_event_id TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(triage_id) REFERENCES triage_results(id)
);

CREATE TABLE IF NOT EXISTS user_rules (
  id TEXT PRIMARY KEY,
  rule_type TEXT NOT NULL,
  description TEXT NOT NULL,
  source_card_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collector_state (
  collector_name TEXT PRIMARY KEY,
  last_scan_at TEXT,
  last_success_at TEXT,
  last_error TEXT
);
`);

// Forward-compat: add columns that may be missing in databases created by an earlier MVP0 boot.
function ensureColumn(table: string, column: string, ddl: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((r) => r.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn('cards', 'actions_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('cards', 'raw_event_id', 'TEXT');
ensureColumn('cards', 'source_url', 'TEXT');

export type RuntimeMessageRow = {
  id: string;
  role: string;
  text: string;
  raw_json: string | null;
  created_at: string;
};

export function insertRuntimeMessage(row: RuntimeMessageRow) {
  db.prepare(
    `INSERT INTO runtime_messages (id, role, text, raw_json, created_at)
     VALUES (@id, @role, @text, @raw_json, @created_at)`
  ).run(row);
}

export function listRuntimeMessages(limit = 200): RuntimeMessageRow[] {
  return db
    .prepare(
      `SELECT id, role, text, raw_json, created_at
       FROM runtime_messages
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(limit) as RuntimeMessageRow[];
}

// -------- events --------

export type EventRow = {
  id: string;
  source: string;
  source_id: string;
  kind: string;
  occurred_at: string;
  title: string | null;
  text: string;
  actor: string | null;
  url: string | null;
  raw_json: string;
  content_hash: string;
  processed_at: string | null;
  created_at: string;
};

/** Returns true if newly inserted. False = duplicate (no-op). */
export function tryInsertEvent(row: EventRow): boolean {
  try {
    db.prepare(
      `INSERT INTO events
       (id, source, source_id, kind, occurred_at, title, text, actor, url, raw_json, content_hash, processed_at, created_at)
       VALUES (@id, @source, @source_id, @kind, @occurred_at, @title, @text, @actor, @url, @raw_json, @content_hash, @processed_at, @created_at)`
    ).run(row);
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint/i.test(err.message)) return false;
    throw err;
  }
}

export function markEventProcessed(id: string, processedAt: string) {
  db.prepare(`UPDATE events SET processed_at = ? WHERE id = ?`).run(processedAt, id);
}

export function listEvents(limit = 50): EventRow[] {
  return db
    .prepare(
      `SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?`
    )
    .all(limit) as EventRow[];
}

// -------- triage results --------

export type TriageResultRow = {
  id: string;
  event_id: string;
  priority: string;
  title: string;
  summary: string;
  reason: string;
  suggested_action: string | null;
  draft_reply: string | null;
  confidence: number | null;
  raw_json: string;
  created_at: string;
};

export function insertTriageResult(row: TriageResultRow) {
  db.prepare(
    `INSERT INTO triage_results
     (id, event_id, priority, title, summary, reason, suggested_action, draft_reply, confidence, raw_json, created_at)
     VALUES (@id, @event_id, @priority, @title, @summary, @reason, @suggested_action, @draft_reply, @confidence, @raw_json, @created_at)`
  ).run(row);
}

export function listTriageResults(limit = 50): TriageResultRow[] {
  return db
    .prepare(`SELECT * FROM triage_results ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as TriageResultRow[];
}

// -------- cards --------

export type CardRow = {
  id: string;
  triage_id: string | null;
  priority: string;
  source: string;
  title: string;
  summary: string;
  reason: string;
  suggested_action: string | null;
  draft_reply: string | null;
  status: string;
  actions_json: string;
  raw_event_id: string | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
};

export function insertCard(row: CardRow) {
  db.prepare(
    `INSERT INTO cards
     (id, triage_id, priority, source, title, summary, reason, suggested_action, draft_reply, status,
      actions_json, raw_event_id, source_url, created_at, updated_at)
     VALUES (@id, @triage_id, @priority, @source, @title, @summary, @reason, @suggested_action, @draft_reply, @status,
             @actions_json, @raw_event_id, @source_url, @created_at, @updated_at)`
  ).run(row);
}

export function updateCardStatus(id: string, status: string, updatedAt: string): CardRow | null {
  db.prepare(`UPDATE cards SET status = ?, updated_at = ? WHERE id = ?`).run(status, updatedAt, id);
  return getCard(id);
}

export function getCard(id: string): CardRow | null {
  return (
    (db.prepare(`SELECT * FROM cards WHERE id = ?`).get(id) as CardRow | undefined) ?? null
  );
}

export function listOpenCards(limit = 100): CardRow[] {
  return db
    .prepare(
      `SELECT * FROM cards WHERE status NOT IN ('dismissed','done')
       ORDER BY
         CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
         created_at DESC
       LIMIT ?`
    )
    .all(limit) as CardRow[];
}

// -------- user rules --------

export type UserRuleRow = {
  id: string;
  rule_type: string;
  description: string;
  source_card_id: string | null;
  active: number;
  created_at: string;
};

export function insertUserRule(row: UserRuleRow) {
  db.prepare(
    `INSERT INTO user_rules (id, rule_type, description, source_card_id, active, created_at)
     VALUES (@id, @rule_type, @description, @source_card_id, @active, @created_at)`
  ).run(row);
}

export function listActiveUserRules(): UserRuleRow[] {
  return db
    .prepare(`SELECT * FROM user_rules WHERE active = 1 ORDER BY created_at DESC`)
    .all() as UserRuleRow[];
}

// -------- collector state --------

export type CollectorStateRow = {
  collector_name: string;
  last_scan_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
};

export function upsertCollectorState(row: CollectorStateRow) {
  db.prepare(
    `INSERT INTO collector_state (collector_name, last_scan_at, last_success_at, last_error)
     VALUES (@collector_name, @last_scan_at, @last_success_at, @last_error)
     ON CONFLICT(collector_name) DO UPDATE SET
       last_scan_at = excluded.last_scan_at,
       last_success_at = COALESCE(excluded.last_success_at, collector_state.last_success_at),
       last_error = excluded.last_error`
  ).run(row);
}

export function getCollectorState(name: string): CollectorStateRow | null {
  return (
    (db.prepare(`SELECT * FROM collector_state WHERE collector_name = ?`).get(name) as
      | CollectorStateRow
      | undefined) ?? null
  );
}
