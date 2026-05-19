import { randomUUID } from 'node:crypto';
import {
  type ContextEntityRow,
  type ContextFeedbackRow,
  type ContextLinkRow,
  type ContextUnitEntityRow,
  type ContextUnitRow,
  getActiveContextUnitByMergeKey,
  getContextEntityByTypeName,
  getContextUnit,
  insertContextEntity,
  insertContextFeedback,
  insertContextLink,
  insertContextUnit,
  linkUnitEntity,
  listContextEntities,
  listContextFeedback,
  listContextLinksFor,
  listContextRelations,
  listContextUnits,
  listEntitiesForUnit,
  updateContextUnit,
} from '../db.js';
import {
  type ContextEntityRef,
  type ContextOriginKind,
  type ContextScope,
  type ContextUnit,
  type ContextUnitDraft,
  type ContextUnitKind,
  computeMergeKey,
  defaultExpiresAt,
  fallbackSalientPhrase,
} from './ContextUnit.js';
import { resolveOrCreateEntity } from './entityResolver.js';

export type UpsertContextUnitInput = ContextUnitDraft & {
  subjectId?: string;
  scope: ContextScope;
  origin: { kind: ContextOriginKind; refId: string };
};

export type UpsertResult = {
  unit: ContextUnit;
  wasUpdate: boolean;
};

