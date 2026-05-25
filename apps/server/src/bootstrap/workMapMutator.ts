// MVP14 Step 4: workMap 可编程原语。
// 由 attention 反馈通道调用，把"用户的偏好"和"实体权重调整"沉淀回 L1，
// 影响下一次 attentionEngine tick 的 packet 与 LLM 推理输入。
//
// 三个原语：
//   addPreference(text)         → 新增/复用一条 work_map:preference unit
//   demoteEntity(id, by)        → 降低 context_entity.confidence（地板 0.1）
//   restoreEntityConfidence     → 反向操作，给 inverse_patch 用
//
// 跟 workMapWriter 不同：那个是 Work Map 整张表的写入，这里是用户反馈
// 触发的单字段修改。两者共享 mergeKey 命名 (work_map:preference:<slug>)。

import { upsertContextUnit } from '../context/contextStore.js';
import { db, getContextEntityById } from '../db.js';
import { createHash } from 'node:crypto';

const ENTITY_CONFIDENCE_FLOOR = 0.1;

function slug(text: string, max = 48): string {
  const t = text.trim().slice(0, max);
  return createHash('sha1').update(t).digest('hex').slice(0, 12);
}

/**
 * 加一条 preference 到 Work Map。
 * 相同文本会 mergeKey 命中（slug），所以重复点击同一偏好不会增列。
 */
export function addPreference(text: string): {
  unitId: string;
  wasUpdate: boolean;
  mergeKey: string;
} {
  const cleaned = text.trim();
  if (!cleaned) throw new Error('addPreference: text empty');
  const mergeKey = `work_map:preference:${slug(cleaned)}`;
  const { unit, wasUpdate } = upsertContextUnit({
    kind: 'preference',
    title: cleaned,
    content: cleaned,
    entities: [{ type: 'person', name: 'me', role: 'subject' }],
    scope: 'work',
    origin: { kind: 'system', refId: 'attention_feedback' },
    actionability: 'record',
    confidence: 0.85,
    mergeHint: mergeKey,
  });
  return { unitId: unit.id, wasUpdate, mergeKey };
}

/**
 * 降低 entity 的 confidence。地板 0.1（避免被完全清零导致后续无法恢复）。
 * 返回 {prevConfidence, newConfidence}，调用方用 prev 写 inverse_patch。
 */
export function demoteEntity(
  entityId: string,
  by = 0.2
): { prevConfidence: number; newConfidence: number; entityName: string; entityType: string } {
  const row = getContextEntityById(entityId);
  if (!row) throw new Error(`demoteEntity: entity ${entityId} not found`);
  const prev = row.confidence ?? 0.5;
  const next = Math.max(ENTITY_CONFIDENCE_FLOOR, prev - by);
  if (next === prev) {
    return { prevConfidence: prev, newConfidence: next, entityName: row.name, entityType: row.type };
  }
  db.prepare(`UPDATE context_entities SET confidence = ?, updated_at = ? WHERE id = ?`).run(
    next,
    new Date().toISOString(),
    entityId
  );
  return { prevConfidence: prev, newConfidence: next, entityName: row.name, entityType: row.type };
}

/**
 * 反向恢复 entity confidence（给 correction undo 用）。
 */
export function restoreEntityConfidence(entityId: string, prevConfidence: number): void {
  db.prepare(`UPDATE context_entities SET confidence = ?, updated_at = ? WHERE id = ?`).run(
    prevConfidence,
    new Date().toISOString(),
    entityId
  );
}

/**
 * 降低 unit↔space link 的某种"权重"。
 * MVP14 简化：直接把对应 context_space_links 行删掉（unit 不再属于此 space）。
 * 更精细的"软降权"留给 Step 5。
 */
export function unlinkUnitFromSpace(unitId: string, spaceId: string): boolean {
  const r = db
    .prepare(
      `DELETE FROM context_space_links
       WHERE target_type = 'context_unit' AND target_id = ? AND space_id = ?`
    )
    .run(unitId, spaceId);
  return r.changes > 0;
}
