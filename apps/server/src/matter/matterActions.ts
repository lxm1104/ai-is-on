/**
 * MVP29 §10.7 — Matter 级用户纠错/控制动作。
 *
 * 用户在 Matter Panel 上的反馈直接落到 Matter 状态层：
 *   matter_done   → userResolveMatter
 *   drop_matter   → userDropMatter
 *   reopen_matter → userReopenMatter（用户可手动重开 dropped，区别于 Reducer 自动重开）
 *   merge_matters → mergeMatters
 *   split_matter  → splitEvidence
 *   wrong_matter  → markWrongEvidence
 *
 * 都写 matter_transitions / matter_context_links（confidence=1，trigger=USER_TRIGGER 哨兵），
 * 并广播 matter_updated 让前端刷新。用户动作是显式断言，绕过 Reducer 的保守阈值。
 */
import { broadcast } from '../ws.js';
import { deleteMatterContextLinksForPair } from '../db.js';
import { getContextUnitById } from '../context/contextStore.js';
// MVP55：重开事项时对称撤销"问题类自动级联"（problemClassStore 仅依赖 db，无循环）
import { getClassIdForMatter, getProblemClass, setProblemClassStatus } from '../problemClass/problemClassStore.js';
import {
  type Matter,
  type MatterContextEffect,
  type MatterStatus,
  canonicalizeMatterTitle,
  classifyMatterType,
  computeMatterCanonicalKey,
} from './matterTypes.js';
import {
  attachMatterContextLink,
  attachMatterEntity,
  createMatter,
  getMatterById,
  listMatterContextLinks,
  listMatterEntities,
  recordMatterTransition,
  saveMatter,
} from './matterStore.js';

// matter_transitions.trigger_context_unit_id 是 NOT NULL；用户动作没有触发 unit，用哨兵。
const USER_TRIGGER = 'user_action';

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function applyStatus(
  matter: Matter,
  toStatus: MatterStatus,
  effect: MatterContextEffect,
  reason: string,
  now: string
): Matter {
  const patched: Matter = {
    ...matter,
    status: toStatus,
    version: matter.version + 1,
    updatedAt: now,
    resolvedAt: toStatus === 'resolved' ? now : effect === 'reopen' ? null : matter.resolvedAt,
    droppedAt: toStatus === 'dropped' ? now : matter.droppedAt,
    reopenedCount: effect === 'reopen' ? matter.reopenedCount + 1 : matter.reopenedCount,
  };
  saveMatter(patched);
  recordMatterTransition({
    matterId: matter.id,
    fromStatus: matter.status,
    toStatus,
    triggerContextUnitId: USER_TRIGGER,
    effect,
    reason,
    confidence: 1,
    now,
  });
  broadcast({ type: 'matter_updated', matterId: matter.id });
  return patched;
}

export function userResolveMatter(matterId: string, reason = '用户标记已处理', now?: string): Matter | null {
  const m = getMatterById(matterId);
  if (!m) return null;
  return applyStatus(m, 'resolved', 'resolve', reason, nowIso(now));
}

export function userDropMatter(matterId: string, reason = '用户放弃此事项', now?: string): Matter | null {
  const m = getMatterById(matterId);
  if (!m) return null;
  return applyStatus(m, 'dropped', 'drop', reason, nowIso(now));
}

// 用户手动重开：dropped 也可重开（区别于 Reducer 永不自动重开 dropped）。
export function userReopenMatter(matterId: string, reason = '用户重开此事项', now?: string): Matter | null {
  const m = getMatterById(matterId);
  if (!m) return null;
  const reopened = applyStatus(m, 'in_progress', 'reopen', reason, nowIso(now));
  // MVP55：重开属于某问题类的事项 → 若该类已被"全部成员办结"自动标记为已修复，对称恢复为 open，
  // 避免台账谎报"已修复"（自动级联必须可逆，否则违背"内部可逆"承诺）。
  if (reopened) {
    try {
      const classId = getClassIdForMatter(matterId);
      if (classId && getProblemClass(classId)?.status === 'resolved') setProblemClassStatus(classId, 'open');
    } catch {
      // problem-class 模块异常不应阻断重开
    }
  }
  return reopened;
}

export type MergeResult = { source: Matter; target: Matter };

