import { randomUUID } from 'node:crypto';
import {
  AliasConflictError,
  db,
  type ContextSpaceLinkRow,
  type ContextSpaceRow,
  type ContextSpaceSuggestionRow,
  getContextSpace,
  getContextSpaceByTypeName,
  getProjectAuthoritativeSpaceId,
  getProjectCanonicalSet,
  insertContextSpace,
  insertContextSpaceSuggestionFeedback,
  listContextSpaces,
  listContextUnits,
  listSpaceLinks,
  listSpaceSuggestions,
  listSpacesForTarget,
  listUnitRoutingCacheByUnit,
  tryInsertContextSpaceLink,
  updateContextSpace,
  upsertContextSpaceLinkBestHit,
  upsertProjectTaxonomy,
  type SpaceLinkHit,
} from '../db.js';
import type { ContextEntityRef, ContextUnit } from '../context/ContextUnit.js';
import { getContextUnitById } from '../context/contextStore.js';
import { resolveAliased, resolveOrCreateEntity } from '../context/entityResolver.js';

export type SpaceType = 'project' | 'topic';

export type SpaceWithLinks = ContextSpaceRow & {
  entityLinks: Array<{ id: string; type: string; name: string; linkType: string }>;
  unitLinkCount: number;
};

// ---------- MVP13 §3.1 SpaceIntentJson codec ----------

export type SpaceIntentJson = {
  schemaVersion: 1;
  summary?: string;
  aliases?: string[];
  keywords?: string[];
  negativeKeywords?: string[];
  workMapGoalTitles?: string[];
  workMapRiskTitles?: string[];
  authoritativeDocNames?: string[];
  stakeholderNames?: string[];
  updatedBy?: 'user' | 'work_map_writer' | 'system';
  updatedAt?: string;
};

export type SpaceWorkMapRefJson = {
  source: 'work_map_writer';
  projectName: string;
  origin: 'work_map';
  unitMergeKeys?: string[];
  updatedAt: string;
};

export function decodeSpaceIntent(raw: string | null | undefined): SpaceIntentJson {
  if (!raw) return { schemaVersion: 1 };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v && typeof v === 'object') {
      return { ...(v as object), schemaVersion: 1 } as SpaceIntentJson;
    }
    return { schemaVersion: 1 };
  } catch {
    return { schemaVersion: 1 };
  }
}

export function encodeSpaceIntent(intent: SpaceIntentJson): string {
  return JSON.stringify({ ...intent, schemaVersion: 1 });
}

export function decodeSpaceWorkMapRef(
  raw: string | null | undefined
): SpaceWorkMapRefJson | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SpaceWorkMapRefJson;
  } catch {
    return null;
  }
}

export function getSpaceIntent(spaceId: string): SpaceIntentJson | null {
  const sp = getContextSpace(spaceId);
  if (!sp) return null;
  return decodeSpaceIntent(sp.intent_json);
}

/**
 * MVP13 §5.2: 用户编辑 intent。强制 updatedBy='user'，
 * 后续 Work Map sync 不会覆盖 user 设置的字段。
 */
export function updateSpaceIntentByUser(
  spaceId: string,
  patch: Partial<Omit<SpaceIntentJson, 'schemaVersion' | 'updatedBy'>>
): SpaceIntentJson | null {
  const sp = getContextSpace(spaceId);
  if (!sp) return null;
  const current = decodeSpaceIntent(sp.intent_json);
  const merged: SpaceIntentJson = {
    ...current,
    ...patch,
    schemaVersion: 1,
    updatedBy: 'user',
    updatedAt: new Date().toISOString(),
  };
  updateContextSpace({
    ...sp,
    intent_json: encodeSpaceIntent(merged),
    updated_at: new Date().toISOString(),
  });
  return merged;
}

/**
 * MVP13 §5.1/5.2: Work Map writer 调这里同步 intent。
 *
 * 规则：
 *   - updatedBy='user' 的 intent：只 patch 缺失字段、追加非冲突 array 元素，不覆盖
 *   - 其他情况：work_map_writer 自动字段全量覆盖
 *
 * patch 里的字段都是 work_map 推导出来的"自动字段"。
 */
