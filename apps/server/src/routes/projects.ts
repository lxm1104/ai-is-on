// MVP19 §M4: project canonical proposals 审核入口（最小可用）。
//
// 设计原则：UI 锁死最小 —— 纯 GET 列表 + POST 行级 approve/reject。
//   没有样式、没有分页、没有批量操作。后续不再追加 UI 投入；如审核流真的不够用，
//   再回头扩；当前阶段优先验证闭词表上线后 proposal 的真实增长情况。
//
// 路由：
//   GET  /api/projects/proposals                 → { items: [...] }
//   POST /api/projects/proposals/:id/resolve     → 见下方 body shape
//
// resolve body：
//   { action: 'approve_new',   canonical?: string, parentCanonical?: string }
//   { action: 'approve_alias', target: string }
//   { action: 'rejected' }
//
// 返回：
//   2xx  { ok: true, proposal: updated row }
//   404  proposal 不存在或已 resolved
//   409  alias 冲突（approve_alias 时 target 与现有 alias 撞车，或 approve_new
//        时 proposed_name 已被另一个 canonical 占用）
//   400  入参非法

import { Router } from 'express';
import {
  AliasConflictError,
  getProjectProposal,
  listPendingProjectProposals,
  resolveProjectProposalStatus,
  upsertProjectTaxonomy,
  db,
} from '../db.js';

export const projectsRouter = Router();

projectsRouter.get('/projects/proposals', (_req, res) => {
  const rows = listPendingProjectProposals();
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      proposedName: r.proposed_name,
      occurrences: r.occurrences,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      sourceEventId: r.source_event_id,
      sourceUnitIds: safeParseStringArray(r.source_unit_ids_json),
    })),
  });
});

projectsRouter.post('/projects/proposals/:id/resolve', (req, res) => {
  const id = req.params.id;
  const proposal = getProjectProposal(id);
  if (!proposal) {
    res.status(404).json({ error: `proposal not found: ${id}` });
    return;
  }
  if (proposal.status !== 'pending') {
    res
      .status(404)
      .json({ error: `proposal already resolved: status=${proposal.status}` });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = typeof body.action === 'string' ? body.action : '';

  try {
    if (action === 'rejected') {
      resolveProjectProposalStatus({ id, status: 'rejected' });
      res.json({ ok: true, proposal: getProjectProposal(id) });
      return;
    }

    if (action === 'approve_new') {
      const canonical =
        typeof body.canonical === 'string' && body.canonical.trim()
          ? body.canonical.trim()
          : proposal.proposed_name;
      const parentCanonical =
        typeof body.parentCanonical === 'string' && body.parentCanonical.trim()
          ? body.parentCanonical.trim()
          : null;
      // parent 必须存在
      if (parentCanonical) {
        const parentExists = db
          .prepare(`SELECT 1 AS x FROM org_project_taxonomy WHERE canonical_name=?`)
          .get(parentCanonical);
        if (!parentExists) {
          res
            .status(400)
            .json({ error: `parentCanonical not in registry: ${parentCanonical}` });
          return;
        }
      }
      // 写新 canonical（upsertProjectTaxonomy 会做 alias 跨行唯一性检查 →
      // 若 proposed_name 已被某行 alias 占据则抛 AliasConflictError → 409）
      upsertProjectTaxonomy({
        canonical_name: canonical,
        aliases_json: JSON.stringify([canonical]),
        summary: null,
        parsed_by: 'user',
        parsed_at: new Date().toISOString(),
        parent_canonical_name: parentCanonical,
      });
      resolveProjectProposalStatus({
        id,
        status: 'approved_new',
        canonical,
        parentCanonical,
      });
      res.json({ ok: true, proposal: getProjectProposal(id) });
      return;
    }

    if (action === 'approve_alias') {
      const target =
        typeof body.target === 'string' && body.target.trim() ? body.target.trim() : '';
      if (!target) {
        res.status(400).json({ error: 'approve_alias requires target canonical' });
        return;
      }
      const targetRow = db
        .prepare(
          `SELECT canonical_name, aliases_json FROM org_project_taxonomy
            WHERE canonical_name=?`
        )
        .get(target) as { canonical_name: string; aliases_json: string } | undefined;
      if (!targetRow) {
        res.status(400).json({ error: `target canonical not in registry: ${target}` });
        return;
      }
      // 把 proposed_name 追加到 target.aliases_json 并 upsert
      let existingAliases: string[] = [];
      try {
        const parsed = JSON.parse(targetRow.aliases_json);
        if (Array.isArray(parsed)) {
          existingAliases = parsed.filter((s): s is string => typeof s === 'string');
        }
      } catch {}
      const mergedAliases = Array.from(
        new Set([...existingAliases, proposal.proposed_name])
      );
      upsertProjectTaxonomy({
        canonical_name: target,
        aliases_json: JSON.stringify(mergedAliases),
        summary: null,
        parsed_by: 'user',
        parsed_at: new Date().toISOString(),
        // parent / authoritative_space_id 不传 → 保留现状
      });
      resolveProjectProposalStatus({ id, status: 'approved_alias', canonical: target });
      res.json({ ok: true, proposal: getProjectProposal(id) });
      return;
    }

    res
      .status(400)
      .json({
        error: `unknown action: ${action}; expected one of approve_new|approve_alias|rejected`,
      });
  } catch (err) {
    if (err instanceof AliasConflictError) {
      res.status(409).json({
        error: 'alias_conflict',
        message: err.message,
        alias: err.alias,
        existingCanonical: err.existingCanonical,
        proposedCanonical: err.proposedCanonical,
      });
      return;
    }
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function safeParseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === 'string');
    }
  } catch {}
  return [];
}
