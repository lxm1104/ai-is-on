import { randomUUID } from 'node:crypto';
import {
  db,
  type ContextSpaceLinkRow,
  type ContextSpaceRow,
  type ContextSpaceSuggestionRow,
  getContextSpace,
  getContextSpaceByTypeName,
  insertContextSpace,
  listContextSpaces,
  listContextUnits,
  listSpaceLinks,
  listSpaceSuggestions,
  listSpacesForTarget,
  listUnitRoutingCacheByUnit,
  tryInsertContextSpaceLink,
  updateContextSpace,
  upsertContextSpaceLinkBestHit,
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

export function createSpace(input: {
  type: SpaceType;
  name: string;
  description?: string;
  entityNames?: Array<{ type: string; name: string }>;
}): ContextSpaceRow {
  const existing = getContextSpaceByTypeName(input.type, input.name);
  if (existing) return existing;

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
    if (links.length === 0) continue;
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

// MVP12 Phase 2 §5.2：confirm 一条 chat_affinity suggestion → 写 chat seed +
// 触发 reconcile，让历史 unit 也补上 'about_via_chat' link。
//
// 同时把该 suggestion 状态置为 'confirmed'。返回 reconcile 命中数。
export function confirmChatAffinitySuggestion(args: {
  spaceId: string;
  suggestionId: string;
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
      sourceEntityId: row.target_id,
      sourceEntityName: row.target_id,
    }),
  });
  // 状态机
  updateSuggestionStatus(args.suggestionId, 'confirmed', null);
  // reconcile：把现有 unit 通过此 chat seed 重新路由
  const stats = reconcileAllUnitsToSpaces();
  return { ok: true, reconciled: stats };
}

export function rejectSuggestion(args: {
  spaceId: string;
  suggestionId: string;
  cooldownDays?: number;
}): { ok: boolean; reason?: string; cooldownUntil?: string } {
  const days = args.cooldownDays ?? 30;
  const row = listAllSuggestionsForSpace(args.spaceId).find(
    (s) => s.id === args.suggestionId
  );
  if (!row) return { ok: false, reason: 'suggestion not found' };
  const cooldownUntil = new Date(
    Date.now() + days * 86400_000
  ).toISOString();
  updateSuggestionStatus(args.suggestionId, 'rejected', cooldownUntil);
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

function updateSuggestionStatus(
  id: string,
  status: 'suggested' | 'confirmed' | 'rejected',
  cooldownUntil: string | null
): void {
  db.prepare(
    `UPDATE context_space_suggestions
     SET status = ?, cooldown_until = ?, updated_at = ?
     WHERE id = ?`
  ).run(status, cooldownUntil, new Date().toISOString(), id);
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
