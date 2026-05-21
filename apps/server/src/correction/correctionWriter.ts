/**
 * MVP10 §6.3 写入入口：根据 CorrectionDraft 落到目标表 + correction_journal + audit_logs。
 * 输入 confirm=false 时仅返回 preview（dry run），不写库。
 */
import { writeAudit } from '../boundary/auditLog.js';
import { createRule } from '../boundary/boundaryStore.js';
import type { Priority } from '../boundary/BoundaryRule.js';
import { mergeEntities } from '../context/entityResolver.js';
import {
  type CardRow,
  type CorrectionJournalRow,
  db,
} from '../db.js';
import {
  type CorrectionDraft,
  type CorrectionType,
  interpret as interpretFn,
  loadCardOrThrow,
} from './feedbackInterpreter.js';
import { isMergeLossy, writeJournalEntry } from './correctionStore.js';

export type CorrectionApplyResult = {
  applied: boolean;
  tier: 'low' | 'medium' | 'high';
  requiresConfirm: boolean;
  journal?: CorrectionJournalRow;
  preview: Record<string, unknown>;
};

export type ApplyInput = {
  cardId: string;
  type: CorrectionType;
  payload: Record<string, unknown>;
  /** 当 tier ∈ {medium, high} 时，必须 confirm=true 才会真的写入。 */
  confirm?: boolean;
};

export function applyCorrection(input: ApplyInput): CorrectionApplyResult {
  const card = loadCardOrThrow(input.cardId);
  const draft = interpretFn(card, input.type, input.payload);
  const preview = buildPreview(draft, card);

  const needsConfirm = draft.tier !== 'low' && !input.confirm;
  if (needsConfirm) {
    return {
      applied: false,
      tier: draft.tier,
      requiresConfirm: true,
      preview,
    };
  }

  const journal = applyConfirmed(draft, card);
  return {
    applied: true,
    tier: draft.tier,
    requiresConfirm: false,
    journal,
    preview,
  };
}

function applyConfirmed(draft: CorrectionDraft, card: CardRow): CorrectionJournalRow {
  switch (draft.type) {
    case 'wrong_priority':
      return applyWrongPriority(draft, card);
    case 'wrong_meaning':
      return applyWrongMeaning(draft, card);
    case 'wrong_actionability':
      return applyWrongActionability(draft, card);
    case 'wrong_kind':
      return applyWrongKind(draft, card);
    case 'wrong_entity':
      return applyWrongEntity(draft, card);
  }
}

// --------------------------------------------------------------------------
// per-type apply
// --------------------------------------------------------------------------

function applyWrongPriority(
  draft: Extract<CorrectionDraft, { type: 'wrong_priority' }>,
  card: CardRow
): CorrectionJournalRow {
  const now = new Date().toISOString();
  // 更新当前卡片 priority
  db.prepare(`UPDATE cards SET priority = ?, updated_at = ? WHERE id = ?`).run(
    draft.newPriority,
    now,
    card.id
  );

  let learnedRuleId: string | undefined;
  if (draft.learnRule) {
    // correction 路径学的规则永远是 record / local_auto —— 用户已经在 inline
    // 显式说"以后类似的都按这个 priority 处理"，这是把信号往 digest 推的本地动作。
    const rule = createRule({
      scope: 'work',
      condition: {
        source: [card.source as never],
        priorityAtMost: draft.newPriority as Priority,
      },
      allowedAction: 'record',
      requiresApproval: false,
      confidence: 0.75,
      source: 'card_action',
      learnedFromCardId: card.id,
      active: true,
      autonomy: 'local_auto',
      reversible: true,
      impactScope: 'self',
    });
    learnedRuleId = rule.id;
    writeAudit({
      action: 'rule_learned',
      reason: `用户在卡片 ${card.id.slice(0, 8)} 上 inline 学习 priority≤${draft.newPriority}（source=${card.source}）`,
      cardId: card.id,
      ruleId: rule.id,
      payload: { via: 'correction.wrong_priority' },
    });
  }

  const forward: Record<string, unknown> = {
    cardId: card.id,
    prevPriority: draft.prevPriority,
    newPriority: draft.newPriority,
    learnedRuleId: learnedRuleId ?? null,
  };
  const inverse: Record<string, unknown> = {
    cardId: card.id,
    restorePriority: draft.prevPriority,
    deactivateRuleId: learnedRuleId ?? null,
  };

  writeAudit({
    action: 'correction_applied',
    reason: `wrong_priority: ${draft.prevPriority} → ${draft.newPriority}${draft.learnRule ? '（已学规则）' : ''}`,
    cardId: card.id,
    payload: forward,
  });

  return writeJournalEntry({
    feedbackId: card.id,
    correctionType: 'wrong_priority',
    targetKind: 'context_unit',  // 把 card 视作目标 surrogate；context_unit field 含义这里复用
    targetId: card.id,
    forwardPatch: forward,
    inversePatch: inverse,
    inverseLossy: false,
  });
}

