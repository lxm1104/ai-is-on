/**
 * MVP12 §5 Phase 2 — chat_affinity suggestion worker。
 *
 * 目标：扫近 7 天的 unit_routing_cache + context_unit_entities，给每个 chat entity
 * 计算与每个 active Space 的"亲和力 score"，超阈值产 'suggested'。用户在 Space
 * 详情页 confirm 后该 chat 才会成为 Space seed。
 *
 * 关键约束（来自 §5.1 + R3 收敛）：
 *   - BIG_CHAT_FILTER: distinct_senders > 30 OR (units > 200 AND distinct_senders > 30)
 *     —— 大群完全跳过，避免 noisy 推荐
 *   - direct_hits 只算 link_type ∈ {about, about_via_doc}，**排除 about_via_chat**
 *     —— 否则形成自激励循环（chat seed 命中 → direct_hits ↑ → score ↑ → 更易被
 *     confirm 更多 chat seed）
 *   - chat_persons 必须从 context_unit_entities 取（type='person'），
 *     **不能** 从 routing cache 取（cache 只含 chat/doc/app）
 *   - 已 confirmed 跳过；rejected 且 cooldown_until > now 跳过；suggested 更新 score
 *
 * Phase 3 一并实现：person_co_occur advisory（chat 与 Space seed person 共现≥5）。
 *
 * 触发方式：手动 POST /api/admin/run-suggestion-worker。
 * 后续可挂定时器（每 6h）。
 */
import { randomUUID } from 'node:crypto';
import {
  db,
  getContextEntityById,
  listContextSpaces,
  listSpaceLinks,
  type ContextEntityRow,
  type ContextSpaceLinkRow,
} from '../db.js';

// ---------- 配置 ----------

const RECENT_DAYS_PRIMARY = 7;
const RECENT_DAYS_PERSON_CO_OCCUR = 30;
const BIG_CHAT_SENDER_CAP = 30;
const BIG_CHAT_UNIT_CAP = 200;
const SCORE_THRESHOLD_DIRECT = 3;
const SCORE_THRESHOLD_PERSON = 2;
const SCORE_THRESHOLD_DOC = 1;
const PERSON_CO_OCCUR_THRESHOLD = 5;

// ---------- 公共数据 ----------

type ChatEntity = ContextEntityRow & { type: 'chat' };

function listChatEntities(): ChatEntity[] {
  return db
    .prepare(`SELECT * FROM context_entities WHERE type = 'chat'`)
    .all() as ChatEntity[];
}

function listActiveSpacesWithSeeds(): Array<{
  spaceId: string;
  personSeedIds: Set<string>;
  docSeedIds: Set<string>;
  chatSeedIds: Set<string>;
}> {
  const spaces = listContextSpaces({ status: 'active' });
  const out: Array<{
    spaceId: string;
    personSeedIds: Set<string>;
    docSeedIds: Set<string>;
    chatSeedIds: Set<string>;
  }> = [];
  for (const s of spaces) {
    const links = listSpaceLinks(s.id).filter(
      (l) => l.target_type === 'entity'
    );
    const persons = new Set<string>();
    const docs = new Set<string>();
    const chats = new Set<string>();
    for (const l of links) {
      const ent = getContextEntityById(l.target_id);
      if (!ent) continue;
      if (ent.type === 'person') persons.add(ent.id);
      else if (ent.type === 'doc') docs.add(ent.id);
      else if (ent.type === 'chat') chats.add(ent.id);
    }
    out.push({
      spaceId: s.id,
      personSeedIds: persons,
      docSeedIds: docs,
      chatSeedIds: chats,
    });
  }
  return out;
}

