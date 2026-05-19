import { randomUUID } from 'node:crypto';
import {
  type ContextSpaceLinkRow,
  type ContextSpaceRow,
  getContextSpace,
  getContextSpaceByTypeName,
  insertContextSpace,
  listContextSpaces,
  listContextUnits,
  listSpaceLinks,
  listSpacesForTarget,
  tryInsertContextSpaceLink,
  updateContextSpace,
} from '../db.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import { getContextUnitById } from '../context/contextStore.js';
import { resolveOrCreateEntity } from '../context/entityResolver.js';

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

/**
 * Given a freshly upserted ContextUnit, attach it to any Space whose seed
 * entities overlap with the unit's entities. Idempotent.
 */
export function resolveUnitToSpaces(unit: ContextUnit): string[] {
  if (!unit.entities || unit.entities.length === 0) return [];
  const matchedSpaceIds = new Set<string>();
  // Resolve each unit entity → entity_id, look up spaces that have an
  // 'entity' link to that entity_id.
  for (const e of unit.entities) {
    try {
      const ent = resolveOrCreateEntity(e.type, e.name);
      const links = listSpacesForTarget('entity', ent.id);
      for (const l of links) matchedSpaceIds.add(l.space_id);
    } catch {
      // skip malformed entity
    }
  }
  if (matchedSpaceIds.size === 0) return [];

  const now = new Date().toISOString();
  const linked: string[] = [];
  for (const spaceId of matchedSpaceIds) {
    const ok = tryInsertContextSpaceLink({
      id: randomUUID(),
      space_id: spaceId,
      target_type: 'context_unit',
      target_id: unit.id,
      link_type: 'about',
      confidence: 0.8,
      created_at: now,
    });
    if (ok) linked.push(spaceId);
  }
  return linked;
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
