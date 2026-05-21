/**
 * MVP10 correction journal helpers + entity-merge lossy detection。
 *
 * forward_patch / inverse_patch 的 JSON 形状由 correctionWriter 写入：
 *   - context_unit: { fields: { fieldName: newValue } }
 *   - boundary_rule: { active?: boolean, condition?: BoundaryCondition, allowedAction?: ... }
 *   - entity_alias: { fromId, toId, mergedAt }
 *
 * lossy 检测 §6.5：merge 之后有下游写入 toId → 撤销将丢失这些关联。
 */
import { randomUUID } from 'node:crypto';
import {
  type CorrectionJournalRow,
  db,
  insertCorrectionJournal,
} from '../db.js';

export type WriteJournalInput = {
  feedbackId: string;
  correctionType: string;
  targetKind: 'context_unit' | 'boundary_rule' | 'entity_alias';
  targetId: string;
  forwardPatch: Record<string, unknown>;
  inversePatch: Record<string, unknown> | null;
  inverseLossy: boolean;
};

export function writeJournalEntry(input: WriteJournalInput): CorrectionJournalRow {
  const now = new Date().toISOString();
  const row: CorrectionJournalRow = {
    id: randomUUID(),
    feedback_id: input.feedbackId,
    correction_type: input.correctionType,
    target_kind: input.targetKind,
    target_id: input.targetId,
    forward_patch_json: JSON.stringify(input.forwardPatch),
    inverse_patch_json: input.inversePatch ? JSON.stringify(input.inversePatch) : null,
    inverse_lossy: input.inverseLossy ? 1 : 0,
    applied_at: now,
    reverted_at: null,
  };
  insertCorrectionJournal(row);
  return row;
}

/**
 * §6.5：判断撤销 mergeEntities(fromId, toId) 是否会 lossy。
 * 命中以下任一即标 lossy=true：
 *   1) 合并后有 ContextUnit 引用 toId 且 updated_at > mergedAt
 *   2) 合并后有 Space link 引用 toId 且 created_at > mergedAt
 */
export function isMergeLossy(toId: string, mergedAt: string): boolean {
  const hit1 = db
    .prepare(
      `SELECT 1 FROM context_unit_entities cue
       JOIN context_units cu ON cu.id = cue.context_unit_id
       WHERE cue.entity_id = :toId AND cu.updated_at > :mergedAt
       LIMIT 1`
    )
    .get({ toId, mergedAt }) as unknown;
  if (hit1) return true;
  const hit2 = db
    .prepare(
      `SELECT 1 FROM context_space_links
       WHERE target_type = 'entity' AND target_id = :toId AND created_at > :mergedAt
       LIMIT 1`
    )
    .get({ toId, mergedAt }) as unknown;
  return !!hit2;
}
