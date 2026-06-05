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
  MatterPriority,
  MatterStatus,
  MatterType,
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

// ============ MVP28 §7.2：给 attention packet 的紧凑 Matter 投影 ============

export type MatterInPacket = {
  id: string;
  title: string;
  type: MatterType;
  status: MatterStatus;
  priority: MatterPriority;
  dueAt?: string | null;
  currentSummary: string;
  nextAction?: string | null;
  owner?: string;
  participants: string[];
  spaces: MatterSpaceView[];
  latestEvidence: Array<{
    contextUnitId: string;
    kind?: string;
    title?: string;
    effect: MatterContextEffect;
    at: string;
  }>;
};

// 只投 active 事项（resolved/dropped 不进 attention——已了结，不再提醒）。
const PACKET_STATUSES: MatterStatus[] = [
  'open',
  'acknowledged',
  'in_progress',
  'waiting',
  'blocked',
];
const PRIORITY_ORDER: Record<MatterPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function projectMattersForPacket(opts: { limit?: number } = {}): MatterInPacket[] {
  const limit = opts.limit ?? 30;
  const matters = listMatters({ statuses: PACKET_STATUSES, limit: 200 });
  matters.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 3;
    const pb = PRIORITY_ORDER[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return matters.slice(0, limit).map((m) => {
    const participants: string[] = [];
    for (const e of listMatterEntities(m.id)) {
      const ent = getContextEntityById(e.entityId);
      if (ent?.type === 'person' && ent.name) participants.push(ent.name);
    }
    const owner = m.ownerEntityId ? getContextEntityById(m.ownerEntityId)?.name : undefined;
    const latestEvidence = listMatterContextLinks(m.id)
      .slice(-3)
      .map((l) => {
        const u = getContextUnit(l.contextUnitId);
        return {
          contextUnitId: l.contextUnitId,
          kind: u?.kind,
          title: u?.title,
          effect: l.effect,
          at: l.createdAt,
        };
      });
    return {
      id: m.id,
      title: m.title,
      type: m.type,
      status: m.status,
      priority: m.priority,
      dueAt: m.dueAt ?? null,
      currentSummary: m.currentSummary,
      nextAction: m.nextAction ?? null,
      owner: owner ?? undefined,
      participants: [...new Set(participants)].slice(0, 6),
      spaces: hydrateSpaces(m),
      latestEvidence,
    };
  });
}
