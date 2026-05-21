import { randomUUID } from 'node:crypto';
import {
  type ContextEntityRow,
  deleteEntityAlias,
  getContextEntityById,
  getContextEntityByTypeName,
  getEntityAlias,
  insertContextEntity,
  insertEntityAlias,
} from '../db.js';

function canonicalName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').normalize('NFKC');
}

/**
 * Resolve an entityId through the alias chain to its current target.
 * MVP10 §6.3.5：合并是有向引用，不批改 context_unit_entities / context_space_links —
 * 旧引用通过运行时 alias 解析仍能路由到 toId。
 * 最多跳 5 次以避免环。
 */
export function resolveAliased(entityId: string): string {
  let cur = entityId;
  for (let i = 0; i < 5; i++) {
    const a = getEntityAlias(cur);
    if (!a) return cur;
    if (a.alias_of === cur) return cur;
    cur = a.alias_of;
  }
  return cur;
}

/**
 * MVP2.0 最小实现：trim + 归一，命中即返回，否则新建。
 * MVP10：命中后再做一轮 alias 解析，让被合并掉的实体透传到 target。
 */
export function resolveOrCreateEntity(
  type: string,
  rawName: string,
  aliases?: string[]
): ContextEntityRow {
  const normalizedType = type.trim().toLowerCase();
  const displayName = canonicalName(rawName);
  if (!displayName) {
    throw new Error('entity name cannot be empty');
  }

  const existing = getContextEntityByTypeName(normalizedType, displayName);
  if (existing) {
    const aliasedId = resolveAliased(existing.id);
    if (aliasedId !== existing.id) {
      const target = getContextEntityById(aliasedId);
      if (target) return target;
    }
    return existing;
  }

  const now = new Date().toISOString();
  const row: ContextEntityRow = {
    id: randomUUID(),
    type: normalizedType,
    name: displayName,
    aliases_json: aliases && aliases.length ? JSON.stringify(aliases) : null,
    source: null,
    confidence: 0.7,
    created_at: now,
    updated_at: now,
  };
  try {
    insertContextEntity(row);
  } catch (err) {
    const fallback = getContextEntityByTypeName(normalizedType, displayName);
    if (fallback) {
      const aliasedId = resolveAliased(fallback.id);
      if (aliasedId !== fallback.id) {
        const target = getContextEntityById(aliasedId);
        if (target) return target;
      }
      return fallback;
    }
    throw err;
  }
  return row;
}

/**
 * MVP10 §6.3.5：合并 fromId 到 toId。写一条 entity_aliases 行，
 * 不批量改 context_unit_entities / context_space_links。
 */
export function mergeEntities(
  fromId: string,
  toId: string
): { mergedAt: string } {
  if (fromId === toId) throw new Error('mergeEntities: from == to');
  const from = getContextEntityById(fromId);
  const to = getContextEntityById(toId);
  if (!from) throw new Error(`mergeEntities: from entity ${fromId} not found`);
  if (!to) throw new Error(`mergeEntities: to entity ${toId} not found`);
  // 防环：toId 若已是某个 alias，先解析到终态
  const finalTo = resolveAliased(toId);
  if (finalTo === fromId) {
    throw new Error('mergeEntities: would create cycle');
  }
  const now = new Date().toISOString();
  insertEntityAlias({ id: fromId, alias_of: finalTo, created_at: now });
  return { mergedAt: now };
}

/** 用于撤销 entity merge 时把 alias 行删掉（lossy 与否由 caller 标）。 */
export function unmergeEntity(fromId: string): void {
  deleteEntityAlias(fromId);
}

/**
 * MVP11.0-a §4.3.5：把 `entity{doc, name:'doc:<token>'}` 幂等合并到 `entity{doc, name:url}`。
 * 让 driveCollector 抓的 `doc:<token>` 与 Work Map 写的 url entity 路由到同一个 target。
 *
 * 边界：
 * - 任一为空 → no-op
 * - 已合并 / 同 id / 循环 / DB 异常 → 吞掉，不让 collector fail
 */
export function mergeDocIdentity(token: string, url: string): void {
  const t = token?.trim();
  const u = url?.trim();
  if (!t || !u) return;
  try {
    const tokenEnt = resolveOrCreateEntity('doc', `doc:${t}`);
    const urlEnt = resolveOrCreateEntity('doc', u);
    const resolvedToken = resolveAliased(tokenEnt.id);
    const resolvedUrl = resolveAliased(urlEnt.id);
    if (resolvedToken === resolvedUrl) return;
    mergeEntities(resolvedToken, resolvedUrl);
  } catch (err) {
    console.warn(
      '[entity] mergeDocIdentity failed:',
      err instanceof Error ? err.message : String(err)
    );
  }
}