// 把 source 的证据 + 实体并入 target，source 置 dropped。
export function mergeMatters(sourceId: string, targetId: string, now?: string): MergeResult | null {
  if (sourceId === targetId) return null;
  const source = getMatterById(sourceId);
  const target = getMatterById(targetId);
  if (!source || !target) return null;
  const ts = nowIso(now);

  for (const e of listMatterEntities(sourceId)) {
    attachMatterEntity({ matterId: targetId, entityId: e.entityId, role: e.role, confidence: e.confidence, now: ts });
  }
  for (const l of listMatterContextLinks(sourceId)) {
    attachMatterContextLink({
      matterId: targetId,
      contextUnitId: l.contextUnitId,
      relation: l.relation === 'created_by' ? 'evidence' : l.relation,
      effect: l.effect,
      confidence: l.confidence,
      reason: `merged from ${sourceId}: ${l.reason}`,
      now: ts,
    });
  }
  // 记一条 target 的审计 transition（状态不变）
  recordMatterTransition({
    matterId: targetId,
    fromStatus: target.status,
    toStatus: target.status,
    triggerContextUnitId: USER_TRIGGER,
    effect: 'no_change',
    reason: `merged matter ${sourceId} into this`,
    confidence: 1,
    now: ts,
  });
  const droppedSource = applyStatus(source, 'dropped', 'drop', `merged into ${targetId}`, ts);
  broadcast({ type: 'matter_updated', matterId: targetId });
  return { source: droppedSource, target: getMatterById(targetId)! };
}

// 把某条 evidence 从 matterId 拆成它自己的新 Matter；原 Matter 上该 evidence 标 dismissed_by。
export function splitEvidence(
  matterId: string,
  contextUnitId: string,
  title?: string,
  now?: string
): Matter | null {
  const m = getMatterById(matterId);
  if (!m) return null;
  const ts = nowIso(now);
  const unit = getContextUnitById(contextUnitId);
  const newTitle = title?.trim() || (unit ? canonicalizeMatterTitle(unit.title) : '拆分的事项');
  const created = createMatter({
    subjectId: m.subjectId,
    scope: unit?.scope ?? m.scope,
    type: unit ? classifyMatterType({ title: unit.title, content: unit.content }) : m.type,
    title: newTitle,
    canonicalKey: computeMatterCanonicalKey({
      subjectId: m.subjectId,
      primaryEntityIds: [contextUnitId],
      actionPhrase: newTitle,
    }),
    status: 'open',
    priority: m.priority,
    createdFromContextUnitId: contextUnitId,
    currentSummary: unit?.content ? unit.content.replace(/\s+/g, ' ').slice(0, 200) : '',
    createdReason: `split from matter ${matterId}`,
    now: ts,
  });
  // 原 Matter 上把该 evidence 标 dismissed（不再算它的证据）
  deleteMatterContextLinksForPair(matterId, contextUnitId);
  attachMatterContextLink({
    matterId,
    contextUnitId,
    relation: 'dismissed_by',
    effect: 'no_change',
    confidence: 1,
    reason: `已拆分到新事项 ${created.id}`,
    now: ts,
  });
  recordMatterTransition({
    matterId,
    fromStatus: m.status,
    toStatus: m.status,
    triggerContextUnitId: contextUnitId,
    effect: 'no_change',
    reason: `evidence split into ${created.id}`,
    confidence: 1,
    now: ts,
  });
  broadcast({ type: 'matter_updated', matterId });
  broadcast({ type: 'matter_updated', matterId: created.id });
  return created;
}

// "这条证据不属于本事项"：relabel 为 dismissed_by。
export function markWrongEvidence(
  matterId: string,
  contextUnitId: string,
  reason = '用户标记：这条证据不属于本事项',
  now?: string
): boolean {
  const m = getMatterById(matterId);
  if (!m) return false;
  const ts = nowIso(now);
  deleteMatterContextLinksForPair(matterId, contextUnitId);
  attachMatterContextLink({
    matterId,
    contextUnitId,
    relation: 'dismissed_by',
    effect: 'no_change',
    confidence: 1,
    reason,
    now: ts,
  });
  broadcast({ type: 'matter_updated', matterId });
  return true;
}
