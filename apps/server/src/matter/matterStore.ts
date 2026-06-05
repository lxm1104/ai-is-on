/**
 * MVP26 §10.x / §16.3 — Matter store：row ↔ domain 映射 + CRUD/业务封装。
 *
 * 这一层不做 reducer 判定（那是 MVP27 matterReducer 的事），只提供：
 *   - createMatter：原子写 matter + entities + created_by context link + 初始 transition
 *   - 各种 read（按 id / canonical_key / created_from / 关联 ContextUnit）
 *   - 幂等 attach helper（entity / context link / transition）
 *
 * 所有 SQL 在 db.ts；本文件只负责把 snake_case Row 映射成 camelCase domain object。
 */
import { randomUUID } from 'node:crypto';
import {
  type MatterContextLinkRow,
  type MatterEntityRow,
  type MatterObservationRow,
  type MatterRow,
  type MatterTransitionRow,
  getActiveMatterByCanonicalKey,
  getMatter,
  getMatterByCreatedFrom,
  insertMatter,
  insertMatterObservation,
  insertMatterTransition,
  listMatterContextLinkRows,
  listMatterEntityRows,
  listMatterLinksForContextUnit,
  listMatterObservationsBySourceEvent,
  listMatterRows,
  listMatterTransitionRows,
  updateMatter,
  upsertMatterContextLink,
  upsertMatterEntity,
} from '../db.js';
import {
  type Matter,
  type MatterContextEffect,
  type MatterContextLink,
  type MatterContextRelation,
  type MatterEntityLink,
  type MatterEntityRole,
  type MatterPriority,
  type MatterScope,
  type MatterStatus,
  type MatterTransition,
  type MatterType,
} from './matterTypes.js';

// ============ row ↔ domain ============

export function rowToMatter(row: MatterRow): Matter {
  return {
    id: row.id,
    subjectId: row.subject_id,
    scope: row.scope as MatterScope,
    type: row.type as MatterType,
    title: row.title,
    canonicalKey: row.canonical_key,
    status: row.status as MatterStatus,
    priority: row.priority as MatterPriority,
    ownerEntityId: row.owner_entity_id ?? null,
    primarySpaceId: row.primary_space_id ?? null,
    dueAt: row.due_at ?? null,
    currentSummary: row.current_summary,
    nextAction: row.next_action ?? null,
    createdFromContextUnitId: row.created_from_context_unit_id,
    lastEvidenceContextUnitId: row.last_evidence_context_unit_id ?? null,
    lastEvidenceAt: row.last_evidence_at ?? null,
    confidence: row.confidence,
    reopenedCount: row.reopened_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? null,
    droppedAt: row.dropped_at ?? null,
  };
}

function matterToRow(m: Matter): MatterRow {
  return {
    id: m.id,
    subject_id: m.subjectId,
    scope: m.scope,
    type: m.type,
    title: m.title,
    canonical_key: m.canonicalKey,
    status: m.status,
    priority: m.priority,
    owner_entity_id: m.ownerEntityId ?? null,
    primary_space_id: m.primarySpaceId ?? null,
    due_at: m.dueAt ?? null,
    current_summary: m.currentSummary,
    next_action: m.nextAction ?? null,
    created_from_context_unit_id: m.createdFromContextUnitId,
    last_evidence_context_unit_id: m.lastEvidenceContextUnitId ?? null,
    last_evidence_at: m.lastEvidenceAt ?? null,
    confidence: m.confidence,
    reopened_count: m.reopenedCount,
    version: m.version,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    resolved_at: m.resolvedAt ?? null,
    dropped_at: m.droppedAt ?? null,
  };
}

