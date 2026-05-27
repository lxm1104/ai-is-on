/**
 * MVP15B M5 — assembleGraphContext(focalUnitId)
 *
 * 给定一个 focal ContextUnit，从 entity_edges / work_item_edges / org_project_phase
 * 现算出"图邻域"slice，供 attention prompt 和 specialist agent 消费。
 *
 * 不调 LLM。60s in-memory cache by focalUnitId（attention tick 频繁，避免每次现算）。
 *
 * 返回 4 块：
 *   - decisionPath：该 project 上 role∈owner/driver/reviewer 的 top 3 人
 *   - expectedButMissing.persons：sharedProject 高 weight 但 focal 里没出现的 top 5 人
 *   - activeBlockers：work_item_edges follows 上溯（B updates A → B 是 A 的上游/可能 blocker）
 *   - projectPhase：focal 只涉及 1 个 canonical project 时填
 */
import {
  db,
  getContextEntityById,
  getProjectPhase,
  listEntityEdges,
  listWorkItemEdges,
  resolveProjectCanonical,
  type EntityEdgeRow,
} from '../db.js';
import { getContextUnitById } from './contextStore.js';
import { resolveAliased } from './entityResolver.js';
import {
  parsePersonAttributesFromRow,
  type OrgRoleFromMe,
} from './personAttributes.js';

const CACHE_TTL_MS = 60_000;
const DECISION_PATH_CAP = 3;
const EXPECTED_MISSING_CAP = 5;
const ACTIVE_BLOCKERS_CAP = 3;
const EXPECTED_MISSING_MIN_WEIGHT = 0.5;

// role 优先序（数值越大越靠前）
const ROLE_PRIORITY: Record<string, number> = {
  owner: 6,
  driver: 5,
  reviewer: 4,
  contributor: 3,
  stakeholder: 2,
  observer: 1,
};

// decisionAuthority 优先序
const DA_PRIORITY: Record<string, number> = {
  high: 3,
  mid: 2,
  low: 1,
};

export type DecisionPathEntry = {
  name: string;
  role: string;                                // 实际写入的 sql-inferred role
  decisionAuthority?: 'high' | 'mid' | 'low';
  orgRole?: OrgRoleFromMe;
  business?: string;
  why?: string;                                // LLM 给的解释（若有）
};

export type ExpectedMissingPerson = {
  name: string;
  reason: string;
  weight: number;
};

export type ActiveBlockerEntry = {
  blockerUnitId: string;
  blockerTitle: string;
  blockerOwner?: string;
  reason: string;
};

export type ProjectPhaseSummary = {
  canonicalName: string;
  phase: string;
  health: string;
  summary?: string;
};

export type GraphContextSlice = {
  focal: { personEntityIds: string[]; projectCanonicalNames: string[] };
  decisionPath: DecisionPathEntry[];
  expectedButMissing: { persons: ExpectedMissingPerson[] };
  activeBlockers: ActiveBlockerEntry[];
  projectPhase?: ProjectPhaseSummary;
};

// ----- 60s in-memory cache -----
type CacheEntry = { cachedAt: number; slice: GraphContextSlice };
const _cache = new Map<string, CacheEntry>();