// 一个 chat entity 关联的 active unit 集合：
//   event unit → 直接通过 context_unit_entities 关联
//   semantic unit → 通过 unit_sources 关联到 event unit，再传递
function unitsForChatEntity(chatEntityId: string, sinceIso: string): Array<{
  unitId: string;
  kind: string;
  updatedAt: string;
}> {
  // 先找直接挂 chat 的 event units
  const eventUnits = db
    .prepare(
      `SELECT cu.id as id, cu.origin_ref_id as event_id, cu.kind as kind, cu.updated_at as updated_at
       FROM context_units cu
       JOIN context_unit_entities cue ON cu.id = cue.context_unit_id
       WHERE cue.entity_id = ? AND cu.status = 'active' AND cu.kind = 'event'
         AND cu.updated_at >= ?`
    )
    .all(chatEntityId, sinceIso) as Array<{
    id: string;
    event_id: string;
    kind: string;
    updated_at: string;
  }>;

  const eventIds = Array.from(new Set(eventUnits.map((u) => u.event_id))).filter(
    Boolean
  );
  const allUnits = new Map<string, { kind: string; updatedAt: string }>();
  for (const u of eventUnits) {
    allUnits.set(u.id, { kind: u.kind, updatedAt: u.updated_at });
  }
  if (eventIds.length > 0) {
    const placeholders = eventIds.map(() => '?').join(',');
    const semantic = db
      .prepare(
        `SELECT DISTINCT cu.id as id, cu.kind as kind, cu.updated_at as updated_at
         FROM unit_sources us
         JOIN context_units cu ON cu.id = us.unit_id
         WHERE us.event_id IN (${placeholders})
           AND cu.status = 'active'
           AND cu.updated_at >= ?`
      )
      .all(...eventIds, sinceIso) as Array<{
      id: string;
      kind: string;
      updated_at: string;
    }>;
    for (const u of semantic) {
      if (!allUnits.has(u.id)) {
        allUnits.set(u.id, { kind: u.kind, updatedAt: u.updated_at });
      }
    }
  }
  return Array.from(allUnits, ([unitId, v]) => ({
    unitId,
    kind: v.kind,
    updatedAt: v.updatedAt,
  }));
}

// chat 内 person entity ids（dedup）。从 context_unit_entities 拉，**不**走 cache。
function distinctPersonsInUnits(unitIds: string[]): Set<string> {
  if (unitIds.length === 0) return new Set();
  const ph = unitIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT cue.entity_id as entity_id
       FROM context_unit_entities cue
       JOIN context_entities ce ON ce.id = cue.entity_id
       WHERE cue.context_unit_id IN (${ph}) AND ce.type = 'person'`
    )
    .all(...unitIds) as Array<{ entity_id: string }>;
  return new Set(rows.map((r) => r.entity_id));
}

// chat 内 doc entity ids（dedup）。doc 既可能在 entities 表里也可能在 cache 里 —
// 这里两路并集。
function distinctDocsInUnits(unitIds: string[]): Set<string> {
  if (unitIds.length === 0) return new Set();
  const ph = unitIds.map(() => '?').join(',');
  // 1) 直接 entity link
  const direct = db
    .prepare(
      `SELECT DISTINCT cue.entity_id as entity_id
       FROM context_unit_entities cue
       JOIN context_entities ce ON ce.id = cue.entity_id
       WHERE cue.context_unit_id IN (${ph}) AND ce.type = 'doc'`
    )
    .all(...unitIds) as Array<{ entity_id: string }>;
  const out = new Set(direct.map((r) => r.entity_id));
  // 2) 从 routing cache 取 doc 名 → resolve entity id
  const cacheRows = db
    .prepare(
      `SELECT routing_entities_json FROM unit_routing_cache
       WHERE unit_id IN (${ph})`
    )
    .all(...unitIds) as Array<{ routing_entities_json: string }>;
  for (const r of cacheRows) {
    try {
      const arr = JSON.parse(r.routing_entities_json) as Array<{
        type: string;
        name: string;
      }>;
      for (const e of arr) {
        if (e.type !== 'doc') continue;
        const ent = db
          .prepare(`SELECT id FROM context_entities WHERE type = 'doc' AND name = ?`)
          .get(e.name) as { id?: string } | undefined;
        if (ent?.id) out.add(ent.id);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

// chat 内 distinct senders（person + app）；用于 BIG_CHAT_FILTER。
function distinctSendersInUnits(unitIds: string[]): {
  persons: number;
  apps: number;
  total: number;
} {
  if (unitIds.length === 0) return { persons: 0, apps: 0, total: 0 };
  const ph = unitIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT ce.type as type, ce.id as id
       FROM context_unit_entities cue
       JOIN context_entities ce ON ce.id = cue.entity_id
       WHERE cue.context_unit_id IN (${ph})
         AND cue.role = 'actor'
         AND ce.type IN ('person', 'app')`
    )
    .all(...unitIds) as Array<{ type: string; id: string }>;
  let persons = 0;
  let apps = 0;
  for (const r of rows) {
    if (r.type === 'person') persons++;
    else if (r.type === 'app') apps++;
  }
  return { persons, apps, total: persons + apps };
}