export function syncSpaceIntentFromWorkMap(
  spaceId: string,
  patch: {
    summary?: string;
    aliases?: string[];
    keywords?: string[];
    workMapGoalTitles?: string[];
    workMapRiskTitles?: string[];
    authoritativeDocNames?: string[];
    stakeholderNames?: string[];
  },
  workMapRef: SpaceWorkMapRefJson
): SpaceIntentJson | null {
  const sp = getContextSpace(spaceId);
  if (!sp) return null;
  const current = decodeSpaceIntent(sp.intent_json);
  const userOwned = current.updatedBy === 'user';
  const now = new Date().toISOString();

  function pickScalar<K extends 'summary'>(key: K): string | undefined {
    if (!userOwned) return patch[key] ?? current[key];
    return current[key] ?? patch[key];
  }
  function pickArrayMerged<K extends keyof typeof patch & string>(
    key: K
  ): string[] | undefined {
    const a = (current[key as keyof SpaceIntentJson] as string[] | undefined) ?? [];
    const b = (patch[key] as string[] | undefined) ?? [];
    if (!userOwned) {
      // work_map 全量覆盖：用 patch 为准，但保留 current 里 user 加的（不区分时全收）
      const set = new Set<string>([...(b ?? [])]);
      // 如果 current 已存在但 patch 也给同样名字 → 还是只一份
      for (const x of a) set.add(x);
      return Array.from(set);
    }
    // user-owned：追加非冲突
    const set = new Set<string>(a);
    for (const x of b) set.add(x);
    return Array.from(set);
  }

  const merged: SpaceIntentJson = {
    ...current,
    schemaVersion: 1,
    summary: pickScalar('summary'),
    aliases: pickArrayMerged('aliases') ?? current.aliases,
    keywords: pickArrayMerged('keywords') ?? current.keywords,
    workMapGoalTitles:
      pickArrayMerged('workMapGoalTitles') ?? current.workMapGoalTitles,
    workMapRiskTitles:
      pickArrayMerged('workMapRiskTitles') ?? current.workMapRiskTitles,
    authoritativeDocNames:
      pickArrayMerged('authoritativeDocNames') ?? current.authoritativeDocNames,
    stakeholderNames:
      pickArrayMerged('stakeholderNames') ?? current.stakeholderNames,
    updatedBy: userOwned ? 'user' : 'work_map_writer',
    updatedAt: now,
  };
  updateContextSpace({
    ...sp,
    intent_json: encodeSpaceIntent(merged),
    work_map_ref_json: JSON.stringify(workMapRef),
    updated_at: now,
  });
  return merged;
}

export function listSpaces(): ContextSpaceRow[] {
  return listContextSpaces({ status: 'active' });
}

export function getSpaceDetail(id: string): {
  space: ContextSpaceRow;
  links: ContextSpaceLinkRow[];
} | null {
  const space = getContextSpace(id);
  if (!space) return null;
  const links = listSpaceLinks(id);
  return { space, links };
}

/**
 * MVP19 §行为设计 / work-map writer 接入注册表：
 *
 * 把一个 context_spaces 行同步到 org_project_taxonomy。语义：
 *   - 若 canonical_name=space.name 不存在 → INSERT 新行
 *     （parsed_by='work_map_writer'、authoritative_space_id=space.id、
 *      parent_canonical_name=NULL、aliases_json=[space.name]）
 *   - 若已存在 → 只 UPDATE 两列：parsed_by='work_map_writer'、
 *     authoritative_space_id=space.id。aliases_json / parent_canonical_name /
 *     summary 一律不动，避免覆盖 LLM 已积累的别名或人工已设的 parent。
 *
 * 由 upsertProjectTaxonomy 实现以下语义自动达成：
 *   - 不存在 → INSERT；
 *   - 存在 → aliases 取并集（重复加入 space.name 不会污染），
 *     summary 空值新值跳过保留旧值；
 *     parent_canonical_name=undefined → 保留现有；
 *     authoritative_space_id 显式传入 → 覆盖。
 *
 * 用途：
 *   1. createSpace 内部调用，让任何新建 space 都自动建注册表锚点；
 *   2. boot migration 一次性扫存量 spaces 同步进 taxonomy（Step 2）。
 *
 * AliasConflictError 容错：仅记 warn 不阻断 createSpace 主流程——space 已经
 * 落库成功，taxonomy 同步失败属于次要副作用，运维可后续 SQL 手工修。
 */