function applyWrongMeaning(
  draft: Extract<CorrectionDraft, { type: 'wrong_meaning' }>,
  card: CardRow
): CorrectionJournalRow {
  const now = new Date().toISOString();
  db.prepare(`UPDATE context_units SET meaning = ?, updated_at = ? WHERE id = ?`).run(
    draft.newMeaning,
    now,
    draft.contextUnitId
  );

  const forward = {
    contextUnitId: draft.contextUnitId,
    field: 'meaning',
    newValue: draft.newMeaning,
    prevValue: draft.prevMeaning,
  };
  const inverse = {
    contextUnitId: draft.contextUnitId,
    field: 'meaning',
    restoreValue: draft.prevMeaning,
  };

  writeAudit({
    action: 'correction_applied',
    reason: 'wrong_meaning: meaning 已更新',
    cardId: card.id,
    payload: forward,
  });

  return writeJournalEntry({
    feedbackId: card.id,
    correctionType: 'wrong_meaning',
    targetKind: 'context_unit',
    targetId: draft.contextUnitId,
    forwardPatch: forward,
    inversePatch: inverse,
    inverseLossy: false,
  });
}

function applyWrongActionability(
  draft: Extract<CorrectionDraft, { type: 'wrong_actionability' }>,
  card: CardRow
): CorrectionJournalRow {
  const now = new Date().toISOString();
  db.prepare(`UPDATE context_units SET actionability = ?, updated_at = ? WHERE id = ?`).run(
    draft.newActionability,
    now,
    draft.contextUnitId
  );

  const forward = {
    contextUnitId: draft.contextUnitId,
    field: 'actionability',
    newValue: draft.newActionability,
    prevValue: draft.prevActionability,
  };
  const inverse = {
    contextUnitId: draft.contextUnitId,
    field: 'actionability',
    restoreValue: draft.prevActionability,
  };

  writeAudit({
    action: 'correction_applied',
    reason: `wrong_actionability: ${draft.prevActionability} → ${draft.newActionability}`,
    cardId: card.id,
    payload: forward,
  });

  return writeJournalEntry({
    feedbackId: card.id,
    correctionType: 'wrong_actionability',
    targetKind: 'context_unit',
    targetId: draft.contextUnitId,
    forwardPatch: forward,
    inversePatch: inverse,
    inverseLossy: false,
  });
}

function applyWrongKind(
  draft: Extract<CorrectionDraft, { type: 'wrong_kind' }>,
  card: CardRow
): CorrectionJournalRow {
  const now = new Date().toISOString();
  db.prepare(`UPDATE context_units SET kind = ?, updated_at = ? WHERE id = ?`).run(
    draft.newKind,
    now,
    draft.contextUnitId
  );

  const forward = {
    contextUnitId: draft.contextUnitId,
    field: 'kind',
    newValue: draft.newKind,
    prevValue: draft.prevKind,
  };
  const inverse = {
    contextUnitId: draft.contextUnitId,
    field: 'kind',
    restoreValue: draft.prevKind,
  };
  writeAudit({
    action: 'correction_applied',
    reason: `wrong_kind: ${draft.prevKind} → ${draft.newKind}`,
    cardId: card.id,
    payload: forward,
  });
  return writeJournalEntry({
    feedbackId: card.id,
    correctionType: 'wrong_kind',
    targetKind: 'context_unit',
    targetId: draft.contextUnitId,
    forwardPatch: forward,
    inversePatch: inverse,
    inverseLossy: false,
  });
}

