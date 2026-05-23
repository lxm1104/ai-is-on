/**
 * MVP14 Phase 1b · Entity co-occurrence read model.
 *
 * 从 context_unit_entities 自连接统计 entity↔entity 共现，作为 "Observed
 * together" 推测信号。与 explicit relationships 严格分区（不混 Tab 渲染段）。
 *
 * 严格过滤（避免群聊 / 路由 entity 污染）：
 *   - entity type 白名单：person, doc, project, topic
 *   - role 白名单：actor, about
 *   - chat / app / container 默认排除
 *   - cu.status='active' + 未过期
 *   - scope ∈ ('personal','work')
 *   - cue1.entity_id < cue2.entity_id 排除直接 self-pair
 *   - alias 化后 canonical id 相同时再次过滤 self-pair
 *   - canonical pair 作 key 聚合 count / lastSeenAt / evidenceUnit
 *   - minCount filter → top N by count desc
 */
import { db, getContextEntityById } from '../db.js';
import { resolveAliased } from './entityResolver.js';

const ENTITY_TYPE_WHITELIST = ['person', 'doc', 'project', 'topic'] as const;
const ROLE_WHITELIST = ['actor', 'about'] as const;

export type CooccurrenceEndpoint = {
  id: string;       // canonical entity id
  type: string;
  name: string;
};

export type CooccurrenceItem = {
  left: CooccurrenceEndpoint;
  right: CooccurrenceEndpoint;
  count: number;
  lastSeenAt: string;
  evidenceUnit: { id: string; title: string };
};

type RawRow = {
  left_id: string;
  right_id: string;
  unit_id: string;
  unit_title: string;
  updated_at: string;
};

export function listCooccurrences(
  opts: { limit?: number; minCount?: number } = {}
): CooccurrenceItem[] {
  const limit = clamp(opts.limit, 50, 1, 200);
  const minCount = clamp(opts.minCount, 2, 1, 100);

  const typePlaceholders = ENTITY_TYPE_WHITELIST.map(() => '?').join(',');
  const rolePlaceholders = ROLE_WHITELIST.map(() => '?').join(',');
  const nowIso = new Date().toISOString();

  const rows = db
    .prepare(
      `SELECT
         cue1.entity_id AS left_id,
         cue2.entity_id AS right_id,
         cu.id          AS unit_id,
         cu.title       AS unit_title,
         cu.updated_at  AS updated_at
       FROM context_unit_entities cue1
       JOIN context_unit_entities cue2
         ON cue1.context_unit_id = cue2.context_unit_id
       JOIN context_units cu
         ON cu.id = cue1.context_unit_id
       JOIN context_entities e1 ON e1.id = cue1.entity_id
       JOIN context_entities e2 ON e2.id = cue2.entity_id
       WHERE cu.status = 'active'
         AND (cu.expires_at IS NULL OR cu.expires_at > ?)
         AND cu.scope IN ('personal','work')
         AND cue1.entity_id < cue2.entity_id
         AND cue1.role IN (${rolePlaceholders})
         AND cue2.role IN (${rolePlaceholders})
         AND e1.type IN (${typePlaceholders})
         AND e2.type IN (${typePlaceholders})
       ORDER BY cu.updated_at DESC`
    )
    .all(
      nowIso,
      ...ROLE_WHITELIST,
      ...ROLE_WHITELIST,
      ...ENTITY_TYPE_WHITELIST,
      ...ENTITY_TYPE_WHITELIST
    ) as RawRow[];

  type Agg = {
    leftId: string;
    rightId: string;
    count: number;
    lastSeenAt: string;
    evidenceUnitId: string;
    evidenceUnitTitle: string;
  };

  // canonical pair key → agg
  const byPair = new Map<string, Agg>();
  // unit-level dedup：同一 unit 内多条 (raw) row alias 后都映到同一 canonical pair
  // 时只算 1 次共现（否则一条 unit 挂多个 alias 会被重复加计）
  const seenUnitPair = new Set<string>();

  for (const r of rows) {
    const leftCanonical = resolveAliased(r.left_id);
    const rightCanonical = resolveAliased(r.right_id);
    if (leftCanonical === rightCanonical) continue; // alias 后 self-pair 过滤

    // 排序 canonical pair，保证 (a,b) 与 (b,a) 同 key
    const [lo, hi] =
      leftCanonical < rightCanonical
        ? [leftCanonical, rightCanonical]
        : [rightCanonical, leftCanonical];
    const pairKey = `${lo}::${hi}`;
    const dedupKey = `${r.unit_id}::${pairKey}`;
    if (seenUnitPair.has(dedupKey)) continue;
    seenUnitPair.add(dedupKey);

    const existing = byPair.get(pairKey);
    if (existing) {
      existing.count += 1;
      // rows 按 updated_at desc 排序，所以第一次见到就是最新；
      // 后续 row 不覆盖 lastSeenAt / evidence
    } else {
      byPair.set(pairKey, {
        leftId: lo,
        rightId: hi,
        count: 1,
        lastSeenAt: r.updated_at,
        evidenceUnitId: r.unit_id,
        evidenceUnitTitle: r.unit_title,
      });
    }
  }

  // minCount + top N
  const list = Array.from(byPair.values())
    .filter((a) => a.count >= minCount)
    .sort((a, b) => b.count - a.count || (b.lastSeenAt > a.lastSeenAt ? 1 : -1))
    .slice(0, limit);

  // resolve canonical entity name/type；alias 化的 id 可能找不到 entity 行，过滤
  const out: CooccurrenceItem[] = [];
  for (const a of list) {
    const leftEnt = getContextEntityById(a.leftId);
    const rightEnt = getContextEntityById(a.rightId);
    if (!leftEnt || !rightEnt) continue;
    // canonical 后再次确认 type 白名单（防御性）
    if (!isWhitelistedType(leftEnt.type) || !isWhitelistedType(rightEnt.type)) {
      continue;
    }
    out.push({
      left: { id: leftEnt.id, type: leftEnt.type, name: leftEnt.name },
      right: { id: rightEnt.id, type: rightEnt.type, name: rightEnt.name },
      count: a.count,
      lastSeenAt: a.lastSeenAt,
      evidenceUnit: { id: a.evidenceUnitId, title: a.evidenceUnitTitle },
    });
  }
  return out;
}

function isWhitelistedType(t: string): boolean {
  return (ENTITY_TYPE_WHITELIST as readonly string[]).includes(t);
}

function clamp(v: number | undefined, def: number, lo: number, hi: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  const n = Math.floor(v);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