function rowToEntityLink(row: MatterEntityRow): MatterEntityLink {
  return {
    matterId: row.matter_id,
    entityId: row.entity_id,
    role: row.role as MatterEntityRole,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

function rowToContextLink(row: MatterContextLinkRow): MatterContextLink {
  return {
    matterId: row.matter_id,
    contextUnitId: row.context_unit_id,
    relation: row.relation as MatterContextRelation,
    effect: row.effect as MatterContextEffect,
    confidence: row.confidence,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function rowToTransition(row: MatterTransitionRow): MatterTransition {
  return {
    id: row.id,
    matterId: row.matter_id,
    fromStatus: (row.from_status as MatterStatus | null) ?? null,
    toStatus: row.to_status as MatterStatus,
    triggerContextUnitId: row.trigger_context_unit_id,
    effect: row.effect as MatterContextEffect,
    reason: row.reason,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

// ============ writes ============

export type CreateMatterEntityInput = {
  entityId: string;
  role: MatterEntityRole;
  confidence?: number;
};

export type CreateMatterInput = {
  subjectId?: string;
  scope: MatterScope;
  type: MatterType;
  title: string;
  canonicalKey: string;
  status?: MatterStatus;
  priority?: MatterPriority;
  ownerEntityId?: string | null;
  primarySpaceId?: string | null;
  dueAt?: string | null;
  currentSummary?: string;
  nextAction?: string | null;
  createdFromContextUnitId: string;
  confidence?: number;
  entities?: CreateMatterEntityInput[];
  /** created_by context link 的理由文案 */
  createdReason?: string;
  /** 测试可注入固定时间戳 */
  now?: string;
};

/**
 * 创建 Matter，并原子写入：
 *   1) matters 行（status 默认 open / version 1 / reopened 0）
 *   2) matter_entities（去重靠 PK）
 *   3) matter_context_links：created_from unit → relation='created_by', effect='create'
 *   4) matter_transitions：null → status 的初始迁移
 */
export function createMatter(input: CreateMatterInput): Matter {
  const now = input.now ?? new Date().toISOString();
  const status = input.status ?? 'open';
  const matter: Matter = {
    id: randomUUID(),
    subjectId: input.subjectId ?? 'me',
    scope: input.scope,
    type: input.type,
    title: input.title,
    canonicalKey: input.canonicalKey,
    status,
    priority: input.priority ?? 'P2',
    ownerEntityId: input.ownerEntityId ?? null,
    primarySpaceId: input.primarySpaceId ?? null,
    dueAt: input.dueAt ?? null,
    currentSummary: input.currentSummary ?? '',
    nextAction: input.nextAction ?? null,
    createdFromContextUnitId: input.createdFromContextUnitId,
    lastEvidenceContextUnitId: input.createdFromContextUnitId,
    lastEvidenceAt: now,
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.7,
    reopenedCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    droppedAt: null,
  };
  insertMatter(matterToRow(matter));

  for (const e of input.entities ?? []) {
    attachMatterEntity({
      matterId: matter.id,
      entityId: e.entityId,
      role: e.role,
      confidence: e.confidence,
      now,
    });
  }

  attachMatterContextLink({
    matterId: matter.id,
    contextUnitId: input.createdFromContextUnitId,
    relation: 'created_by',
    effect: 'create',
    confidence: matter.confidence,
    reason: input.createdReason ?? 'Matter created from this context unit',
    now,
  });

  recordMatterTransition({
    matterId: matter.id,
    fromStatus: null,
    toStatus: status,
    triggerContextUnitId: input.createdFromContextUnitId,
    effect: 'create',
    reason: input.createdReason ?? 'Matter created',
    confidence: matter.confidence,
    now,
  });

  return matter;
}

/** 覆盖式持久化一个已修改的 Matter（version/updated_at 由调用方维护）。MVP27 reducer 用。 */
export function saveMatter(matter: Matter): void {
  updateMatter(matterToRow(matter));
}

export function attachMatterEntity(input: {
  matterId: string;
  entityId: string;
  role: MatterEntityRole;
  confidence?: number;
  now?: string;
}): void {
  upsertMatterEntity({
    matter_id: input.matterId,
    entity_id: input.entityId,
    role: input.role,
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.7,
    created_at: input.now ?? new Date().toISOString(),
  });
}

export function attachMatterContextLink(input: {
  matterId: string;
  contextUnitId: string;
  relation: MatterContextRelation;
  effect: MatterContextEffect;
  confidence?: number;
  reason: string;
  now?: string;
}): void {
  upsertMatterContextLink({
    matter_id: input.matterId,
    context_unit_id: input.contextUnitId,
    relation: input.relation,
    effect: input.effect,
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.7,
    reason: input.reason,
    created_at: input.now ?? new Date().toISOString(),
  });
}

export function recordMatterTransition(input: {
  matterId: string;
  fromStatus: MatterStatus | null;
  toStatus: MatterStatus;
  triggerContextUnitId: string;
  effect: MatterContextEffect;
  reason: string;
  confidence?: number;
  now?: string;
}): MatterTransition {
  const row: MatterTransitionRow = {
    id: randomUUID(),
    matter_id: input.matterId,
    from_status: input.fromStatus,
    to_status: input.toStatus,
    trigger_context_unit_id: input.triggerContextUnitId,
    effect: input.effect,
    reason: input.reason,
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.7,
    created_at: input.now ?? new Date().toISOString(),
  };
  insertMatterTransition(row);
  return rowToTransition(row);
}

// ============ reads ============

export function getMatterById(id: string): Matter | null {
  const row = getMatter(id);
  return row ? rowToMatter(row) : null;
}

export function listMatters(
  opts: { statuses?: MatterStatus[]; limit?: number; updatedSince?: string } = {}
): Matter[] {
  return listMatterRows(opts).map(rowToMatter);
}

export function getMatterByCanonicalKey(
  canonicalKey: string,
  subjectId = 'me'
): Matter | null {
  const row = getActiveMatterByCanonicalKey(subjectId, canonicalKey);
  return row ? rowToMatter(row) : null;
}

export function getMatterByCreatedFromContextUnit(contextUnitId: string): Matter | null {
  const row = getMatterByCreatedFrom(contextUnitId);
  return row ? rowToMatter(row) : null;
}

export function listMatterEntities(matterId: string): MatterEntityLink[] {
  return listMatterEntityRows(matterId).map(rowToEntityLink);
}

export function listMatterContextLinks(matterId: string): MatterContextLink[] {
  return listMatterContextLinkRows(matterId).map(rowToContextLink);
}

export function listMatterTransitions(matterId: string): MatterTransition[] {
  return listMatterTransitionRows(matterId).map(rowToTransition);
}

// ============ MVP29 matter_observations ============

export function recordMatterObservation(input: {
  sourceEventId: string;
  contextUnitIds: string[];
  observationType: string;
  matterType: string;
  title: string;
  lifecycleEffect?: string | null;
  evidence: string;
  confidence?: number;
  candidateMatterIds?: string[];
  now?: string;
}): void {
  insertMatterObservation({
    id: randomUUID(),
    source_event_id: input.sourceEventId,
    context_unit_ids_json: JSON.stringify(input.contextUnitIds ?? []),
    observation_type: input.observationType,
    matter_type: input.matterType,
    title: input.title,
    lifecycle_effect: input.lifecycleEffect ?? null,
    evidence: input.evidence,
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.7,
    candidate_matter_ids_json: JSON.stringify(input.candidateMatterIds ?? []),
    raw_json: JSON.stringify(input),
    created_at: input.now ?? new Date().toISOString(),
  });
}

export function listMatterObservationsForEvent(eventId: string): MatterObservationRow[] {
  return listMatterObservationsBySourceEvent(eventId);
}

/** /api/context/units/:id/matters：一条 ContextUnit 影响了哪些 Matter（含 link 关系）。 */
export function listMattersForContextUnit(
  contextUnitId: string
): Array<{ matter: Matter; link: MatterContextLink }> {
  const out: Array<{ matter: Matter; link: MatterContextLink }> = [];
  for (const linkRow of listMatterLinksForContextUnit(contextUnitId)) {
    const matterRow = getMatter(linkRow.matter_id);
    if (!matterRow) continue;
    out.push({ matter: rowToMatter(matterRow), link: rowToContextLink(linkRow) });
  }
  return out;
}