function applyWrongEntity(
  draft: Extract<CorrectionDraft, { type: 'wrong_entity' }>,
  card: CardRow
): CorrectionJournalRow {
  const { mergedAt } = mergeEntities(draft.fromEntityId, draft.toEntityId);
  // 立即评估 lossy（撤销时还会再算一次，但首次写入 journal 里记一个 baseline）
  const lossy = isMergeLossy(draft.toEntityId, mergedAt);

  const forward = {
    fromEntityId: draft.fromEntityId,
    toEntityId: draft.toEntityId,
    fromName: draft.fromName,
    toName: draft.toName,
    mergedAt,
  };
  const inverse = {
    fromEntityId: draft.fromEntityId,
    toEntityId: draft.toEntityId,
    mergedAt,
    // lossy=true 时不可无损撤销
  };

  writeAudit({
    action: 'correction_applied',
    reason: `wrong_entity: 合并 "${draft.fromName}" → "${draft.toName}"${lossy ? '（lossy）' : ''}`,
    cardId: card.id,
    payload: forward,
  });

  return writeJournalEntry({
    feedbackId: card.id,
    correctionType: 'wrong_entity',
    targetKind: 'entity_alias',
    targetId: draft.fromEntityId,
    forwardPatch: forward,
    inversePatch: inverse,
    inverseLossy: lossy,
  });
}

// --------------------------------------------------------------------------
// preview
// --------------------------------------------------------------------------

function buildPreview(draft: CorrectionDraft, card: CardRow): Record<string, unknown> {
  switch (draft.type) {
    case 'wrong_priority':
      return {
        type: draft.type,
        tier: draft.tier,
        cardTitle: card.title,
        from: draft.prevPriority,
        to: draft.newPriority,
        willLearnRule: draft.learnRule,
        ruleSummary: draft.learnRule
          ? `${card.source} 来源、priority≤${draft.newPriority} → record（合并到 daily digest）`
          : null,
      };
    case 'wrong_meaning':
      return {
        type: draft.type,
        tier: draft.tier,
        cardTitle: card.title,
        prevMeaning: draft.prevMeaning,
        newMeaning: draft.newMeaning,
        kindChanged: draft.kindChanged,
        warning: draft.kindChanged ? '可能影响 trigger 行为' : undefined,
      };
    case 'wrong_actionability':
      return {
        type: draft.type,
        tier: draft.tier,
        cardTitle: card.title,
        from: draft.prevActionability,
        to: draft.newActionability,
        warning: '会影响 trigger 行为',
      };
    case 'wrong_kind':
      return {
        type: draft.type,
        tier: draft.tier,
        cardTitle: card.title,
        from: draft.prevKind,
        to: draft.newKind,
        warning: '会影响 trigger 行为',
      };
    case 'wrong_entity': {
      // 估算影响面：有多少 unit / Space link 引用了 from/to 任一
      const cnt = db
        .prepare(
          `SELECT COUNT(*) AS n FROM context_unit_entities WHERE entity_id IN (?, ?)`
        )
        .get(draft.fromEntityId, draft.toEntityId) as { n: number };
      return {
        type: draft.type,
        tier: draft.tier,
        from: draft.fromName,
        to: draft.toName,
        affectedUnitRefs: cnt.n,
        warning:
          '有新数据写入后不可无损撤销（lossy 由 journal 标记）',
      };
    }
  }
}

// Re-export for routes convenience
export { interpretFn as interpret };