export function syncSpaceToProjectTaxonomy(space: ContextSpaceRow): void {
  if (space.type !== 'project') return; // topic 类不挂 project taxonomy
  try {
    upsertProjectTaxonomy({
      canonical_name: space.name,
      aliases_json: JSON.stringify([space.name]),
      summary: null,
      parsed_by: 'work_map_writer',
      parsed_at: new Date().toISOString(),
      authoritative_space_id: space.id,
      // parent_canonical_name 不传 → 保留现状（已存在的 canonical 可能已设父；
      // 新创建的顶层为 NULL）
    });
  } catch (err) {
    if (err instanceof AliasConflictError) {
      console.warn(
        `[contextSpaces] syncSpaceToProjectTaxonomy alias conflict for space ` +
          `"${space.name}" (${space.id}): alias "${err.alias}" already belongs ` +
          `to canonical "${err.existingCanonical}". Skipping taxonomy sync; ` +
          `manual SQL needed.`
      );
      return;
    }
    throw err;
  }
}

export function createSpace(input: {
  type: SpaceType;
  name: string;
  description?: string;
  entityNames?: Array<{ type: string; name: string }>;
}): ContextSpaceRow {
  const existing = getContextSpaceByTypeName(input.type, input.name);
  if (existing) {
    // MVP19: 即便是复用已有 space，也确保 taxonomy 锚点存在（幂等）
    syncSpaceToProjectTaxonomy(existing);
    return existing;
  }

  const now = new Date().toISOString();
  const row: ContextSpaceRow = {
    id: randomUUID(),
    type: input.type,
    name: input.name,
    description: input.description ?? null,
    owner_subject_id: 'me',
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  insertContextSpace(row);

  // Attach seed entities — these are the entities the resolver will key on
  // to associate future ContextUnits with this Space.
  if (input.entityNames && input.entityNames.length > 0) {
    for (const e of input.entityNames) {
      const entity = resolveOrCreateEntity(e.type, e.name);
      tryInsertContextSpaceLink({
        id: randomUUID(),
        space_id: row.id,
        target_type: 'entity',
        target_id: entity.id,
        link_type: 'about',
        confidence: 1.0,
        created_at: now,
      });
    }
  } else {
    // Default: also create a project/topic entity matching the space name,
    // so a ContextUnit referencing that name (e.g. project 'AI is ON') will
    // route to this space.
    const entity = resolveOrCreateEntity(input.type, input.name);
    tryInsertContextSpaceLink({
      id: randomUUID(),
      space_id: row.id,
      target_type: 'entity',
      target_id: entity.id,
      link_type: 'about',
      confidence: 1.0,
      created_at: now,
    });
  }

  // MVP19: 新建 space 自动同步到 project canonical 注册表（仅 project 类型）。
  // 失败不阻断 createSpace 主流程（详见 syncSpaceToProjectTaxonomy 注释）。
  syncSpaceToProjectTaxonomy(row);

  return row;
}

export function archiveSpace(id: string): ContextSpaceRow | null {
  const row = getContextSpace(id);
  if (!row) return null;
  const updated: ContextSpaceRow = {
    ...row,
    status: 'archived',
    updated_at: new Date().toISOString(),
  };
  updateContextSpace(updated);
  return updated;
}

// MVP12 §4.1 P1.6：rank 表（rank 越大越优）
//
//   person / project (direct via unit.entities)        → rank 3, 'about',          conf 0.80
//   doc            (direct via unit.entities or cache) → rank 2, 'about_via_doc',  conf 0.85
//   chat seed      (only via routing cache)            → rank 1, 'about_via_chat', conf 0.75
const RANK_TABLE: Record<string, { rank: number; linkType: string; confidence: number; via: string }> = {
  person: { rank: 3, linkType: 'about', confidence: 0.8, via: 'person' },
  project: { rank: 3, linkType: 'about', confidence: 0.8, via: 'project' },
  topic: { rank: 3, linkType: 'about', confidence: 0.8, via: 'topic' },
  doc: { rank: 2, linkType: 'about_via_doc', confidence: 0.85, via: 'doc' },
  chat: { rank: 1, linkType: 'about_via_chat', confidence: 0.75, via: 'chat_seed' },
};

/**
 * 把 unit 自身的 entities 与（semantic 时）routing cache 里的 entities 合并去重，
 * dedup by (type, name, role)。
 */
function collectRoutingEntities(unit: ContextUnit): ContextEntityRef[] {
  const seen = new Set<string>();
  const out: ContextEntityRef[] = [];
  const push = (e: ContextEntityRef) => {
    const key = `${e.type}::${e.name}::${e.role ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  for (const e of unit.entities ?? []) push(e);

  if (unit.kind !== 'event') {
    try {
      for (const row of listUnitRoutingCacheByUnit(unit.id)) {
        const refs = JSON.parse(row.routing_entities_json) as ContextEntityRef[];
        for (const e of refs) push(e);
      }
    } catch (err) {
      console.warn(
        '[spaces] read routing cache failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return out;
}

/**
 * MVP12 §4.1 P1.6：把 unit 路由到所有匹配 Space，rank-aware 写 link。
 * 同 Space 多个 entity 命中取 max rank（并列取较大 confidence），reason 累加。
 */
export function resolveUnitToSpaces(unit: ContextUnit): string[] {
  const routing = collectRoutingEntities(unit);
  if (routing.length === 0) return [];

  // spaceId → 当前最佳 hit（基于 rank → confidence）
  const bestPerSpace = new Map<string, SpaceLinkHit>();
  // spaceId → 已 evidence 过的 (via, sourceEntityId) 集合，避免同 unit 同入口多次写
  const evidenceSeen = new Map<string, Set<string>>();

  for (const e of routing) {
    const tier = RANK_TABLE[e.type];
    if (!tier) continue; // 不参与路由的 entity type (emotion / org / ...)
    let entId: string;
    try {
      const ent = resolveOrCreateEntity(e.type, e.name);
      entId = resolveAliased(ent.id);
    } catch {
      continue;
    }
    const links = listSpacesForTarget('entity', entId);
    for (const l of links) {
      const seenKey = `${tier.via}::${entId}`;
      const seenSet = evidenceSeen.get(l.space_id) ?? new Set<string>();
      if (seenSet.has(seenKey)) continue;
      seenSet.add(seenKey);
      evidenceSeen.set(l.space_id, seenSet);

      const candidate: SpaceLinkHit = {
        rank: tier.rank,
        linkType: tier.linkType,
        confidence: tier.confidence,
        reason: {
          via: tier.via,
          sourceEntityId: entId,
          sourceEntityName: e.name,
        },
      };
      const current = bestPerSpace.get(l.space_id);
      if (
        !current ||
        candidate.rank > current.rank ||
        (candidate.rank === current.rank && candidate.confidence > current.confidence)
      ) {
        bestPerSpace.set(l.space_id, candidate);
      }
    }

    // ----- MVP19：project entity 额外走 canonical→space 路径 -----
    // 即使该 project entity 没被任何 space 直接 seed-link，只要它的 canonical 或
    // 任一祖先 canonical 有 authoritative_space_id，也算作命中那个 space。
    // 用独立的 via='project_canonical' 跟 direct entity 路径区分，避免 seenKey 撞车。
    if (e.type === 'project') {
      let canonicalSet: Set<string>;
      try {
        canonicalSet = getProjectCanonicalSet(e.name);
      } catch (err) {
        // getProjectAncestorChain 内部检测到环时会抛；这里降级为只用自身
        console.warn(
          `[spaces] getProjectCanonicalSet failed for "${e.name}":`,
          err instanceof Error ? err.message : String(err)
        );
        canonicalSet = new Set([e.name]);
      }
      for (const canonical of canonicalSet) {
        const spaceId = getProjectAuthoritativeSpaceId(canonical);
        if (!spaceId) continue;
        const seenKey = `project_canonical::${canonical}`;
        const seenSet = evidenceSeen.get(spaceId) ?? new Set<string>();
        if (seenSet.has(seenKey)) continue;
        seenSet.add(seenKey);
        evidenceSeen.set(spaceId, seenSet);

        const candidate: SpaceLinkHit = {
          rank: tier.rank,           // project 档：rank=3
          linkType: tier.linkType,   // 'about'
          confidence: tier.confidence, // 0.8
          reason: {
            via: 'project_canonical',
            sourceEntityId: entId,
            sourceEntityName: canonical,
          },
        };
        const current = bestPerSpace.get(spaceId);
        if (
          !current ||
          candidate.rank > current.rank ||
          (candidate.rank === current.rank && candidate.confidence > current.confidence)
        ) {
          bestPerSpace.set(spaceId, candidate);
        }
      }
    }
  }

  if (bestPerSpace.size === 0) return [];
  const now = new Date().toISOString();
  const linked: string[] = [];
  for (const [spaceId, hit] of bestPerSpace) {
    const r = upsertContextSpaceLinkBestHit(spaceId, unit.id, hit, randomUUID, now);
    if (r === 'inserted' || r === 'upgraded') linked.push(spaceId);
  }
  return linked;
}

// ---------- MVP13 §6.1 / §6.2 confirm / reject reason ----------

export type ConfirmReasonCode =
  | 'exact_project_chat'
  | 'useful_context_source'
  | 'name_match'
  | 'people_match'
  | 'doc_match'
  | 'other';

export type RejectReasonCode =
  | 'wrong_space'
  | 'chat_too_broad'
  | 'only_incidental_mention'
  | 'obsolete'
  | 'duplicate_seed'
  | 'private_or_noise'
  | 'permanent_not_relevant'
  | 'other';

const CONFIRM_REASON_DEFAULT: ConfirmReasonCode = 'exact_project_chat';
const REJECT_REASON_DEFAULT: RejectReasonCode = 'other';

/** MVP13 §6.2 reason-aware cooldown 默认值。 */
export function cooldownDaysForRejectReason(
  code: RejectReasonCode | undefined
): number {
  switch (code) {
    case 'obsolete':
      return 14;
    case 'wrong_space':
    case 'private_or_noise':
      return 90;
    case 'duplicate_seed':
    case 'permanent_not_relevant':
      return 365;
    default:
      return 30;
  }
}

function buildSuggestionSnapshot(
  row: ContextSpaceSuggestionRow
): Record<string, unknown> {
  let evidence: unknown = null;
  try {
    evidence = JSON.parse(row.evidence_json);
  } catch {
    evidence = row.evidence_json;
  }
  return {
    suggestion: {
      id: row.id,
      target_type: row.target_type,
      target_id: row.target_id,
      space_id: row.space_id,
      suggestion_type: row.suggestion_type,
      score: row.score,
      status: row.status,
      cooldown_until: row.cooldown_until,
      rule_score: row.rule_score,
      llm_score: row.llm_score,
      final_score: row.final_score,
      llm_decision: row.llm_decision,
      llm_confidence: row.llm_confidence,
      ranker_status: row.ranker_status,
      ranker_version: row.ranker_version,
      model_id: row.model_id,
    },
    evidence,
  };
}

function writeFeedbackRow(args: {
  row: ContextSpaceSuggestionRow;
  action: 'confirmed' | 'rejected';
  reasonCode: string;
  comment?: string | null;
  cooldownUntil?: string | null;
}): void {
  insertContextSpaceSuggestionFeedback({
    id: randomUUID(),
    suggestion_id: args.row.id,
    space_id: args.row.space_id,
    target_type: args.row.target_type,
    target_id: args.row.target_id,
    suggestion_type: args.row.suggestion_type,
    action: args.action,
    reason_code: args.reasonCode,
    comment: args.comment ?? null,
    cooldown_until: args.cooldownUntil ?? null,
    snapshot_json: JSON.stringify(buildSuggestionSnapshot(args.row)),
    created_at: new Date().toISOString(),
  });
}

// MVP12 Phase 2 §5.2 + MVP13 §6：confirm 一条 chat_affinity suggestion → 写 chat seed +
// 触发 reconcile，让历史 unit 也补上 'about_via_chat' link；同时记录 feedback。
export function confirmChatAffinitySuggestion(args: {
  spaceId: string;
  suggestionId: string;
  reasonCode?: ConfirmReasonCode;
  comment?: string | null;
  decidedBy?: string;
}): {
  ok: boolean;
  reason?: string;
  reconciled?: { scanned: number; linked: number };
} {
  const row = listAllSuggestionsForSpace(args.spaceId).find(
    (s) => s.id === args.suggestionId
  );
  if (!row) return { ok: false, reason: 'suggestion not found' };
  if (row.suggestion_type !== 'chat_affinity')
    return { ok: false, reason: 'only chat_affinity supported here' };
  if (row.target_type !== 'entity') return { ok: false, reason: 'bad target_type' };

  const reasonCode = args.reasonCode ?? CONFIRM_REASON_DEFAULT;

  // 写 chat seed entity link（target_type='entity', link_type='about', confidence=1.0）
  const now = new Date().toISOString();
  tryInsertContextSpaceLink({
    id: randomUUID(),
    space_id: args.spaceId,
    target_type: 'entity',
    target_id: row.target_id,
    link_type: 'about',
    confidence: 1.0,
    created_at: now,
    reason_json: JSON.stringify({
      via: 'chat_seed_confirmed',
      source: 'mvp13_llm_ranker',
      suggestionId: row.id,
      llmScore: row.llm_score ?? null,
      ruleScore: row.rule_score ?? null,
      reasonCode,
    }),
  });
  updateSuggestionDecision(
    args.suggestionId,
    'confirmed',
    null,
    args.decidedBy ?? 'me'
  );
  writeFeedbackRow({
    row,
    action: 'confirmed',
    reasonCode,
    comment: args.comment ?? null,
  });
  const stats = reconcileAllUnitsToSpaces();
  return { ok: true, reconciled: stats };
}

export function rejectSuggestion(args: {
  spaceId: string;
  suggestionId: string;
  cooldownDays?: number;
  reasonCode?: RejectReasonCode;
  comment?: string | null;
  decidedBy?: string;
}): { ok: boolean; reason?: string; cooldownUntil?: string } {
  const row = listAllSuggestionsForSpace(args.spaceId).find(
    (s) => s.id === args.suggestionId
  );
  if (!row) return { ok: false, reason: 'suggestion not found' };
  const reasonCode = args.reasonCode ?? REJECT_REASON_DEFAULT;
  const days = args.cooldownDays ?? cooldownDaysForRejectReason(reasonCode);
  const cooldownUntil = new Date(
    Date.now() + days * 86400_000
  ).toISOString();
  updateSuggestionDecision(
    args.suggestionId,
    'rejected',
    cooldownUntil,
    args.decidedBy ?? 'me'
  );
  writeFeedbackRow({
    row,
    action: 'rejected',
    reasonCode,
    comment: args.comment ?? null,
    cooldownUntil,
  });
  return { ok: true, cooldownUntil };
}

function listAllSuggestionsForSpace(spaceId: string): ContextSpaceSuggestionRow[] {
  return db
    .prepare(
      `SELECT * FROM context_space_suggestions
       WHERE space_id = ? ORDER BY score DESC, updated_at DESC`
    )
    .all(spaceId) as ContextSpaceSuggestionRow[];
}

function updateSuggestionDecision(
  id: string,
  status: 'suggested' | 'confirmed' | 'rejected',
  cooldownUntil: string | null,
  decidedBy: string
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE context_space_suggestions
     SET status = ?, cooldown_until = ?, updated_at = ?,
         decided_at = ?, decided_by = ?
     WHERE id = ?`
  ).run(status, cooldownUntil, now, now, decidedBy, id);
}

export function listSuggestionsForSpace(
  spaceId: string,
  status?: string
): ContextSpaceSuggestionRow[] {
  return listSpaceSuggestions(spaceId, status);
}

/**
 * Backfill: walk all active ContextUnits and route each through
 * resolveUnitToSpaces. Used when a new Space is created and we want to
 * pick up the units that already match its seed entities.
 */
export function reconcileAllUnitsToSpaces(): { scanned: number; linked: number } {
  const rows = listContextUnits({ status: 'active', limit: 2000, includeExpired: true });
  let linked = 0;
  for (const r of rows) {
    const unit = getContextUnitById(r.id);
    if (!unit) continue;
    const result = resolveUnitToSpaces(unit);
    linked += result.length;
  }
  return { scanned: rows.length, linked };
}