export function assembleGraphContext(
  focalUnitId: string,
  opts: { now?: number; bypassCache?: boolean } = {}
): GraphContextSlice | null {
  const now = opts.now ?? Date.now();
  const cached = _cache.get(focalUnitId);
  if (
    !opts.bypassCache &&
    cached &&
    now - cached.cachedAt < CACHE_TTL_MS
  ) {
    return cached.slice;
  }

  // 1. 加载 focal unit
  const focal = getContextUnitById(focalUnitId);
  if (!focal) return null;

  // 2. 提取 focal 涉及的 person entity ids（canonical）+ project canonical names
  const { personEntityIds, projectCanonicalNames } = extractFocalAnchors(focalUnitId);

  // 2.5 self 解析（self 不进 decisionPath / expectedButMissing —— attention 是给"我"看的，
  // 把"我自己"列为应抄送的人/决策者没意义）
  const selfCanonicalId = loadSelfCanonicalId();

  // 3. decisionPath：top 3 决策位置的人
  const decisionPath = buildDecisionPath(projectCanonicalNames, selfCanonicalId);

  // 4. expectedButMissing.persons：sharedProject 高 weight 但 focal 里没出现的人
  const focalAndSelf = new Set(personEntityIds);
  if (selfCanonicalId) focalAndSelf.add(selfCanonicalId);
  const expectedMissingPersons = buildExpectedMissingPersons(
    projectCanonicalNames,
    focalAndSelf
  );

  // 5. activeBlockers：work_item_edges follows 上溯
  const activeBlockers = buildActiveBlockers(focalUnitId);

  // 6. projectPhase：focal 只涉及 1 个 canonical project 时
  let projectPhase: ProjectPhaseSummary | undefined;
  if (projectCanonicalNames.length === 1) {
    const row = getProjectPhase(projectCanonicalNames[0]);
    if (row && row.phase && row.health) {
      projectPhase = {
        canonicalName: row.canonical_name,
        phase: row.phase,
        health: row.health,
        summary: row.summary ?? undefined,
      };
    }
  }

  const slice: GraphContextSlice = {
    focal: { personEntityIds, projectCanonicalNames },
    decisionPath,
    expectedButMissing: { persons: expectedMissingPersons },
    activeBlockers,
    projectPhase,
  };

  _cache.set(focalUnitId, { cachedAt: now, slice });
  return slice;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function loadSelfCanonicalId(): string | null {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = 'self_person_entity_id'`)
    .get() as { value: string } | undefined;
  if (!row?.value) return null;
  return resolveAliased(row.value);
}

function extractFocalAnchors(focalUnitId: string): {
  personEntityIds: string[];
  projectCanonicalNames: string[];
} {
  // 拉 focal unit 关联的所有 entities
  type Row = { entity_id: string; type: string; name: string };
  const rows = db
    .prepare(
      `SELECT cue.entity_id, ce.type, ce.name
       FROM context_unit_entities cue
       JOIN context_entities ce ON ce.id = cue.entity_id
       WHERE cue.context_unit_id = ?`
    )
    .all(focalUnitId) as Row[];

  const personSet = new Set<string>();
  const projectSet = new Set<string>();
  for (const r of rows) {
    if (r.type === 'person') {
      personSet.add(resolveAliased(r.entity_id));
    } else if (r.type === 'project') {
      // resolve to canonical name
      personSet; // noop, keep
      const canonical = resolveProjectCanonical(r.name);
      projectSet.add(canonical);
    }
  }
  return {
    personEntityIds: Array.from(personSet),
    projectCanonicalNames: Array.from(projectSet),
  };
}

function buildDecisionPath(
  projectCanonicalNames: string[],
  selfCanonicalId: string | null
): DecisionPathEntry[] {
  if (projectCanonicalNames.length === 0) return [];

  // 取所有相关 ppj 边
  const allEdges: EntityEdgeRow[] = [];
  for (const canonical of projectCanonicalNames) {
    const edges = listEntityEdges({
      kind: 'person_project',
      toId: canonical,
      limit: 50,
    });
    // self 不进 decisionPath
    for (const e of edges) {
      if (selfCanonicalId && e.from_id === selfCanonicalId) continue;
      allEdges.push(e);
    }
  }

  // 设计折衷（MVP15B 真 db smoke 后调整）：
  // 现实数据里 30 个 ppj 边全是 contributor/stakeholder（因为多数 person+project
  // 共现来自 about role 或非 commitment kind）。严格 filter owner/driver/reviewer
  // 会让 decisionPath 跑空，直到 M3 LLM 把 decisionAuthority 升 high/mid。
  //
  // 折衷：不按 role 硬过滤（除了 observer），统一按 composite (DA*10 + role) 排序。
  // 这样：
  //   · 无 LLM 标签时：top contributor 也能浮出来当"参与最深的人"
  //   · M3 LLM 标过后：DA=high 的人自动排到最前（composite=30+role），盖过纯 role 信号
  const filtered = allEdges.filter((e) => (e.role_or_type ?? '') !== 'observer');

  // 排序：先按 (decisionAuthority 优先 * 10 + role 优先) desc，再按 weight desc
  filtered.sort((a, b) => {
    const aDa = DA_PRIORITY[a.decision_authority ?? ''] ?? 0;
    const bDa = DA_PRIORITY[b.decision_authority ?? ''] ?? 0;
    const aRole = ROLE_PRIORITY[a.role_or_type ?? ''] ?? 0;
    const bRole = ROLE_PRIORITY[b.role_or_type ?? ''] ?? 0;
    const aComposite = aDa * 10 + aRole;
    const bComposite = bDa * 10 + bRole;
    if (aComposite !== bComposite) return bComposite - aComposite;
    return b.weight - a.weight;
  });

  // dedup by person (跨多个 project 出现) — 取最高优先级一条
  const seen = new Set<string>();
  const out: DecisionPathEntry[] = [];
  for (const edge of filtered) {
    if (seen.has(edge.from_id)) continue;
    seen.add(edge.from_id);
    const personRow = getContextEntityById(edge.from_id);
    if (!personRow) continue;
    const attrs = parsePersonAttributesFromRow(personRow);
    out.push({
      name: personRow.name,
      role: edge.role_or_type ?? 'contributor',
      decisionAuthority: (edge.decision_authority ?? undefined) as DecisionPathEntry['decisionAuthority'],
      orgRole: attrs?.orgRoleFromMe,
      business: attrs?.larkDeptBusiness,
      why: edge.llm_why ?? undefined,
    });
    if (out.length >= DECISION_PATH_CAP) break;
  }
  return out;
}

function buildExpectedMissingPersons(
  projectCanonicalNames: string[],
  focalPersonIds: Set<string>
): ExpectedMissingPerson[] {
  if (projectCanonicalNames.length === 0) return [];

  // 拉所有项目相关的 ppj 边
  type Cand = { personId: string; canonical: string; weight: number };
  const candidates: Cand[] = [];
  for (const canonical of projectCanonicalNames) {
    const edges = listEntityEdges({
      kind: 'person_project',
      toId: canonical,
      minWeight: EXPECTED_MISSING_MIN_WEIGHT,
      limit: 50,
    });
    for (const e of edges) {
      candidates.push({ personId: e.from_id, canonical, weight: e.weight });
    }
  }

  // 排除 focal 里已有的人；同一 person 多 project 合并取最大 weight + 项目列表
  type Aggr = { personId: string; weight: number; projects: string[] };
  const byPerson = new Map<string, Aggr>();
  for (const c of candidates) {
    if (focalPersonIds.has(c.personId)) continue;
    const existing = byPerson.get(c.personId);
    if (!existing) {
      byPerson.set(c.personId, {
        personId: c.personId,
        weight: c.weight,
        projects: [c.canonical],
      });
    } else {
      existing.weight = Math.max(existing.weight, c.weight);
      if (!existing.projects.includes(c.canonical)) {
        existing.projects.push(c.canonical);
      }
    }
  }

  // 排序 + cap
  const sorted = Array.from(byPerson.values()).sort((a, b) => b.weight - a.weight);
  const out: ExpectedMissingPerson[] = [];
  for (const a of sorted) {
    const personRow = getContextEntityById(a.personId);
    if (!personRow) continue;
    const projectList = a.projects.join(' / ');
    out.push({
      name: personRow.name,
      reason: `${personRow.name} 是 ${projectList} 的协作者（weight=${a.weight.toFixed(2)}），本次未参与`,
      weight: a.weight,
    });
    if (out.length >= EXPECTED_MISSING_CAP) break;
  }
  return out;
}

function buildActiveBlockers(focalUnitId: string): ActiveBlockerEntry[] {
  // work_item_edges: type='follows' 语义是 "A follows B"（focal=A），B 是上游/潜在 blocker
  // 所以查 to_unit_id = focal AND status='active' → blockerUnitId = from_unit_id (B)
  const edges = listWorkItemEdges({
    toUnitId: focalUnitId,
    status: 'active',
    limit: 20,
  });
  const blockerEdges = edges.filter((e) => e.type === 'follows');
  if (blockerEdges.length === 0) return [];

  // 拉 blocker unit 的 title + actor entity name（owner hint）
  const out: ActiveBlockerEntry[] = [];
  for (const edge of blockerEdges) {
    const blockerUnit = getContextUnitById(edge.from_unit_id);
    if (!blockerUnit) continue;
    // 简单 owner hint：blocker unit 上 role='actor' AND type='person' 的第一个
    const ownerRow = db
      .prepare(
        `SELECT ce.name FROM context_unit_entities cue
         JOIN context_entities ce ON ce.id = cue.entity_id
         WHERE cue.context_unit_id = ? AND cue.role = 'actor' AND ce.type = 'person'
         LIMIT 1`
      )
      .get(edge.from_unit_id) as { name: string } | undefined;
    out.push({
      blockerUnitId: edge.from_unit_id,
      blockerTitle: blockerUnit.title,
      blockerOwner: ownerRow?.name,
      reason: edge.reason || 'follows link 推断的上游 unit（MVP15B：标"可能阻塞"，blocks 真值待 MVP15.5）',
    });
    if (out.length >= ACTIVE_BLOCKERS_CAP) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 测试 / 维护暴露
// ---------------------------------------------------------------------------
export const __internal = {
  CACHE_TTL_MS,
  DECISION_PATH_CAP,
  EXPECTED_MISSING_CAP,
  ACTIVE_BLOCKERS_CAP,
  EXPECTED_MISSING_MIN_WEIGHT,
  ROLE_PRIORITY,
  DA_PRIORITY,
  resetCache: () => _cache.clear(),
  cacheSize: () => _cache.size,
};
