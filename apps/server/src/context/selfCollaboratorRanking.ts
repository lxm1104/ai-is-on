/**
 * MVP15A §7.5 — Self 协作圈 read model（不入表，实时算 + 60s in-memory cache）。
 *
 * 用户最终目标里的"每一个人跟我配合的关系" → 这是给前端 MyCollaboratorsPanel 的
 * 数据出口，也是 Phase D assembleGraphContext 的 selfAnchored 切片基础。
 *
 * 数据流：
 *   1. resolveAliased(self_person_entity_id) → canonicalSelfId
 *   2. listEntityEdges 双向查 self↔X 的 person_person 边（注意：person_person 强制
 *      from < to，所以需要 fromId=self OR toId=self 两次查）
 *   3. 对每个 X，查 entity_edges (kind='person_project', from_id=X)
 *      得到 X 的 canonical project 集合 → 跟 self 的 canonical project 求交集 = sharedProjects
 *   4. decisionRoleHint：根据 X 在 self 也参与的 unit 上的 role 简化推断
 *   5. 装 SelfCollaboratorEntry，按 weight 排序，取 top N
 *
 * 空 self（settings 里没有 self_person_entity_id）→ 返回 []，不抛。
 */

import { db, listEntityEdges, getContextEntityById } from '../db.js';
import { resolveAliased } from './entityResolver.js';
import {
  parsePersonAttributesFromRow,
  type OrgRoleFromMe,
  type PersonAttributes,
} from './personAttributes.js';
import { computeOrgRoleFromMe } from './personOrgRole.js';

export type DecisionRoleHint =
  | 'co_owner'
  | 'reviewer'
  | 'contributor'
  | 'observer'
  | null;

export type SelfCollaboratorEntry = {
  personEntityId: string;
  name: string;
  weight: number;
  orgRole?: OrgRoleFromMe;
  business?: string;
  functionLabel?: string;
  /** Canonical project 名字（不是 entity id）；通过 entity_edges 算 self 与 TA 的交集 */
  sharedProjectCanonicalNames: string[];
  decisionRoleHint: DecisionRoleHint;
  /** 跟 self 共现的 unit id 上限 5 条 */
  evidenceUnitIds: string[];
  lastSeenAt: string;
};

// ---- 60s in-memory cache ----
const CACHE_TTL_MS = 60_000;
let _cache: {
  cachedAt: number;
  selfCanonicalId: string;
  entries: SelfCollaboratorEntry[];
} | null = null;

export function buildSelfCollaboratorRanking(
  opts: { limit?: number; now?: number; bypassCache?: boolean } = {}
): SelfCollaboratorEntry[] {
  const now = opts.now ?? Date.now();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  // self 解析
  const selfIdRaw = (
    db
      .prepare(`SELECT value FROM settings WHERE key = 'self_person_entity_id'`)
      .get() as { value: string } | undefined
  )?.value;
  if (!selfIdRaw) return []; // 空 self 不抛
  const selfId = resolveAliased(selfIdRaw);

  // cache 命中
  if (
    !opts.bypassCache &&
    _cache &&
    _cache.selfCanonicalId === selfId &&
    now - _cache.cachedAt < CACHE_TTL_MS
  ) {
    return _cache.entries.slice(0, limit);
  }

  // self 自己的 person_project 集合（canonical name set）
  const selfProjects = new Set(
    listEntityEdges({ kind: 'person_project', fromId: selfId, limit: 200 }).map(
      (e) => e.to_id
    )
  );

  // self self attrs（一次性加载用于 orgRole 比较）
  const selfAttrs = loadAttrs(selfId);

  // 拉所有 self↔X 的 person_person 边（双向）
  const left = listEntityEdges({ kind: 'person_person', fromId: selfId, limit: 500 });
  const right = listEntityEdges({ kind: 'person_person', toId: selfId, limit: 500 });

  // 用 Map 按 canonical otherId 索引，方便后续 Work Map relationship 单元合并
  const byPersonId = new Map<string, SelfCollaboratorEntry>();

  for (const e of [...left, ...right]) {
    const otherId = e.from_id === selfId ? e.to_id : e.from_id;
    if (otherId === selfId) continue; // 防御性
    const otherRow = getContextEntityById(otherId);
    if (!otherRow) continue;
    const entry = makeEntry(
      otherId,
      otherRow.name,
      e.weight,
      e.last_seen_at,
      parseEvidence(e.evidence_unit_ids_json),
      selfAttrs,
      selfProjects
    );
    byPersonId.set(otherId, entry);
  }

  // ----------------------------------------------------------------------------
  // 2026-05-27 dogfood 发现：cooccurrence 数据稀疏（11 个 Work Map relationship
  // 人里只 4 个跟 self 在同 unit 出现过）。补救：直接读 work_map:relationship:*
  // 单元，把里头的 person entity 都纳入 ranking。这是用户**显式确认过**的协作者，
  // 不应该因为数据采集口子的局限被漏掉。
  //
  // weight 策略：cooccurrence-based weight 优先（说明 TA 真在最近的 unit 里活跃）；
  // 没共现数据的人给一个 baseline 1.5（介于 1-2 次共现之间的位置）。
  // ----------------------------------------------------------------------------
  const RELATIONSHIP_BASELINE_WEIGHT = 1.5;
  const wmUnits = db
    .prepare(
      `SELECT id, updated_at FROM context_units
       WHERE status='active' AND merge_key LIKE 'work_map:relationship:%'`
    )
    .all() as Array<{ id: string; updated_at: string }>;
  for (const unit of wmUnits) {
    const ents = db
      .prepare(
        `SELECT entity_id FROM context_unit_entities
         WHERE context_unit_id = ?`
      )
      .all(unit.id) as Array<{ entity_id: string }>;
    for (const ent of ents) {
      const canonicalId = resolveAliased(ent.entity_id);
      if (canonicalId === selfId) continue;
      const personRow = getContextEntityById(canonicalId);
      if (!personRow || personRow.type !== 'person') continue;
      if (personRow.name === 'me' || personRow.name === 'Me' || personRow.name === '我') {
        continue;
      }
      if (byPersonId.has(canonicalId)) continue; // 已有 cooccurrence-based entry，保留
      const entry = makeEntry(
        canonicalId,
        personRow.name,
        RELATIONSHIP_BASELINE_WEIGHT,
        unit.updated_at,
        [unit.id],
        selfAttrs,
        selfProjects
      );
      byPersonId.set(canonicalId, entry);
    }
  }

  const entries = Array.from(byPersonId.values()).sort((a, b) => b.weight - a.weight);
  _cache = { cachedAt: now, selfCanonicalId: selfId, entries };
  return entries.slice(0, limit);
}

