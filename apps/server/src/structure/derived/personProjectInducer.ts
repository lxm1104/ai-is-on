/**
 * MVP15A §7.3 — PersonProjectEdge inducer。
 *
 * 走 entity-overlap 路径（**不走** context_space_links，因为现实数据里覆盖率<5%；
 * 详见 docs/MVP15A 落差分析 D2）：同 active work-scope unit 上 person 和 project
 * entity 共现 → 一条 person→project 边。
 *
 * 关键设计：
 *   - **from_id** = person canonical entity_id（已 resolveAliased）
 *   - **to_id** = project canonical name 字符串（已 resolveProjectCanonical）
 *     —— 不是 entity_id，因为 taxonomy 是 name-based 聚类，同 canonical 下可能有多个
 *     不同 entity_id 的 alias
 *   - SQL HAVING cooccur ≥ 2：过滤单次共现噪音（详见 §9 自审 #1）
 *   - weight = Σ exp(-ageHours/720)，30d 半衰
 *   - weight ≥ 0.2 才入边（比 person_person 阈值 0.3 略低，因为单条 person-project
 *     已经过了 cooccur≥2 SQL 筛）
 *   - role 推断按 §7.3 频次门槛规则（见 inferRole）
 *
 * 这个 inducer **不依赖** personPerson；但 personPerson **依赖** 本 inducer 算
 * sharedProjectCanonicalNames，详见 graphInducer.ts 调用顺序。
 */

// MVP21 S5.1: 本文件从 context/ 迁到 structure/derived/。
import { randomUUID } from 'node:crypto';
import { db, upsertEntityEdge, type EntityEdgeRow } from '../../db.js';
import { resolveAliased } from '../../context/entityResolver.js';
import { resolveProjectCanonical } from '../../db.js';

export type PersonProjectRole =
  | 'owner'
  | 'driver'
  | 'reviewer'
  | 'contributor'
  | 'stakeholder'
  | 'observer';

export type PersonProjectInducerSummary = {
  written: number;       // upsert 到 entity_edges 的边数
  skippedLowSignal: number; // cooccur≥2 / weight≥0.2 任一未过 → 跳过
  rawTuples: number;     // SQL 出来的 (person, project, unit) 元组数
};

const MIN_COOCCUR = 2;          // SQL HAVING
const MIN_WEIGHT = 0.2;         // 应用层过滤
const HALF_LIFE_HOURS = 720;    // 30 天
const EVIDENCE_CAP = 5;

type RawTuple = {
  person_entity_id: string;
  project_entity_name: string;
  unit_id: string;
  unit_kind: string;
  unit_role: string;       // 'actor' | 'about' | ...
  unit_updated_at: string;
};

type Bucket = {
  personEntityId: string;        // canonical (resolveAliased)
  projectCanonicalName: string;  // canonical (resolveProjectCanonical)
  // 每条 evidence：unit + kind + role + 时间
  evidence: Array<{ unitId: string; updatedAt: string; kindRole: string }>;
};

