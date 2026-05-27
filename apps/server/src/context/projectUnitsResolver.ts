/**
 * MVP15B § M1 — 给定一个 canonical project name，反向找属于此 canonical 的
 * 所有 context_unit。
 *
 * 链路：org_project_taxonomy.canonical_name
 *   → 解析 aliases_json 得到一组 entity name
 *   → context_entities WHERE type='project' AND name IN (...)
 *   → context_unit_entities 找含这些 entity_id 的 unit_id
 *   → context_units 拉 unit 数据
 *
 * 用途：M2 judgeProjectPhase 给每个 canonical project 收证据；M5 assembleGraphContext
 * 算 expectedButMissing 时候用得到。
 */
import { db, type ContextEntityRow, type ContextUnitRow } from '../db.js';
import type { ContextUnit, ContextUnitKind } from './ContextUnit.js';
import { listActiveContextUnits } from './contextStore.js';

export type ListUnitsForProjectOpts = {
  /** 只返回这些 kind 的 unit；不传 = 全部 */
  kinds?: ContextUnitKind[];
  /** 总 unit 数上限（默认 50） */
  limit?: number;
  /** 只看 updated_at >= sinceIso 的 unit；用于"近 N 天事件" */
  sinceIso?: string;
};

/**
 * 给定一个 canonical project name（来自 org_project_taxonomy），返回属于此 project 的
 * 所有 active work-scope context_unit。
 *
 * 如果 canonical 在 taxonomy 表里没有记录，回退用 canonical name 作为唯一别名查询
 * （这样新增项目即便还没 LLM 解析也能拿到它直接命名的 unit）。
 */
export function listUnitsForProjectCanonical(
  canonicalName: string,
  opts: ListUnitsForProjectOpts = {}
): ContextUnit[] {
  const trimmed = canonicalName.trim();
  if (!trimmed) return [];

  // 1) taxonomy 反查 aliases
  const taxRow = db
    .prepare(`SELECT aliases_json FROM org_project_taxonomy WHERE canonical_name = ?`)
    .get(trimmed) as { aliases_json: string } | undefined;
  let aliases: string[];
  if (taxRow) {
    try {
      const parsed = JSON.parse(taxRow.aliases_json);
      aliases = Array.isArray(parsed)
        ? parsed.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : [trimmed];
    } catch {
      aliases = [trimmed];
    }
  } else {
    aliases = [trimmed];
  }
  if (aliases.length === 0) return [];

  // 2) entity name → entity_id（type='project'）
  const placeholders = aliases.map(() => '?').join(',');
  const entityRows = db
    .prepare(
      `SELECT id FROM context_entities WHERE type = 'project' AND name IN (${placeholders})`
    )
    .all(...aliases) as Array<{ id: string }>;
  if (entityRows.length === 0) return [];
  const entityIds = entityRows.map((r) => r.id);

  // 3) context_unit_entities 找含这些 entity 的 unit_id
  const eidPlaceholders = entityIds.map(() => '?').join(',');
  const sinceClause = opts.sinceIso ? `AND cu.updated_at >= ?` : '';
  const kindsClause =
    opts.kinds && opts.kinds.length > 0
      ? `AND cu.kind IN (${opts.kinds.map(() => '?').join(',')})`
      : '';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const params: Array<string | number> = [...entityIds];
  if (opts.sinceIso) params.push(opts.sinceIso);
  if (opts.kinds && opts.kinds.length > 0) params.push(...opts.kinds);
  params.push(limit);

  const unitRows = db
    .prepare(
      `SELECT DISTINCT cu.*
       FROM context_units cu
       JOIN context_unit_entities cue ON cue.context_unit_id = cu.id
       WHERE cue.entity_id IN (${eidPlaceholders})
         AND cu.status = 'active'
         AND cu.scope = 'work'
         ${sinceClause}
         ${kindsClause}
       ORDER BY cu.updated_at DESC
       LIMIT ?`
    )
    .all(...params) as ContextUnitRow[];

  // 4) 走 listActiveContextUnits 的 rowToUnit 路径拿到 hydrated 实体
  //    最稳妥：用 ids 单独查（保证 entities 都被 hydrated）
  if (unitRows.length === 0) return [];
  const unitIds = unitRows.map((r) => r.id);
  const idPlaceholders = unitIds.map(() => '?').join(',');
  // 这里走 listActiveContextUnits 拿全套，再过滤；保证 hydration 与系统其它路径一致
  const all = listActiveContextUnits({ limit: 1000 });
  const idSet = new Set(unitIds);
  // 按 unitIds 原顺序排（updated_at DESC）
  const indexById = new Map(unitIds.map((id, i) => [id, i]));
  return all
    .filter((u) => idSet.has(u.id))
    .sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0));
}