function parseEvidence(json: string): string[] {
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string');
  } catch {}
  return [];
}

function makeEntry(
  otherId: string,
  otherName: string,
  weight: number,
  lastSeenAt: string,
  evidenceUnitIds: string[],
  selfAttrs: PersonAttributes | null,
  selfProjects: Set<string>
): SelfCollaboratorEntry {
  const otherRow = getContextEntityById(otherId);
  const otherAttrs = otherRow ? parsePersonAttributesFromRow(otherRow as never) : null;

  // 共同 project：otherId 的 person_project ∩ selfProjects
  const otherProjects = listEntityEdges({
    kind: 'person_project',
    fromId: otherId,
    limit: 200,
  }).map((edge) => edge.to_id);
  const shared = otherProjects.filter((p) => selfProjects.has(p));

  const orgRole = otherAttrs ? computeOrgRoleFromMe(selfAttrs, otherAttrs) : undefined;
  const hint = decisionRoleHintFor(otherId);

  return {
    personEntityId: otherId,
    name: otherName,
    weight,
    orgRole,
    business: otherAttrs?.larkDeptBusiness,
    functionLabel: otherAttrs?.larkDeptFunctionLabel,
    sharedProjectCanonicalNames: shared,
    decisionRoleHint: hint,
    evidenceUnitIds: evidenceUnitIds.slice(0, 5),
    lastSeenAt,
  };
}

/**
 * decisionRoleHint 简化推断（MVP15A SQL only）：看 X 在 entity_edges (person_project)
 * 上最高 role 命中：
 *   - owner / driver → 'co_owner'
 *   - reviewer       → 'reviewer'
 *   - contributor    → 'contributor'
 *   - stakeholder / observer → 'observer'
 *   - 无任何 person_project 边 → null
 *
 * MVP15B 用 LLM 读 evidence 给"decisionAuthority: high/mid/low"，到时候替换。
 */
function decisionRoleHintFor(personEntityId: string): DecisionRoleHint {
  const edges = listEntityEdges({
    kind: 'person_project',
    fromId: personEntityId,
    limit: 50,
  });
  if (edges.length === 0) return null;
  const rolePriority: Record<string, number> = {
    owner: 4,
    driver: 4,
    reviewer: 3,
    contributor: 2,
    stakeholder: 1,
    observer: 0,
  };
  let best = 0;
  for (const e of edges) {
    const r = (e.role_or_type ?? '') as string;
    const p = rolePriority[r] ?? 0;
    if (p > best) best = p;
  }
  if (best >= 4) return 'co_owner';
  if (best >= 3) return 'reviewer';
  if (best >= 2) return 'contributor';
  return 'observer';
}

function loadAttrs(entityId: string): PersonAttributes | null {
  const row = getContextEntityById(entityId);
  if (!row) return null;
  return parsePersonAttributesFromRow(row as never);
}

// 暴露给测试
export const __internal = {
  CACHE_TTL_MS,
  decisionRoleHintFor,
  resetCache: () => {
    _cache = null;
  },
};
