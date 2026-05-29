/**
 * MVP15A §7.4 — WorkItemEdge follows inducer + purgeStaleEdges。
 *
 * follows 边来源：`context_links (link_type='updates')` 已经在 db 里
 * （87 条样本数据观察）。语义：B updates A → A follows B（B 是 A 的"后续"，
 * A 跟随 B 的更新）。
 *
 * MVP15A 只产 follows；blocks / depends_on / derived_from 推 MVP15B（LLM）。
 *
 * 自动失活：
 *   - inducer 每次跑都校验任一 unit 失活 → edge.status='resolved'
 *   - markStaleWorkItemEdges：90 天没碰过的 active 边转 stale
 *
 * purgeStaleEdges（entity_edges + work_item_edges 联合清理）：
 *   - entity_edges：last_seen_at < cutoff 删，self-anchored 例外保留
 *   - work_item_edges：调 markStaleWorkItemEdges
 *   - dryRun=true 第一周默认（self-审 §9 #9）
 */

// MVP21 S5.1: 本文件从 context/ 迁到 structure/derived/。
import { randomUUID } from 'node:crypto';
import {
  db,
  listEntityEdges,
  listWorkItemEdges,
  markStaleWorkItemEdges,
  purgeStaleEntityEdges,
  upsertWorkItemEdge,
  type WorkItemEdgeRow,
} from '../../db.js';

export type WorkItemInducerSummary = {
  written: number;        // 新建/更新的 follows 边数
  resolved: number;       // 因 unit 失活转 resolved 的边数
  skippedSelfLoop: number;
};

const REASON_TEXT = 'context_links.updates: B updates A → A follows B';

type ContextLinkRow = {
  id: string;
  from_context_id: string;
  to_context_id: string;
  link_type: string;
  confidence: number;
  created_at: string;
};

type ContextUnitStatusRow = { id: string; status: string };

export function induceWorkItemFollowsEdges(): WorkItemInducerSummary {
  const nowIso = new Date().toISOString();

  // 拉 updates link
  const updates = db
    .prepare(
      `SELECT * FROM context_links WHERE link_type = 'updates'`
    )
    .all() as ContextLinkRow[];

  // 收集涉及的 unit_id 一次查 status（避免循环里 N 次 SQL）
  const unitIds = new Set<string>();
  for (const l of updates) {
    unitIds.add(l.from_context_id);
    unitIds.add(l.to_context_id);
  }
  const unitStatus = new Map<string, string>();
  if (unitIds.size > 0) {
    const placeholders = Array.from(unitIds).map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, status FROM context_units WHERE id IN (${placeholders})`)
      .all(...Array.from(unitIds)) as ContextUnitStatusRow[];
    for (const r of rows) unitStatus.set(r.id, r.status);
  }

  let written = 0;
  let resolved = 0;
  let skippedSelfLoop = 0;

  for (const link of updates) {
    // 方向：updates(B, A) → A follows B
    // context_links.from = B（更新方），context_links.to = A（被更新方）
    const fromUnitId = link.to_context_id; // A
    const toUnitId = link.from_context_id; // B

    // self-loop 跳过
    if (fromUnitId === toUnitId) {
      skippedSelfLoop++;
      continue;
    }

    // 任一 unit 不存在或失活 → status='resolved'
    const fromStatus = unitStatus.get(fromUnitId) ?? null;
    const toStatus = unitStatus.get(toUnitId) ?? null;
    const eitherNotActive =
      fromStatus !== 'active' || toStatus !== 'active';

    const row: WorkItemEdgeRow = {
      id: randomUUID(),
      from_unit_id: fromUnitId,
      to_unit_id: toUnitId,
      type: 'follows',
      status: eitherNotActive ? 'resolved' : 'active',
      reason: REASON_TEXT,
      evidence_unit_ids_json: JSON.stringify([fromUnitId, toUnitId]),
      detected_at: nowIso,
      resolved_at: eitherNotActive ? nowIso : null,
      updated_at: nowIso,
    };
    upsertWorkItemEdge(row);
    written++;
    if (eitherNotActive) resolved++;
  }

  return { written, resolved, skippedSelfLoop };
}

// ----------------------------------------------------------------------------
// Combined purge: entity_edges + work_item_edges
// ----------------------------------------------------------------------------

export type PurgeOpts = {
  /** 默认 90 天没碰过的边算 stale */
  cutoffDays?: number;
  /** dryRun 仅日志统计，不实删 */
  dryRun?: boolean;
  now?: number;
};

export type PurgeSummary = {
  entityEdgesMatched: number;
  entityEdgesDeleted: number;
  workItemEdgesTransitioned: number;
  dryRun: boolean;
};

/**
 * 联合清理：
 * 1. entity_edges 中 last_seen_at < cutoff 的边删除（保留 self-anchored）
 * 2. work_item_edges 中 active 但 updated_at < cutoff 的边转 stale
 *
 * MVP15A §9 #9：默认 dryRun=true 第一周观察，避免误删。
 */
export function purgeStaleEdges(opts: PurgeOpts = {}): PurgeSummary {
  const now = opts.now ?? Date.now();
  const cutoffDays = opts.cutoffDays ?? 90;
  const cutoffIso = new Date(now - cutoffDays * 86400_000).toISOString();
  const dryRun = opts.dryRun ?? true;

  const selfId = (
    db.prepare(`SELECT value FROM settings WHERE key = 'self_person_entity_id'`).get() as
      | { value: string }
      | undefined
  )?.value ?? null;

  const entRes = purgeStaleEntityEdges(cutoffIso, selfId, { dryRun });
  const wiRes = dryRun ? { transitioned: 0 } : markStaleWorkItemEdges(cutoffIso);

  return {
    entityEdgesMatched: entRes.matched,
    entityEdgesDeleted: entRes.deleted,
    workItemEdgesTransitioned: wiRes.transitioned,
    dryRun,
  };
}

// 暴露给测试
export const __internal = {
  REASON_TEXT,
};
