import { randomUUID } from 'node:crypto';
import {
  type ContextEntityRow,
  getContextEntityByTypeName,
  insertContextEntity,
} from '../db.js';

function canonicalName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').normalize('NFKC');
}

function canonicalKey(s: string): string {
  return canonicalName(s).toLowerCase();
}

/**
 * MVP2.0 最小实现：trim + lowercase 归一，命中即返回，否则新建。
 * MVP2.1 引入 alias 表后再扩展同名/同别名命中。不接向量。
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

  // 首先按 canonical 名字尝试命中
  const existing = getContextEntityByTypeName(normalizedType, displayName);
  if (existing) {
    // 简单合并 alias（如果有新别名）。MVP2.0 不向量化、不写回 aliases。
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
    // 并发或 UNIQUE 冲突，回查一遍兜底
    const fallback = getContextEntityByTypeName(normalizedType, displayName);
    if (fallback) return fallback;
    throw err;
  }
  return row;
}
