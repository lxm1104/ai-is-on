/**
 * MVP26 §16.3 — Matter read model：给 debug API（MVP28 起也给 attention packet）用的投影。
 *
 * Matter 本身只存 id / 摘要 / 状态 / canonical_key；展示时需要把 evidence 的 ContextUnit
 * kind/title、entity 名字、space 名字、transition timeline hydrate 出来。本文件负责这层拼装，
 * 不写库、无副作用。原文仍回查 events / context_units（Matter 不复制大段原文）。
 */
import {
  getContextEntityById,
  getContextSpace,
  getContextUnit,
  listSpacesForTarget,
} from '../db.js';
import type {
  Matter,
  MatterContextEffect,
  MatterContextRelation,
  MatterEntityRole,
  MatterStatus,
} from './matterTypes.js';
import {
  getMatterById,
  listMatterContextLinks,
  listMatterEntities,
  listMatters,
  listMatterTransitions,
} from './matterStore.js';

export type MatterEntityView = {
  entityId: string;
  role: MatterEntityRole;
  confidence: number;
  type?: string;
  name?: string;
};

export type MatterEvidenceView = {
  contextUnitId: string;
  relation: MatterContextRelation;
  effect: MatterContextEffect;
  confidence: number;
  reason: string;
  at: string;
  kind?: string;
  title?: string;
};

export type MatterTimelineView = {
  id: string;
  fromStatus: MatterStatus | null;
  toStatus: MatterStatus;
  effect: MatterContextEffect;
  reason: string;
  confidence: number;
  triggerContextUnitId: string;
  at: string;
};

export type MatterSpaceView = { id: string; name: string };

export type MatterDetail = Matter & {
  entities: MatterEntityView[];
  evidence: MatterEvidenceView[];
  timeline: MatterTimelineView[];
  spaces: MatterSpaceView[];
};

export type MatterListItem = Matter & {
  entities: MatterEntityView[];
  spaces: MatterSpaceView[];
  evidenceCount: number;
};

function hydrateEntities(matterId: string): MatterEntityView[] {
  return listMatterEntities(matterId).map((e) => {
    const ent = getContextEntityById(e.entityId);
    return {
      entityId: e.entityId,
      role: e.role,
      confidence: e.confidence,
      type: ent?.type,
      name: ent?.name,
    };
  });
}

// primary_space_id + 任何 target_type='matter' 的 context_space_links（§5.6），按 space id 去重。
function hydrateSpaces(matter: Matter): MatterSpaceView[] {
  const out: MatterSpaceView[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    const sp = getContextSpace(id);
    if (!sp) return;
    seen.add(id);
    out.push({ id: sp.id, name: sp.name });
  };
  push(matter.primarySpaceId);
  for (const link of listSpacesForTarget('matter', matter.id)) push(link.space_id);
  return out;
}

function hydrateEvidence(matterId: string): MatterEvidenceView[] {
  return listMatterContextLinks(matterId).map((l) => {
    const unit = getContextUnit(l.contextUnitId);
    return {
      contextUnitId: l.contextUnitId,
      relation: l.relation,
      effect: l.effect,
      confidence: l.confidence,
      reason: l.reason,
      at: l.createdAt,
      kind: unit?.kind,
      title: unit?.title,
    };
  });
}

function hydrateTimeline(matterId: string): MatterTimelineView[] {
  return listMatterTransitions(matterId).map((t) => ({
    id: t.id,
    fromStatus: t.fromStatus,
    toStatus: t.toStatus,
    effect: t.effect,
    reason: t.reason,
    confidence: t.confidence,
    triggerContextUnitId: t.triggerContextUnitId,
    at: t.createdAt,
  }));
}

export function projectMatterDetail(id: string): MatterDetail | null {
  const matter = getMatterById(id);
  if (!matter) return null;
  return {
    ...matter,
    entities: hydrateEntities(matter.id),
    evidence: hydrateEvidence(matter.id),
    timeline: hydrateTimeline(matter.id),
    spaces: hydrateSpaces(matter),
  };
}

export function projectMatters(
  opts: { statuses?: MatterStatus[]; limit?: number } = {}
): MatterListItem[] {
  return listMatters(opts).map((matter) => ({
    ...matter,
    entities: hydrateEntities(matter.id),
    spaces: hydrateSpaces(matter),
    evidenceCount: listMatterContextLinks(matter.id).length,
  }));
}
