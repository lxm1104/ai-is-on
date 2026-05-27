/**
 * MVP15A §7.2 — PersonPersonEdge inducer。
 *
 * 复用 cooccurrenceService 的数据源（同 unit 上两 person entity 共现），加上：
 *   - **businessRelation** 维度：双方 PersonAttributes.larkDeptBusiness 比较得
 *     'same_business'|'cross_business'|'external'|'unknown'
 *   - **sharedProjectCanonicalNames**：通过查 entity_edges (kind='person_project')
 *     算双方共同的 canonical project 名 —— **要求 personProject inducer 先跑**！
 *
 * 关键设计：
 *   - SQL self-join cu/cue/ce，role ∈ ('actor','about')
 *   - JS 层 resolveAliased dedup，确保 from_id < to_id（UNIQUE 约束）
 *   - weight = Σ exp(-ageHours/720)，30d 半衰
 *   - weight ≥ 0.3 才入边（比 person_project 的 0.2 严，因为 person_person 共现稠密）
 *   - evidence cap = 10 条 unit_id（按时间倒序）
 *   - 'me' / 'Me' / '我' placeholder 过滤
 */

import { randomUUID } from 'node:crypto';
import {
  db,
  listEntityEdges,
  upsertEntityEdge,
  type EntityEdgeRow,
} from '../db.js';
import { resolveAliased } from './entityResolver.js';
import {
  parsePersonAttributesFromRow,
  type PersonAttributes,
} from './personAttributes.js';

export type BusinessRelation =
  | 'same_business'
  | 'cross_business'
  | 'external'
  | 'unknown';

export type PersonPersonInducerSummary = {
  written: number;
  skippedLowSignal: number;
  rawPairs: number;
};

const MIN_WEIGHT = 0.3;
const HALF_LIFE_HOURS = 720;       // 30 天
const EVIDENCE_CAP = 10;

type RawTuple = {
  // SQL 给的两人 id，未必小于；JS 层再排序
  a_id: string;
  b_id: string;
  unit_id: string;
  unit_updated_at: string;
};

type Bucket = {
  fromId: string;         // canonical，已保证 fromId < toId
  toId: string;
  evidence: Array<{ unitId: string; updatedAt: string }>;
};

