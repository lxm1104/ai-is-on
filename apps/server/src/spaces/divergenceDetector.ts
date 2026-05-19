import {
  type ContextSpaceRow,
  db,
  listSpaceLinks,
} from '../db.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import { getContextUnitById, listLinksFor } from '../context/contextStore.js';
import { listSpaces } from './contextSpaceService.js';

/**
 * MVP5.1 divergence detector. Per §7.5 we only cover 2 patterns:
 *
 *   1. commitment-stale:  commitment.dueAt < now, AND no action_result link
 *      from this commitment, AND no doc_update event in the same Space whose
 *      occurredAt > dueAt → the commitment is overdue and the doc didn't move.
 *
 *   2. decision-not-sunk: a kind=decision (or constraint about a decision) unit
 *      exists in the Space, but no doc_update event with the same key entity
 *      shows up after the decision's occurredAt → the team decided but never
 *      wrote it down.
 *
 * Pure function. Caller persists triggers / cards.
 */

export type DivergenceFinding = {
  kind: 'commitment_stale' | 'decision_not_sunk';
  spaceId: string;
  spaceName: string;
  contextUnitId: string;        // the offending commitment / decision unit
  reasoning: string;
  payload: Record<string, unknown>;
};

const OVERDUE_GRACE_MS = 2 * 3600_000; // 不立刻报，逾期 2h 才算 stale

export function detectDivergenceForSpace(
  space: ContextSpaceRow,
  now: number = Date.now()
): DivergenceFinding[] {
  const out: DivergenceFinding[] = [];
  const links = listSpaceLinks(space.id);
  const unitLinks = links.filter((l) => l.target_type === 'context_unit');

  // Hydrate the units we care about
  const units: ContextUnit[] = [];
  for (const l of unitLinks) {
    const u = getContextUnitById(l.target_id);
    if (u && u.status === 'active') units.push(u);
  }

  // 只看 source='drive' 的 event ContextUnit（doc 更新信号）。
  // ContextUnit 本身不存 source，所以通过 origin.refId 关联到 events 表 JOIN 查 source。
  const driveEventOriginIds = units
    .filter((u) => u.kind === 'event' && u.origin.kind === 'event')
    .map((u) => u.origin.refId);
  const latestDocUpdateAt = driveEventOriginIds.length
    ? getLatestDocUpdateAt(driveEventOriginIds)
    : 0;

  // Rule 1: commitment_stale
  for (const u of units) {
    if (u.kind !== 'commitment') continue;
    const due = u.time?.dueAt ? new Date(u.time.dueAt).getTime() : NaN;
    if (!Number.isFinite(due)) continue;
    if (due > now - OVERDUE_GRACE_MS) continue; // 没真正逾期或刚到期

    // Has any "action_result" link from this commitment?
    const linkRows = listLinksFor(u.id);
    const hasActionResult = linkRows.some((l) => {
      const otherId = l.from_context_id === u.id ? l.to_context_id : l.from_context_id;
      const other = getContextUnitById(otherId);
      return other?.kind === 'action_result';
    });
    if (hasActionResult) continue;

    // Has a *doc* been updated *since* dueAt within this Space?
    // 只看 drive 类 event；calendar 会议变更不算 "doc 同步"。
    if (latestDocUpdateAt > due) continue;

    const overdueHours = Math.round((now - due) / 3600_000);
    out.push({
      kind: 'commitment_stale',
      spaceId: space.id,
      spaceName: space.name,
      contextUnitId: u.id,
      reasoning: `承诺"${u.title}"已逾期 ${overdueHours}h，未见完成信号、相关文档也未更新`,
      payload: {
        commitmentTitle: u.title,
        dueAt: u.time?.dueAt,
        overdueHours,
        entities: u.entities.map((e) => ({ type: e.type, name: e.name })),
      },
    });
  }

  // Rule 2: decision_not_sunk
  for (const u of units) {
    if (u.kind !== 'decision') continue;
    const decidedAt = new Date(u.time?.occurredAt ?? u.updatedAt).getTime();
    if (!Number.isFinite(decidedAt)) continue;
    // 给点缓冲：决策当下不报，至少 24h 后还没沉淀文档才报
    if (now - decidedAt < 24 * 3600_000) continue;
    // doc 在 decision 之后是否有更新？
    if (latestDocUpdateAt > decidedAt) continue;
    out.push({
      kind: 'decision_not_sunk',
      spaceId: space.id,
      spaceName: space.name,
      contextUnitId: u.id,
      reasoning: `决策"${u.title}"已超过 24h 未在相关文档中沉淀`,
      payload: {
        decisionTitle: u.title,
        decidedAt: u.time?.occurredAt,
        entities: u.entities.map((e) => ({ type: e.type, name: e.name })),
      },
    });
  }

  return out;
}

export function detectAllDivergences(now: number = Date.now()): DivergenceFinding[] {
  const out: DivergenceFinding[] = [];
  for (const space of listSpaces()) {
    out.push(...detectDivergenceForSpace(space, now));
  }
  return out;
}

/**
 * Look up the latest occurred_at among `events` rows whose source='drive'
 * and id ∈ originRefIds. Returns ms since epoch, or 0.
 */
function getLatestDocUpdateAt(originRefIds: string[]): number {
  if (originRefIds.length === 0) return 0;
  const placeholders = originRefIds.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT MAX(occurred_at) AS latest FROM events
       WHERE source = 'drive' AND id IN (${placeholders})`
    )
    .get(...originRefIds) as { latest: string | null } | undefined;
  if (!row?.latest) return 0;
  const t = new Date(row.latest).getTime();
  return Number.isFinite(t) ? t : 0;
}
