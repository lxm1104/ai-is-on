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

-- ============ MVP2 Context Continuity ============

CREATE TABLE IF NOT EXISTS context_units (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL DEFAULT 'me',
  scope TEXT NOT NULL,

  origin_kind TEXT NOT NULL,
  origin_ref_id TEXT NOT NULL,

  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  meaning TEXT,
  emotion_json TEXT,
  time_json TEXT,
  actionability TEXT NOT NULL DEFAULT 'record',
  confidence REAL NOT NULL DEFAULT 0.7,

  merge_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_json TEXT,

  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_units_merge_key ON context_units(merge_key);
CREATE INDEX IF NOT EXISTS idx_context_units_kind_status ON context_units(kind, status);
CREATE INDEX IF NOT EXISTS idx_context_units_expires_at ON context_units(expires_at);
CREATE INDEX IF NOT EXISTS idx_context_units_origin ON context_units(origin_kind, origin_ref_id);

CREATE TABLE IF NOT EXISTS context_entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT,
  source TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(type, name)
);

CREATE TABLE IF NOT EXISTS context_unit_entities (
  context_unit_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'about',
  confidence REAL NOT NULL DEFAULT 0.7,
  PRIMARY KEY (context_unit_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_cue_unit ON context_unit_entities(context_unit_id);
CREATE INDEX IF NOT EXISTS idx_cue_entity ON context_unit_entities(entity_id);

CREATE TABLE IF NOT EXISTS context_relations (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  context_unit_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  valid_from TEXT,
  valid_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_links (
  id TEXT PRIMARY KEY,
  from_context_id TEXT NOT NULL,
  to_context_id TEXT NOT NULL,
  link_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_links_from ON context_links(from_context_id);
CREATE INDEX IF NOT EXISTS idx_context_links_to ON context_links(to_context_id);

CREATE TABLE IF NOT EXISTS context_feedback (
  id TEXT PRIMARY KEY,
  context_unit_id TEXT,
  card_id TEXT,
  reason TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);

-- ============ MVP3 Triggered Agent Loop ============

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  context_unit_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  due_at TEXT,
  due_at_bucket TEXT,                  -- 用于 idempotency：e.g. dueAt 取整到小时
  reasoning TEXT,                      -- 为什么触发，供 UI 展示
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_status ON triggers(status);
CREATE INDEX IF NOT EXISTS idx_triggers_due_at ON triggers(due_at);
-- idempotency: 同一 (type, context_unit, bucket) 不重复创建 pending trigger
CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_idempotency
  ON triggers(trigger_type, context_unit_id, due_at_bucket)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  trigger_id TEXT,
  agent_type TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_trigger ON agent_runs(trigger_id);

CREATE TABLE IF NOT EXISTS action_proposals (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT,
  proposal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reversible INTEGER NOT NULL DEFAULT 1,
  impact_scope TEXT NOT NULL DEFAULT 'self',
  requires_approval INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT,                   -- 可选附加字段，e.g. priority/source/entities
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_proposals_agent_run ON action_proposals(agent_run_id);
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
// MVP2: cards 多来源（triage / agent_run / manual），保留 triage_id 兼容
ensureColumn('cards', 'source_kind', "TEXT NOT NULL DEFAULT 'triage'");
ensureColumn('cards', 'source_ref_id', 'TEXT');
// MVP2: events 加 context_extracted_at（与 processed_at 解耦）
ensureColumn('events', 'context_extracted_at', 'TEXT');

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
  source_kind: string;                  // 'triage' | 'agent_run' | 'manual'
  source_ref_id: string | null;
  created_at: string;
  updated_at: string;
};

export function insertCard(row: CardRow) {
  db.prepare(
    `INSERT INTO cards
     (id, triage_id, priority, source, title, summary, reason, suggested_action, draft_reply, status,
      actions_json, raw_event_id, source_url, source_kind, source_ref_id, created_at, updated_at)
     VALUES (@id, @triage_id, @priority, @source, @title, @summary, @reason, @suggested_action, @draft_reply, @status,
             @actions_json, @raw_event_id, @source_url, @source_kind, @source_ref_id, @created_at, @updated_at)`
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

export function markEventContextExtracted(id: string, at: string) {
  db.prepare(`UPDATE events SET context_extracted_at = ? WHERE id = ?`).run(at, id);
}

// -------- context_units --------

export type ContextUnitRow = {
  id: string;
  subject_id: string;
  scope: string;
  origin_kind: string;
  origin_ref_id: string;
  kind: string;
  title: string;
  content: string;
  meaning: string | null;
  emotion_json: string | null;
  time_json: string | null;
  actionability: string;
  confidence: number;
  merge_key: string | null;
  version: number;
  supersedes_json: string | null;
  expires_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export function insertContextUnit(row: ContextUnitRow) {
  db.prepare(
    `INSERT INTO context_units
     (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
      meaning, emotion_json, time_json, actionability, confidence,
      merge_key, version, supersedes_json, expires_at, status, created_at, updated_at)
     VALUES (@id, @subject_id, @scope, @origin_kind, @origin_ref_id, @kind, @title, @content,
             @meaning, @emotion_json, @time_json, @actionability, @confidence,
             @merge_key, @version, @supersedes_json, @expires_at, @status, @created_at, @updated_at)`
  ).run(row);
}

export function updateContextUnit(row: ContextUnitRow) {
  db.prepare(
    `UPDATE context_units SET
       subject_id=@subject_id, scope=@scope, origin_kind=@origin_kind, origin_ref_id=@origin_ref_id,
       kind=@kind, title=@title, content=@content, meaning=@meaning,
       emotion_json=@emotion_json, time_json=@time_json, actionability=@actionability,
       confidence=@confidence, merge_key=@merge_key, version=@version,
       supersedes_json=@supersedes_json, expires_at=@expires_at, status=@status, updated_at=@updated_at
     WHERE id=@id`
  ).run(row);
}

export function getContextUnit(id: string): ContextUnitRow | null {
  return (
    (db.prepare(`SELECT * FROM context_units WHERE id = ?`).get(id) as
      | ContextUnitRow
      | undefined) ?? null
  );
}

export function getActiveContextUnitByOrigin(
  originKind: string,
  originRefId: string
): ContextUnitRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM context_units
         WHERE origin_kind = ? AND origin_ref_id = ? AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(originKind, originRefId) as ContextUnitRow | undefined) ?? null
  );
}

export function getActiveContextUnitByMergeKey(mergeKey: string): ContextUnitRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM context_units WHERE merge_key = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
      )
      .get(mergeKey) as ContextUnitRow | undefined) ?? null
  );
}

