/**
 * MVP10 §6.3 interpret 用户在 source 卡片上的 inline 纠错 click 成结构化 CorrectionDraft。
 *
 * 重点：interpreter 只负责"识别"+"分类"，不写库 —— writer 才负责 apply。
 * tier 决定 UX：low 直接写；medium / high 需要二次确认 (confirm=true)。
 */

import {
  type ActionProposalRow,
  type CardRow,
  getActionProposal,
  getCard,
  getContextEntityById,
  getContextUnit,
} from '../db.js';

export type CorrectionType =
  | 'wrong_priority'
  | 'wrong_meaning'
  | 'wrong_actionability'
  | 'wrong_entity'
  | 'wrong_kind';

export type Tier = 'low' | 'medium' | 'high';

export type CorrectionDraft =
  | {
      type: 'wrong_priority';
      tier: Tier;
      cardId: string;
      contextUnitId: string | null;
      newPriority: 'P0' | 'P1' | 'P2' | 'P3';
      learnRule: boolean;
      prevPriority: string;
    }
  | {
      type: 'wrong_meaning';
      tier: Tier;
      cardId: string;
      contextUnitId: string;
      newMeaning: string;
      prevMeaning: string | null;
      kindChanged: boolean;
    }
  | {
      type: 'wrong_actionability';
      tier: Tier;
      cardId: string;
      contextUnitId: string;
      newActionability: 'none' | 'record' | 'notify' | 'ask' | 'act';
      prevActionability: string;
    }
  | {
      type: 'wrong_entity';
      tier: Tier;
      cardId: string;
      fromEntityId: string;
      toEntityId: string;
      fromName: string;
      toName: string;
    }
  | {
      type: 'wrong_kind';
      tier: Tier;
      cardId: string;
      contextUnitId: string;
      newKind: string;
      prevKind: string;
    };

export function findCardContextUnitId(card: CardRow): string | null {
  // triage 卡：raw_event_id → event ContextUnit
  if (card.source_kind === 'triage' && card.raw_event_id) {
    // 不强引入 contextStore，直接 SQL 查
    return findEventContextUnitIdSql(card.raw_event_id);
  }
  // agent_run 卡：source_ref_id → action_proposal.payload_json.contextUnitId
  if (card.source_kind === 'agent_run' && card.source_ref_id) {
    const prop = getActionProposal(card.source_ref_id);
    if (!prop) return null;
    try {
      const payload = JSON.parse(prop.payload_json ?? '{}') as { contextUnitId?: string };
      return payload.contextUnitId ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

import { db } from '../db.js';
function findEventContextUnitIdSql(eventId: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM context_units
       WHERE origin_kind='event' AND origin_ref_id=? AND status='active'
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(eventId) as { id: string } | undefined;
  return row?.id ?? null;
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
const ACTIONABILITIES = ['none', 'record', 'notify', 'ask', 'act'] as const;

export function interpret(
  card: CardRow,
  type: CorrectionType,
  payload: Record<string, unknown>
): CorrectionDraft {
  const contextUnitId = findCardContextUnitId(card);

  switch (type) {
    case 'wrong_priority': {
      const newPriority = String(payload.newPriority ?? '') as (typeof PRIORITIES)[number];
      if (!PRIORITIES.includes(newPriority)) {
        throw new Error(`wrong_priority: invalid newPriority ${payload.newPriority}`);
      }
      const learnRule = payload.learnRule === true;
      return {
        type: 'wrong_priority',
        tier: learnRule ? 'medium' : 'low',
        cardId: card.id,
        contextUnitId,
        newPriority,
        learnRule,
        prevPriority: card.priority,
      };
    }

    case 'wrong_meaning': {
      if (!contextUnitId) {
        throw new Error('wrong_meaning: card has no linked ContextUnit');
      }
      const unitRow = getContextUnit(contextUnitId);
      if (!unitRow) throw new Error(`wrong_meaning: ContextUnit ${contextUnitId} not found`);
      const newMeaning = String(payload.newMeaning ?? '');
      if (!newMeaning.trim()) throw new Error('wrong_meaning: newMeaning empty');
      const kindChanged = payload.kindChanged === true;
      return {
        type: 'wrong_meaning',
        tier: kindChanged ? 'high' : 'low',
        cardId: card.id,
        contextUnitId,
        newMeaning,
        prevMeaning: unitRow.meaning,
        kindChanged,
      };
    }

    case 'wrong_actionability': {
      if (!contextUnitId) throw new Error('wrong_actionability: no ContextUnit');
      const unitRow = getContextUnit(contextUnitId);
      if (!unitRow) throw new Error('wrong_actionability: ContextUnit not found');
      const newAct = String(payload.newActionability ?? '') as (typeof ACTIONABILITIES)[number];
      if (!ACTIONABILITIES.includes(newAct)) {
        throw new Error(`wrong_actionability: invalid value ${payload.newActionability}`);
      }
      return {
        type: 'wrong_actionability',
        tier: 'high',
        cardId: card.id,
        contextUnitId,
        newActionability: newAct,
        prevActionability: unitRow.actionability,
      };
    }

    case 'wrong_entity': {
      const fromId = String(payload.fromEntityId ?? '');
      const toId = String(payload.toEntityId ?? '');
      if (!fromId || !toId) throw new Error('wrong_entity: from/to required');
      if (fromId === toId) throw new Error('wrong_entity: from == to');
      const from = getContextEntityById(fromId);
      const to = getContextEntityById(toId);
      if (!from) throw new Error(`wrong_entity: fromEntity ${fromId} not found`);
      if (!to) throw new Error(`wrong_entity: toEntity ${toId} not found`);
      return {
        type: 'wrong_entity',
        tier: 'high',
        cardId: card.id,
        fromEntityId: fromId,
        toEntityId: toId,
        fromName: from.name,
        toName: to.name,
      };
    }

    case 'wrong_kind': {
      if (!contextUnitId) throw new Error('wrong_kind: no ContextUnit');
      const unitRow = getContextUnit(contextUnitId);
      if (!unitRow) throw new Error('wrong_kind: ContextUnit not found');
      const newKind = String(payload.newKind ?? '');
      if (!newKind) throw new Error('wrong_kind: newKind required');
      return {
        type: 'wrong_kind',
        tier: 'high',
        cardId: card.id,
        contextUnitId,
        newKind,
        prevKind: unitRow.kind,
      };
    }

    default:
      throw new Error(`unsupported correction type: ${type}`);
  }
}

export function loadCardOrThrow(cardId: string): CardRow {
  const card = getCard(cardId);
  if (!card) throw new Error(`card not found: ${cardId}`);
  return card;
}
