import { randomUUID } from 'node:crypto';
import {
  type AttentionInteractionRow,
  insertAttentionInteraction,
  listRecentAttentionInteractions as dbListRecentAttentionInteractions,
} from '../db.js';
import type { AttentionItem, AttentionPriority } from './attentionTypes.js';

export type AttentionInteractionAction =
  | 'ack'
  | 'dismiss'
  | 'not_relevant'
  | 'ask_agent'
  | 'create_task'
  | 'send_reply'     // MVP34：用户确认后由 AI 代发飞书 IM 回复（首个对外执行动作）
  | 'matter_resolve' // MVP31：办结提案确认
  | 'mark_done'      // MVP32：用户标记已处理（matter 同步 resolved）
  | 'matter_reopen'; // MVP32：重开事项（核实存疑确认 / 撤销已处理）

export type AttentionInteraction = {
  id: string;
  attentionId: string;
  action: AttentionInteractionAction;
  inputHash: string;
  priority: AttentionPriority;
  title: string;
  signalIds: string[];
  relatedEntityIds: string[];
  relatedSpaceIds: string[];
  createdAt: string;
};

function parseJsonArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function coerceAction(action: string): AttentionInteractionAction {
  switch (action) {
    case 'ack':
    case 'dismiss':
    case 'not_relevant':
    case 'ask_agent':
    case 'create_task':
    case 'send_reply':
    case 'matter_resolve':
    case 'mark_done':
    case 'matter_reopen':
      return action;
    default:
      return 'ack';
  }
}

function coercePriority(priority: string): AttentionPriority {
  return priority === 'P0' || priority === 'P1' || priority === 'P2' || priority === 'P3'
    ? priority
    : 'P2';
}

function rowToInteraction(row: AttentionInteractionRow): AttentionInteraction {
  return {
    id: row.id,
    attentionId: row.attention_id,
    action: coerceAction(row.action),
    inputHash: row.input_hash,
    priority: coercePriority(row.priority),
    title: row.title,
    signalIds: parseJsonArray(row.signal_ids_json),
    relatedEntityIds: parseJsonArray(row.related_entity_ids_json),
    relatedSpaceIds: parseJsonArray(row.related_space_ids_json),
    createdAt: row.created_at,
  };
}

export function recordAttentionInteraction(
  item: AttentionItem,
  action: AttentionInteractionAction,
  now = new Date().toISOString()
): AttentionInteraction {
  const row: AttentionInteractionRow = {
    id: randomUUID(),
    attention_id: item.id,
    action,
    input_hash: item.inputHash,
    priority: item.priority,
    title: item.title,
    signal_ids_json: JSON.stringify(item.signalIds),
    related_entity_ids_json: JSON.stringify(item.relatedEntityIds),
    related_space_ids_json: JSON.stringify(item.relatedSpaceIds),
    created_at: now,
  };
  insertAttentionInteraction(row);
  return rowToInteraction(row);
}

export function listRecentAttentionInteractions(opts: {
  sinceIso: string;
  limit: number;
}): AttentionInteraction[] {
  return dbListRecentAttentionInteractions(opts).map(rowToInteraction);
}
