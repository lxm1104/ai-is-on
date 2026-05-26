// MVP14 Step 4: attention item 反馈通道。
//
// 与原 cards correction 的关键差别：
//   - attention item 是 LLM 推理产出，用户不该直接编辑它；改了下次 tick 也会被覆盖
//   - 反馈必须改 L1（context_entities / context_space_links / work_map preferences），
//     才能影响下一次 attentionEngine 推理的输入
//
// 4 种反馈：
//   not_relevant   → markAttentionItem(dismissed) + 关联 entity confidence -= 0.1
//   wrong_space    → 解开 unit↔space link + space link 计数减分
//   demote_entity  → 该 entity confidence -= 0.2（地板 0.1）
//   add_preference → workMap 新增一条 preference unit
//
// 流程：interpret → preview / 二次确认 → apply → writeJournalEntry / writeAudit
//      → enqueueAttentionTickSoon 触发下一次 attention 重算

import { writeAudit } from '../boundary/auditLog.js';
import { writeJournalEntry } from '../correction/correctionStore.js';
import {
  addPreference,
  demoteEntity,
  restoreEntityConfidence,
  unlinkUnitFromSpace,
} from '../bootstrap/workMapMutator.js';
import {
  getAttentionItem,
  updateAttentionItemStatus,
} from './attentionStore.js';
import {
  type AttentionInteractionAction,
  recordAttentionInteraction,
} from './attentionInteractions.js';
import type { AttentionItem } from './attentionTypes.js';
import type { CorrectionJournalRow } from '../db.js';

export type AttentionFeedbackType =
  | 'not_relevant'
  | 'wrong_space'
  | 'demote_entity'
  | 'add_preference';

export type AttentionFeedbackTier = 'low' | 'medium' | 'high';

type FeedbackResult = {
  applied: boolean;
  tier: AttentionFeedbackTier;
  requiresConfirm: boolean;
  journal?: CorrectionJournalRow;
  preview: Record<string, unknown>;
};

export type ApplyFeedbackInput = {
  attentionId: string;
  type: AttentionFeedbackType;
  payload: Record<string, unknown>;
  confirm?: boolean;
  sourceAction?: AttentionInteractionAction;
};

const NOT_RELEVANT_ENTITY_DEMOTE_BY = 0.1;
const DEMOTE_ENTITY_BY = 0.2;

export function applyAttentionFeedback(input: ApplyFeedbackInput): FeedbackResult {
  const attn = getAttentionItem(input.attentionId);
  if (!attn) throw new Error(`attention item not found: ${input.attentionId}`);

  switch (input.type) {
    case 'not_relevant':
      return applyNotRelevant(attn, input);
    case 'wrong_space':
      return applyWrongSpace(attn, input);
    case 'demote_entity':
      return applyDemoteEntity(attn, input);
    case 'add_preference':
      return applyAddPreference(attn, input);
    default:
      throw new Error(`unknown feedback type: ${input.type}`);
  }
}

// --------------------------------------------------------------------------
// 1) not_relevant
// --------------------------------------------------------------------------