export function inducePersonPersonEdges(opts: {
  now: number;
}): PersonPersonInducerSummary {
  const nowMs = opts.now;
  const nowIso = new Date(nowMs).toISOString();

  // SQL：同 unit 上 person ↔ person 共现，role ∈ ('actor','about')
  // 注意：a.entity_id < b.entity_id 是 SQL 层 self-pair 排除；canonical 排序在 JS 做
  const rows = db
    .prepare(
      `SELECT
         a.entity_id     AS a_id,
         b.entity_id     AS b_id,
         a.context_unit_id AS unit_id,
         cu.updated_at   AS unit_updated_at
       FROM context_unit_entities a
       JOIN context_unit_entities b
         ON a.context_unit_id = b.context_unit_id
        AND a.entity_id < b.entity_id
       JOIN context_entities ea ON ea.id = a.entity_id AND ea.type = 'person'
       JOIN context_entities eb ON eb.id = b.entity_id AND eb.type = 'person'
       JOIN context_units cu ON cu.id = a.context_unit_id
       WHERE cu.status = 'active'
         AND cu.scope = 'work'
         AND (cu.expires_at IS NULL OR cu.expires_at > ?)
         AND a.role IN ('actor','about')
         AND b.role IN ('actor','about')
         AND ea.name NOT IN ('me', 'Me', '我')
         AND eb.name NOT IN ('me', 'Me', '我')`
    )
    .all(nowIso) as RawTuple[];

  // 应用层：resolveAliased + 重排 from < to + group_by canonical pair
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const aCanonical = resolveAliased(r.a_id);
    const bCanonical = resolveAliased(r.b_id);
    if (aCanonical === bCanonical) continue; // alias 化后变同人
    const [fromId, toId] = aCanonical < bCanonical
      ? [aCanonical, bCanonical]
      : [bCanonical, aCanonical];
    const key = `${fromId}|${toId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { fromId, toId, evidence: [] };
      buckets.set(key, bucket);
    }
    bucket.evidence.push({ unitId: r.unit_id, updatedAt: r.unit_updated_at });
  }

  // 注意：同一 unit 上两 person + a<b 的 SQL 已经天然每对 (a,b,unit) 只一行；
  // 但 alias 化后可能不同 entity 都映射到同 canonical，导致同 unit 同 pair 出现 2+ 次。
  // 在 weight/evidence 计算前按 unit 去重。
  let written = 0;
  let skippedLowSignal = 0;

  for (const bucket of buckets.values()) {
    const uniqueByUnit = new Map<string, { unitId: string; updatedAt: string }>();
    for (const e of bucket.evidence) {
      if (!uniqueByUnit.has(e.unitId)) uniqueByUnit.set(e.unitId, e);
    }
    const uniqueEvidence = Array.from(uniqueByUnit.values());

    // weight 衰减
    let weight = 0;
    for (const e of uniqueEvidence) {
      const ageHours = (nowMs - new Date(e.updatedAt).getTime()) / 3600_000;
      weight += Math.exp(-Math.max(0, ageHours) / HALF_LIFE_HOURS);
    }
    if (weight < MIN_WEIGHT) {
      skippedLowSignal++;
      continue;
    }

    // businessRelation：load 双方 attrs
    const fromAttrs = loadAttrs(bucket.fromId);
    const toAttrs = loadAttrs(bucket.toId);
    const businessRelation = computeBusinessRelation(fromAttrs, toAttrs);

    // sharedProjectCanonicalNames：query entity_edges 双方共同的 canonical project
    const sharedProjects = computeSharedProjects(bucket.fromId, bucket.toId);

    const sortedEvidence = [...uniqueEvidence].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
    const evidenceIds = sortedEvidence.slice(0, EVIDENCE_CAP).map((e) => e.unitId);
    const lastSeenAt = sortedEvidence[0].updatedAt;

    const row: EntityEdgeRow = {
      id: randomUUID(),
      edge_kind: 'person_person',
      from_id: bucket.fromId,
      to_id: bucket.toId,
      role_or_type: null,                       // MVP15B LLM 写 collabType
      weight,
      business_relation: businessRelation,
      shared_ids_json: JSON.stringify(sharedProjects),
      evidence_unit_ids_json: JSON.stringify(evidenceIds),
      detected_at: nowIso,
      last_seen_at: lastSeenAt,
      updated_at: nowIso,
    };
    upsertEntityEdge(row);
    written++;
  }

  return {
    written,
    skippedLowSignal,
    rawPairs: rows.length,
  };
}

// ----------------------------------------------------------------------------
// businessRelation 派生
// ----------------------------------------------------------------------------

export function computeBusinessRelation(
  a: PersonAttributes | null,
  b: PersonAttributes | null
): BusinessRelation {
  // external 优先：任一是跨租户
  if (a?.larkIsCrossTenant === true || b?.larkIsCrossTenant === true) {
    return 'external';
  }
  const aBiz = (a?.larkDeptBusiness ?? '').trim();
  const bBiz = (b?.larkDeptBusiness ?? '').trim();
  if (!aBiz || !bBiz) return 'unknown';
  if (aBiz === bBiz) return 'same_business';
  return 'cross_business';
}

function loadAttrs(entityId: string): PersonAttributes | null {
  const row = db
    .prepare(`SELECT * FROM context_entities WHERE id = ?`)
    .get(entityId) as { type?: string; attributes_json?: string | null } | undefined;
  if (!row) return null;
  return parsePersonAttributesFromRow(row as never);
}

// ----------------------------------------------------------------------------
// sharedProjects：双方在 entity_edges (person_project) 上共同的 canonical project 名
// ----------------------------------------------------------------------------

function computeSharedProjects(fromId: string, toId: string): string[] {
  // 注意：person_project 边的 to_id 是 canonical project name（不是 entity_id）
  const fromProjects = new Set(
    listEntityEdges({ kind: 'person_project', fromId, limit: 200 }).map((e) => e.to_id)
  );
  const toProjects = new Set(
    listEntityEdges({ kind: 'person_project', fromId: toId, limit: 200 }).map(
      (e) => e.to_id
    )
  );
  const shared: string[] = [];
  for (const p of fromProjects) {
    if (toProjects.has(p)) shared.push(p);
  }
  return shared;
}

// 暴露给测试
export const __internal = {
  MIN_WEIGHT,
  HALF_LIFE_HOURS,
  EVIDENCE_CAP,
  computeBusinessRelation,
  computeSharedProjects,
};