export function listContextUnits(opts: {
  limit?: number;
  kind?: string;
  originKind?: string;
  actionability?: string;
  status?: string;
  includeExpired?: boolean;
} = {}): ContextUnitRow[] {
  const limit = opts.limit ?? 100;
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (opts.kind) {
    where.push('kind = @kind');
    params.kind = opts.kind;
  }
  if (opts.originKind) {
    where.push('origin_kind = @origin_kind');
    params.origin_kind = opts.originKind;
  }
  if (opts.actionability) {
    where.push('actionability = @actionability');
    params.actionability = opts.actionability;
  }
  if (opts.status) {
    where.push('status = @status');
    params.status = opts.status;
  } else {
    where.push("status = 'active'");
  }
  if (!opts.includeExpired) {
    where.push('(expires_at IS NULL OR expires_at > @now)');
    params.now = new Date().toISOString();
  }
  const sql = `SELECT * FROM context_units${where.length ? ' WHERE ' + where.join(' AND ') : ''}
               ORDER BY updated_at DESC LIMIT @limit`;
  return db.prepare(sql).all(params) as ContextUnitRow[];
}

// -------- context_entities --------

export type ContextEntityRow = {
  id: string;
  type: string;
  name: string;
  aliases_json: string | null;
  source: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
};

export function insertContextEntity(row: ContextEntityRow) {
  db.prepare(
    `INSERT INTO context_entities
     (id, type, name, aliases_json, source, confidence, created_at, updated_at)
     VALUES (@id, @type, @name, @aliases_json, @source, @confidence, @created_at, @updated_at)`
  ).run(row);
}