export function inducePersonProjectEdges(opts: {
  now: number;
}): PersonProjectInducerSummary {
  const nowMs = opts.now;
  const nowIso = new Date(nowMs).toISOString();

  // 注意：不在 SQL 层 group_by，因为 group 维度（person, project_canonical）
  // 需要应用层 resolve；SQL 只拿 raw tuples 出来。
  // 同时 SQL HAVING cooccur >= MIN_COOCCUR 在应用层做（更灵活，且 raw count
  // 是按 entity_id pair 而不是 canonical pair —— 应用层 group 后才是 canonical
  // 维度的 cooccur）。
  const rows = db
    .prepare(
      `SELECT
         cuep.entity_id AS person_entity_id,
         pej.name       AS project_entity_name,
         cuep.context_unit_id AS unit_id,
         cu.kind        AS unit_kind,
         cuep.role      AS unit_role,
         cu.updated_at  AS unit_updated_at
       FROM context_units cu
       JOIN context_unit_entities cuep  ON cuep.context_unit_id = cu.id
       JOIN context_entities      ep    ON ep.id = cuep.entity_id  AND ep.type = 'person'
       JOIN context_unit_entities cuepj ON cuepj.context_unit_id = cu.id
       JOIN context_entities      pej   ON pej.id = cuepj.entity_id AND pej.type = 'project'
       WHERE cu.status = 'active'
         AND cu.scope = 'work'
         AND (cu.expires_at IS NULL OR cu.expires_at > ?)
         -- 'me' / '我' 是 workMapWriter 给 preference 这类 self-anchored unit
         -- 写的 placeholder entity，不是真实 person。canonical self entity
         -- 通过 self_person_entity_id setting 单独定位，不在这里走 person_project 边。
         AND ep.name NOT IN ('me', 'Me', '我')`
    )
    .all(nowIso) as RawTuple[];

  // 应用层 group by (canonical person id, canonical project name)
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const personCanonical = resolveAliased(r.person_entity_id);
    const projectCanonical = resolveProjectCanonical(r.project_entity_name);
    const key = `${personCanonical}|${projectCanonical}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        personEntityId: personCanonical,
        projectCanonicalName: projectCanonical,
        evidence: [],
      };
      buckets.set(key, bucket);
    }
    // 同一 unit 可能出现多次（多人扮演同一 role）；这里收集所有，去重在 evidence 时做
    // 2026-05-27 dogfood：把 author/owner/assignee 等"实际参与"角色统一归一化成
    // 'actor'，弱关系（mentioned/cc/observer/about/target）归一化成 'about'。
    // 这样 inferRole 的 'kind:actor' 频次门槛能正确触发。
    const normalizedRole = normalizeRole(r.unit_role);
    bucket.evidence.push({
      unitId: r.unit_id,
      updatedAt: r.unit_updated_at,
      kindRole: `${r.unit_kind}:${normalizedRole}`,
    });
  }

  let written = 0;
  let skippedLowSignal = 0;

  for (const bucket of buckets.values()) {
    // 同 unit 去重
    const uniqueByUnit = new Map<string, { unitId: string; updatedAt: string; kindRole: string }>();
    for (const e of bucket.evidence) {
      // 同 unit 多次时优先保留高优先级 kindRole（owner > driver > reviewer > about）
      const existing = uniqueByUnit.get(e.unitId);
      if (!existing) {
        uniqueByUnit.set(e.unitId, e);
      } else {
        const existingScore = scoreKindRole(existing.kindRole);
        const newScore = scoreKindRole(e.kindRole);
        if (newScore > existingScore) uniqueByUnit.set(e.unitId, e);
      }
    }

    const uniqueEvidence = Array.from(uniqueByUnit.values());
    if (uniqueEvidence.length < MIN_COOCCUR) {
      skippedLowSignal++;
      continue;
    }

    // weight: Σ exp(-ageHours/720)
    let weight = 0;
    for (const e of uniqueEvidence) {
      const ageHours = (nowMs - new Date(e.updatedAt).getTime()) / 3600_000;
      weight += Math.exp(-Math.max(0, ageHours) / HALF_LIFE_HOURS);
    }
    if (weight < MIN_WEIGHT) {
      skippedLowSignal++;
      continue;
    }

    const role = inferRole(uniqueEvidence.map((e) => e.kindRole));
    // 按时间倒序排，取最新 5 个作为 evidence_unit_ids
    const sortedEvidence = [...uniqueEvidence].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
    const evidenceIds = sortedEvidence.slice(0, EVIDENCE_CAP).map((e) => e.unitId);
    const lastSeenAt = sortedEvidence[0].updatedAt;

    const row: EntityEdgeRow = {
      id: randomUUID(),
      edge_kind: 'person_project',
      from_id: bucket.personEntityId,
      to_id: bucket.projectCanonicalName,
      role_or_type: role,
      weight,
      business_relation: null,
      shared_ids_json: null,
      evidence_unit_ids_json: JSON.stringify(evidenceIds),
      detected_at: nowIso,
      last_seen_at: lastSeenAt,
      updated_at: nowIso,
      // MVP15B LLM 字段：inducer 不填，由 decisionAuthorityClassifier 单独 UPDATE
      decision_authority: null,
      collab_type: null,
      llm_classified_at: null,
      llm_why: null,
    };
    upsertEntityEdge(row);
    written++;
  }

  return {
    written,
    skippedLowSignal,
    rawTuples: rows.length,
  };
}

// ----------------------------------------------------------------------------
// role inference（§7.3 频次门槛规则）
// ----------------------------------------------------------------------------

const KIND_ROLE_PRIORITY: Record<string, number> = {
  'commitment:actor': 5,
  'goal:actor': 4,
  'decision:actor': 3,
  'intent:actor': 2,
  'event:actor': 2,
  'state:actor': 2,
  // about-only kind
  'commitment:about': 1,
  'goal:about': 1,
  'decision:about': 1,
};
function scoreKindRole(kindRole: string): number {
  return KIND_ROLE_PRIORITY[kindRole] ?? (kindRole.endsWith(':about') ? 0 : 1);
}

/**
 * 优先序：owner > driver > reviewer > contributor > stakeholder > observer。
 * 频次门槛（避免单次 commitment.actor 越过多次 about）：
 *   - owner：commitment:actor 出现 ≥ 2 次
 *   - driver：goal:actor 出现 ≥ 2 次
 *   - reviewer：decision:actor 出现 ≥ 1 次（decision 本身频率低，单次有效）
 *   - contributor：commitment/goal:actor 单次或其它 actor role 主导
 *   - stakeholder：about role 主导（aboutCount > actorCount × 2）
 *   - observer：其它（应该极少出现，因为已经过 cooccur≥2 SQL 筛）
 */
export function inferRole(kindRolePairs: string[]): PersonProjectRole {
  const freq = new Map<string, number>();
  for (const p of kindRolePairs) freq.set(p, (freq.get(p) ?? 0) + 1);
  if ((freq.get('commitment:actor') ?? 0) >= 2) return 'owner';
  if ((freq.get('goal:actor') ?? 0) >= 2) return 'driver';
  if ((freq.get('decision:actor') ?? 0) >= 1) return 'reviewer';
  if (
    (freq.get('commitment:actor') ?? 0) === 1 ||
    (freq.get('goal:actor') ?? 0) === 1
  ) {
    return 'contributor';
  }
  let aboutCount = 0;
  let actorCount = 0;
  for (const [k, v] of freq) {
    if (k.endsWith(':about')) aboutCount += v;
    if (k.endsWith(':actor')) actorCount += v;
  }
  if (aboutCount > actorCount * 2) return 'stakeholder';
  if (actorCount > 0) return 'contributor';
  return 'observer';
}

/**
 * 角色归一化：飞书/字节多 collector 用了 40+ 种 role 名（actor/author/owner/
 * assignee/organizer/cc/mentioned/...）。把它们归一化成 'actor' / 'about' / 其它
 * 供 inferRole 频次门槛使用。
 *
 * actor-like（实际参与做事）：actor, author, owner, assignee, requester, reporter,
 *   organizer, speaker, coordinator, proposer, decision_maker, editor, developer,
 *   tester, verifier, fixer, evaluator, source, handler, confirmer
 * about-like（被提及/弱关联）：about, subject, mentioned, cc, observer, participant,
 *   target, peer, initiator, forwarder, counterpart, concerned_party, blocker_source,
 *   stakeholder, gatekeeper, involved, explainer
 * 其它原样保留
 */
const ACTOR_LIKE_ROLES = new Set([
  'actor', 'author', 'owner', 'assignee', 'requester', 'reporter', 'organizer',
  'speaker', 'coordinator', 'proposer', 'decision_maker', 'editor', 'developer',
  'tester', 'verifier', 'fixer', 'evaluator', 'source', 'handler', 'confirmer',
  'responder', 'initiator',
]);
const ABOUT_LIKE_ROLES = new Set([
  'about', 'subject', 'mentioned', 'cc', 'observer', 'participant', 'target',
  'peer', 'forwarder', 'counterpart', 'concerned_party', 'blocker_source',
  'stakeholder', 'gatekeeper', 'involved', 'explainer',
]);
export function normalizeRole(role: string): 'actor' | 'about' | string {
  if (ACTOR_LIKE_ROLES.has(role)) return 'actor';
  if (ABOUT_LIKE_ROLES.has(role)) return 'about';
  return role;
}

// 暴露给测试
export const __internal = {
  MIN_COOCCUR,
  MIN_WEIGHT,
  HALF_LIFE_HOURS,
  EVIDENCE_CAP,
  scoreKindRole,
  inferRole,
};
