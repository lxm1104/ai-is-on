import { randomUUID } from 'node:crypto';
import {
  type ContextEntityRow,
  type ContextFeedbackRow,
  type ContextLinkRow,
  type ContextUnitEntityRow,
  type ContextUnitRow,
  deleteUnitRoutingCacheByEvent,
  getActiveContextUnitByMergeKey,
  getActiveContextUnitByOrigin,
  getActiveContextUnitByOriginAndKind,
  getContextEntityByTypeName,
  getContextUnit,
  insertContextEntity,
  insertContextFeedback,
  insertContextLink,
  insertContextUnit,
  insertUnitSource,
  linkUnitEntity,
  listContextEntities,
  listContextFeedback,
  listContextLinksFor,
  listContextUnits,
  listEntitiesForUnit,
  listUnitSourcesByEvent,
  updateContextUnit,
  upsertUnitRoutingCache,
} from '../db.js';
import {
  type ContextActionability,
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
import { resolveAliased, resolveOrCreateEntity } from './entityResolver.js';
import { type SemanticTags, encodeSemanticTags } from './semanticTags.js';
import {
  type ChangeContext,
  computeChangeContext,
  createdChangeContext,
  snapshotOf,
} from './changeContext.js';

export type UpsertContextUnitInput = ContextUnitDraft & {
  subjectId?: string;
  scope: ContextScope;
  origin: { kind: ContextOriginKind; refId: string };
  /** MVP32：true 时跳过 upsert hooks（trigger/attention/matterReducer 都不触发）。
   *  仅限"状态已被确定性通道同步落库"的用户断言 unit（如 mark_done 的处理说明）——
   *  这类 unit 再进 Reducer 只会对已落定的 matter 重复跑 LLM 判定（echo），纯浪费。勿滥用。 */
  silent?: boolean;
};

export type UpsertResult = {
  unit: ContextUnit;
  wasUpdate: boolean;
};

// MVP3: lazy import to avoid circular require (triggerEvaluator → contextStore.getContextUnitById)
// MVP8.0 §5.2：hook 签名扩成 (unit, changeContext?) 让 trigger 能把字段级 diff 带到 payload。
// MVP14 Step1：支持多订阅者（triggerScheduler + attentionEngine 都要挂）。
// 注册顺序即调用顺序；某个 hook 抛错不影响其他 hook。
type PushHook = (unit: ContextUnit, changeContext?: ChangeContext) => void;
const pushHooks: PushHook[] = [];
export function registerUpsertHook(hook: PushHook) {
  pushHooks.push(hook);
}

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
    let aliases: string[] | undefined;
    if (ent.aliases_json) {
      try {
        const parsed = JSON.parse(ent.aliases_json);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          aliases = parsed as string[];
        }
      } catch {
        /* ignore malformed aliases_json */
      }
    }
    out.push({
      type: ent.type,
      name: ent.name,
      confidence: l.confidence,
      role: l.role,
      aliases,
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

  // 1) 解析 entity → entity_id；MVP10：mergeKey 计算用 alias 解析后的 id，
  // 让"X 合并到 Y"之后 X 的新 unit 与 Y 的旧 unit 落到同一 mergeKey。
  const entityIds: string[] = [];
  const entityRefs: Array<{ id: string; ref: ContextEntityRef }> = [];
  for (const e of input.entities ?? []) {
    const ent = resolveOrCreateEntity(e.type, e.name, e.aliases);
    entityIds.push(resolveAliased(ent.id));
    entityRefs.push({ id: ent.id, ref: { ...e, name: ent.name } });
  }

  // 2) salient phrase
  const salient =
    input.mergeHint && input.mergeHint.trim()
      ? input.mergeHint.trim()
      : fallbackSalientPhrase(input.kind, input.origin);

  // 3) mergeKey
  //   - MVP7: `work_map:` 前缀的 mergeHint 直接当 mergeKey 用，不再 sha1。
  //     原因：活动 context scorer 要靠 `mergeKey.startsWith('work_map:')` 给 Work Map
  //     条目加 +0.6 boost；sha1 之后无法识别。可读性也好。
  //     幂等性等价：同一 work_map slug → 同一 mergeKey → 同一 unit。
  const mergeKey = salient.startsWith('work_map:')
    ? salient
    : computeMergeKey({
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
    // MVP8.0 §5.2：在覆盖前抓 before snapshot（带旧 entities），用于 diff。
    const beforeUnit = rowToUnit(existing, hydrateEntities(existing.id));
    const beforeSnap = snapshotOf(beforeUnit);

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
    const newUnit = rowToUnit(updated, entityRefs.map((e) => e.ref));
    const changeContext = computeChangeContext(beforeSnap, newUnit);
    // MVP12 §4.1 P1.5：必须在 invokeHook 之前落地 unit_sources / unit_routing_cache，
    // 否则 resolveUnitToSpaces 在 hook 里读到空 cache。
    materializeRoutingForUnit(newUnit, now);
    const result: UpsertResult = { unit: newUnit, wasUpdate: true };
    if (!input.silent) invokeHook(result.unit, changeContext);
    return result;
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
  const result: UpsertResult = {
    unit: rowToUnit(row, entityRefs.map((e) => e.ref)),
    wasUpdate: false,
  };
  // MVP12 §4.1 P1.5：见 update 分支注释。
  materializeRoutingForUnit(result.unit, now);
  if (!input.silent) invokeHook(result.unit, createdChangeContext());
  return result;
}

// MVP12 §4.1 P1.5：把这次 upsert 的 routing 证据落到 unit_sources + unit_routing_cache。
//
// 规则：
//   - kind='event' 且 origin.kind='event'：
//       * 写 unit_sources(unit_id=unit.id, event_id=origin.refId)
//       * DELETE unit_routing_cache WHERE source_event_id = origin.refId
//       * 重新 materialize：为所有 unit_sources WHERE event_id = origin.refId
//         的 unit（包含本 event unit 自己 + 所有引用它的 semantic unit）写一行 cache
//   - kind != 'event' 且 origin.kind='event'（即 triage 产出的 semantic unit）：
//       * 写 unit_sources(unit_id=unit.id, event_id=origin.refId)
//       * 仅为 (unit.id, origin.refId) materialize 一行（用本 unit 当前 routing entities
//         + 该 event 的 routing entities 取并集太重；保持简单：用本 unit 自己的 entities，
//         resolver 端拉 cache + own entities 时会再合并）
//   - 其它 origin（chat / agent_run / manual / system）：不写。
//
// 注意：cache 里只保留 routing entity 类型（chat / doc / app）；其他类型在 resolver 里
// 通过 unit.entities 直接命中，不需要 cache。
function materializeRoutingForUnit(unit: ContextUnit, nowIso: string): void {
  if (unit.origin.kind !== 'event') return;
  const eventId = unit.origin.refId;
  if (!eventId) return;

  // 1) 写 unit_sources
  try {
    insertUnitSource({
      id: randomUUID(),
      unit_id: unit.id,
      event_id: eventId,
      recorded_at: nowIso,
    });
  } catch (err) {
    console.warn(
      '[routing] insertUnitSource failed:',
      err instanceof Error ? err.message : String(err)
    );
  }

  const routingEntities = filterRoutingEntities(unit.entities);

  if (unit.kind === 'event') {
    // event unit：抽 routing entities，整个 source_event_id 重建 cache
    try {
      deleteUnitRoutingCacheByEvent(eventId);
    } catch (err) {
      console.warn(
        '[routing] deleteUnitRoutingCacheByEvent failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
    const json = JSON.stringify(routingEntities);
    // 为本 event 的所有 source units 各 materialize 一行
    let sources: { unit_id: string }[] = [];
    try {
      sources = listUnitSourcesByEvent(eventId).map((r) => ({ unit_id: r.unit_id }));
    } catch (err) {
      console.warn(
        '[routing] listUnitSourcesByEvent failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
    // 防御：本次插入的 unit_sources 行可能尚未被 sources 包含（race）；
    // 确保至少 unit.id 在内。
    if (!sources.some((s) => s.unit_id === unit.id)) {
      sources.push({ unit_id: unit.id });
    }
    for (const s of sources) {
      try {
        upsertUnitRoutingCache({
          id: randomUUID(),
          unit_id: s.unit_id,
          source_event_id: eventId,
          routing_entities_json: json,
          updated_at: nowIso,
        });
      } catch (err) {
        console.warn(
          '[routing] upsertUnitRoutingCache failed:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    return;
  }

  // semantic unit（kind != 'event'）：为本 (unit.id, eventId) 写一行 cache。
  // routing entities = 源 event ContextUnit 上的 chat/doc/app 取并集 + 本 unit 自己可能含的 doc。
  // 即便 semantic unit 不含 routing 类型，也要写一行让 resolver 通过 chat / doc 找到 Space。
  const eventUnit = getActiveContextUnitByOriginAndKind('event', eventId, 'event');
  const merged: ContextEntityRef[] = [...routingEntities];
  if (eventUnit) {
    try {
      const evEntities = hydrateEntities(eventUnit.id);
      for (const e of filterRoutingEntities(evEntities)) {
        merged.push(e);
      }
    } catch {
      /* swallow */
    }
  }
  // dedup by (type, name, role)
  const seen = new Set<string>();
  const finalRouting: ContextEntityRef[] = [];
  for (const e of merged) {
    const key = `${e.type}::${e.name}::${e.role ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    finalRouting.push(e);
  }
  try {
    upsertUnitRoutingCache({
      id: randomUUID(),
      unit_id: unit.id,
      source_event_id: eventId,
      routing_entities_json: JSON.stringify(finalRouting),
      updated_at: nowIso,
    });
  } catch (err) {
    console.warn(
      '[routing] upsertUnitRoutingCache (semantic) failed:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

const ROUTING_ENTITY_TYPES = new Set(['chat', 'doc', 'app']);

function filterRoutingEntities(entities: ContextEntityRef[]): ContextEntityRef[] {
  return entities.filter((e) => ROUTING_ENTITY_TYPES.has(e.type));
}

function invokeHook(unit: ContextUnit, changeContext?: ChangeContext) {
  for (const hook of pushHooks) {
    try {
      hook(unit, changeContext);
    } catch (err) {
      console.warn(
        '[context] upsert hook failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }
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

export function findEventContextUnitId(eventId: string): string | null {
  const row = getActiveContextUnitByOrigin('event', eventId);
  return row?.id ?? null;
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
  // MVP11.0-a：collector 现场算出的结构化字段（优先于默认 fallback）。
  entities?: ContextEntityRef[];
  contextMergeHint?: string;
  actionability?: ContextActionability;
  semanticTags?: SemanticTags;
}): ContextUnit {
  // MVP12 §4.1 P1.3：union + dedup by (type, name, role)。
  //   - collector entities 已含 actor 角色 → 跳过 fallback；
  //   - 否则按旧逻辑补一个 actor person。
  const seen = new Set<string>();
  const entities: ContextEntityRef[] = [];
  const push = (e: ContextEntityRef) => {
    const key = `${e.type}::${e.name}::${e.role ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push(e);
  };
  for (const e of opts.entities ?? []) push(e);
  const hasActorAlready = entities.some((e) => e.role === 'actor');
  if (!hasActorAlready && opts.actor && opts.actor.trim()) {
    push({ type: 'person', name: opts.actor, role: opts.actorRole ?? 'actor' });
  }
  // semanticTags 通过 meaning 前缀透传给 evaluator
  const meaning =
    opts.semanticTags && Object.keys(opts.semanticTags).length
      ? encodeSemanticTags(opts.semanticTags)
      : undefined;
  return upsertContextUnit({
    kind: 'event',
    title: opts.title,
    content: opts.content,
    entities,
    scope: opts.scope,
    origin: { kind: 'event', refId: opts.eventId },
    time: { occurredAt: opts.occurredAt },
    actionability: opts.actionability ?? 'record',
    confidence: 0.9,
    mergeHint: opts.contextMergeHint,
    meaning,
  }).unit;
}