// 给一个 chat 内 unit 集合 + Space，算 direct_hits（不含 about_via_chat）
function countDirectHits(unitIds: string[], spaceId: string): number {
  if (unitIds.length === 0) return 0;
  const ph = unitIds.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM context_space_links
       WHERE space_id = ? AND target_type = 'context_unit'
         AND target_id IN (${ph})
         AND link_type IN ('about', 'about_via_doc')`
    )
    .get(spaceId, ...unitIds) as { n: number };
  return row.n;
}

// ---------- suggestion upsert ----------

type SuggestionInput = {
  targetType: 'entity';
  targetId: string;
  spaceId: string;
  suggestionType: 'chat_affinity' | 'person_co_occur';
  score: number;
  evidence: Record<string, unknown>;
};

function upsertSuggestion(input: SuggestionInput): 'inserted' | 'updated' | 'skipped' {
  const now = new Date().toISOString();
  const existing = db
    .prepare(
      `SELECT * FROM context_space_suggestions
       WHERE target_type = ? AND target_id = ? AND space_id = ? AND suggestion_type = ?`
    )
    .get(
      input.targetType,
      input.targetId,
      input.spaceId,
      input.suggestionType
    ) as
    | {
        id: string;
        status: string;
        cooldown_until: string | null;
      }
    | undefined;

  if (existing) {
    if (existing.status === 'confirmed') return 'skipped';
    if (
      existing.status === 'rejected' &&
      existing.cooldown_until &&
      existing.cooldown_until > now
    )
      return 'skipped';
    // suggested 或 rejected 且已过 cooldown → 刷新
    db.prepare(
      `UPDATE context_space_suggestions
       SET score = ?, evidence_json = ?, status = 'suggested',
           cooldown_until = NULL, updated_at = ?
       WHERE id = ?`
    ).run(input.score, JSON.stringify(input.evidence), now, existing.id);
    return 'updated';
  }
  try {
    db.prepare(
      `INSERT INTO context_space_suggestions
       (id, target_type, target_id, space_id, suggestion_type, score, evidence_json,
        status, cooldown_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'suggested', NULL, ?, ?)`
    ).run(
      randomUUID(),
      input.targetType,
      input.targetId,
      input.spaceId,
      input.suggestionType,
      input.score,
      JSON.stringify(input.evidence),
      now,
      now
    );
    return 'inserted';
  } catch {
    return 'skipped';
  }
}

// ---------- 主 entry ----------

export type SuggestionWorkerStats = {
  chatsScanned: number;
  chatsBigSkipped: number;
  chatAffinityInserted: number;
  chatAffinityUpdated: number;
  personCoOccurInserted: number;
  personCoOccurUpdated: number;
};

export function runSuggestionWorker(): SuggestionWorkerStats {
  const stats: SuggestionWorkerStats = {
    chatsScanned: 0,
    chatsBigSkipped: 0,
    chatAffinityInserted: 0,
    chatAffinityUpdated: 0,
    personCoOccurInserted: 0,
    personCoOccurUpdated: 0,
  };
  const now = Date.now();
  const sincePrimary = new Date(
    now - RECENT_DAYS_PRIMARY * 86400_000
  ).toISOString();
  const sincePerson = new Date(
    now - RECENT_DAYS_PERSON_CO_OCCUR * 86400_000
  ).toISOString();

  const chats = listChatEntities();
  const spaces = listActiveSpacesWithSeeds();
  if (chats.length === 0 || spaces.length === 0) return stats;

  for (const c of chats) {
    stats.chatsScanned++;
    const unitsPrimary = unitsForChatEntity(c.id, sincePrimary);
    const unitIdsPrimary = unitsPrimary.map((u) => u.unitId);
    const senders = distinctSendersInUnits(unitIdsPrimary);

    // BIG_CHAT_FILTER：大群整体跳过，包括 person co-occur
    const isBig =
      senders.persons > BIG_CHAT_SENDER_CAP ||
      (unitIdsPrimary.length > BIG_CHAT_UNIT_CAP &&
        senders.persons > BIG_CHAT_SENDER_CAP);
    if (isBig) {
      stats.chatsBigSkipped++;
      continue;
    }

    // 至少要有点 activity 才考虑
    if (unitIdsPrimary.length === 0) continue;

    const chatPersons = distinctPersonsInUnits(unitIdsPrimary);
    const chatDocs = distinctDocsInUnits(unitIdsPrimary);

    // ---- Phase 2: chat_affinity per Space ----
    for (const sp of spaces) {
      // 如果该 chat 已经是这个 Space 的 chat seed，跳过 self-loop
      if (sp.chatSeedIds.has(c.id)) continue;

      const directHits = countDirectHits(unitIdsPrimary, sp.spaceId);
      const personOverlap = countIntersection(chatPersons, sp.personSeedIds);
      const docOverlap = countIntersection(chatDocs, sp.docSeedIds);

      const meetsThreshold =
        directHits >= SCORE_THRESHOLD_DIRECT ||
        personOverlap >= SCORE_THRESHOLD_PERSON ||
        docOverlap >= SCORE_THRESHOLD_DOC;
      if (!meetsThreshold) continue;

      const score =
        (directHits / Math.log(1 + unitIdsPrimary.length || 1)) *
        (1 + 0.3 * personOverlap + 0.5 * docOverlap);

      const r = upsertSuggestion({
        targetType: 'entity',
        targetId: c.id,
        spaceId: sp.spaceId,
        suggestionType: 'chat_affinity',
        score,
        evidence: {
          unitsInChat: unitIdsPrimary.length,
          directHits,
          personOverlap,
          docOverlap,
          distinctSenders: senders.persons,
          chatName: c.name,
          chatAliases: c.aliases_json ? safeParseJsonArray(c.aliases_json) : [],
          recentDays: RECENT_DAYS_PRIMARY,
        },
      });
      if (r === 'inserted') stats.chatAffinityInserted++;
      else if (r === 'updated') stats.chatAffinityUpdated++;
    }

    // ---- Phase 3: person_co_occur ----
    // 用 30 天窗口、小群（已过 BIG_CHAT_FILTER）、排除 app sender。
    const unitsPerson = unitsForChatEntity(c.id, sincePerson);
    const unitIdsPerson = unitsPerson.map((u) => u.unitId);
    if (unitIdsPerson.length < 5) continue; // §6 要求 units >= 5

    const chatPersonsForCoOccur = distinctPersonsInUnits(unitIdsPerson);
    if (chatPersonsForCoOccur.size === 0) continue;

    for (const sp of spaces) {
      if (sp.personSeedIds.size === 0) continue;
      for (const personId of chatPersonsForCoOccur) {
        if (sp.personSeedIds.has(personId)) continue; // 已是 seed 则跳过
        // 在本 chat 中 person 与某 seed person 同时出现的 unit 数
        const seedIds = Array.from(sp.personSeedIds);
        const ph1 = unitIdsPerson.map(() => '?').join(',');
        const ph2 = seedIds.map(() => '?').join(',');
        const row = db
          .prepare(
            `SELECT COUNT(DISTINCT cu1.context_unit_id) as n
             FROM context_unit_entities cu1
             JOIN context_unit_entities cu2
               ON cu1.context_unit_id = cu2.context_unit_id
             WHERE cu1.context_unit_id IN (${ph1})
               AND cu1.entity_id = ?
               AND cu2.entity_id IN (${ph2})`
          )
          .get(...unitIdsPerson, personId, ...seedIds) as { n: number };
        if (row.n < PERSON_CO_OCCUR_THRESHOLD) continue;

        const r = upsertSuggestion({
          targetType: 'entity',
          targetId: personId,
          spaceId: sp.spaceId,
          suggestionType: 'person_co_occur',
          score: row.n,
          evidence: {
            chatId: c.id,
            chatName: c.name,
            coOccurCount: row.n,
            recentDays: RECENT_DAYS_PERSON_CO_OCCUR,
          },
        });
        if (r === 'inserted') stats.personCoOccurInserted++;
        else if (r === 'updated') stats.personCoOccurUpdated++;
      }
    }
  }
  return stats;
}

function countIntersection(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function safeParseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// 用于 API / UI 的 helper（暴露给 routes）
export type ListSpaceLinkRowExtra = ContextSpaceLinkRow;