function rowToUnit(row: ContextUnitRow, entities: ContextEntityRef[] = []): ContextUnit {
  return {
    id: row.id,
    subjectId: row.subject_id,
    scope: row.scope as ContextScope,
    origin: { kind: row.origin_kind as ContextOriginKind, refId: row.origin_ref_id },
    kind: row.kind as ContextUnitKind,
    title: row.title,
    content: row.content,
    entities,
    relations: [],
    time: row.time_json ? safeParse(row.time_json) : undefined,
    emotion: row.emotion_json ? safeParse(row.emotion_json) : undefined,
    meaning: row.meaning ?? undefined,
    actionability: row.actionability as ContextUnit['actionability'],
    confidence: row.confidence,
    mergeKey: row.merge_key ?? undefined,
    version: row.version,
    supersedes: row.supersedes_json ? safeParse(row.supersedes_json) : undefined,
    status: row.status as ContextUnit['status'],
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse<T = unknown>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

function hydrateEntities(unitId: string): ContextEntityRef[] {
  const links = listEntitiesForUnit(unitId);
  if (links.length === 0) return [];
  const out: ContextEntityRef[] = [];
  for (const l of links) {
    const ent = getEntityById(l.entity_id);
    if (!ent) continue;
    out.push({
      type: ent.type,
      name: ent.name,
      confidence: l.confidence,
      role: l.role,
    });
  }
  return out;
}

function getEntityById(id: string): ContextEntityRow | null {
  // 简单单条 lookup；TODO: 量级上来后建 by-id 索引
  const all = listContextEntities(10_000);
  return all.find((e) => e.id === id) ?? null;
}

/**
 * Upsert by mergeKey. MVP2 选原地 UPDATE + version++（方案 §4.3.2）。
 * 没有 mergeKey 时退化为 insert。
 */
export function upsertContextUnit(input: UpsertContextUnitInput): UpsertResult {
  const now = new Date().toISOString();
  const subjectId = input.subjectId ?? 'me';

  // 1) 解析 entity → entity_id
  const entityIds: string[] = [];
  const entityRefs: Array<{ id: string; ref: ContextEntityRef }> = [];
  for (const e of input.entities ?? []) {
    const ent = resolveOrCreateEntity(e.type, e.name, e.aliases);
    entityIds.push(ent.id);
    entityRefs.push({ id: ent.id, ref: { ...e, name: ent.name } });
  }

  // 2) salient phrase
  const salient =
    input.mergeHint && input.mergeHint.trim()
      ? input.mergeHint.trim()
      : fallbackSalientPhrase(input.kind, input.origin);

  // 3) mergeKey
  const mergeKey = computeMergeKey({
    subjectId,
    kind: input.kind,
    primaryEntityIds: entityIds,
    salientPhrase: salient,
  });

  // 4) 已存在 → UPDATE，否则 INSERT
  const existing = getActiveContextUnitByMergeKey(mergeKey);
  const dueAt = input.time?.dueAt;
  const expiresAt =
    input.time?.expiresAt ?? defaultExpiresAt(input.kind, existing?.created_at ?? now, dueAt);

  if (existing) {
    const updated: ContextUnitRow = {
      ...existing,
      subject_id: subjectId,
      scope: input.scope,
      origin_kind: input.origin.kind,
      origin_ref_id: input.origin.refId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      meaning: input.meaning ?? existing.meaning,
      emotion_json: input.emotion ? JSON.stringify(input.emotion) : existing.emotion_json,
      time_json: input.time ? JSON.stringify(input.time) : existing.time_json,
      actionability: input.actionability ?? existing.actionability,
      confidence:
        typeof input.confidence === 'number' ? input.confidence : existing.confidence,
      merge_key: mergeKey,
      version: existing.version + 1,
      expires_at: expiresAt ?? existing.expires_at,
      status: 'active',
      updated_at: now,
    };
    updateContextUnit(updated);
    for (const { id, ref } of entityRefs) {
      linkUnitEntity({
        context_unit_id: updated.id,
        entity_id: id,
        role: ref.role ?? 'about',
        confidence: ref.confidence ?? 0.7,
      });
    }
    return { unit: rowToUnit(updated, entityRefs.map((e) => e.ref)), wasUpdate: true };
  }

  const id = randomUUID();
  const row: ContextUnitRow = {
    id,
    subject_id: subjectId,
    scope: input.scope,
    origin_kind: input.origin.kind,
    origin_ref_id: input.origin.refId,
    kind: input.kind,
    title: input.title,
    content: input.content,
    meaning: input.meaning ?? null,
    emotion_json: input.emotion ? JSON.stringify(input.emotion) : null,
    time_json: input.time ? JSON.stringify(input.time) : null,
    actionability: input.actionability ?? 'record',
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.7,
    merge_key: mergeKey,
    version: 1,
    supersedes_json: null,
    expires_at: expiresAt,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  insertContextUnit(row);
  for (const { id: eid, ref } of entityRefs) {
    linkUnitEntity({
      context_unit_id: id,
      entity_id: eid,
      role: ref.role ?? 'about',
      confidence: ref.confidence ?? 0.7,
    });
  }
  return { unit: rowToUnit(row, entityRefs.map((e) => e.ref)), wasUpdate: false };
}

export function getContextUnitById(id: string): ContextUnit | null {
  const row = getContextUnit(id);
  if (!row) return null;
  return rowToUnit(row, hydrateEntities(row.id));
}

export type ListContextUnitOpts = {
  limit?: number;
  kind?: string;
  originKind?: string;
  actionability?: string;
};

export function listActiveContextUnits(opts: ListContextUnitOpts = {}): ContextUnit[] {
  const rows = listContextUnits(opts);
  return rows.map((r) => rowToUnit(r, hydrateEntities(r.id)));
}

export function listAllEntities(limit = 200) {
  return listContextEntities(limit);
}

export function listAllRelations(limit = 200) {
  return listContextRelations(limit);
}

export function linkContextUnits(
  fromId: string,
  toId: string,
  linkType: 'updates' | 'contradicts' | 'follows' | 'about',
  confidence = 0.8
): ContextLinkRow {
  const row: ContextLinkRow = {
    id: randomUUID(),
    from_context_id: fromId,
    to_context_id: toId,
    link_type: linkType,
    confidence,
    created_at: new Date().toISOString(),
  };
  insertContextLink(row);
  return row;
}

export function listLinksFor(unitId: string) {
  return listContextLinksFor(unitId);
}

export function addContextFeedback(input: {
  contextUnitId?: string;
  cardId?: string;
  reason: string;
  comment?: string;
}): ContextFeedbackRow {
  const row: ContextFeedbackRow = {
    id: randomUUID(),
    context_unit_id: input.contextUnitId ?? null,
    card_id: input.cardId ?? null,
    reason: input.reason,
    comment: input.comment ?? null,
    created_at: new Date().toISOString(),
  };
  insertContextFeedback(row);
  return row;
}

export function listAllFeedback() {
  return listContextFeedback(100);
}

// 给 collector 直写最小 ContextUnit 用的便捷封装
export function insertMinimalEventContextUnit(opts: {
  eventId: string;
  scope: ContextScope;
  title: string;
  content: string;
  occurredAt: string;
  source: string;
  actor?: string;
  actorRole?: string;
}): ContextUnit {
  // 用 entity 表把 actor / source 落下来，便于后续合并
  const entities: ContextEntityRef[] = [];
  if (opts.actor && opts.actor.trim()) {
    entities.push({ type: 'person', name: opts.actor, role: opts.actorRole ?? 'actor' });
  }
  return upsertContextUnit({
    kind: 'event',
    title: opts.title,
    content: opts.content,
    entities,
    scope: opts.scope,
    origin: { kind: 'event', refId: opts.eventId },
    time: { occurredAt: opts.occurredAt },
    actionability: 'record',
    confidence: 0.9,
  }).unit;
}
