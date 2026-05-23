/**
 * MVP14 Phase 1a · Explicit Relationships read model.
 *
 * 真正在用的"关系"承载在 ContextUnit.kind='relationship' 上，不是空表
 * context_relations。本 service 把这些 unit 投成一个 enriched read model：
 *
 *   - source: 来源 tag（基于 mergeKey + origin.kind 联合判断）
 *   - persons: canonical person entity 列表（已 resolveAliased）
 *   - summary: meaning ?? content ?? title（≤200 chars）
 *   - updatedAt
 *
 * 不依赖 context_relations 表；表保留物理 schema 但应用层已无 caller（Phase 1c
 * 一并清理）。
 */
import {
  getContextEntityById,
  listEntitiesForUnit,
  type ContextEntityRow,
} from '../db.js';
import { resolveAliased } from './entityResolver.js';
import { listActiveContextUnits } from './contextStore.js';
import type { ContextUnit } from './ContextUnit.js';

export type RelationshipSource =
  | 'work_map'
  | 'extracted_from_event'
  | 'manual'
  | 'system'
  | 'agent'
  | 'other';

export type RelationshipPerson = {
  id: string;            // canonical (resolveAliased)
  name: string;
};

export type RelationshipItem = {
  id: string;
  source: RelationshipSource;
  persons: RelationshipPerson[];
  summary: string;       // <= 200 chars
  title: string;
  updatedAt: string;
};

const SUMMARY_MAX = 200;

export function listRelationships(opts: { limit?: number } = {}): RelationshipItem[] {
  const limit = clampLimit(opts.limit, 100, 500);
  // 复用现成的 active unit list helper；按 updated_at desc 排序由 listContextUnits 给。
  const units = listActiveContextUnits({ kind: 'relationship', limit });
  return units.map(toItem);
}

function toItem(u: ContextUnit): RelationshipItem {
  return {
    id: u.id,
    source: classifySource(u),
    persons: collectCanonicalPersons(u.id),
    summary: buildSummary(u),
    title: u.title,
    updatedAt: u.updatedAt,
  };
}

/**
 * Source 判定规则（与 Codex 共识）：
 *   mergeKey 'work_map:relationship:*'             → work_map
 *   origin.kind='system' && refId='work_map'       → work_map
 *   origin.kind='event'                            → extracted_from_event
 *   origin.kind='manual'                           → manual
 *   origin.kind='system'                           → system   (非 work_map)
 *   origin.kind='agent_run'                        → agent
 *   其他                                            → other
 */
export function classifySource(u: ContextUnit): RelationshipSource {
  if (u.mergeKey?.startsWith('work_map:relationship:')) return 'work_map';
  if (u.origin.kind === 'system' && u.origin.refId === 'work_map') {
    return 'work_map';
  }
  switch (u.origin.kind) {
    case 'event':
      return 'extracted_from_event';
    case 'manual':
      return 'manual';
    case 'system':
      return 'system';
    case 'agent_run':
      return 'agent';
    default:
      return 'other';
  }
}

/**
 * Codex A'3 P1：UI 不能只用 hydrated entities 里的 name/type（没有 id），
 * 必须从 context_unit_entities 拿 entity_id → resolveAliased → 取 canonical entity。
 * 这样多个 alias 指向同一个人时，UI 只显示 1 个 chip 而不是 N 个。
 */
function collectCanonicalPersons(unitId: string): RelationshipPerson[] {
  const links = listEntitiesForUnit(unitId);
  const seen = new Set<string>();
  const out: RelationshipPerson[] = [];
  for (const l of links) {
    const canonicalId = resolveAliased(l.entity_id);
    if (seen.has(canonicalId)) continue;
    const ent: ContextEntityRow | null = getContextEntityById(canonicalId);
    if (!ent || ent.type !== 'person') continue;
    seen.add(canonicalId);
    out.push({ id: canonicalId, name: ent.name });
  }
  return out;
}

/**
 * Codex A'4 P1：summary 优先级 meaning ?? content ?? title，因为 workMapWriter 写入时
 * 只填 content 不填 meaning（apps/server/src/bootstrap/workMapWriter.ts:111-120）。
 */
function buildSummary(u: ContextUnit): string {
  const raw = (u.meaning && u.meaning.trim()) || (u.content && u.content.trim()) || u.title;
  if (raw.length <= SUMMARY_MAX) return raw;
  return raw.slice(0, SUMMARY_MAX) + '…';
}

function clampLimit(input: number | undefined, fallback: number, max: number): number {
  if (input === undefined || !Number.isFinite(input)) return fallback;
  const n = Math.floor(input);
  if (n <= 0) return fallback;
  return Math.min(n, max);
}