function applyNotRelevant(attn: AttentionItem, input: ApplyFeedbackInput): FeedbackResult {
  // low tier：仅 dismiss + 轻微 entity demote（-0.1，地板 0.1），用户体感是"小推一下"
  const preview = {
    type: 'not_relevant',
    attentionId: attn.id,
    title: attn.title,
    willDismiss: true,
    relatedEntityIds: attn.relatedEntityIds,
    entityDemoteBy: NOT_RELEVANT_ENTITY_DEMOTE_BY,
  };

  if (!input.confirm && input.confirm !== undefined) {
    return { applied: false, tier: 'low', requiresConfirm: false, preview };
  }

  const now = new Date().toISOString();
  updateAttentionItemStatus(attn.id, 'dismissed', now);
  recordAttentionInteraction(attn, input.sourceAction ?? 'not_relevant', now);

  const demotedRecords: Array<{ entityId: string; prev: number; next: number; name: string }> = [];
  for (const eid of attn.relatedEntityIds) {
    try {
      const r = demoteEntity(eid, NOT_RELEVANT_ENTITY_DEMOTE_BY);
      demotedRecords.push({
        entityId: eid,
        prev: r.prevConfidence,
        next: r.newConfidence,
        name: r.entityName,
      });
    } catch (err) {
      console.warn(
        `[attention_feedback] demoteEntity ${eid} skipped:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  const forward = {
    attentionId: attn.id,
    status: 'dismissed',
    demotedEntities: demotedRecords,
  };
  const inverse = {
    attentionId: attn.id,
    restoreStatus: 'live',
    restoreEntities: demotedRecords.map((r) => ({ id: r.entityId, prevConfidence: r.prev })),
  };
  writeAudit({
    action: 'attention_dismissed_with_learn',
    reason: `用户标"这条没用"：${attn.title}（demote ${demotedRecords.length} 个 entity）`,
    payload: forward,
  });
  const journal = writeJournalEntry({
    feedbackId: attn.id,
    correctionType: 'attention_not_relevant',
    targetKind: 'attention_item',
    targetId: attn.id,
    forwardPatch: forward,
    inversePatch: inverse,
    inverseLossy: false,
  });
  return { applied: true, tier: 'low', requiresConfirm: false, journal, preview };
}

// --------------------------------------------------------------------------
// 2) wrong_space
// --------------------------------------------------------------------------

function applyWrongSpace(attn: AttentionItem, input: ApplyFeedbackInput): FeedbackResult {
  // 用户给一个 wrongSpaceId（必填），可选 unitIds（默认用 attn.signalIds）
  const wrongSpaceId = String(input.payload.wrongSpaceId ?? '').trim();
  if (!wrongSpaceId) throw new Error('wrong_space: wrongSpaceId required');
  const unitIds = Array.isArray(input.payload.unitIds)
    ? (input.payload.unitIds as unknown[]).map(String)
    : attn.signalIds;

  const preview = {
    type: 'wrong_space',
    attentionId: attn.id,
    title: attn.title,
    wrongSpaceId,
    affectedUnitIds: unitIds,
  };

  const needsConfirm = input.confirm !== true;
  if (needsConfirm) {
    return { applied: false, tier: 'medium', requiresConfirm: true, preview };
  }

  const unlinked: string[] = [];
  for (const uid of unitIds) {
    if (unlinkUnitFromSpace(uid, wrongSpaceId)) unlinked.push(uid);
  }
  const forward = { attentionId: attn.id, wrongSpaceId, unlinked };
  const inverse = null; // 简化版：解开后不保留 link 的全部字段，无损撤销留 Step5

  writeAudit({
    action: 'attention_space_corrected',
    reason: `用户标"关联项目错了"：${attn.title}（解开 ${unlinked.length} 个 link）`,
    payload: forward,
  });
  const journal = writeJournalEntry({
    feedbackId: attn.id,
    correctionType: 'attention_wrong_space',
    targetKind: 'attention_item',
    targetId: attn.id,
    forwardPatch: forward,
    inversePatch: inverse,
    inverseLossy: true,
  });
  return { applied: true, tier: 'medium', requiresConfirm: false, journal, preview };
}

// --------------------------------------------------------------------------
// 3) demote_entity
// --------------------------------------------------------------------------

function applyDemoteEntity(attn: AttentionItem, input: ApplyFeedbackInput): FeedbackResult {
  const entityId = String(input.payload.entityId ?? '').trim();
  if (!entityId) throw new Error('demote_entity: entityId required');
  const by = typeof input.payload.by === 'number' ? (input.payload.by as number) : DEMOTE_ENTITY_BY;

  const preview = {
    type: 'demote_entity',
    attentionId: attn.id,
    entityId,
    by,
  };

  const needsConfirm = input.confirm !== true;
  if (needsConfirm) {
    return { applied: false, tier: 'medium', requiresConfirm: true, preview };
  }

  const r = demoteEntity(entityId, by);
  const forward = {
    attentionId: attn.id,
    entityId,
    entityName: r.entityName,
    prevConfidence: r.prevConfidence,
    newConfidence: r.newConfidence,
  };
  const inverse = {
    entityId,
    restoreConfidence: r.prevConfidence,
  };
  writeAudit({
    action: 'attention_entity_demoted',
    reason: `用户降低 ${r.entityType}:${r.entityName} 权重: ${r.prevConfidence.toFixed(2)} → ${r.newConfidence.toFixed(2)}`,
    payload: forward,
  });
  const journal = writeJournalEntry({
    feedbackId: attn.id,
    correctionType: 'attention_demote_entity',
    targetKind: 'entity_alias',
    targetId: entityId,
    forwardPatch: forward,
    inversePatch: inverse,
    inverseLossy: false,
  });
  return { applied: true, tier: 'medium', requiresConfirm: false, journal, preview };
}

// --------------------------------------------------------------------------
// 4) add_preference
// --------------------------------------------------------------------------

function applyAddPreference(attn: AttentionItem, input: ApplyFeedbackInput): FeedbackResult {
  const text = String(input.payload.text ?? '').trim();
  if (!text) throw new Error('add_preference: text required');

  const preview = {
    type: 'add_preference',
    attentionId: attn.id,
    text,
  };
  const needsConfirm = input.confirm !== true;
  if (needsConfirm) {
    return { applied: false, tier: 'medium', requiresConfirm: true, preview };
  }

  const r = addPreference(text);
  const forward = {
    attentionId: attn.id,
    text,
    unitId: r.unitId,
    mergeKey: r.mergeKey,
    wasUpdate: r.wasUpdate,
  };
  writeAudit({
    action: 'attention_preference_added',
    reason: `用户添加偏好："${text}"`,
    payload: forward,
  });
  const journal = writeJournalEntry({
    feedbackId: attn.id,
    correctionType: 'attention_add_preference',
    targetKind: 'context_unit',
    targetId: r.unitId,
    forwardPatch: forward,
    // 不写 inverse：preference unit 用户可以从 WorkMapPanel 自己手动删
    inversePatch: null,
    inverseLossy: true,
  });
  return { applied: true, tier: 'medium', requiresConfirm: false, journal, preview };
}

// re-export for routes
export { restoreEntityConfidence };
