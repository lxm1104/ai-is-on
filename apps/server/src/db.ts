import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });

export const db = new Database(config.sqlitePath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS runtime_messages (
  id TEXT PRIMARY KEY,
  topic_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'manual',
  source_ref_id TEXT,
  opencode_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_topics_status_updated ON chat_topics(status, updated_at);

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
-- idempotency: 同一 (type, context_unit, bucket) 整个生命周期只触发一次。
-- 不区分 pending/done/failed —— pull worker 每 60s 跑一次，如果只挡 pending，
-- 已 done 的 commitment 会被反复重新触发，刷屏卡片。
CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_idempotency
  ON triggers(trigger_type, context_unit_id, due_at_bucket);

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

-- ============ MVP4 Personal Life + Caring ============

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============ MVP5 Team Context Sync ============

CREATE TABLE IF NOT EXISTS context_spaces (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                    -- 'project' | 'topic'  (relationship/personal_goal 留 MVP5.x)
  name TEXT NOT NULL,
  description TEXT,
  owner_subject_id TEXT NOT NULL DEFAULT 'me',
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'archived'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(type, name)
);

-- 把 entity / ContextUnit 关联到一个 Space
CREATE TABLE IF NOT EXISTS context_space_links (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  target_type TEXT NOT NULL,             -- 'entity' | 'context_unit'
  target_id TEXT NOT NULL,
  link_type TEXT NOT NULL,               -- 'about' | 'follows' | 'owns' | ...
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL,
  UNIQUE(space_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_csl_space ON context_space_links(space_id);
CREATE INDEX IF NOT EXISTS idx_csl_target ON context_space_links(target_type, target_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_context_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_space ON decisions(space_id);

-- ============ MVP6 Boundary Learning + Limited Autonomy ============

CREATE TABLE IF NOT EXISTS boundary_rules (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'work',          -- 'personal' | 'work' | 'team'
  condition_json TEXT NOT NULL,                -- structured BoundaryCondition (see §8.2)
  allowed_action TEXT NOT NULL,                -- 'record' | 'notify' | 'draft' | 'execute_reversible'
  requires_approval INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.7,
  learned_from_card_id TEXT,
  source TEXT NOT NULL,                        -- 'user_rule_migration' | 'card_action' | 'manual'
  migrated INTEGER NOT NULL DEFAULT 0,         -- true → unstructured, awaiting human review
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_boundary_rules_active ON boundary_rules(active);
CREATE INDEX IF NOT EXISTS idx_boundary_rules_source ON boundary_rules(source);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT,
  card_id TEXT,
  rule_id TEXT,
  action TEXT NOT NULL,                        -- 'card_blocked' | 'card_softened' | 'rule_learned' | 'auto_resolved' | ...
  reason TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_rule ON audit_logs(rule_id);

-- ============ MVP10 Feedback Correction + Entity Alias ============

-- 仅记录"X 被合并到 Y"的有向引用；不动 context_entities 主表。
-- 运行时 resolveAliased(id) 透传到 alias_of 的终态。
CREATE TABLE IF NOT EXISTS entity_aliases (
  id TEXT PRIMARY KEY,                 -- 被合并掉的 entity_id
  alias_of TEXT NOT NULL,              -- 合并后保留的 entity_id (target)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_target ON entity_aliases(alias_of);

-- 每条用户纠错的 forward / inverse patch 写在这里，配合 audit_logs 做可撤销。
CREATE TABLE IF NOT EXISTS correction_journal (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,                 -- card 触发；保留与 context_feedback.id 关联
  correction_type TEXT NOT NULL,             -- wrong_priority | wrong_entity | wrong_kind | ...
  target_kind TEXT NOT NULL,                 -- context_unit | boundary_rule | entity_alias
  target_id TEXT NOT NULL,
  forward_patch_json TEXT NOT NULL,
  inverse_patch_json TEXT,                   -- NULL = 不可无损撤销
  inverse_lossy INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL,
  reverted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_correction_journal_feedback ON correction_journal(feedback_id);
CREATE INDEX IF NOT EXISTS idx_correction_journal_target ON correction_journal(target_kind, target_id);

-- ============ MVP12 Source / Semantic routing ============

-- unit→source events 多对一：upsertContextUnit 时记录「这条 unit 是哪些 event 喂出来的」，
-- 让 mergeKey 合并多个 event 后仍能枚举所有源 event 的 routing entities。
CREATE TABLE IF NOT EXISTS unit_sources (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(unit_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_unit_sources_unit ON unit_sources(unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_sources_event ON unit_sources(event_id);

-- materialized routing cache：resolver hot path 直接读这里，避免回查 event unit。
-- 每行 = (unit_id, source_event_id) → 这个 event 上抽出来的 routing entities (chat / doc / app)。
CREATE TABLE IF NOT EXISTS unit_routing_cache (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  routing_entities_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(unit_id, source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_unit_routing_unit ON unit_routing_cache(unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_routing_event ON unit_routing_cache(source_event_id);

-- Phase 2 chat_affinity / person_co_occur / doc_overlap 等学习建议；schema 先建好，
-- 本期 (Phase 1) 不写入。
CREATE TABLE IF NOT EXISTS context_space_suggestions (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  suggestion_type TEXT NOT NULL,
  score REAL NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'suggested',
  cooldown_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(target_type, target_id, space_id, suggestion_type)
);
CREATE INDEX IF NOT EXISTS idx_css_space ON context_space_suggestions(space_id);
CREATE INDEX IF NOT EXISTS idx_css_status ON context_space_suggestions(status);

-- ============ MVP26 Matter 事务状态层 ============
-- Context 是证据层，Matter 是持续状态层。一条 Matter 把同一件正在进行的事的
-- 多条 ContextUnit 收拢成一等实体，回答「这件事现在推进到哪了」。
-- 详见 docs/MVP26-MVP29-Matter事务状态层技术方案.md §4-§5。
--
-- 约束：不复用 context_units.status（那是记录可见性 active/archived/superseded）；
-- Matter 生命周期放在 matters.status。Matter 不存大段原文，只存摘要 + evidence 的
-- context_unit_id，原文回查 events / context_units。

CREATE TABLE IF NOT EXISTS matters (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL DEFAULT 'me',
  scope TEXT NOT NULL,

  type TEXT NOT NULL,
  title TEXT NOT NULL,
  canonical_key TEXT NOT NULL,           -- 候选召回 + 幂等提示，非 DB 硬唯一约束（见 §5.1）

  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'P2',

  owner_entity_id TEXT,
  primary_space_id TEXT,
  due_at TEXT,

  current_summary TEXT NOT NULL DEFAULT '',
  next_action TEXT,

  created_from_context_unit_id TEXT NOT NULL,
  last_evidence_context_unit_id TEXT,
  last_evidence_at TEXT,

  confidence REAL NOT NULL DEFAULT 0.7,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  dropped_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_matters_status_updated ON matters(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_matters_canonical_key ON matters(canonical_key);
CREATE INDEX IF NOT EXISTS idx_matters_due_at ON matters(due_at);
CREATE INDEX IF NOT EXISTS idx_matters_created_from ON matters(created_from_context_unit_id);

CREATE TABLE IF NOT EXISTS matter_entities (
  matter_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'about',
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL,
  PRIMARY KEY (matter_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_matter_entities_matter ON matter_entities(matter_id);
CREATE INDEX IF NOT EXISTS idx_matter_entities_entity ON matter_entities(entity_id);

CREATE TABLE IF NOT EXISTS matter_context_links (
  matter_id TEXT NOT NULL,
  context_unit_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  effect TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (matter_id, context_unit_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_mcl_matter ON matter_context_links(matter_id);
CREATE INDEX IF NOT EXISTS idx_mcl_context ON matter_context_links(context_unit_id);

CREATE TABLE IF NOT EXISTS matter_transitions (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  trigger_context_unit_id TEXT NOT NULL,
  effect TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matter_transitions_matter ON matter_transitions(matter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_matter_transitions_context ON matter_transitions(trigger_context_unit_id);

-- MVP29 §5.5：Triage 直出的 MatterObservation（"这条 event 看起来在创建/推进/完成/阻塞某事项"）。
-- Reducer 可优先消费它降低 LLM 调用；也作为审计。即便该 event 没有新 contextUpdate 也会落。
CREATE TABLE IF NOT EXISTS matter_observations (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  context_unit_ids_json TEXT NOT NULL DEFAULT '[]',
  observation_type TEXT NOT NULL,
  matter_type TEXT NOT NULL,
  title TEXT NOT NULL,
  lifecycle_effect TEXT,
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  candidate_matter_ids_json TEXT NOT NULL DEFAULT '[]',
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matter_observations_event ON matter_observations(source_event_id);
CREATE INDEX IF NOT EXISTS idx_matter_observations_type ON matter_observations(observation_type);
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
// MVP14 Step 3: 老 triage→cards 流水线下线后，旧 cards 行降为归档（暂不删表，便于回溯）
ensureColumn('cards', 'archived_at', 'TEXT');
// triage 失败可见化：失败批次重试一次后才销账，并留下 triage_failed_at 痕迹（不再静默丢弃）。
ensureColumn('events', 'triage_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('events', 'triage_failed_at', 'TEXT');
// Topic 化聊天：老库 runtime_messages 没有 topic_id，保留为空，前端只展示选中 topic 的消息。
ensureColumn('runtime_messages', 'topic_id', 'TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS idx_runtime_messages_topic ON runtime_messages(topic_id, created_at)`);
const legacyRuntimeMessages = db
  .prepare(`SELECT COUNT(*) AS count FROM runtime_messages WHERE topic_id IS NULL`)
  .get() as { count: number };
if (legacyRuntimeMessages.count > 0) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO chat_topics
     (id, title, source_kind, source_ref_id, opencode_session_id, status, created_at, updated_at, last_message_at)
     VALUES ('legacy-global-chat', '历史会话', 'legacy', NULL, NULL, 'active', ?, ?, ?)`
  ).run(now, now, now);
  db.prepare(`UPDATE runtime_messages SET topic_id = 'legacy-global-chat' WHERE topic_id IS NULL`).run();
}
// MVP2: events 加 context_extracted_at（与 processed_at 解耦）
ensureColumn('events', 'context_extracted_at', 'TEXT');

// MVP32: 办结核实结果（MatterResolveVerification JSON）。注意：updateMatter/insertMatter 的
// 命名参数列集不含此列（better-sqlite3 对多余 key 抛错），读走 SELECT *，写走专用 UPDATE。
ensureColumn('matters', 'resolve_verification_json', 'TEXT');

// MVP33 U1: collector 覆盖水位（coverage watermark）。游标只推进到「已完整覆盖」的时间点，
// 截断/上限命中时水位停在被截处，下轮续扫——停摆/洪峰后不再静默永久丢数据。
// last_success_at 回归"活性"语义（最近一次成功扫描的墙钟时间），covered_until 表达覆盖进度。
ensureColumn('collector_state', 'covered_until', 'TEXT');
// MVP33 U2: matter_observations 消费标记。带 lifecycle_effect 的观察经召回+判定落到 Matter
// 状态机后在此销账；NULL = 未消费（启动补扫的依据）。consume_result 记录结论（审计）。
ensureColumn('matter_observations', 'consumed_at', 'TEXT');
ensureColumn('matter_observations', 'consume_result', 'TEXT');

// MVP7: boundary_rules 加 condition_hash 做幂等。结构化字段稳定 JSON → sha1。
// 重跑 bootstrap / 同样的 card_action 学到完全相同的 rule 时只更新 updated_at，不新建行。
ensureColumn('boundary_rules', 'condition_hash', 'TEXT');
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_boundary_rules_condition_hash
   ON boundary_rules(condition_hash) WHERE condition_hash IS NOT NULL`
);

// MVP10.1: 3 级 autonomy 梯度（doc §6.4）。
// - local_auto: 纯本地、可逆、低风险，自动执行（如合并 P3 到 daily_digest）
// - local_with_audit: 本地状态写入或规则学习，必须 audit + journal（默认）
// - external_always_confirm: 对外、共享、不可控副作用，永远确认
ensureColumn('boundary_rules', 'autonomy', "TEXT NOT NULL DEFAULT 'local_with_audit'");
ensureColumn('boundary_rules', 'reversible', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('boundary_rules', 'impact_scope', "TEXT NOT NULL DEFAULT 'self'");

// MVP37 能力二「流程记忆」：操作轨迹（一次任务怎么做的）+ 蒸馏出的 playbook（这类任务标准步骤）。
// task_traces：从真实处理（排查 toolLog / 执行动作）采集的有序步骤，按 task_type_key 归类，是蒸馏原料。
// task_playbooks：同类轨迹蒸馏出的可复用流程；tier=suggest(只建议)/semi_auto/auto（渐进放权，先只 suggest）。
db.exec(`
CREATE TABLE IF NOT EXISTS task_traces (
  id TEXT PRIMARY KEY,
  task_type_key TEXT NOT NULL,
  matter_id TEXT,
  source TEXT NOT NULL,                 -- 'investigation' | 'execution' | 'chat'
  title TEXT NOT NULL,
  steps_json TEXT NOT NULL,             -- TraceStep[]：{order,kind,tool?,summary,params?}
  outcome TEXT,                         -- 结论/结果摘要（如 resolved/progressed/已发送）
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_traces_type ON task_traces(task_type_key, created_at);
CREATE INDEX IF NOT EXISTS idx_task_traces_matter ON task_traces(matter_id);

CREATE TABLE IF NOT EXISTS task_playbooks (
  id TEXT PRIMARY KEY,
  task_type_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  steps_json TEXT NOT NULL,             -- PlaybookStep[]：{order,intent,toolHint?,note}
  tier TEXT NOT NULL DEFAULT 'suggest', -- 'suggest' | 'semi_auto' | 'auto'
  origin TEXT NOT NULL DEFAULT 'distilled', -- 'user'(人写/编辑) | 'distilled'(自发蒸馏)
  approved INTEGER NOT NULL DEFAULT 0,   -- 用户是否已批准（人写默认 1；蒸馏草稿 0）
  trace_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  correction_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.5,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
// task_playbooks 可能在本列加入前就建过表（dev 已重启过）→ ensureColumn 补列。
ensureColumn('task_playbooks', 'origin', "TEXT NOT NULL DEFAULT 'distilled'");
ensureColumn('task_playbooks', 'approved', 'INTEGER NOT NULL DEFAULT 0');

// MVP12: context_space_links 加 reason_json，记录这条 link 的命中路径
// （via='person'|'doc'|'chat_seed' ...）。upsertContextSpaceLinkBestHit cap 5 条 evidence。
ensureColumn('context_space_links', 'reason_json', 'TEXT');

// MVP15 §3.1 / §4: context_entities 加 attributes_json，承载 person 节点的 lark profile
// （larkOpenId / larkDepartmentName / larkIsCrossTenant / larkSyncedAt 等）以及推断的
// orgRoleFromMe。schema 与 parser 见 apps/server/src/context/personAttributes.ts。
// 列长期 nullable —— 仅 person entity 写、其他 type 留 NULL。
ensureColumn('context_entities', 'attributes_json', 'TEXT');

// MVP15 §4 (revision): 部门名 → {business, function} 的解析缓存。表名不带 lark：
// 解析逻辑跟产品/组织无关，将来接入其他 SaaS 通讯录也能复用。
// 一个 unique dept_name 字符串解析一次，永久缓存（部门改名时手动失效）。
db.exec(`
CREATE TABLE IF NOT EXISTS org_department_taxonomy (
  dept_name TEXT PRIMARY KEY,
  business TEXT,                            -- "Lark Base" / "TikTok" / "懂车帝"；不可解析时 NULL
  function_label TEXT,                      -- function_path 的第一段，方便 chip 直接展示
  function_path_json TEXT,                  -- JSON 数组，例 ["Engineering","Infra","Performance"]
  parsed_by TEXT NOT NULL DEFAULT 'llm',    -- 'llm' | 'manual' | 'rule'，预留多源覆盖
  parsed_at TEXT NOT NULL
);
`);

// ============ MVP15A: 图归纳 ============
// 详见 docs/MVP15A-Work-Map-图归纳与协作圈技术方案.md §6。
//
// 1. entity_edges：承载 person↔person / person↔project 两类边
//    （MVP15C 预留 project↔project；schema 已能容纳）。
// 2. work_item_edges：承载 ContextUnit↔ContextUnit 的 follows 边
//    （MVP15B 扩 blocks/depends_on/derived_from）。
// 3. org_project_taxonomy：LLM project entity 去重缓存（仿 dept_taxonomy）。
db.exec(`
CREATE TABLE IF NOT EXISTS entity_edges (
  id TEXT PRIMARY KEY,
  edge_kind TEXT NOT NULL,              -- 'person_person' | 'person_project' | 'project_project'(预留)
  from_id TEXT NOT NULL,                -- canonical entity id（已 resolveAliased）
  to_id TEXT NOT NULL,                  -- canonical entity id；person_person 时强制 from_id < to_id
  role_or_type TEXT,                    -- person_project: 'owner'|'driver'|'reviewer'|'contributor'|'stakeholder'|'observer'
                                        -- person_person: NULL（MVP15A），MVP15B LLM 写 collabType
  weight REAL NOT NULL DEFAULT 0,       -- recency-decayed cooccur count（30d 半衰）
  business_relation TEXT,               -- 仅 person_person：'same_business'|'cross_business'|'external'|'unknown'
  shared_ids_json TEXT,                 -- 仅 person_person：sharedProjectEntityIds[]
  evidence_unit_ids_json TEXT NOT NULL DEFAULT '[]',  -- ≤10 条 unit id，用于 hover 解释
  detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_edges_kind ON entity_edges(edge_kind);
CREATE INDEX IF NOT EXISTS idx_entity_edges_from ON entity_edges(edge_kind, from_id);
CREATE INDEX IF NOT EXISTS idx_entity_edges_to ON entity_edges(edge_kind, to_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_edges
  ON entity_edges(edge_kind, from_id, to_id);

CREATE TABLE IF NOT EXISTS work_item_edges (
  id TEXT PRIMARY KEY,
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  type TEXT NOT NULL,                   -- MVP15A 只写 'follows'；MVP15B 加 'blocks'|'depends_on'|'derived_from'
  status TEXT NOT NULL DEFAULT 'active',-- 'active'|'resolved'|'stale'
  reason TEXT NOT NULL,                 -- ≤200 字解释
  evidence_unit_ids_json TEXT NOT NULL DEFAULT '[]',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_item_edges_from ON work_item_edges(from_unit_id);
CREATE INDEX IF NOT EXISTS idx_work_item_edges_to ON work_item_edges(to_unit_id);
CREATE INDEX IF NOT EXISTS idx_work_item_edges_status ON work_item_edges(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_item_edges
  ON work_item_edges(from_unit_id, to_unit_id, type);

CREATE TABLE IF NOT EXISTS org_project_taxonomy (
  canonical_name TEXT PRIMARY KEY,
  aliases_json TEXT NOT NULL,           -- JSON 数组：包含 canonical_name 自身
  summary TEXT,                         -- LLM 一句话项目摘要，可空
  parsed_by TEXT NOT NULL DEFAULT 'llm',-- 'llm'|'manual'|'rule'
  parsed_at TEXT NOT NULL
);
-- 反向索引粗筛：从 entity 名 → canonical_name，aliases_json 里 LIKE 匹配后应用层精确匹配
CREATE INDEX IF NOT EXISTS idx_org_project_aliases ON org_project_taxonomy(aliases_json);
`);

// ============ MVP19: 项目 canonical 注册表与闭词表抽取 ============
// 详见 docs/MVP19-项目canonical注册表与闭词表抽取技术方案.md §数据模型。
//
// D-1：把 org_project_taxonomy 升级为带 hierarchy 的 canonical 注册表：
//   parent_canonical_name：归属的父 canonical（NULL = 顶层；禁止环，应用层校验）
//   authoritative_space_id：本 canonical 直接对应一个 context_spaces.id（用于 ① ↔ ② 锚点反查）
ensureColumn('org_project_taxonomy', 'parent_canonical_name', 'TEXT');
ensureColumn('org_project_taxonomy', 'authoritative_space_id', 'TEXT');
db.exec(`
CREATE INDEX IF NOT EXISTS idx_opt_parent
  ON org_project_taxonomy(parent_canonical_name);

-- E-1：triage LLM 抽到的项目名不在 knownProjects 列表里时，进 pending 队列等审核。
-- 同一 proposed_name 在 pending 状态下只能存在一行（partial unique index）；重复触发只
-- bump occurrences + last_seen_at + 累加 source_unit_ids。reject 后再次同名可重新进 pending
-- （pending 行已被 status 排除出 partial index，不会冲突）。
CREATE TABLE IF NOT EXISTS project_canonical_proposals (
  id TEXT PRIMARY KEY,
  proposed_name TEXT NOT NULL,         -- LLM 原文抽出来的项目字符串
  source_unit_ids_json TEXT NOT NULL,  -- JSON 数组：triage 出处 unit id（保留近 20 条）
  source_event_id TEXT,                -- 触发 triage 的 raw event id，可选
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'approved_new' | 'approved_alias' | 'rejected'
  resolved_canonical_name TEXT,        -- approved 时填：归到哪个 canonical
  resolved_as_parent_canonical TEXT,   -- approved_new 时可选：直接指定 parent
  resolved_by TEXT,
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pcp_proposed_pending
  ON project_canonical_proposals(proposed_name)
  WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_pcp_status_lastseen
  ON project_canonical_proposals(status, last_seen_at DESC);
`);

// MVP19 boot migration（一次性，幂等可重复启动）。
// Step 2：扫所有现存 context_spaces（type='project'），同步到 org_project_taxonomy。
// Step 3：把已知 Chatbot 业务线下的 7 个子 canonical 挂到 'Chatbot 产研协同'。
// 两步都尽量惰性：Step 2 通过 INSERT/UPDATE 分支实现 idempotent；
// Step 3 用 WHERE parent IS NULL 守卫，避免覆盖用户已设置的 parent。
//
// 直接 inline SQL 而非调用 contextSpaceService.syncSpaceToProjectTaxonomy，
// 是为了避免 db.ts ← contextSpaceService.ts 循环导入；语义保持一致。
(function runMvp19BootMigration() {
  const nowIso = new Date().toISOString();

  // ----- Step 2: spaces → taxonomy -----
  const spaceRows = db
    .prepare(
      `SELECT id, name FROM context_spaces
        WHERE type='project' AND (status IS NULL OR status='active')`
    )
    .all() as Array<{ id: string; name: string }>;
  for (const sp of spaceRows) {
    try {
      const exists = db
        .prepare(`SELECT 1 AS x FROM org_project_taxonomy WHERE canonical_name=?`)
        .get(sp.name) as { x: number } | undefined;
      if (!exists) {
        db.prepare(
          `INSERT INTO org_project_taxonomy
             (canonical_name, aliases_json, summary, parsed_by, parsed_at,
              parent_canonical_name, authoritative_space_id)
           VALUES (?, ?, NULL, 'work_map_writer', ?, NULL, ?)`
        ).run(sp.name, JSON.stringify([sp.name]), nowIso, sp.id);
      } else {
        // 仅 UPDATE 两列；aliases / parent / summary 一律不动
        db.prepare(
          `UPDATE org_project_taxonomy
              SET parsed_by='work_map_writer',
                  authoritative_space_id=?
            WHERE canonical_name=?`
        ).run(sp.id, sp.name);
      }
    } catch (err) {
      console.warn(
        `[MVP19 boot] failed to sync space "${sp.name}":`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ----- Step 3: Chatbot-* 7 兄弟收编为 'Chatbot 产研协同' 的子 -----
  // 守卫：只在 parent 仍为 NULL 时设；用户手工改过就尊重。
  // 'Chatbot 产研协同' 自身必须存在才有意义；若它还没在 taxonomy 里说明 Step 2
  // 没把对应 space 同步进来（dev DB 上不存在该 space 时），此时跳过避免 dangling parent。
  const parentExists = db
    .prepare(
      `SELECT 1 AS x FROM org_project_taxonomy
        WHERE canonical_name='Chatbot 产研协同'`
    )
    .get();
  if (parentExists) {
    const chatbotChildren = [
      'Chatbot',
      'Chatbot Skill Market',
      'Chatbot Agent Builder',
      'Chatbot Badcase 收集跟进',
      'Chatbot 接入 Workspace',
      'Chatbot 支持在会话内分享',
      'Chatbot一期',
    ];
    const stmt = db.prepare(
      `UPDATE org_project_taxonomy
          SET parent_canonical_name='Chatbot 产研协同'
        WHERE canonical_name=?
          AND parent_canonical_name IS NULL`
    );
    let updated = 0;
    for (const child of chatbotChildren) {
      const r = stmt.run(child);
      if (r.changes > 0) updated++;
    }
    if (updated > 0) {
      console.log(
        `[MVP19 boot] Step 3: ${updated}/${chatbotChildren.length} Chatbot-* ` +
          `canonical parented to 'Chatbot 产研协同'`
      );
    }
  }
})();

// ============ MVP15B: 图语义化 ============
// 详见 docs/MVP15B-Work-Map-图语义化与Attention接入技术方案.md §4。
//
// 给 entity_edges 加 4 列承载 LLM 标签：
//   decision_authority：仅 person_project 用，'high'|'mid'|'low'
//   collab_type：      仅 person_person 用，'collab'|'reviewer_author'|'cross_team'|'mentor'
//   llm_classified_at：cache 失效用（14 天 TTL）
//   llm_why：           ≤200 字 LLM 简释
ensureColumn('entity_edges', 'decision_authority', 'TEXT');
ensureColumn('entity_edges', 'collab_type', 'TEXT');
ensureColumn('entity_edges', 'llm_classified_at', 'TEXT');
ensureColumn('entity_edges', 'llm_why', 'TEXT');

// org_project_phase：LLM 判定的项目阶段 + 健康度。canonical_name 跟 org_project_taxonomy 对齐。
// 30 天 TTL（ttl_until 字段），过期重判；手动 invalidate 也可。
db.exec(`
CREATE TABLE IF NOT EXISTS org_project_phase (
  canonical_name TEXT PRIMARY KEY,
  phase TEXT,                                -- 'discovery'|'planning'|'execution'|'review'|'frozen'
  health TEXT,                               -- 'on_track'|'at_risk'|'overdue'|'unknown'
  health_evidence_unit_ids_json TEXT,        -- JSON 数组：导致 at_risk/overdue 判定的 unit id
  summary TEXT,                              -- LLM 一句话项目状态描述
  llm_classified_at TEXT NOT NULL,
  ttl_until TEXT NOT NULL                    -- ISO；< now 时视为过期需重判
);
CREATE INDEX IF NOT EXISTS idx_org_project_phase_ttl ON org_project_phase(ttl_until);
`);

// MVP13 §3.1: Space intent + Work Map ref
ensureColumn('context_spaces', 'intent_json', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('context_spaces', 'work_map_ref_json', 'TEXT');
ensureColumn('context_spaces', 'suggestion_policy', "TEXT NOT NULL DEFAULT 'manual_confirm'");

// MVP13 §3.2: context_space_suggestions 扩展 LLM ranker 输出
ensureColumn('context_space_suggestions', 'rule_score', 'REAL');
ensureColumn('context_space_suggestions', 'llm_score', 'REAL');
ensureColumn('context_space_suggestions', 'final_score', 'REAL');
ensureColumn('context_space_suggestions', 'llm_decision', 'TEXT');
ensureColumn('context_space_suggestions', 'llm_confidence', 'REAL');
ensureColumn('context_space_suggestions', 'ranker_status', "TEXT NOT NULL DEFAULT 'rule_only'");
ensureColumn('context_space_suggestions', 'ranker_version', 'TEXT');
ensureColumn('context_space_suggestions', 'model_id', 'TEXT');
ensureColumn('context_space_suggestions', 'decided_at', 'TEXT');
ensureColumn('context_space_suggestions', 'decided_by', 'TEXT');
db.exec(`
CREATE INDEX IF NOT EXISTS idx_css_ranker_status
  ON context_space_suggestions(ranker_status);
CREATE INDEX IF NOT EXISTS idx_css_decided_at
  ON context_space_suggestions(decided_at);

-- MVP13 §3.3: ranker run audit + input_hash cache
CREATE TABLE IF NOT EXISTS context_space_ranker_runs (
  id TEXT PRIMARY KEY,
  worker_run_id TEXT NOT NULL,
  ranker_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_id TEXT,
  status TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL,
  input_summary_json TEXT NOT NULL,
  output_json TEXT,
  reused_from_run_id TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_csr_input_hash
  ON context_space_ranker_runs(input_hash, started_at);
CREATE INDEX IF NOT EXISTS idx_csr_worker
  ON context_space_ranker_runs(worker_run_id);
CREATE INDEX IF NOT EXISTS idx_csr_status
  ON context_space_ranker_runs(status);

-- MVP13 §3.4: feedback history（snapshot 不丢，行级 upsert 不损失历史）
CREATE TABLE IF NOT EXISTS context_space_suggestion_feedback (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  suggestion_type TEXT NOT NULL,
  action TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  comment TEXT,
  cooldown_until TEXT,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cssf_space
  ON context_space_suggestion_feedback(space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cssf_target
  ON context_space_suggestion_feedback(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cssf_reason
  ON context_space_suggestion_feedback(reason_code);

-- ============ MVP14 Attention Engine (Step 1) ============
-- L2 注意力推理引擎的输出 + 审计。
-- attention_items：LLM 全局推理产出的 "现在该关注什么" 列表。
-- attention_engine_runs：每次 tick 的审计行（含 input_hash cache）。
CREATE TABLE IF NOT EXISTS attention_items (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,                  -- engine run 计数器，绑定到 attention_engine_runs.generation
  llm_run_id TEXT,                              -- 对应 attention_engine_runs.id
  input_hash TEXT NOT NULL,                     -- 用于 dedupe / supersede
  priority TEXT NOT NULL,                       -- 'P0' | 'P1' | 'P2' | 'P3'
  title TEXT NOT NULL,
  why TEXT NOT NULL,                            -- LLM 给的 "why this matters now"
  suggested_action TEXT,
  signal_ids_json TEXT NOT NULL DEFAULT '[]',   -- 关联的 events / context_units id
  related_entity_ids_json TEXT NOT NULL DEFAULT '[]',
  related_space_ids_json TEXT NOT NULL DEFAULT '[]',
  recommended_agent TEXT,                       -- 可选 'prepareMeeting' | 'commitmentDigest' | ...
  status TEXT NOT NULL DEFAULT 'live',          -- 'live' | 'acted' | 'dismissed' | 'superseded' | 'expired'
  expires_at TEXT,
  source_kind TEXT NOT NULL DEFAULT 'attention',
  action_options_json TEXT,                     -- MVP23：处理角度 ProcessingOption[]；null=单按钮
  raw_json TEXT NOT NULL,                       -- 完整 LLM 原始 item，留底审计
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attention_status ON attention_items(status);
CREATE INDEX IF NOT EXISTS idx_attention_input_hash ON attention_items(input_hash);
CREATE INDEX IF NOT EXISTS idx_attention_generation ON attention_items(generation);
CREATE INDEX IF NOT EXISTS idx_attention_expires_at ON attention_items(expires_at);
-- MVP23：attention 卡片处理角度（ProcessingOption[] JSON，nullable=单按钮）。
-- 注：必须在 attention_items 建表语句之后调用 ensureColumn。`);
ensureColumn('attention_items', 'action_options_json', 'TEXT');
// MVP28：把 attention item 绑定到 Matter，便于 Matter resolved/dropped 后按 matter_id 快速清旧卡。
ensureColumn('attention_items', 'matter_id', 'TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS idx_attention_matter ON attention_items(matter_id);`);
db.exec(`

-- 用户对 attention item 的轻量交互日志。
-- 这些记录会进入下一轮 attention prompt，但不作为长期 ContextUnit，避免污染记忆层。
CREATE TABLE IF NOT EXISTS attention_interactions (
  id TEXT PRIMARY KEY,
  attention_id TEXT NOT NULL,
  action TEXT NOT NULL,                         -- 'ack' | 'dismiss' | 'not_relevant' | 'ask_agent' | 'create_task' | 'matter_resolve' | 'mark_done' | 'matter_reopen'
  input_hash TEXT NOT NULL,
  priority TEXT NOT NULL,
  title TEXT NOT NULL,
  signal_ids_json TEXT NOT NULL DEFAULT '[]',
  related_entity_ids_json TEXT NOT NULL DEFAULT '[]',
  related_space_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attention_interactions_created
  ON attention_interactions(created_at);
CREATE INDEX IF NOT EXISTS idx_attention_interactions_attention
  ON attention_interactions(attention_id);
CREATE INDEX IF NOT EXISTS idx_attention_interactions_action
  ON attention_interactions(action);

-- 外部任务系统绑定。ContextUnit 负责语义记忆；这里负责飞书 task guid/url、
-- 幂等 key、原始返回与后续状态同步。
CREATE TABLE IF NOT EXISTS external_task_bindings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,                       -- 'lark'
  external_guid TEXT NOT NULL,
  external_url TEXT,
  source_kind TEXT NOT NULL,                    -- 'card' | 'attention'
  source_ref_id TEXT NOT NULL,
  commitment_unit_id TEXT,
  result_unit_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',       -- 'created' | 'failed' | 'completed' | 'archived'
  idempotency_key TEXT NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, external_guid),
  UNIQUE(provider, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_external_task_bindings_source
  ON external_task_bindings(source_kind, source_ref_id);
CREATE INDEX IF NOT EXISTS idx_external_task_bindings_status
  ON external_task_bindings(status);

CREATE TABLE IF NOT EXISTS attention_engine_runs (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  trigger TEXT NOT NULL,                        -- 'tick' | 'manual' | 'upsert_hook'
  input_hash TEXT NOT NULL,
  input_summary_json TEXT NOT NULL,             -- packet 形状摘要（counts 等），便于审计
  prompt_version TEXT NOT NULL,
  model_id TEXT,
  status TEXT NOT NULL,                         -- 'ok' | 'failed' | 'cache_hit' | 'skipped_no_change'
  output_text TEXT,                             -- LLM 原始返回
  error TEXT,
  items_emitted INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_aer_input_hash
  ON attention_engine_runs(input_hash, started_at);
CREATE INDEX IF NOT EXISTS idx_aer_status ON attention_engine_runs(status);
CREATE INDEX IF NOT EXISTS idx_aer_generation ON attention_engine_runs(generation);
`);

// MVP3 迁移：旧的 idempotency 索引是 partial (WHERE status='pending')，
// 导致 pull worker 每 60s 对同一 commitment 重复触发新 trigger，
// 累计后会刷一屏卡片。改为全状态 UNIQUE。
function ensureIdempotencyIndex() {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_triggers_idempotency'`
    )
    .get() as { sql?: string } | undefined;
  const sql = row?.sql ?? '';
  if (sql.includes('WHERE')) {
    db.exec(`DROP INDEX IF EXISTS idx_triggers_idempotency`);
    // 清掉重复的非 pending 行，否则 UNIQUE 建不上
    db.exec(`
      DELETE FROM triggers WHERE id IN (
        SELECT t1.id FROM triggers t1
        JOIN (
          SELECT trigger_type, context_unit_id, due_at_bucket, MIN(created_at) AS keep_at
          FROM triggers
          GROUP BY trigger_type, context_unit_id, due_at_bucket
          HAVING COUNT(*) > 1
        ) dup
        ON t1.trigger_type = dup.trigger_type
        AND t1.context_unit_id = dup.context_unit_id
        AND t1.due_at_bucket = dup.due_at_bucket
        AND t1.created_at > dup.keep_at
      )
    `);
    db.exec(
      `CREATE UNIQUE INDEX idx_triggers_idempotency ON triggers(trigger_type, context_unit_id, due_at_bucket)`
    );
    console.log('[db] migrated idx_triggers_idempotency to full-status UNIQUE');
  }
}
ensureIdempotencyIndex();

export type RuntimeMessageRow = {
  id: string;
  topic_id: string | null;
  role: string;
  text: string;
  raw_json: string | null;
  created_at: string;
};

export function insertRuntimeMessage(row: RuntimeMessageRow) {
  db.prepare(
    `INSERT INTO runtime_messages (id, topic_id, role, text, raw_json, created_at)
     VALUES (@id, @topic_id, @role, @text, @raw_json, @created_at)`
  ).run(row);
}

export function updateRuntimeMessage(row: RuntimeMessageRow) {
  db.prepare(
    `INSERT INTO runtime_messages (id, topic_id, role, text, raw_json, created_at)
     VALUES (@id, @topic_id, @role, @text, @raw_json, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       topic_id = excluded.topic_id,
       role = excluded.role,
       text = excluded.text,
       raw_json = excluded.raw_json,
       created_at = excluded.created_at`
  ).run(row);
}

export function listRuntimeMessages(limit = 200, topicId?: string): RuntimeMessageRow[] {
  if (topicId) {
    return db
      .prepare(
        `SELECT id, topic_id, role, text, raw_json, created_at
         FROM runtime_messages
         WHERE topic_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(topicId, limit) as RuntimeMessageRow[];
  }
  return db
    .prepare(
      `SELECT id, topic_id, role, text, raw_json, created_at
       FROM runtime_messages
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(limit) as RuntimeMessageRow[];
}

// -------- chat_topics --------

export type ChatTopicRow = {
  id: string;
  title: string;
  source_kind: string;
  source_ref_id: string | null;
  opencode_session_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
};

export function insertChatTopic(row: ChatTopicRow) {
  db.prepare(
    `INSERT INTO chat_topics
     (id, title, source_kind, source_ref_id, opencode_session_id, status, created_at, updated_at, last_message_at)
     VALUES (@id, @title, @source_kind, @source_ref_id, @opencode_session_id, @status, @created_at, @updated_at, @last_message_at)`
  ).run(row);
}

export function getChatTopic(id: string): ChatTopicRow | null {
  return (
    (db.prepare(`SELECT * FROM chat_topics WHERE id = ?`).get(id) as
      | ChatTopicRow
      | undefined) ?? null
  );
}

export function listChatTopics(limit = 100): ChatTopicRow[] {
  return db
    .prepare(
      `SELECT * FROM chat_topics
       WHERE status = 'active'
       ORDER BY COALESCE(last_message_at, updated_at, created_at) DESC
       LIMIT ?`
    )
    .all(limit) as ChatTopicRow[];
}

export function updateChatTopic(
  id: string,
  patch: Partial<Pick<ChatTopicRow, 'title' | 'opencode_session_id' | 'status' | 'updated_at' | 'last_message_at'>>
) {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE chat_topics SET ${sets.join(', ')} WHERE id = @id`).run(params);
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

/** triage 批次失败时调用：attempts +1，返回累计失败次数（决定是否还有重试额度）。 */
export function bumpEventTriageAttempts(id: string): number {
  db.prepare(`UPDATE events SET triage_attempts = triage_attempts + 1 WHERE id = ?`).run(id);
  const row = db
    .prepare(`SELECT triage_attempts AS n FROM events WHERE id = ?`)
    .get(id) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 重试额度耗尽后销账：打 processed_at 防止重复入队，同时记 triage_failed_at 供排查。 */
export function markEventTriageFailed(id: string, at: string) {
  db.prepare(
    `UPDATE events SET processed_at = ?, triage_failed_at = ? WHERE id = ?`
  ).run(at, at, id);
}

export function listEvents(limit = 50): EventRow[] {
  return db
    .prepare(
      `SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?`
    )
    .all(limit) as EventRow[];
}

export function getEventById(id: string): EventRow | undefined {
  return db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as EventRow | undefined;
}

/**
 * MVP11.0-b：列出近 sinceIso 之后、指定 source/kind 的 events，按 occurred_at desc。
 * 给 driveCommentCollector 用来获取「近 14 天编辑过的 doc」候选 file_token 集合。
 */
export function listEventsBySourceSince(
  source: string,
  kind: string | null,
  sinceIso: string,
  limit = 500
): EventRow[] {
  if (kind) {
    return db
      .prepare(
        `SELECT * FROM events
         WHERE source = ? AND kind = ? AND occurred_at >= ?
         ORDER BY occurred_at DESC LIMIT ?`
      )
      .all(source, kind, sinceIso, limit) as EventRow[];
  }
  return db
    .prepare(
      `SELECT * FROM events
       WHERE source = ? AND occurred_at >= ?
       ORDER BY occurred_at DESC LIMIT ?`
    )
    .all(source, sinceIso, limit) as EventRow[];
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

/**
 * MVP14 Step3.5: 拉近 windowMs 毫秒内 status='new' 的 agent_run 卡，
 * 喂给 attention engine 的 packet（让 LLM 看到专项 agent 的建议作为高质量信号）。
 */
export function listRecentAgentProposalCards(
  windowMs: number,
  limit = 20
): CardRow[] {
  const since = new Date(Date.now() - windowMs).toISOString();
  return db
    .prepare(
      `SELECT * FROM cards
       WHERE source_kind = 'agent_run' AND status = 'new' AND created_at >= ?
       ORDER BY
         CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
         created_at DESC
       LIMIT ?`
    )
    .all(since, limit) as CardRow[];
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
  // MVP33 U1：覆盖水位。游标读取优先 covered_until（旧库回退 last_success_at）；
  // 错误轮写 null → COALESCE 保旧值（与 last_success_at 同语义）。
  covered_until: string | null;
};

export function upsertCollectorState(row: CollectorStateRow) {
  db.prepare(
    `INSERT INTO collector_state (collector_name, last_scan_at, last_success_at, last_error, covered_until)
     VALUES (@collector_name, @last_scan_at, @last_success_at, @last_error, @covered_until)
     ON CONFLICT(collector_name) DO UPDATE SET
       last_scan_at = excluded.last_scan_at,
       last_success_at = COALESCE(excluded.last_success_at, collector_state.last_success_at),
       last_error = excluded.last_error,
       covered_until = COALESCE(excluded.covered_until, collector_state.covered_until)`
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

// MVP29C：attention 的 LLM 偶尔把 signalId 缩成 8 位前缀落库（非完整 UUID），
// 导致后续按 id 精确匹配查不到 → 卡片显示"未解析的 signal / 无原文链接"。
// 这里把"看起来像被截断的 UUID 前缀"的短 token 按唯一前缀还原成完整 id：
//   - 已是完整/普通 id（≥36 或不像 uuid 前缀）→ 原样返回
//   - 在 context_units / cards / events 里唯一前缀命中 → 返回完整 id
//   - 查不到或前缀歧义（命中多行）→ 原样返回，交由调用方落到 unknown
// 查找顺序与 resolveAttentionOriginItems 的三级兜底一致：context_units → cards → events。
export function expandTruncatedId(id: string): string {
  // 完整 UUID 长 36（含连字符）；只对更短、且仅含十六进制/连字符的 token 尝试还原。
  if (!/^[0-9a-f-]{4,35}$/i.test(id)) return id;
  for (const table of ['context_units', 'cards', 'events'] as const) {
    const rows = db
      .prepare(`SELECT id FROM ${table} WHERE id LIKE ? LIMIT 2`)
      .all(`${id}%`) as Array<{ id: string }>;
    if (rows.length === 1) return rows[0].id;
  }
  return id;
}

// MVP29D：matter（事项）有独立 id 空间，既不是 ContextUnit/card/event，也不该混进 signalIds
// —— matter 用 attention_items.matter_id 绑定，不是"原始信号"，解不出原文。判断一个 id 是否指向 matter：
//   - 精确命中 → 返回完整 matter id
//   - 唯一前缀命中（LLM 把 matter id 也截断成 8 位）→ 返回完整 matter id
//   - 否则 → null
// 用途：① 解析时把 matterId 还原成完整 id（auto-clear 才能按 matter 状态清卡）；
//       ② 把误混进 signalIds 的 matter id 过滤掉（否则"查看原始信息"显示"未解析的 signal"）。
export function matchMatterId(id: string): string | null {
  if (!id) return null;
  const exact = db.prepare(`SELECT id FROM matters WHERE id = ?`).get(id) as
    | { id: string }
    | undefined;
  if (exact) return exact.id;
  // 仅对"像被截断的 UUID 前缀"的短 token 做前缀兜底；完整 id（≥36）已在上面精确处理。
  if (!/^[0-9a-f-]{4,35}$/i.test(id)) return null;
  const rows = db
    .prepare(`SELECT id FROM matters WHERE id LIKE ? LIMIT 2`)
    .all(`${id}%`) as Array<{ id: string }>;
  return rows.length === 1 ? rows[0].id : null;
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

// MVP12：按 origin + kind 精确取 unit，避免 multiple semantic units share origin
// 时拿到错的那个（典型场景：triage 出的 commitment 与 collector 直写的 event unit
// 都有 origin_kind='event' && origin_ref_id=<eventId>，按 updated_at DESC 取会拿到 semantic）。
export function getActiveContextUnitByOriginAndKind(
  originKind: string,
  originRefId: string,
  kind: string
): ContextUnitRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM context_units
         WHERE origin_kind = ? AND origin_ref_id = ? AND kind = ? AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(originKind, originRefId, kind) as ContextUnitRow | undefined) ?? null
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
  // MVP15: type='person' 时承载 PersonAttributes（含 lark profile + orgRoleFromMe），
  // 其他 type 留 NULL。schema 见 apps/server/src/context/personAttributes.ts。
  attributes_json: string | null;
};

export function insertContextEntity(row: ContextEntityRow) {
  db.prepare(
    `INSERT INTO context_entities
     (id, type, name, aliases_json, source, confidence, created_at, updated_at, attributes_json)
     VALUES (@id, @type, @name, @aliases_json, @source, @confidence, @created_at, @updated_at, @attributes_json)`
  ).run(row);
}

// MVP15: 给 person entity 写入 PersonAttributes JSON。仅更新 attributes_json + updated_at，
// 不动 confidence / name / aliases。调用方负责序列化（用 personAttributes.serialize）。
export function updateContextEntityAttributes(
  entityId: string,
  attributesJson: string | null,
  updatedAt: string
): void {
  db.prepare(
    `UPDATE context_entities SET attributes_json = ?, updated_at = ? WHERE id = ?`
  ).run(attributesJson, updatedAt, entityId);
}

// MVP15: 列出有 open_id alias 的 person entity（aliases_json 里含 ou_ 前缀的项）。
// larkOrgCollector 用来枚举可同步的人员。limit 后再由 collector 在 JS 层按 TTL 过滤。
// 注意：aliases_json 是 JSON 字符串数组；SQL LIKE 是粗筛，最终匹配在 JS 里再确认。
export function listPersonEntitiesWithOpenIdAlias(limit = 500): ContextEntityRow[] {
  return db
    .prepare(
      `SELECT * FROM context_entities
        WHERE type = 'person'
          AND aliases_json IS NOT NULL
          AND aliases_json LIKE '%ou_%'
        ORDER BY updated_at DESC
        LIMIT ?`
    )
    .all(limit) as ContextEntityRow[];
}

// -------- MVP15 §4 (revision): org_department_taxonomy --------

export type OrgDeptTaxonomyRow = {
  dept_name: string;
  business: string | null;
  function_label: string | null;
  function_path_json: string | null;
  parsed_by: string;
  parsed_at: string;
};

export function getDeptTaxonomy(deptName: string): OrgDeptTaxonomyRow | null {
  return (
    (db
      .prepare(`SELECT * FROM org_department_taxonomy WHERE dept_name = ?`)
      .get(deptName) as OrgDeptTaxonomyRow | undefined) ?? null
  );
}

export function getDeptTaxonomiesBulk(deptNames: string[]): Map<string, OrgDeptTaxonomyRow> {
  const out = new Map<string, OrgDeptTaxonomyRow>();
  if (deptNames.length === 0) return out;
  const placeholders = deptNames.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM org_department_taxonomy WHERE dept_name IN (${placeholders})`
    )
    .all(...deptNames) as OrgDeptTaxonomyRow[];
  for (const r of rows) out.set(r.dept_name, r);
  return out;
}

export function upsertDeptTaxonomy(row: OrgDeptTaxonomyRow): void {
  db.prepare(
    `INSERT INTO org_department_taxonomy
       (dept_name, business, function_label, function_path_json, parsed_by, parsed_at)
     VALUES (@dept_name, @business, @function_label, @function_path_json, @parsed_by, @parsed_at)
     ON CONFLICT(dept_name) DO UPDATE SET
       business = excluded.business,
       function_label = excluded.function_label,
       function_path_json = excluded.function_path_json,
       parsed_by = excluded.parsed_by,
       parsed_at = excluded.parsed_at`
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

export function getContextEntityById(id: string): ContextEntityRow | null {
  return (
    (db.prepare(`SELECT * FROM context_entities WHERE id = ?`).get(id) as
      | ContextEntityRow
      | undefined) ?? null
  );
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

/**
 * MVP5：列出所有 active 的「任务 commitment」—— kind='commitment' 且关联了
 * type='task' 的 entity。供 task collector 做集合差对账（本地有、但本轮未完成全集里
 * 没有的 → 标 superseded）。用 entity-join 直查、不受 listActiveContextUnits 的 limit 影响。
 * caller（larkTaskCollector）会 hydrate 后再校验 name 前缀 lark_task: 并取 guid，
 * 故此处只按 type='task' 粗筛即可。
 */
export function listActiveLarkTaskCommitmentRows(): ContextUnitRow[] {
  return db
    .prepare(
      `SELECT DISTINCT cu.* FROM context_units cu
       JOIN context_unit_entities cue ON cu.id = cue.context_unit_id
       JOIN context_entities ce ON cue.entity_id = ce.id
       WHERE cu.kind = 'commitment' AND cu.status = 'active' AND ce.type = 'task'
       ORDER BY cu.updated_at DESC`
    )
    .all() as ContextUnitRow[];
}

// -------- context_relations: REMOVED in MVP14 Phase 1c --------
// 物理表 CREATE TABLE 保留在上方 schema（零行无害；DROP 需写迁移）。
// 应用层无 caller。"关系" 走 ContextUnit.kind='relationship'，参见
// apps/server/src/context/relationshipsService.ts 与 cooccurrenceService.ts。

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

// -------- settings (MVP4 key/value) --------

export function getSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, now);
}

// -------- context_spaces (MVP5 + MVP13) --------

export type ContextSpaceRow = {
  id: string;
  type: string;                    // 'project' | 'topic'
  name: string;
  description: string | null;
  owner_subject_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  // MVP13 §3.1
  intent_json?: string;
  work_map_ref_json?: string | null;
  suggestion_policy?: string;
};

export function insertContextSpace(row: ContextSpaceRow) {
  db.prepare(
    `INSERT INTO context_spaces (id, type, name, description, owner_subject_id, status, created_at, updated_at,
       intent_json, work_map_ref_json, suggestion_policy)
     VALUES (@id, @type, @name, @description, @owner_subject_id, @status, @created_at, @updated_at,
       @intent_json, @work_map_ref_json, @suggestion_policy)`
  ).run({
    ...row,
    intent_json: row.intent_json ?? '{}',
    work_map_ref_json: row.work_map_ref_json ?? null,
    suggestion_policy: row.suggestion_policy ?? 'manual_confirm',
  });
}

export function getContextSpace(id: string): ContextSpaceRow | null {
  return (
    (db.prepare(`SELECT * FROM context_spaces WHERE id = ?`).get(id) as
      | ContextSpaceRow
      | undefined) ?? null
  );
}

export function getContextSpaceByTypeName(type: string, name: string): ContextSpaceRow | null {
  return (
    (db
      .prepare(`SELECT * FROM context_spaces WHERE type = ? AND name = ?`)
      .get(type, name) as ContextSpaceRow | undefined) ?? null
  );
}

export function listContextSpaces(opts: { status?: string; limit?: number } = {}): ContextSpaceRow[] {
  const limit = opts.limit ?? 50;
  const where = opts.status ? `WHERE status = '${opts.status.replace(/'/g, "''")}'` : '';
  return db
    .prepare(`SELECT * FROM context_spaces ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as ContextSpaceRow[];
}

export function updateContextSpace(row: ContextSpaceRow) {
  db.prepare(
    `UPDATE context_spaces SET type=@type, name=@name, description=@description,
       owner_subject_id=@owner_subject_id, status=@status, updated_at=@updated_at,
       intent_json=COALESCE(@intent_json, intent_json),
       work_map_ref_json=@work_map_ref_json,
       suggestion_policy=COALESCE(@suggestion_policy, suggestion_policy)
     WHERE id=@id`
  ).run({
    ...row,
    intent_json: row.intent_json ?? null,
    work_map_ref_json: row.work_map_ref_json ?? null,
    suggestion_policy: row.suggestion_policy ?? null,
  });
}

// -------- context_space_links --------

export type ContextSpaceLinkRow = {
  id: string;
  space_id: string;
  target_type: string;             // 'entity' | 'context_unit'
  target_id: string;
  link_type: string;
  confidence: number;
  created_at: string;
  reason_json?: string | null;     // MVP12: 命中路径 evidence; cap 5
};

export function tryInsertContextSpaceLink(row: ContextSpaceLinkRow): boolean {
  try {
    db.prepare(
      `INSERT INTO context_space_links (id, space_id, target_type, target_id, link_type, confidence, created_at, reason_json)
       VALUES (@id, @space_id, @target_type, @target_id, @link_type, @confidence, @created_at, @reason_json)`
    ).run({ reason_json: null, ...row });
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return false;
    throw err;
  }
}

export function getContextSpaceLink(
  spaceId: string,
  targetType: string,
  targetId: string
): ContextSpaceLinkRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM context_space_links
         WHERE space_id = ? AND target_type = ? AND target_id = ?`
      )
      .get(spaceId, targetType, targetId) as ContextSpaceLinkRow | undefined) ?? null
  );
}

export function updateContextSpaceLink(
  id: string,
  patch: { link_type?: string; confidence?: number; reason_json?: string | null }
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.link_type !== undefined) {
    sets.push('link_type = @link_type');
    params.link_type = patch.link_type;
  }
  if (patch.confidence !== undefined) {
    sets.push('confidence = @confidence');
    params.confidence = patch.confidence;
  }
  if (patch.reason_json !== undefined) {
    sets.push('reason_json = @reason_json');
    params.reason_json = patch.reason_json;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE context_space_links SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function listSpaceLinks(spaceId: string): ContextSpaceLinkRow[] {
  return db
    .prepare(`SELECT * FROM context_space_links WHERE space_id = ? ORDER BY created_at DESC`)
    .all(spaceId) as ContextSpaceLinkRow[];
}

export function listSpacesForTarget(
  targetType: string,
  targetId: string
): ContextSpaceLinkRow[] {
  return db
    .prepare(
      `SELECT * FROM context_space_links WHERE target_type = ? AND target_id = ?`
    )
    .all(targetType, targetId) as ContextSpaceLinkRow[];
}

// MVP12 §4.1 P1.7：context_unit link 的 rank-aware upsert。
// 比较新 hit.rank vs 旧 link 当前 rank：
//   - 新 rank > 旧 → 升级 link_type / confidence；reason_json append（cap 5）
//   - 新 rank == 旧 → 取较大 confidence；reason_json append
//   - 新 rank < 旧 → 仅 append reason_json
// Space seed entity link 不走此路径（target_type='entity' 仍用 tryInsertContextSpaceLink）。
export type SpaceLinkHit = {
  rank: number;
  linkType: string;
  confidence: number;
  reason: {
    via: 'person' | 'project' | 'doc' | 'chat_seed' | 'topic' | string;
    sourceEntityId: string;
    sourceEntityName: string;
  };
};

const REASON_CAP = 5;

type ReasonJson = {
  via: string;
  sourceEntityId: string;
  sourceEntityName: string;
  more?: Array<{ via: string; sourceEntityId: string; sourceEntityName: string }>;
};

function rankOfLinkType(linkType: string): number {
  if (linkType === 'about') return 3;
  if (linkType === 'about_via_doc') return 2;
  if (linkType === 'about_via_chat') return 1;
  // unknown link types from older data — treat as 0 so any new hit wins
  return 0;
}

export function upsertContextSpaceLinkBestHit(
  spaceId: string,
  unitId: string,
  hit: SpaceLinkHit,
  idFactory: () => string,
  nowIso: string
): 'inserted' | 'upgraded' | 'reason-appended' | 'noop' {
  const existing = getContextSpaceLink(spaceId, 'context_unit', unitId);
  const newReason: ReasonJson = {
    via: hit.reason.via,
    sourceEntityId: hit.reason.sourceEntityId,
    sourceEntityName: hit.reason.sourceEntityName,
  };

  if (!existing) {
    const ok = tryInsertContextSpaceLink({
      id: idFactory(),
      space_id: spaceId,
      target_type: 'context_unit',
      target_id: unitId,
      link_type: hit.linkType,
      confidence: hit.confidence,
      created_at: nowIso,
      reason_json: JSON.stringify(newReason),
    });
    return ok ? 'inserted' : 'noop';
  }

  const oldRank = rankOfLinkType(existing.link_type);
  let existingReason: ReasonJson | null = null;
  try {
    existingReason = existing.reason_json ? JSON.parse(existing.reason_json) : null;
  } catch {
    existingReason = null;
  }

  // Build appended reason: keep current primary, push old primary into more[] if upgrading.
  function appendReason(
    primary: ReasonJson,
    incoming: { via: string; sourceEntityId: string; sourceEntityName: string }
  ): ReasonJson {
    const more = primary.more ? [...primary.more] : [];
    // skip duplicates on (via, sourceEntityId)
    const dupKey = (r: { via: string; sourceEntityId: string }) =>
      `${r.via}::${r.sourceEntityId}`;
    if (
      dupKey(primary) === dupKey(incoming) ||
      more.some((m) => dupKey(m) === dupKey(incoming))
    ) {
      return primary;
    }
    more.push(incoming);
    if (more.length > REASON_CAP - 1) more.length = REASON_CAP - 1;
    return { ...primary, more };
  }

  if (hit.rank > oldRank) {
    // Upgrade: new becomes primary, old primary demoted into more[].
    const upgraded: ReasonJson = { ...newReason };
    if (existingReason) {
      upgraded.more = [
        {
          via: existingReason.via,
          sourceEntityId: existingReason.sourceEntityId,
          sourceEntityName: existingReason.sourceEntityName,
        },
        ...(existingReason.more ?? []),
      ].slice(0, REASON_CAP - 1);
    }
    updateContextSpaceLink(existing.id, {
      link_type: hit.linkType,
      confidence: hit.confidence,
      reason_json: JSON.stringify(upgraded),
    });
    return 'upgraded';
  }

  if (hit.rank === oldRank) {
    const newConf = Math.max(existing.confidence, hit.confidence);
    const merged = existingReason
      ? appendReason(existingReason, newReason)
      : newReason;
    updateContextSpaceLink(existing.id, {
      confidence: newConf,
      reason_json: JSON.stringify(merged),
    });
    return 'reason-appended';
  }

  // hit.rank < oldRank: keep link, just append evidence
  if (existingReason) {
    const merged = appendReason(existingReason, newReason);
    updateContextSpaceLink(existing.id, { reason_json: JSON.stringify(merged) });
    return 'reason-appended';
  }
  return 'noop';
}

// -------- decisions --------

export type DecisionRow = {
  id: string;
  space_id: string | null;
  title: string;
  content: string;
  source_context_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
};

export function insertDecision(row: DecisionRow) {
  db.prepare(
    `INSERT INTO decisions (id, space_id, title, content, source_context_id, decided_by, decided_at,
      confidence, created_at, updated_at)
     VALUES (@id, @space_id, @title, @content, @source_context_id, @decided_by, @decided_at,
       @confidence, @created_at, @updated_at)`
  ).run(row);
}

export function listDecisionsBySpace(spaceId: string, limit = 50): DecisionRow[] {
  return db
    .prepare(`SELECT * FROM decisions WHERE space_id = ? ORDER BY decided_at DESC LIMIT ?`)
    .all(spaceId, limit) as DecisionRow[];
}

// -------- boundary_rules (MVP6) --------

export type BoundaryRuleRow = {
  id: string;
  scope: string;
  condition_json: string;
  allowed_action: string;
  requires_approval: number;
  confidence: number;
  learned_from_card_id: string | null;
  source: string;
  migrated: number;
  active: number;
  condition_hash: string | null;
  // MVP10.1
  autonomy: string;
  reversible: number;
  impact_scope: string;
  created_at: string;
  updated_at: string;
};

export function insertBoundaryRule(row: BoundaryRuleRow) {
  db.prepare(
    `INSERT INTO boundary_rules (id, scope, condition_json, allowed_action, requires_approval,
       confidence, learned_from_card_id, source, migrated, active, condition_hash,
       autonomy, reversible, impact_scope, created_at, updated_at)
     VALUES (@id, @scope, @condition_json, @allowed_action, @requires_approval,
       @confidence, @learned_from_card_id, @source, @migrated, @active, @condition_hash,
       @autonomy, @reversible, @impact_scope, @created_at, @updated_at)`
  ).run(row);
}

export function getBoundaryRuleByConditionHash(hash: string): BoundaryRuleRow | null {
  return (
    (db
      .prepare(`SELECT * FROM boundary_rules WHERE condition_hash = ?`)
      .get(hash) as BoundaryRuleRow | undefined) ?? null
  );
}

export function touchBoundaryRule(id: string): void {
  db.prepare(`UPDATE boundary_rules SET updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id
  );
}

export function listBoundaryRules(opts: { activeOnly?: boolean } = {}): BoundaryRuleRow[] {
  if (opts.activeOnly) {
    return db
      .prepare(`SELECT * FROM boundary_rules WHERE active = 1 ORDER BY created_at DESC`)
      .all() as BoundaryRuleRow[];
  }
  return db
    .prepare(`SELECT * FROM boundary_rules ORDER BY created_at DESC`)
    .all() as BoundaryRuleRow[];
}

export function getBoundaryRule(id: string): BoundaryRuleRow | null {
  return (
    (db.prepare(`SELECT * FROM boundary_rules WHERE id = ?`).get(id) as
      | BoundaryRuleRow
      | undefined) ?? null
  );
}

export function updateBoundaryRuleActive(id: string, active: boolean): BoundaryRuleRow | null {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE boundary_rules SET active = ?, updated_at = ? WHERE id = ?`
  ).run(active ? 1 : 0, now, id);
  return getBoundaryRule(id);
}

// -------- audit_logs (MVP6) --------

export type AuditLogRow = {
  id: string;
  agent_run_id: string | null;
  card_id: string | null;
  rule_id: string | null;
  action: string;
  reason: string;
  payload_json: string | null;
  created_at: string;
};

export function insertAuditLog(row: AuditLogRow) {
  db.prepare(
    `INSERT INTO audit_logs (id, agent_run_id, card_id, rule_id, action, reason, payload_json, created_at)
     VALUES (@id, @agent_run_id, @card_id, @rule_id, @action, @reason, @payload_json, @created_at)`
  ).run(row);
}

export function listAuditLogs(limit = 200): AuditLogRow[] {
  return db
    .prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as AuditLogRow[];
}

// -------- entity_aliases (MVP10) --------

export type EntityAliasRow = {
  id: string;
  alias_of: string;
  created_at: string;
};

export function insertEntityAlias(row: EntityAliasRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO entity_aliases (id, alias_of, created_at)
     VALUES (@id, @alias_of, @created_at)`
  ).run(row);
}

export function getEntityAlias(id: string): EntityAliasRow | null {
  return (
    (db.prepare(`SELECT * FROM entity_aliases WHERE id = ?`).get(id) as
      | EntityAliasRow
      | undefined) ?? null
  );
}

export function deleteEntityAlias(id: string): void {
  db.prepare(`DELETE FROM entity_aliases WHERE id = ?`).run(id);
}

// -------- correction_journal (MVP10) --------

export type CorrectionJournalRow = {
  id: string;
  feedback_id: string;
  correction_type: string;
  target_kind: string;
  target_id: string;
  forward_patch_json: string;
  inverse_patch_json: string | null;
  inverse_lossy: number;
  applied_at: string;
  reverted_at: string | null;
};

export function insertCorrectionJournal(row: CorrectionJournalRow): void {
  db.prepare(
    `INSERT INTO correction_journal
     (id, feedback_id, correction_type, target_kind, target_id,
      forward_patch_json, inverse_patch_json, inverse_lossy, applied_at, reverted_at)
     VALUES (@id, @feedback_id, @correction_type, @target_kind, @target_id,
       @forward_patch_json, @inverse_patch_json, @inverse_lossy, @applied_at, @reverted_at)`
  ).run(row);
}

export function getCorrectionJournal(id: string): CorrectionJournalRow | null {
  return (
    (db.prepare(`SELECT * FROM correction_journal WHERE id = ?`).get(id) as
      | CorrectionJournalRow
      | undefined) ?? null
  );
}

export function listCorrectionJournalForCard(cardId: string): CorrectionJournalRow[] {
  // feedback_id 在 MVP10 阶段直接复用 card_id（每张卡的 inline correction 用 card_id 作 feedback_id）
  return db
    .prepare(
      `SELECT * FROM correction_journal WHERE feedback_id = ? ORDER BY applied_at DESC`
    )
    .all(cardId) as CorrectionJournalRow[];
}

export function listCorrectionJournalRecent(limit = 50): CorrectionJournalRow[] {
  return db
    .prepare(`SELECT * FROM correction_journal ORDER BY applied_at DESC LIMIT ?`)
    .all(limit) as CorrectionJournalRow[];
}

export function markCorrectionReverted(id: string, at: string): void {
  db.prepare(`UPDATE correction_journal SET reverted_at = ? WHERE id = ?`).run(at, id);
}

// -------- unit_sources / unit_routing_cache (MVP12) --------

export type UnitSourceRow = {
  id: string;
  unit_id: string;
  event_id: string;
  recorded_at: string;
};

export function insertUnitSource(row: UnitSourceRow): boolean {
  try {
    db.prepare(
      `INSERT INTO unit_sources (id, unit_id, event_id, recorded_at)
       VALUES (@id, @unit_id, @event_id, @recorded_at)`
    ).run(row);
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return false;
    throw err;
  }
}

export function listUnitSourcesByEvent(eventId: string): UnitSourceRow[] {
  return db
    .prepare(`SELECT * FROM unit_sources WHERE event_id = ?`)
    .all(eventId) as UnitSourceRow[];
}

export function listUnitSourcesByUnit(unitId: string): UnitSourceRow[] {
  return db
    .prepare(`SELECT * FROM unit_sources WHERE unit_id = ?`)
    .all(unitId) as UnitSourceRow[];
}

export type UnitRoutingCacheRow = {
  id: string;
  unit_id: string;
  source_event_id: string;
  routing_entities_json: string;
  updated_at: string;
};

export function upsertUnitRoutingCache(row: UnitRoutingCacheRow): void {
  db.prepare(
    `INSERT INTO unit_routing_cache (id, unit_id, source_event_id, routing_entities_json, updated_at)
     VALUES (@id, @unit_id, @source_event_id, @routing_entities_json, @updated_at)
     ON CONFLICT(unit_id, source_event_id) DO UPDATE SET
       routing_entities_json = excluded.routing_entities_json,
       updated_at = excluded.updated_at`
  ).run(row);
}

export function deleteUnitRoutingCacheByEvent(eventId: string): void {
  db.prepare(`DELETE FROM unit_routing_cache WHERE source_event_id = ?`).run(eventId);
}

export function listUnitRoutingCacheByUnit(unitId: string): UnitRoutingCacheRow[] {
  return db
    .prepare(`SELECT * FROM unit_routing_cache WHERE unit_id = ?`)
    .all(unitId) as UnitRoutingCacheRow[];
}

// -------- context_space_suggestions (MVP12 schema + MVP13 ranker fields) --------

export type ContextSpaceSuggestionRow = {
  id: string;
  target_type: string;
  target_id: string;
  space_id: string;
  suggestion_type: string;
  score: number;                    // MVP13: stores final_score for back-compat sort
  evidence_json: string;
  status: string;
  cooldown_until: string | null;
  created_at: string;
  updated_at: string;
  // MVP13 §3.2
  rule_score?: number | null;
  llm_score?: number | null;
  final_score?: number | null;
  llm_decision?: string | null;
  llm_confidence?: number | null;
  ranker_status?: string;
  ranker_version?: string | null;
  model_id?: string | null;
  decided_at?: string | null;
  decided_by?: string | null;
};

export function listSpaceSuggestions(
  spaceId: string,
  status?: string
): ContextSpaceSuggestionRow[] {
  if (status) {
    return db
      .prepare(
        `SELECT * FROM context_space_suggestions
         WHERE space_id = ? AND status = ?
         ORDER BY score DESC, updated_at DESC`
      )
      .all(spaceId, status) as ContextSpaceSuggestionRow[];
  }
  return db
    .prepare(
      `SELECT * FROM context_space_suggestions
       WHERE space_id = ?
       ORDER BY score DESC, updated_at DESC`
    )
    .all(spaceId) as ContextSpaceSuggestionRow[];
}

// -------- MVP13 ranker run audit --------

export type ContextSpaceRankerRunRow = {
  id: string;
  worker_run_id: string;
  ranker_version: string;
  prompt_version: string;
  model_id: string | null;
  status: string;                  // ok | failed | timeout | parse_error | cache_hit
  candidate_count: number;
  accepted_count: number;
  rejected_count: number;
  input_hash: string;
  input_summary_json: string;
  output_json: string | null;
  reused_from_run_id: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};

export function insertContextSpaceRankerRun(row: ContextSpaceRankerRunRow): void {
  db.prepare(
    `INSERT INTO context_space_ranker_runs
       (id, worker_run_id, ranker_version, prompt_version, model_id, status,
        candidate_count, accepted_count, rejected_count,
        input_hash, input_summary_json, output_json, reused_from_run_id,
        error, started_at, completed_at)
     VALUES
       (@id, @worker_run_id, @ranker_version, @prompt_version, @model_id, @status,
        @candidate_count, @accepted_count, @rejected_count,
        @input_hash, @input_summary_json, @output_json, @reused_from_run_id,
        @error, @started_at, @completed_at)`
  ).run(row);
}

export function updateContextSpaceRankerRun(
  id: string,
  patch: Partial<
    Pick<
      ContextSpaceRankerRunRow,
      | 'status'
      | 'candidate_count'
      | 'accepted_count'
      | 'rejected_count'
      | 'output_json'
      | 'reused_from_run_id'
      | 'error'
      | 'completed_at'
      | 'model_id'
    >
  >
): void {
  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = @${k}`);
    params[k] = v ?? null;
  }
  if (fields.length === 0) return;
  db.prepare(
    `UPDATE context_space_ranker_runs SET ${fields.join(', ')} WHERE id = @id`
  ).run(params);
}

/**
 * MVP13 §3.3：24h TTL 内复用同 input_hash 的 ok 结果。
 */
export function findRecentRankerRunByInputHash(
  inputHash: string,
  ttlHours: number
): ContextSpaceRankerRunRow | null {
  const cutoff = new Date(Date.now() - ttlHours * 3600_000).toISOString();
  const row = db
    .prepare(
      `SELECT * FROM context_space_ranker_runs
       WHERE input_hash = ? AND status = 'ok' AND completed_at IS NOT NULL
         AND started_at >= ?
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .get(inputHash, cutoff) as ContextSpaceRankerRunRow | undefined;
  return row ?? null;
}

export function deleteRankerRunsOlderThan(olderThanDays: number): number {
  const cutoff = new Date(
    Date.now() - olderThanDays * 86400_000
  ).toISOString();
  const r = db
    .prepare(`DELETE FROM context_space_ranker_runs WHERE started_at < ?`)
    .run(cutoff);
  return r.changes;
}

// -------- MVP13 suggestion feedback history --------

export type ContextSpaceSuggestionFeedbackRow = {
  id: string;
  suggestion_id: string;
  space_id: string;
  target_type: string;
  target_id: string;
  suggestion_type: string;
  action: string;                  // confirmed | rejected
  reason_code: string;
  comment: string | null;
  cooldown_until: string | null;
  snapshot_json: string;
  created_at: string;
};

export function insertContextSpaceSuggestionFeedback(
  row: ContextSpaceSuggestionFeedbackRow
): void {
  db.prepare(
    `INSERT INTO context_space_suggestion_feedback
       (id, suggestion_id, space_id, target_type, target_id, suggestion_type,
        action, reason_code, comment, cooldown_until, snapshot_json, created_at)
     VALUES
       (@id, @suggestion_id, @space_id, @target_type, @target_id, @suggestion_type,
        @action, @reason_code, @comment, @cooldown_until, @snapshot_json, @created_at)`
  ).run(row);
}

/**
 * MVP13 §6.4：拉 few-shot examples。优先同 Space 最近 windowDays 天；
 * 若同 Space 拿不满，返回 caller 用全局兜底。
 */
export function listSuggestionFeedbackExamples(opts: {
  spaceId?: string;
  windowDays: number;
  perAction: number;
}): ContextSpaceSuggestionFeedbackRow[] {
  const cutoff = new Date(
    Date.now() - opts.windowDays * 86400_000
  ).toISOString();
  if (opts.spaceId) {
    const confirmed = db
      .prepare(
        `SELECT * FROM context_space_suggestion_feedback
         WHERE space_id = ? AND action = 'confirmed' AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(opts.spaceId, cutoff, opts.perAction) as ContextSpaceSuggestionFeedbackRow[];
    const rejected = db
      .prepare(
        `SELECT * FROM context_space_suggestion_feedback
         WHERE space_id = ? AND action = 'rejected' AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(opts.spaceId, cutoff, opts.perAction) as ContextSpaceSuggestionFeedbackRow[];
    return [...confirmed, ...rejected];
  }
  // global
  const confirmed = db
    .prepare(
      `SELECT * FROM context_space_suggestion_feedback
       WHERE action = 'confirmed' AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(cutoff, opts.perAction) as ContextSpaceSuggestionFeedbackRow[];
  const rejected = db
    .prepare(
      `SELECT * FROM context_space_suggestion_feedback
       WHERE action = 'rejected' AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(cutoff, opts.perAction) as ContextSpaceSuggestionFeedbackRow[];
  return [...confirmed, ...rejected];
}

export function listSuggestionFeedbackForCalibration(
  windowDays: number
): ContextSpaceSuggestionFeedbackRow[] {
  const cutoff = new Date(
    Date.now() - windowDays * 86400_000
  ).toISOString();
  return db
    .prepare(
      `SELECT * FROM context_space_suggestion_feedback
       WHERE created_at >= ?
       ORDER BY created_at DESC`
    )
    .all(cutoff) as ContextSpaceSuggestionFeedbackRow[];
}

// -------- MVP14 Attention Engine (Step 1) --------

export type AttentionItemRow = {
  id: string;
  generation: number;
  llm_run_id: string | null;
  input_hash: string;
  priority: string;                // 'P0'..'P3'
  title: string;
  why: string;
  suggested_action: string | null;
  signal_ids_json: string;
  related_entity_ids_json: string;
  related_space_ids_json: string;
  recommended_agent: string | null;
  status: string;                  // 'live' | 'acted' | 'dismissed' | 'superseded' | 'expired'
  expires_at: string | null;
  source_kind: string;
  action_options_json: string | null;  // MVP23：ProcessingOption[] JSON；null=单按钮
  matter_id: string | null;             // MVP28：item 讲的是哪个 Matter（resolved 后按此清卡）
  raw_json: string;
  created_at: string;
  updated_at: string;
};

export function insertAttentionItem(row: AttentionItemRow): void {
  db.prepare(
    `INSERT INTO attention_items
       (id, generation, llm_run_id, input_hash, priority, title, why, suggested_action,
        signal_ids_json, related_entity_ids_json, related_space_ids_json,
        recommended_agent, status, expires_at, source_kind, action_options_json, matter_id, raw_json,
        created_at, updated_at)
     VALUES
       (@id, @generation, @llm_run_id, @input_hash, @priority, @title, @why, @suggested_action,
        @signal_ids_json, @related_entity_ids_json, @related_space_ids_json,
        @recommended_agent, @status, @expires_at, @source_kind, @action_options_json, @matter_id, @raw_json,
        @created_at, @updated_at)`
  ).run(row);
}

// MVP28：把绑定到已 resolved/dropped Matter 的 live attention item 一次性标 superseded。
// 每次 attention tick 开头调用，保证 Matter 在别处办掉后旧卡自动消失。
export function markAttentionSupersededForResolvedMatters(updatedAt: string): number {
  const r = db
    .prepare(
      `UPDATE attention_items
         SET status = 'superseded', updated_at = ?
       WHERE status = 'live'
         AND matter_id IS NOT NULL
         -- MVP29D：matter_id 可能被 LLM 截断成 8 位前缀落库，用前缀匹配兜底，
         -- 否则 resolved/dropped 的 matter 永远清不掉旧卡（"已处理还在催"）。
         AND EXISTS (
           SELECT 1 FROM matters m
            WHERE m.status IN ('resolved','dropped')
              AND m.id LIKE attention_items.matter_id || '%'
         )`
    )
    .run(updatedAt);
  return r.changes;
}

export function getAttentionItem(id: string): AttentionItemRow | null {
  return (
    (db
      .prepare(`SELECT * FROM attention_items WHERE id = ?`)
      .get(id) as AttentionItemRow | undefined) ?? null
  );
}

export function listLiveAttentionItems(limit = 100): AttentionItemRow[] {
  return db
    .prepare(
      `SELECT * FROM attention_items
       WHERE status = 'live'
       ORDER BY
         CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
         created_at DESC
       LIMIT ?`
    )
    .all(limit) as AttentionItemRow[];
}

export function updateAttentionItemStatus(
  id: string,
  status: string,
  updatedAt: string
): AttentionItemRow | null {
  db.prepare(
    `UPDATE attention_items SET status = ?, updated_at = ? WHERE id = ?`
  ).run(status, updatedAt, id);
  return getAttentionItem(id);
}

/**
 * churn guard v2（2026-06-12）：内容等价但优先级变化 → 原地升降级，
 * 保住卡片身份（id/created_at/用户状态），不再「杀旧建新」洗牌。
 */
export function updateAttentionItemPriority(
  id: string,
  priority: string,
  updatedAt: string
): AttentionItemRow | null {
  db.prepare(
    `UPDATE attention_items SET priority = ?, updated_at = ? WHERE id = ?`
  ).run(priority, updatedAt, id);
  return getAttentionItem(id);
}

/**
 * 把同 input_hash 的旧 live 项标 superseded。
 * 在每次成功 run 后、插入新 items 前调用，保证幂等重跑不会双倍出货。
 */
export function markAttentionItemsSupersededByHash(
  inputHash: string,
  updatedAt: string
): number {
  const r = db
    .prepare(
      `UPDATE attention_items
         SET status = 'superseded', updated_at = ?
       WHERE input_hash = ? AND status = 'live'`
    )
    .run(updatedAt, inputHash);
  return r.changes;
}

/**
 * TTL 兜底：把 created_at < beforeIso 的 live 项标 'expired'。
 * 防 LLM 漏写 supersedeIds 导致跨 hash 的旧 item 永久堆积。
 */
export function markAttentionItemsExpired(
  beforeIso: string,
  updatedAt: string
): number {
  const r = db
    .prepare(
      `UPDATE attention_items
         SET status = 'expired', updated_at = ?
       WHERE status = 'live' AND (
         created_at < ?
         OR (expires_at IS NOT NULL AND expires_at <= ?)
       )`
    )
    .run(updatedAt, beforeIso, updatedAt);
  return r.changes;
}

export type AttentionInteractionRow = {
  id: string;
  attention_id: string;
  action: string;
  input_hash: string;
  priority: string;
  title: string;
  signal_ids_json: string;
  related_entity_ids_json: string;
  related_space_ids_json: string;
  created_at: string;
};

export function insertAttentionInteraction(row: AttentionInteractionRow): void {
  db.prepare(
    `INSERT INTO attention_interactions
       (id, attention_id, action, input_hash, priority, title,
        signal_ids_json, related_entity_ids_json, related_space_ids_json, created_at)
     VALUES
       (@id, @attention_id, @action, @input_hash, @priority, @title,
        @signal_ids_json, @related_entity_ids_json, @related_space_ids_json, @created_at)`
  ).run(row);
}

export function listRecentAttentionInteractions(opts: {
  sinceIso: string;
  limit: number;
}): AttentionInteractionRow[] {
  return db
    .prepare(
      `SELECT * FROM attention_interactions
       WHERE created_at >= @sinceIso
       ORDER BY created_at DESC
       LIMIT @limit`
    )
    .all(opts) as AttentionInteractionRow[];
}

export type ExternalTaskBindingRow = {
  id: string;
  provider: string;
  external_guid: string;
  external_url: string | null;
  source_kind: string;
  source_ref_id: string;
  commitment_unit_id: string | null;
  result_unit_id: string | null;
  status: string;
  idempotency_key: string;
  raw_json: string | null;
  created_at: string;
  updated_at: string;
};

export function upsertExternalTaskBinding(row: ExternalTaskBindingRow): void {
  db.prepare(
    `INSERT INTO external_task_bindings
       (id, provider, external_guid, external_url, source_kind, source_ref_id,
        commitment_unit_id, result_unit_id, status, idempotency_key, raw_json,
        created_at, updated_at)
     VALUES
       (@id, @provider, @external_guid, @external_url, @source_kind, @source_ref_id,
        @commitment_unit_id, @result_unit_id, @status, @idempotency_key, @raw_json,
        @created_at, @updated_at)
     ON CONFLICT(provider, idempotency_key) DO UPDATE SET
       external_guid = excluded.external_guid,
       external_url = excluded.external_url,
       commitment_unit_id = excluded.commitment_unit_id,
       result_unit_id = excluded.result_unit_id,
       status = excluded.status,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`
  ).run(row);
}

export function getExternalTaskBindingByIdempotency(
  provider: string,
  idempotencyKey: string
): ExternalTaskBindingRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM external_task_bindings
         WHERE provider = ? AND idempotency_key = ?`
      )
      .get(provider, idempotencyKey) as ExternalTaskBindingRow | undefined) ?? null
  );
}

export type AttentionEngineRunRow = {
  id: string;
  generation: number;
  trigger: string;                 // 'tick' | 'manual' | 'upsert_hook'
  input_hash: string;
  input_summary_json: string;
  prompt_version: string;
  model_id: string | null;
  status: string;                  // 'ok' | 'failed' | 'cache_hit' | 'skipped_no_change'
  output_text: string | null;
  error: string | null;
  items_emitted: number;
  started_at: string;
  completed_at: string | null;
};

export function insertAttentionEngineRun(row: AttentionEngineRunRow): void {
  db.prepare(
    `INSERT INTO attention_engine_runs
       (id, generation, trigger, input_hash, input_summary_json, prompt_version,
        model_id, status, output_text, error, items_emitted, started_at, completed_at)
     VALUES
       (@id, @generation, @trigger, @input_hash, @input_summary_json, @prompt_version,
        @model_id, @status, @output_text, @error, @items_emitted, @started_at, @completed_at)`
  ).run(row);
}

export function updateAttentionEngineRun(
  id: string,
  patch: Partial<
    Pick<
      AttentionEngineRunRow,
      | 'status'
      | 'output_text'
      | 'error'
      | 'items_emitted'
      | 'model_id'
      | 'completed_at'
      | 'input_summary_json'
    >
  >
): void {
  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = @${k}`);
    params[k] = v ?? null;
  }
  if (fields.length === 0) return;
  db.prepare(
    `UPDATE attention_engine_runs SET ${fields.join(', ')} WHERE id = @id`
  ).run(params);
}

/**
 * 找 TTL 内（以分钟计）同 input_hash 且 status='ok' 的最新一条 run。
 * 用于跳过短时间内的重复推理（节省 LLM 成本）。
 */
export function findRecentAttentionRunByInputHash(
  inputHash: string,
  ttlMinutes: number
): AttentionEngineRunRow | null {
  const cutoff = new Date(Date.now() - ttlMinutes * 60_000).toISOString();
  const row = db
    .prepare(
      `SELECT * FROM attention_engine_runs
       WHERE input_hash = ? AND status = 'ok' AND completed_at IS NOT NULL
         AND completed_at >= ?
       ORDER BY completed_at DESC
       LIMIT 1`
    )
    .get(inputHash, cutoff) as AttentionEngineRunRow | undefined;
  return row ?? null;
}

export function getLastAttentionEngineRun(): AttentionEngineRunRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM attention_engine_runs ORDER BY started_at DESC LIMIT 1`
      )
      .get() as AttentionEngineRunRow | undefined) ?? null
  );
}

export function nextAttentionGeneration(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(generation), 0) AS max_gen FROM attention_engine_runs`
    )
    .get() as { max_gen: number };
  return (row?.max_gen ?? 0) + 1;
}

// ============================================================================
// MVP15A: 图归纳 — entity_edges / work_item_edges / org_project_taxonomy helpers
// 详见 docs/MVP15A-Work-Map-图归纳与协作圈技术方案.md §6 §7.1
// ============================================================================

export type EdgeKind = 'person_person' | 'person_project' | 'project_project';

export type EntityEdgeRow = {
  id: string;
  edge_kind: EdgeKind;
  from_id: string;
  to_id: string;
  role_or_type: string | null;
  weight: number;
  business_relation: string | null;
  shared_ids_json: string | null;
  evidence_unit_ids_json: string;
  detected_at: string;
  last_seen_at: string;
  updated_at: string;
  // MVP15B: LLM 语义标签（详见 docs/MVP15B §4.1）
  decision_authority: string | null;     // 仅 person_project：'high'|'mid'|'low'
  collab_type: string | null;            // 仅 person_person：'collab'|'reviewer_author'|'cross_team'|'mentor'
  llm_classified_at: string | null;      // ISO；< now-14d 视为过期
  llm_why: string | null;                // ≤200 字简释
};

/**
 * upsert 一条 entity_edge。
 * UNIQUE 约束在 (edge_kind, from_id, to_id) 上；命中则更新 weight / role_or_type /
 * business_relation / shared_ids_json / evidence / last_seen_at / updated_at，
 * detected_at 保持首次落库时间。
 *
 * MVP15B：**LLM 标签字段（decision_authority / collab_type / llm_classified_at / llm_why）
 * 不在 upsertEntityEdge 中维护**——这是 inducer 走的边数据通路，LLM 字段由
 * `decisionAuthorityClassifier` / `collabTypeClassifier` 单独 UPDATE。这样 inducer
 * 每次跑不会把 LLM 标签覆盖回 null。
 */
export function upsertEntityEdge(row: EntityEdgeRow): void {
  db.prepare(
    `INSERT INTO entity_edges
       (id, edge_kind, from_id, to_id, role_or_type, weight, business_relation,
        shared_ids_json, evidence_unit_ids_json, detected_at, last_seen_at, updated_at,
        decision_authority, collab_type, llm_classified_at, llm_why)
     VALUES (@id, @edge_kind, @from_id, @to_id, @role_or_type, @weight, @business_relation,
             @shared_ids_json, @evidence_unit_ids_json, @detected_at, @last_seen_at, @updated_at,
             @decision_authority, @collab_type, @llm_classified_at, @llm_why)
     ON CONFLICT(edge_kind, from_id, to_id) DO UPDATE SET
       role_or_type           = excluded.role_or_type,
       weight                 = excluded.weight,
       business_relation      = excluded.business_relation,
       shared_ids_json        = excluded.shared_ids_json,
       evidence_unit_ids_json = excluded.evidence_unit_ids_json,
       last_seen_at           = excluded.last_seen_at,
       updated_at             = excluded.updated_at`
       /* LLM 字段（decision_authority/collab_type/llm_classified_at/llm_why）刻意不在
          ON CONFLICT 分支里更新，避免 inducer 覆盖掉 LLM classifier 之前写入的标签。
          LLM 字段更新走 updateEntityEdgeLlmTags 函数。 */
  ).run(row);
}

/**
 * MVP15B：单独的 LLM 标签更新函数。LLM classifier 分类完后用这个写回。
 * @param updates 部分字段更新——传 null 显式清空，undefined 跳过。
 */
export function updateEntityEdgeLlmTags(
  edgeId: string,
  updates: {
    decision_authority?: string | null;
    collab_type?: string | null;
    llm_why?: string | null;
    llm_classified_at: string;       // 必填，记下分类时间
  }
): void {
  const sets: string[] = ['llm_classified_at = ?'];
  const params: Array<string | null> = [updates.llm_classified_at];
  if (updates.decision_authority !== undefined) {
    sets.push('decision_authority = ?');
    params.push(updates.decision_authority);
  }
  if (updates.collab_type !== undefined) {
    sets.push('collab_type = ?');
    params.push(updates.collab_type);
  }
  if (updates.llm_why !== undefined) {
    sets.push('llm_why = ?');
    params.push(updates.llm_why);
  }
  params.push(edgeId);
  db.prepare(`UPDATE entity_edges SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export type ListEntityEdgesOpts = {
  kind?: EdgeKind;
  fromId?: string;
  toId?: string;
  minWeight?: number;
  limit?: number;
};

export function listEntityEdges(opts: ListEntityEdgesOpts = {}): EntityEdgeRow[] {
  const conds: string[] = [];
  const params: Array<string | number> = [];
  if (opts.kind) {
    conds.push('edge_kind = ?');
    params.push(opts.kind);
  }
  if (opts.fromId) {
    conds.push('from_id = ?');
    params.push(opts.fromId);
  }
  if (opts.toId) {
    conds.push('to_id = ?');
    params.push(opts.toId);
  }
  if (typeof opts.minWeight === 'number') {
    conds.push('weight >= ?');
    params.push(opts.minWeight);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
  const stmt = db.prepare(
    `SELECT * FROM entity_edges ${where} ORDER BY weight DESC, last_seen_at DESC LIMIT ?`
  );
  return stmt.all(...params, limit) as EntityEdgeRow[];
}

/**
 * 删掉 last_seen_at < cutoff 的 entity_edges。**保留 self-anchored 边**（self id
 * 在 from_id 或 to_id 上的）—— 历史协作记忆不丢。返回删除的边数。
 * dryRun=true 时只统计不删（MVP15A 第一周默认 dryRun，见自审 §9 #9）。
 */
export function purgeStaleEntityEdges(
  cutoffIso: string,
  selfEntityId: string | null,
  opts: { dryRun?: boolean } = {}
): { matched: number; deleted: number } {
  const baseWhere = `last_seen_at < ?`;
  const selfGuard = selfEntityId ? ` AND from_id != ? AND to_id != ?` : '';
  const params: Array<string> = [cutoffIso];
  if (selfEntityId) params.push(selfEntityId, selfEntityId);
  const matched = (
    db.prepare(`SELECT COUNT(*) AS n FROM entity_edges WHERE ${baseWhere}${selfGuard}`).get(
      ...params
    ) as { n: number }
  ).n;
  if (opts.dryRun) return { matched, deleted: 0 };
  const res = db
    .prepare(`DELETE FROM entity_edges WHERE ${baseWhere}${selfGuard}`)
    .run(...params);
  return { matched, deleted: res.changes };
}

// -------- work_item_edges --------

export type WorkItemEdgeRow = {
  id: string;
  from_unit_id: string;
  to_unit_id: string;
  type: string;                          // MVP15A: 'follows'
  status: 'active' | 'resolved' | 'stale';
  reason: string;
  evidence_unit_ids_json: string;
  detected_at: string;
  resolved_at: string | null;
  updated_at: string;
};

export function upsertWorkItemEdge(row: WorkItemEdgeRow): void {
  db.prepare(
    `INSERT INTO work_item_edges
       (id, from_unit_id, to_unit_id, type, status, reason,
        evidence_unit_ids_json, detected_at, resolved_at, updated_at)
     VALUES (@id, @from_unit_id, @to_unit_id, @type, @status, @reason,
             @evidence_unit_ids_json, @detected_at, @resolved_at, @updated_at)
     ON CONFLICT(from_unit_id, to_unit_id, type) DO UPDATE SET
       status                 = excluded.status,
       reason                 = excluded.reason,
       evidence_unit_ids_json = excluded.evidence_unit_ids_json,
       resolved_at            = excluded.resolved_at,
       updated_at             = excluded.updated_at`
  ).run(row);
}

export function listWorkItemEdges(
  opts: { fromUnitId?: string; toUnitId?: string; status?: string; limit?: number } = {}
): WorkItemEdgeRow[] {
  const conds: string[] = [];
  const params: Array<string | number> = [];
  if (opts.fromUnitId) {
    conds.push('from_unit_id = ?');
    params.push(opts.fromUnitId);
  }
  if (opts.toUnitId) {
    conds.push('to_unit_id = ?');
    params.push(opts.toUnitId);
  }
  if (opts.status) {
    conds.push('status = ?');
    params.push(opts.status);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
  return db
    .prepare(`SELECT * FROM work_item_edges ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params, limit) as WorkItemEdgeRow[];
}

/** 把 status='active' 但 updated_at 早于 cutoff 的 work_item_edges 转 'stale'。 */
export function markStaleWorkItemEdges(cutoffIso: string): { transitioned: number } {
  const r = db
    .prepare(
      `UPDATE work_item_edges SET status='stale', updated_at=?
       WHERE status='active' AND updated_at < ?`
    )
    .run(new Date().toISOString(), cutoffIso);
  return { transitioned: r.changes };
}

// -------- org_project_taxonomy --------

export type OrgProjectTaxonomyRow = {
  canonical_name: string;
  aliases_json: string;                  // JSON array of strings
  summary: string | null;
  parsed_by: string;
  parsed_at: string;
  // MVP19：层级注册表扩展。两列在迁移后存在但允许 NULL（老行 / 顶层 canonical / 未锚点 canonical）。
  parent_canonical_name?: string | null; // 归属的父 canonical；NULL = 顶层。禁止环。
  authoritative_space_id?: string | null; // 直接对应 context_spaces.id；通常仅父 canonical 填。
};

/**
 * MVP19：alias 跨行唯一性冲突。
 * upsertProjectTaxonomy 在写入前发现 proposed alias 已属于其他 canonical 时抛此错。
 * 调用方应捕获后走显式合并流程（approve_alias / 人工 SQL 改 row），不要静默吞掉。
 */
export class AliasConflictError extends Error {
  readonly alias: string;
  readonly existingCanonical: string;
  readonly proposedCanonical: string;
  constructor(opts: { alias: string; existingCanonical: string; proposedCanonical: string }) {
    super(
      `alias "${opts.alias}" already belongs to canonical "${opts.existingCanonical}", ` +
        `cannot also assign to "${opts.proposedCanonical}"`
    );
    this.name = 'AliasConflictError';
    this.alias = opts.alias;
    this.existingCanonical = opts.existingCanonical;
    this.proposedCanonical = opts.proposedCanonical;
  }
}

export function listProjectTaxonomy(): OrgProjectTaxonomyRow[] {
  return db
    .prepare(`SELECT * FROM org_project_taxonomy ORDER BY canonical_name`)
    .all() as OrgProjectTaxonomyRow[];
}

/**
 * upsert 语义（增量解析关键）：如果 canonical_name 已存在，**aliases 取并集**而非覆盖。
 * 这样后续 LLM run 给同一 canonical 加了新 alias 不会把老 alias 丢掉。
 * summary 走"新值覆盖空值"策略——新 row.summary 非空就用，空则保留旧值。
 *
 * MVP19 扩展：
 *  - 顶部加 alias 跨行唯一性检查（lower-case 比较）。如果 proposed alias 已属于
 *    其他 canonical 行，throw AliasConflictError，要求显式合并。这是为了防止
 *    LLM 把同一 alias 同时归到两个 canonical 引发后续 resolve 歧义。
 *  - 接受可选 parent_canonical_name / authoritative_space_id；同样走"新值覆盖空值"，
 *    且只在 row 显式传入（非 undefined）时才考虑覆盖；传 null 则强制清空。
 */
export function upsertProjectTaxonomy(row: OrgProjectTaxonomyRow): void {
  // ----- MVP19: alias 跨行唯一性检查 -----
  let proposedAliases: string[] = [];
  try {
    const parsed = JSON.parse(row.aliases_json);
    if (Array.isArray(parsed)) {
      proposedAliases = parsed.filter((s): s is string => typeof s === 'string');
    }
  } catch {
    // proposed aliases 解析失败时退到空集，不参与冲突检查
  }
  if (proposedAliases.length > 0) {
    const proposedLowerSet = new Set(proposedAliases.map((s) => s.trim().toLowerCase()));
    // SQLite LIKE 默认大小写不敏感（针对 ASCII），中文走字面包含；
    // 我们只需要扫除自身以外的 row，应用层 lower 比对。
    const others = db
      .prepare(
        `SELECT canonical_name, aliases_json FROM org_project_taxonomy
          WHERE canonical_name <> ?`
      )
      .all(row.canonical_name) as Array<{ canonical_name: string; aliases_json: string }>;
    for (const other of others) {
      let otherAliases: unknown;
      try {
        otherAliases = JSON.parse(other.aliases_json);
      } catch {
        continue;
      }
      if (!Array.isArray(otherAliases)) continue;
      for (const a of otherAliases) {
        if (typeof a !== 'string') continue;
        const lower = a.trim().toLowerCase();
        if (proposedLowerSet.has(lower)) {
          throw new AliasConflictError({
            alias: a,
            existingCanonical: other.canonical_name,
            proposedCanonical: row.canonical_name,
          });
        }
      }
    }
  }
  // ----- 原有 upsert 路径 -----
  const existing = (
    db
      .prepare(`SELECT * FROM org_project_taxonomy WHERE canonical_name = ?`)
      .get(row.canonical_name) as OrgProjectTaxonomyRow | undefined
  );
  if (!existing) {
    db.prepare(
      `INSERT INTO org_project_taxonomy
         (canonical_name, aliases_json, summary, parsed_by, parsed_at,
          parent_canonical_name, authoritative_space_id)
       VALUES (@canonical_name, @aliases_json, @summary, @parsed_by, @parsed_at,
               @parent_canonical_name, @authoritative_space_id)`
    ).run({
      canonical_name: row.canonical_name,
      aliases_json: row.aliases_json,
      summary: row.summary,
      parsed_by: row.parsed_by,
      parsed_at: row.parsed_at,
      parent_canonical_name: row.parent_canonical_name ?? null,
      authoritative_space_id: row.authoritative_space_id ?? null,
    });
    return;
  }
  // 合并 aliases：并集
  let oldAliases: unknown;
  try {
    oldAliases = JSON.parse(existing.aliases_json);
  } catch {
    oldAliases = [];
  }
  let newAliases: unknown;
  try {
    newAliases = JSON.parse(row.aliases_json);
  } catch {
    newAliases = [];
  }
  const merged = Array.from(
    new Set([
      ...((Array.isArray(oldAliases) ? oldAliases : []) as string[]),
      ...((Array.isArray(newAliases) ? newAliases : []) as string[]),
    ].filter((s): s is string => typeof s === 'string'))
  );
  const mergedSummary = (row.summary && row.summary.trim()) || existing.summary;
  // parent / authoritative_space_id：undefined = 保持现状；null = 显式清空；非空 = 覆盖
  const mergedParent =
    row.parent_canonical_name === undefined
      ? existing.parent_canonical_name ?? null
      : row.parent_canonical_name;
  const mergedAuthSpace =
    row.authoritative_space_id === undefined
      ? existing.authoritative_space_id ?? null
      : row.authoritative_space_id;
  db.prepare(
    `UPDATE org_project_taxonomy
       SET aliases_json=?, summary=?, parsed_by=?, parsed_at=?,
           parent_canonical_name=?, authoritative_space_id=?
       WHERE canonical_name=?`
  ).run(
    JSON.stringify(merged),
    mergedSummary,
    row.parsed_by,
    row.parsed_at,
    mergedParent,
    mergedAuthSpace,
    row.canonical_name
  );
}

/**
 * 给定 entity 名，返回对应 canonical_name；缓存里没找到返回原名（不做隐式合并）。
 * 实现：SQL LIKE 粗筛后应用层精确匹配（aliases_json 是 JSON 数组字符串）。
 * 性能：org_project_taxonomy 行数通常 ≤80，全表 LIKE 是 O(N)；不引入额外缓存。
 *
 * MVP19：alias 比较改为大小写不敏感（lower(input) === lower(alias)），
 * 但注册表存储仍保持原始大小写（人类可读）。canonical_name 仍是 PK 大小写敏感，
 * 避免 'Chatbot' 和 'chatbot' 共存两行——upsert 入口做规范化。
 */
export function resolveProjectCanonical(entityName: string): string {
  const trimmed = entityName.trim();
  if (!trimmed) return entityName;
  const trimmedLower = trimmed.toLowerCase();
  // 粗筛：LIKE 用 lower-case 输入；SQLite 默认 LIKE 大小写不敏感（针对 ASCII），
  // 中文不受影响，仍走字面包含。比 substring 多查若干候选，应用层用 lower 精筛。
  const candidates = db
    .prepare(
      `SELECT canonical_name, aliases_json FROM org_project_taxonomy
        WHERE aliases_json LIKE ?`
    )
    .all(`%${trimmed.replace(/[%_]/g, '\\$&')}%`) as Array<{
    canonical_name: string;
    aliases_json: string;
  }>;
  for (const c of candidates) {
    let arr: unknown;
    try {
      arr = JSON.parse(c.aliases_json);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    if (
      arr.some(
        (a) => typeof a === 'string' && a.trim().toLowerCase() === trimmedLower
      )
    ) {
      return c.canonical_name;
    }
  }
  return entityName;
}

// ----- MVP19：层级展开 helpers -----

/**
 * 从给定 canonical_name 沿 parent_canonical_name 上溯到 NULL 为止，
 * 组成祖先链（不含自身）。canonical 不存在返回 []。
 *
 * 环防护：traversal 超过 32 层立刻 throw + 写 audit。
 * （正常树深度远小于 32；触到这个边界一定是数据出错。）
 */
const PROJECT_ANCESTOR_MAX_DEPTH = 32;
export function getProjectAncestorChain(canonical: string): string[] {
  const chain: string[] = [];
  let cur: string | null = canonical;
  const seen = new Set<string>([canonical]);
  for (let depth = 0; depth < PROJECT_ANCESTOR_MAX_DEPTH; depth++) {
    const row = db
      .prepare(
        `SELECT parent_canonical_name FROM org_project_taxonomy
          WHERE canonical_name = ?`
      )
      .get(cur) as { parent_canonical_name: string | null } | undefined;
    if (!row) return chain; // canonical 不存在或无父
    const parent = row.parent_canonical_name;
    if (!parent) return chain;
    if (seen.has(parent)) {
      // 检测到环；写 audit 帮排查（auditLog 单独 import 太重，留 console.error + throw）
      console.error(
        `[projectTaxonomy] cycle detected at canonical="${cur}" -> parent="${parent}" ` +
          `(chain so far: ${[...chain, parent].join(' -> ')})`
      );
      throw new Error(
        `project canonical hierarchy cycle detected at "${parent}" (chain: ${chain.join(' -> ')})`
      );
    }
    seen.add(parent);
    chain.push(parent);
    cur = parent;
  }
  // 超过最大深度也按异常处理
  console.error(
    `[projectTaxonomy] ancestor chain exceeded max depth ${PROJECT_ANCESTOR_MAX_DEPTH} ` +
      `starting from "${canonical}", chain so far: ${chain.join(' -> ')}`
  );
  throw new Error(
    `project canonical hierarchy depth exceeded ${PROJECT_ANCESTOR_MAX_DEPTH} starting from "${canonical}"`
  );
}

/**
 * 便利函数：resolveProjectCanonical(name) ∪ getProjectAncestorChain(canonical)。
 * 给 selfCollaboratorRanking / resolveUnitToSpaces 等需要求"同业务大盘"交集的下游用。
 */
export function getProjectCanonicalSet(name: string): Set<string> {
  const canonical = resolveProjectCanonical(name);
  const set = new Set<string>([canonical]);
  for (const ancestor of getProjectAncestorChain(canonical)) set.add(ancestor);
  return set;
}

/**
 * 反查：给定 canonical_name，返回它直接对应的 context_spaces.id（如有）。
 * 不沿 parent 链向上找——调用方按需自己组合 getProjectAncestorChain。
 */
export function getProjectAuthoritativeSpaceId(canonical: string): string | null {
  const row = db
    .prepare(
      `SELECT authoritative_space_id FROM org_project_taxonomy
        WHERE canonical_name = ?`
    )
    .get(canonical) as { authoritative_space_id: string | null } | undefined;
  return row?.authoritative_space_id ?? null;
}

/**
 * MVP19 §E：渲染 <knownProjects> XML 块，注入到 triage user message。
 *
 * 顶层：parent_canonical_name IS NULL 的 canonical（即注册表里的"根"）。
 *   排序：先有 authoritative_space_id 的（user-curated space），
 *         然后按最近 30d 是否被 person_project edge 引用，
 *         最后按 canonical_name 字母序兜底。
 *   每行：`- "canonical" (alias: "a", "b")`
 *         若有子：换行 `  sub: "child1", "child2", ...`
 *
 * 截断：当顶层超过 maxTopLevel（默认 100）行时按上述排序截断。
 *       每条 alias 取前 5，sub 取前 8，超出 ` …`。
 *
 * 用途：仅 triagePrompt.buildTriageUserMessage 用。其他场景不要复用。
 */
export type BuildKnownProjectsOpts = {
  maxTopLevel?: number;          // 默认 100
  recentEdgeWindowMs?: number;   // "最近 30d" 默认 30*24h
  now?: number;                  // 测试可注入
};
export function buildKnownProjectsBlock(opts: BuildKnownProjectsOpts = {}): string {
  const maxTopLevel = opts.maxTopLevel ?? 100;
  const recentMs = opts.recentEdgeWindowMs ?? 30 * 24 * 3600_000;
  const nowMs = opts.now ?? Date.now();
  const recentCutoff = new Date(nowMs - recentMs).toISOString();

  type Row = {
    canonical_name: string;
    aliases_json: string;
    authoritative_space_id: string | null;
  };
  const tops = db
    .prepare(
      `SELECT canonical_name, aliases_json, authoritative_space_id
         FROM org_project_taxonomy
        WHERE parent_canonical_name IS NULL`
    )
    .all() as Row[];

  // 取每个顶层是否近期被 person_project edge 引用
  const recentRefSet = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT to_id FROM entity_edges
            WHERE edge_kind='person_project' AND last_seen_at >= ?`
        )
        .all(recentCutoff) as Array<{ to_id: string }>
    ).map((r) => r.to_id)
  );

  // 排序：authoritative_space_id 优先，然后 recent edge ref，然后字母序
  tops.sort((a, b) => {
    const aHasSpace = a.authoritative_space_id ? 1 : 0;
    const bHasSpace = b.authoritative_space_id ? 1 : 0;
    if (aHasSpace !== bHasSpace) return bHasSpace - aHasSpace;
    const aRecent = recentRefSet.has(a.canonical_name) ? 1 : 0;
    const bRecent = recentRefSet.has(b.canonical_name) ? 1 : 0;
    if (aRecent !== bRecent) return bRecent - aRecent;
    return a.canonical_name.localeCompare(b.canonical_name);
  });

  const truncated = tops.length > maxTopLevel;
  const renderTops = tops.slice(0, maxTopLevel);

  // 拉所有 children（一次查询，按 parent 索引）
  const allChildren = db
    .prepare(
      `SELECT canonical_name, parent_canonical_name FROM org_project_taxonomy
        WHERE parent_canonical_name IS NOT NULL
        ORDER BY canonical_name`
    )
    .all() as Array<{ canonical_name: string; parent_canonical_name: string }>;
  const childrenByParent = new Map<string, string[]>();
  for (const c of allChildren) {
    const arr = childrenByParent.get(c.parent_canonical_name) ?? [];
    arr.push(c.canonical_name);
    childrenByParent.set(c.parent_canonical_name, arr);
  }

  const lines: string[] = [];
  lines.push(`<knownProjects count="${tops.length}"${truncated ? ' truncated="true"' : ''}>`);
  for (const t of renderTops) {
    let aliases: string[] = [];
    try {
      const parsed = JSON.parse(t.aliases_json);
      if (Array.isArray(parsed)) {
        aliases = parsed.filter((s): s is string => typeof s === 'string' && s !== t.canonical_name);
      }
    } catch {}
    const aliasPart =
      aliases.length > 0
        ? ` (alias: ${aliases.slice(0, 5).map((a) => `"${a}"`).join(', ')}${
            aliases.length > 5 ? ' …' : ''
          })`
        : '';
    lines.push(`- "${t.canonical_name}"${aliasPart}`);
    const subs = childrenByParent.get(t.canonical_name) ?? [];
    if (subs.length > 0) {
      const subPart = subs.slice(0, 8).map((s) => `"${s}"`).join(', ');
      const more = subs.length > 8 ? ' …' : '';
      lines.push(`  sub: ${subPart}${more}`);
    }
  }
  lines.push('</knownProjects>');
  return lines.join('\n');
}

/**
 * MVP19 §E-1：把 triage LLM 抽出的"不在 knownProjects 里的项目名"upsert 进
 * project_canonical_proposals 队列。
 *
 * 语义：
 *  - pending 状态下同名行最多一行（partial UNIQUE 保证）；
 *  - 已存在 pending 行 → bump occurrences、更新 last_seen_at、
 *    累加 source_unit_ids（保留近 20 条避免无限增长）；
 *  - 不存在 pending 行 → INSERT 新行 status='pending', occurrences=1。
 *
 * idGen 默认走 randomUUID，测试可注入。
 */
export type UpsertProposalInput = {
  proposedName: string;
  sourceUnitIds: string[];
  sourceEventId?: string | null;
};
const PROPOSAL_SOURCE_UNIT_IDS_CAP = 20;
export function upsertProjectCanonicalProposal(
  input: UpsertProposalInput,
  opts: { idGen?: () => string; now?: () => string } = {}
): { id: string; created: boolean; occurrences: number } {
  const idGen = opts.idGen ?? (() => randomUUID());
  const nowFn = opts.now ?? (() => new Date().toISOString());
  const nowIso = nowFn();
  const proposedName = input.proposedName.trim();
  if (!proposedName) {
    throw new Error('upsertProjectCanonicalProposal: proposedName empty');
  }
  const existing = db
    .prepare(
      `SELECT id, occurrences, source_unit_ids_json
         FROM project_canonical_proposals
        WHERE proposed_name = ? AND status = 'pending'`
    )
    .get(proposedName) as
    | { id: string; occurrences: number; source_unit_ids_json: string }
    | undefined;
  if (existing) {
    let oldIds: string[] = [];
    try {
      const parsed = JSON.parse(existing.source_unit_ids_json);
      if (Array.isArray(parsed)) oldIds = parsed.filter((s): s is string => typeof s === 'string');
    } catch {}
    const mergedIds = Array.from(new Set([...oldIds, ...input.sourceUnitIds]))
      .slice(-PROPOSAL_SOURCE_UNIT_IDS_CAP);
    const newOcc = existing.occurrences + 1;
    db.prepare(
      `UPDATE project_canonical_proposals
          SET occurrences=?, source_unit_ids_json=?, last_seen_at=?
        WHERE id=?`
    ).run(newOcc, JSON.stringify(mergedIds), nowIso, existing.id);
    return { id: existing.id, created: false, occurrences: newOcc };
  }
  const id = idGen();
  db.prepare(
    `INSERT INTO project_canonical_proposals
       (id, proposed_name, source_unit_ids_json, source_event_id, occurrences,
        first_seen_at, last_seen_at, status)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'pending')`
  ).run(
    id,
    proposedName,
    JSON.stringify(input.sourceUnitIds.slice(-PROPOSAL_SOURCE_UNIT_IDS_CAP)),
    input.sourceEventId ?? null,
    nowIso,
    nowIso
  );
  return { id, created: true, occurrences: 1 };
}

/**
 * MVP19 §M4：列出待审核 proposals（status='pending'），按 last_seen_at 倒序。
 */
export type ProjectCanonicalProposalRow = {
  id: string;
  proposed_name: string;
  source_unit_ids_json: string;
  source_event_id: string | null;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  status: 'pending' | 'approved_new' | 'approved_alias' | 'rejected';
  resolved_canonical_name: string | null;
  resolved_as_parent_canonical: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
};
export function listPendingProjectProposals(
  limit = 200
): ProjectCanonicalProposalRow[] {
  return db
    .prepare(
      `SELECT * FROM project_canonical_proposals
        WHERE status='pending'
        ORDER BY last_seen_at DESC
        LIMIT ?`
    )
    .all(limit) as ProjectCanonicalProposalRow[];
}

export function getProjectProposal(id: string): ProjectCanonicalProposalRow | null {
  const r = db
    .prepare(`SELECT * FROM project_canonical_proposals WHERE id=?`)
    .get(id) as ProjectCanonicalProposalRow | undefined;
  return r ?? null;
}

/**
 * 把一条 proposal 标记为已处理。调用方负责事先做实际的 taxonomy 写入
 * （insert canonical / append alias），本函数只更新 proposal 行的 status/resolved_* 字段。
 *
 * status:
 *  - 'approved_new'   → resolution.canonical = 新 canonical 名（通常 = proposed_name）
 *                       resolution.parentCanonical 可选
 *  - 'approved_alias' → resolution.canonical = 已存在的 target canonical
 *  - 'rejected'       → resolution 可省略
 */
export type ResolveProposalInput =
  | { id: string; status: 'approved_new'; canonical: string; parentCanonical?: string | null; resolvedBy?: string }
  | { id: string; status: 'approved_alias'; canonical: string; resolvedBy?: string }
  | { id: string; status: 'rejected'; resolvedBy?: string };

export function resolveProjectProposalStatus(input: ResolveProposalInput): void {
  const nowIso = new Date().toISOString();
  if (input.status === 'rejected') {
    db.prepare(
      `UPDATE project_canonical_proposals
          SET status='rejected', resolved_by=?, resolved_at=?
        WHERE id=?`
    ).run(input.resolvedBy ?? 'user', nowIso, input.id);
    return;
  }
  if (input.status === 'approved_alias') {
    db.prepare(
      `UPDATE project_canonical_proposals
          SET status='approved_alias',
              resolved_canonical_name=?,
              resolved_by=?, resolved_at=?
        WHERE id=?`
    ).run(input.canonical, input.resolvedBy ?? 'user', nowIso, input.id);
    return;
  }
  // approved_new
  db.prepare(
    `UPDATE project_canonical_proposals
        SET status='approved_new',
            resolved_canonical_name=?,
            resolved_as_parent_canonical=?,
            resolved_by=?, resolved_at=?
      WHERE id=?`
  ).run(
    input.canonical,
    input.parentCanonical ?? null,
    input.resolvedBy ?? 'user',
    nowIso,
    input.id
  );
}

// ============================================================================
// MVP15B: org_project_phase helpers（LLM 判定的项目阶段 + 健康度）
// 详见 docs/MVP15B §4.2
// ============================================================================

export type OrgProjectPhaseRow = {
  canonical_name: string;
  phase: string | null;
  health: string | null;
  health_evidence_unit_ids_json: string | null;
  summary: string | null;
  llm_classified_at: string;
  ttl_until: string;
};

export function getProjectPhase(canonicalName: string): OrgProjectPhaseRow | null {
  return (
    (db
      .prepare(`SELECT * FROM org_project_phase WHERE canonical_name = ?`)
      .get(canonicalName) as OrgProjectPhaseRow | undefined) ?? null
  );
}

/** 返回所有 canonical_name 中 ttl_until < nowIso 的（含从未分类过的）。 */
export function listProjectPhasesNeedingRefresh(
  allCanonicalNames: string[],
  nowIso: string
): string[] {
  if (allCanonicalNames.length === 0) return [];
  const placeholders = allCanonicalNames.map(() => '?').join(',');
  const existing = db
    .prepare(
      `SELECT canonical_name, ttl_until FROM org_project_phase
        WHERE canonical_name IN (${placeholders})`
    )
    .all(...allCanonicalNames) as Array<{ canonical_name: string; ttl_until: string }>;
  const existingMap = new Map(existing.map((r) => [r.canonical_name, r.ttl_until]));
  return allCanonicalNames.filter((name) => {
    const ttl = existingMap.get(name);
    return !ttl || ttl < nowIso; // 没记录 OR 过期
  });
}

export function upsertProjectPhase(row: OrgProjectPhaseRow): void {
  db.prepare(
    `INSERT INTO org_project_phase
       (canonical_name, phase, health, health_evidence_unit_ids_json,
        summary, llm_classified_at, ttl_until)
     VALUES (@canonical_name, @phase, @health, @health_evidence_unit_ids_json,
             @summary, @llm_classified_at, @ttl_until)
     ON CONFLICT(canonical_name) DO UPDATE SET
       phase                         = excluded.phase,
       health                        = excluded.health,
       health_evidence_unit_ids_json = excluded.health_evidence_unit_ids_json,
       summary                       = excluded.summary,
       llm_classified_at             = excluded.llm_classified_at,
       ttl_until                     = excluded.ttl_until`
  ).run(row);
}

// ============ MVP26 Matter 事务状态层 ============
// Row 类型 + 原子 CRUD helper。domain 映射、业务规则、reducer 都在 matter/* 里，
// 这里只负责 SQL。schema 见本文件上方 `-- MVP26 Matter 事务状态层` 区段。

// -------- matters --------

export type MatterRow = {
  id: string;
  subject_id: string;
  scope: string;
  type: string;
  title: string;
  canonical_key: string;
  status: string;
  priority: string;
  owner_entity_id: string | null;
  primary_space_id: string | null;
  due_at: string | null;
  current_summary: string;
  next_action: string | null;
  created_from_context_unit_id: string;
  last_evidence_context_unit_id: string | null;
  last_evidence_at: string | null;
  confidence: number;
  reopened_count: number;
  version: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  dropped_at: string | null;
  // MVP32: 仅读取路径（SELECT *）水合；matterToRow 不映射此字段——insertMatter/updateMatter 的
  // 命名参数 SQL 没有 @resolve_verification_json，对象多带这个 key 会被 better-sqlite3 拒绝。
  resolve_verification_json?: string | null;
};

export function insertMatter(row: MatterRow): void {
  db.prepare(
    `INSERT INTO matters
       (id, subject_id, scope, type, title, canonical_key, status, priority,
        owner_entity_id, primary_space_id, due_at, current_summary, next_action,
        created_from_context_unit_id, last_evidence_context_unit_id, last_evidence_at,
        confidence, reopened_count, version, created_at, updated_at, resolved_at, dropped_at)
     VALUES (@id, @subject_id, @scope, @type, @title, @canonical_key, @status, @priority,
             @owner_entity_id, @primary_space_id, @due_at, @current_summary, @next_action,
             @created_from_context_unit_id, @last_evidence_context_unit_id, @last_evidence_at,
             @confidence, @reopened_count, @version, @created_at, @updated_at, @resolved_at, @dropped_at)`
  ).run(row);
}

export function updateMatter(row: MatterRow): void {
  db.prepare(
    `UPDATE matters SET
       subject_id = @subject_id, scope = @scope, type = @type, title = @title,
       canonical_key = @canonical_key, status = @status, priority = @priority,
       owner_entity_id = @owner_entity_id, primary_space_id = @primary_space_id, due_at = @due_at,
       current_summary = @current_summary, next_action = @next_action,
       last_evidence_context_unit_id = @last_evidence_context_unit_id,
       last_evidence_at = @last_evidence_at, confidence = @confidence,
       reopened_count = @reopened_count, version = @version, updated_at = @updated_at,
       resolved_at = @resolved_at, dropped_at = @dropped_at
     WHERE id = @id`
  ).run(row);
}

export function getMatter(id: string): MatterRow | null {
  return (db.prepare(`SELECT * FROM matters WHERE id = ?`).get(id) as MatterRow | undefined) ?? null;
}

// MVP32: 办结核实结果专用单列 UPDATE（不走 updateMatter，避免被 saveMatter 全量覆盖语义裹挟；
// 也不 bump version/updated_at——verification 是元数据，不代表事项本身有新动静）。
export function updateMatterResolveVerification(id: string, json: string | null): void {
  db.prepare(`UPDATE matters SET resolve_verification_json = ? WHERE id = ?`).run(json, id);
}

// MVP26 backfill 幂等：一条 commitment 只 seed 一个 Matter。
export function getMatterByCreatedFrom(contextUnitId: string): MatterRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM matters WHERE created_from_context_unit_id = ? ORDER BY created_at ASC LIMIT 1`
      )
      .get(contextUnitId) as MatterRow | undefined) ?? null
  );
}

// canonical_key 用于候选召回，不是 DB 硬唯一（见 §5.1）；这里取最近更新的活跃 Matter。
export function getActiveMatterByCanonicalKey(
  subjectId: string,
  canonicalKey: string
): MatterRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM matters
           WHERE subject_id = ? AND canonical_key = ?
             AND status NOT IN ('resolved','dropped')
           ORDER BY updated_at DESC LIMIT 1`
      )
      .get(subjectId, canonicalKey) as MatterRow | undefined) ?? null
  );
}

export function listMatterRows(
  opts: { statuses?: string[]; limit?: number; updatedSince?: string } = {}
): MatterRow[] {
  const limit = opts.limit ?? 200;
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (opts.statuses && opts.statuses.length) {
    const ph = opts.statuses.map((_, i) => `@s${i}`);
    where.push(`status IN (${ph.join(',')})`);
    opts.statuses.forEach((s, i) => {
      params[`s${i}`] = s;
    });
  }
  if (opts.updatedSince) {
    where.push('updated_at >= @updated_since');
    params.updated_since = opts.updatedSince;
  }
  const sql = `SELECT * FROM matters${where.length ? ' WHERE ' + where.join(' AND ') : ''}
               ORDER BY updated_at DESC LIMIT @limit`;
  return db.prepare(sql).all(params) as MatterRow[];
}

// -------- matter_entities --------

export type MatterEntityRow = {
  matter_id: string;
  entity_id: string;
  role: string;
  confidence: number;
  created_at: string;
};

export function upsertMatterEntity(row: MatterEntityRow): void {
  db.prepare(
    `INSERT INTO matter_entities (matter_id, entity_id, role, confidence, created_at)
     VALUES (@matter_id, @entity_id, @role, @confidence, @created_at)
     ON CONFLICT(matter_id, entity_id, role) DO UPDATE SET
       confidence = excluded.confidence`
  ).run(row);
}

export function listMatterEntityRows(matterId: string): MatterEntityRow[] {
  return db
    .prepare(`SELECT * FROM matter_entities WHERE matter_id = ?`)
    .all(matterId) as MatterEntityRow[];
}

// -------- matter_context_links --------

export type MatterContextLinkRow = {
  matter_id: string;
  context_unit_id: string;
  relation: string;
  effect: string;
  confidence: number;
  reason: string;
  created_at: string;
};

export function upsertMatterContextLink(row: MatterContextLinkRow): void {
  db.prepare(
    `INSERT INTO matter_context_links
       (matter_id, context_unit_id, relation, effect, confidence, reason, created_at)
     VALUES (@matter_id, @context_unit_id, @relation, @effect, @confidence, @reason, @created_at)
     ON CONFLICT(matter_id, context_unit_id, relation) DO UPDATE SET
       effect = excluded.effect, confidence = excluded.confidence, reason = excluded.reason`
  ).run(row);
}

export function listMatterContextLinkRows(matterId: string): MatterContextLinkRow[] {
  return db
    .prepare(`SELECT * FROM matter_context_links WHERE matter_id = ? ORDER BY created_at ASC`)
    .all(matterId) as MatterContextLinkRow[];
}

// /api/context/units/:id/matters：反查一条 ContextUnit 影响了哪些 Matter。
export function listMatterLinksForContextUnit(contextUnitId: string): MatterContextLinkRow[] {
  return db
    .prepare(
      `SELECT * FROM matter_context_links WHERE context_unit_id = ? ORDER BY created_at ASC`
    )
    .all(contextUnitId) as MatterContextLinkRow[];
}

// MVP29：用户纠错（wrong-evidence / split）需要把某 (matter, unit) 的所有关系行删掉再重写。
export function deleteMatterContextLinksForPair(matterId: string, contextUnitId: string): number {
  const r = db
    .prepare(`DELETE FROM matter_context_links WHERE matter_id = ? AND context_unit_id = ?`)
    .run(matterId, contextUnitId);
  return r.changes;
}

// -------- matter_transitions --------

export type MatterTransitionRow = {
  id: string;
  matter_id: string;
  from_status: string | null;
  to_status: string;
  trigger_context_unit_id: string;
  effect: string;
  reason: string;
  confidence: number;
  created_at: string;
};

export function insertMatterTransition(row: MatterTransitionRow): void {
  db.prepare(
    `INSERT INTO matter_transitions
       (id, matter_id, from_status, to_status, trigger_context_unit_id, effect, reason, confidence, created_at)
     VALUES (@id, @matter_id, @from_status, @to_status, @trigger_context_unit_id, @effect, @reason, @confidence, @created_at)`
  ).run(row);
}

export function listMatterTransitionRows(matterId: string): MatterTransitionRow[] {
  return db
    .prepare(`SELECT * FROM matter_transitions WHERE matter_id = ? ORDER BY created_at ASC`)
    .all(matterId) as MatterTransitionRow[];
}

// -------- matter_observations (MVP29) --------

export type MatterObservationRow = {
  id: string;
  source_event_id: string;
  context_unit_ids_json: string;
  observation_type: string;
  matter_type: string;
  title: string;
  lifecycle_effect: string | null;
  evidence: string;
  confidence: number;
  candidate_matter_ids_json: string;
  raw_json: string;
  created_at: string;
  // MVP33 U2：消费标记（NULL=未消费）。consume_result 形如 'attach:progress:applied' / 'delegated_to_reducer'。
  consumed_at: string | null;
  consume_result: string | null;
};

export function insertMatterObservation(row: MatterObservationRow): void {
  db.prepare(
    `INSERT INTO matter_observations
       (id, source_event_id, context_unit_ids_json, observation_type, matter_type, title,
        lifecycle_effect, evidence, confidence, candidate_matter_ids_json, raw_json, created_at,
        consumed_at, consume_result)
     VALUES (@id, @source_event_id, @context_unit_ids_json, @observation_type, @matter_type, @title,
             @lifecycle_effect, @evidence, @confidence, @candidate_matter_ids_json, @raw_json, @created_at,
             @consumed_at, @consume_result)`
  ).run(row);
}

export function getMatterObservationRow(id: string): MatterObservationRow | null {
  return (
    (db.prepare(`SELECT * FROM matter_observations WHERE id = ?`).get(id) as
      | MatterObservationRow
      | undefined) ?? null
  );
}

/** MVP33 U2：消费销账。candidateMatterIdsJson 可选回写（补上 MVP29 预留未用的字段）。 */
export function markMatterObservationConsumed(
  id: string,
  consumedAt: string,
  consumeResult: string,
  candidateMatterIdsJson?: string
): void {
  if (candidateMatterIdsJson !== undefined) {
    db.prepare(
      `UPDATE matter_observations
       SET consumed_at = ?, consume_result = ?, candidate_matter_ids_json = ?
       WHERE id = ?`
    ).run(consumedAt, consumeResult, candidateMatterIdsJson, id);
  } else {
    db.prepare(
      `UPDATE matter_observations SET consumed_at = ?, consume_result = ? WHERE id = ?`
    ).run(consumedAt, consumeResult, id);
  }
}

/** MVP33 U2：启动补扫——窗口内未消费、带 lifecycle_effect 的观察（fire-and-forget 丢失的 in-flight）。 */
export function listUnconsumedMatterObservationRows(
  createdAfterIso: string,
  limit = 50
): MatterObservationRow[] {
  return db
    .prepare(
      `SELECT * FROM matter_observations
       WHERE consumed_at IS NULL AND lifecycle_effect IS NOT NULL AND created_at > ?
       ORDER BY created_at ASC LIMIT ?`
    )
    .all(createdAfterIso, limit) as MatterObservationRow[];
}

export function listMatterObservationsBySourceEvent(eventId: string): MatterObservationRow[] {
  return db
    .prepare(
      `SELECT * FROM matter_observations WHERE source_event_id = ? ORDER BY created_at ASC`
    )
    .all(eventId) as MatterObservationRow[];
}