export function getContextEntityByTypeName(type: string, name: string): ContextEntityRow | null {
  return (
    (db
      .prepare(`SELECT * FROM context_entities WHERE type = ? AND name = ?`)
      .get(type, name) as ContextEntityRow | undefined) ?? null
  );
}

export function listContextEntities(limit = 200): ContextEntityRow[] {
  return db
    .prepare(`SELECT * FROM context_entities ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as ContextEntityRow[];
}

// -------- context_unit_entities --------

export type ContextUnitEntityRow = {
  context_unit_id: string;
  entity_id: string;
  role: string;
  confidence: number;
};

export function linkUnitEntity(row: ContextUnitEntityRow) {
  db.prepare(
    `INSERT OR REPLACE INTO context_unit_entities
     (context_unit_id, entity_id, role, confidence)
     VALUES (@context_unit_id, @entity_id, @role, @confidence)`
  ).run(row);
}

export function listEntitiesForUnit(contextUnitId: string): ContextUnitEntityRow[] {
  return db
    .prepare(`SELECT * FROM context_unit_entities WHERE context_unit_id = ?`)
    .all(contextUnitId) as ContextUnitEntityRow[];
}

// -------- context_relations --------

export type ContextRelationRow = {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  context_unit_id: string | null;
  confidence: number;
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
};

export function insertContextRelation(row: ContextRelationRow) {
  db.prepare(
    `INSERT INTO context_relations
     (id, from_entity_id, to_entity_id, relation_type, context_unit_id, confidence,
      valid_from, valid_until, created_at, updated_at)
     VALUES (@id, @from_entity_id, @to_entity_id, @relation_type, @context_unit_id, @confidence,
             @valid_from, @valid_until, @created_at, @updated_at)`
  ).run(row);
}

export function listContextRelations(limit = 200): ContextRelationRow[] {
  return db
    .prepare(`SELECT * FROM context_relations ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as ContextRelationRow[];
}

// -------- context_links --------

export type ContextLinkRow = {
  id: string;
  from_context_id: string;
  to_context_id: string;
  link_type: string;
  confidence: number;
  created_at: string;
};

export function insertContextLink(row: ContextLinkRow) {
  db.prepare(
    `INSERT INTO context_links (id, from_context_id, to_context_id, link_type, confidence, created_at)
     VALUES (@id, @from_context_id, @to_context_id, @link_type, @confidence, @created_at)`
  ).run(row);
}

export function listContextLinksFor(contextUnitId: string): ContextLinkRow[] {
  return db
    .prepare(
      `SELECT * FROM context_links WHERE from_context_id = ? OR to_context_id = ?
       ORDER BY created_at DESC`
    )
    .all(contextUnitId, contextUnitId) as ContextLinkRow[];
}

// -------- context_feedback --------

export type ContextFeedbackRow = {
  id: string;
  context_unit_id: string | null;
  card_id: string | null;
  reason: string;
  comment: string | null;
  created_at: string;
};

export function insertContextFeedback(row: ContextFeedbackRow) {
  db.prepare(
    `INSERT INTO context_feedback (id, context_unit_id, card_id, reason, comment, created_at)
     VALUES (@id, @context_unit_id, @card_id, @reason, @comment, @created_at)`
  ).run(row);
}

export function listContextFeedback(limit = 100): ContextFeedbackRow[] {
  return db
    .prepare(`SELECT * FROM context_feedback ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as ContextFeedbackRow[];
}

// -------- triggers --------

export type TriggerRow = {
  id: string;
  trigger_type: string;
  context_unit_id: string | null;
  payload_json: string;
  status: string;
  due_at: string | null;
  due_at_bucket: string | null;
  reasoning: string | null;
  created_at: string;
  updated_at: string;
};

/** Insert; if idempotency clash (same type/unit/bucket pending), returns null. */
export function tryInsertTrigger(row: TriggerRow): boolean {
  try {
    db.prepare(
      `INSERT INTO triggers
       (id, trigger_type, context_unit_id, payload_json, status, due_at, due_at_bucket, reasoning, created_at, updated_at)
       VALUES (@id, @trigger_type, @context_unit_id, @payload_json, @status, @due_at, @due_at_bucket, @reasoning, @created_at, @updated_at)`
    ).run(row);
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return false;
    throw err;
  }
}

export function getTrigger(id: string): TriggerRow | null {
  return (
    (db.prepare(`SELECT * FROM triggers WHERE id = ?`).get(id) as TriggerRow | undefined) ?? null
  );
}

export function updateTriggerStatus(id: string, status: string, updatedAt: string) {
  db.prepare(`UPDATE triggers SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    updatedAt,
    id
  );
}

export function listTriggers(opts: { status?: string; limit?: number } = {}): TriggerRow[] {
  const limit = opts.limit ?? 100;
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (opts.status) {
    where.push('status = @status');
    params.status = opts.status;
  }
  const sql = `SELECT * FROM triggers${where.length ? ' WHERE ' + where.join(' AND ') : ''}
               ORDER BY due_at IS NULL, due_at ASC, created_at DESC LIMIT @limit`;
  return db.prepare(sql).all(params) as TriggerRow[];
}

export function listDueTriggers(now: string): TriggerRow[] {
  return db
    .prepare(
      `SELECT * FROM triggers
       WHERE status = 'pending' AND (due_at IS NULL OR due_at <= ?)
       ORDER BY due_at IS NULL, due_at ASC`
    )
    .all(now) as TriggerRow[];
}

// -------- agent_runs --------

export type AgentRunRow = {
  id: string;
  trigger_id: string | null;
  agent_type: string;
  input_json: string;
  output_json: string | null;
  status: string;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

export function insertAgentRun(row: AgentRunRow) {
  db.prepare(
    `INSERT INTO agent_runs
     (id, trigger_id, agent_type, input_json, output_json, status, error, started_at, completed_at, created_at)
     VALUES (@id, @trigger_id, @agent_type, @input_json, @output_json, @status, @error, @started_at, @completed_at, @created_at)`
  ).run(row);
}

export function updateAgentRun(
  id: string,
  patch: Partial<Pick<AgentRunRow, 'status' | 'output_json' | 'error' | 'started_at' | 'completed_at'>>
) {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function getAgentRun(id: string): AgentRunRow | null {
  return (
    (db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as AgentRunRow | undefined) ??
    null
  );
}

export function listAgentRuns(limit = 100): AgentRunRow[] {
  return db
    .prepare(`SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as AgentRunRow[];
}

// -------- action_proposals --------

export type ActionProposalRow = {
  id: string;
  agent_run_id: string | null;
  proposal_type: string;
  title: string;
  body: string;
  reversible: number;
  impact_scope: string;
  requires_approval: number;
  status: string;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
};

export function insertActionProposal(row: ActionProposalRow) {
  db.prepare(
    `INSERT INTO action_proposals
     (id, agent_run_id, proposal_type, title, body, reversible, impact_scope, requires_approval,
      status, payload_json, created_at, updated_at)
     VALUES (@id, @agent_run_id, @proposal_type, @title, @body, @reversible, @impact_scope, @requires_approval,
             @status, @payload_json, @created_at, @updated_at)`
  ).run(row);
}

export function getActionProposal(id: string): ActionProposalRow | null {
  return (
    (db
      .prepare(`SELECT * FROM action_proposals WHERE id = ?`)
      .get(id) as ActionProposalRow | undefined) ?? null
  );
}

export function listActionProposals(limit = 100): ActionProposalRow[] {
  return db
    .prepare(`SELECT * FROM action_proposals ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as ActionProposalRow[];
}
