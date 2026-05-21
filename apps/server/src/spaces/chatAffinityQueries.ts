/**
 * MVP13 §3 / §4：chat ↔ Space 关联用到的只读 SQL helpers。
 *
 * 从原 MVP12 [suggestionWorker.ts](apps/server/src/spaces/suggestionWorker.ts) 抽出来共享，
 * MVP13 evidence builder + MVP12 person_co_occur 路径都用。
 */
import {
  db,
  getContextEntityById,
  listContextSpaces,
  listSpaceLinks,
  type ContextEntityRow,
} from '../db.js';

export type ChatEntity = ContextEntityRow & { type: 'chat' };

export function listChatEntities(): ChatEntity[] {
  return db
    .prepare(`SELECT * FROM context_entities WHERE type = 'chat'`)
    .all() as ChatEntity[];
}

export type SpaceWithSeeds = {
  spaceId: string;
  personSeedIds: Set<string>;
  docSeedIds: Set<string>;
  chatSeedIds: Set<string>;
};

export function listActiveSpacesWithSeeds(): SpaceWithSeeds[] {
  const spaces = listContextSpaces({ status: 'active' });
  const out: SpaceWithSeeds[] = [];
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

export type UnitInChat = { unitId: string; kind: string; updatedAt: string };

export function unitsForChatEntity(
  chatEntityId: string,
  sinceIso: string
): UnitInChat[] {
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

export function distinctPersonsInUnits(unitIds: string[]): Set<string> {
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

export function distinctDocsInUnits(unitIds: string[]): Set<string> {
  if (unitIds.length === 0) return new Set();
  const ph = unitIds.map(() => '?').join(',');
  const direct = db
    .prepare(
      `SELECT DISTINCT cue.entity_id as entity_id
       FROM context_unit_entities cue
       JOIN context_entities ce ON ce.id = cue.entity_id
       WHERE cue.context_unit_id IN (${ph}) AND ce.type = 'doc'`
    )
    .all(...unitIds) as Array<{ entity_id: string }>;
  const out = new Set(direct.map((r) => r.entity_id));
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

export function distinctSendersInUnits(unitIds: string[]): {
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

export function countDirectHits(unitIds: string[], spaceId: string): number {
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

export function countIntersection(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

export function safeParseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** MVP13: 30 天活跃 unit 数（用于 chat 摘要里的 `units30d`）。 */
export function unitsForChatEntityCount30d(chatEntityId: string): number {
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  return unitsForChatEntity(chatEntityId, since30).length;
}

/**
 * 抽 chat 内 top persons：count = 该 person 在 unit 内出现次数，
 * 取前 `topN`。同时拿到 roles（actor / about / participant 等）合集。
 */
export function topPersonsInUnits(
  unitIds: string[],
  topN = 5
): Array<{ id: string; name: string; count: number; roles: string[] }> {
  if (unitIds.length === 0) return [];
  const ph = unitIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT cue.entity_id as id, ce.name as name, cue.role as role, COUNT(*) as count
       FROM context_unit_entities cue
       JOIN context_entities ce ON ce.id = cue.entity_id
       WHERE cue.context_unit_id IN (${ph}) AND ce.type = 'person'
       GROUP BY cue.entity_id, cue.role`
    )
    .all(...unitIds) as Array<{
    id: string;
    name: string;
    role: string;
    count: number;
  }>;
  const agg = new Map<
    string,
    { id: string; name: string; count: number; roles: Set<string> }
  >();
  for (const r of rows) {
    const cur = agg.get(r.id) ?? {
      id: r.id,
      name: r.name,
      count: 0,
      roles: new Set<string>(),
    };
    cur.count += r.count;
    if (r.role) cur.roles.add(r.role);
    agg.set(r.id, cur);
  }
  return Array.from(agg.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map((x) => ({
      id: x.id,
      name: x.name,
      count: x.count,
      roles: Array.from(x.roles),
    }));
}

export function topDocsInUnits(
  unitIds: string[],
  topN = 5
): Array<{ id: string; name: string; count: number }> {
  if (unitIds.length === 0) return [];
  const ph = unitIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT cue.entity_id as id, ce.name as name, COUNT(*) as count
       FROM context_unit_entities cue
       JOIN context_entities ce ON ce.id = cue.entity_id
       WHERE cue.context_unit_id IN (${ph}) AND ce.type = 'doc'
       GROUP BY cue.entity_id`
    )
    .all(...unitIds) as Array<{ id: string; name: string; count: number }>;
  return rows.sort((a, b) => b.count - a.count).slice(0, topN);
}

export function topUnitKinds(
  unitIds: string[],
  topN = 5
): Array<{ kind: string; count: number }> {
  if (unitIds.length === 0) return [];
  const ph = unitIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) as count FROM context_units
       WHERE id IN (${ph}) AND status = 'active'
       GROUP BY kind`
    )
    .all(...unitIds) as Array<{ kind: string; count: number }>;
  return rows.sort((a, b) => b.count - a.count).slice(0, topN);
}

/** 拉 unit 的 title / meaning / entity ref 名字，用于 summarizedUnits。 */
export function fetchSummarizedUnits(
  unitIds: string[],
  limit = 8
): Array<{
  id: string;
  kind: string;
  title: string;
  meaning?: string | null;
  updatedAt: string;
  entityRefs: string[];
}> {
  if (unitIds.length === 0) return [];
  const ph = unitIds.map(() => '?').join(',');
  const units = db
    .prepare(
      `SELECT id, kind, title, meaning, updated_at FROM context_units
       WHERE id IN (${ph}) AND status = 'active'
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(...unitIds, limit) as Array<{
    id: string;
    kind: string;
    title: string | null;
    meaning: string | null;
    updated_at: string;
  }>;
  const out: Array<{
    id: string;
    kind: string;
    title: string;
    meaning?: string | null;
    updatedAt: string;
    entityRefs: string[];
  }> = [];
  for (const u of units) {
    const refs = db
      .prepare(
        `SELECT ce.name as name FROM context_unit_entities cue
         JOIN context_entities ce ON ce.id = cue.entity_id
         WHERE cue.context_unit_id = ?
         LIMIT 8`
      )
      .all(u.id) as Array<{ name: string }>;
    out.push({
      id: u.id,
      kind: u.kind,
      title: u.title ?? '',
      meaning: u.meaning ?? null,
      updatedAt: u.updated_at,
      entityRefs: refs.map((r) => r.name),
    });
  }
  return out;
}

/** 历史反馈：拉同 (target_type, target_id) 的最近 N 条 feedback 用作 ruleSignals.negativeFeedbackHits / positiveFeedbackHits */
export function countFeedbackHits(
  targetType: string,
  targetId: string,
  spaceId: string,
  withinDays: number
): { positive: number; negative: number } {
  const cutoff = new Date(
    Date.now() - withinDays * 86400_000
  ).toISOString();
  const rows = db
    .prepare(
      `SELECT action FROM context_space_suggestion_feedback
       WHERE target_type = ? AND target_id = ? AND space_id = ? AND created_at >= ?`
    )
    .all(targetType, targetId, spaceId, cutoff) as Array<{ action: string }>;
  let pos = 0;
  let neg = 0;
  for (const r of rows) {
    if (r.action === 'confirmed') pos++;
    else if (r.action === 'rejected') neg++;
  }
  return { positive: pos, negative: neg };
}

/** Space → seed entity 名字汇总，用于 evidence.space.seedEntities */
export function seedEntitySummary(spaceId: string): {
  project: Array<{ id: string; name: string }>;
  topic: Array<{ id: string; name: string }>;
  person: Array<{ id: string; name: string }>;
  doc: Array<{ id: string; name: string }>;
  chat: Array<{ id: string; name: string }>;
} {
  const out = {
    project: [] as Array<{ id: string; name: string }>,
    topic: [] as Array<{ id: string; name: string }>,
    person: [] as Array<{ id: string; name: string }>,
    doc: [] as Array<{ id: string; name: string }>,
    chat: [] as Array<{ id: string; name: string }>,
  };
  for (const l of listSpaceLinks(spaceId)) {
    if (l.target_type !== 'entity') continue;
    const ent = getContextEntityById(l.target_id);
    if (!ent) continue;
    const target = (out as Record<string, Array<{ id: string; name: string }>>)[
      ent.type
    ];
    if (target) target.push({ id: ent.id, name: ent.name });
  }
  return out;
}
