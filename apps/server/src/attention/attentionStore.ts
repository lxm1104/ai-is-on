// MVP14 Attention Engine — store 层。
// 薄包装 apps/server/src/db.ts 的 attention_items / attention_engine_runs helper，
// 负责 row ↔ domain 类型转换（JSON 字段反序列化）。
// 不放任何业务逻辑（写哪些、何时写由 attentionEngine 决定）。

import {
  AttentionItemRow,
  AttentionEngineRunRow,
  insertAttentionItem as dbInsertAttentionItem,
  getAttentionItem as dbGetAttentionItem,
  listLiveAttentionItems as dbListLiveAttentionItems,
  updateAttentionItemStatus as dbUpdateAttentionItemStatus,
  markAttentionItemsSupersededByHash as dbMarkSupersededByHash,
  markAttentionItemsExpired as dbMarkExpired,
  insertAttentionEngineRun as dbInsertEngineRun,
  updateAttentionEngineRun as dbUpdateEngineRun,
  findRecentAttentionRunByInputHash as dbFindRecentRunByInputHash,
  getLastAttentionEngineRun as dbGetLastEngineRun,
  nextAttentionGeneration as dbNextGeneration,
} from '../db.js';
import type {
  AttentionItem,
  AttentionPriority,
  AttentionStatus,
  AttentionLLMItem,
  AttentionRunStatus,
  AttentionRunTrigger,
  AttentionInputSummary,
} from './attentionTypes.js';

// ---------- 反序列化辅助 ----------

function parseJsonArray(s: string | null | undefined, field: string): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
    return [];
  } catch {
    console.warn(`[attentionStore] failed to parse JSON array for ${field}: ${s}`);
    return [];
  }
}

function coercePriority(s: string): AttentionPriority {
  return s === 'P0' || s === 'P1' || s === 'P2' || s === 'P3' ? s : 'P2';
}

function coerceStatus(s: string): AttentionStatus {
  switch (s) {
    case 'live':
    case 'acted':
    case 'dismissed':
    case 'superseded':
    case 'expired':
      return s;
    default:
      return 'live';
  }
}

export function rowToAttentionItem(row: AttentionItemRow): AttentionItem {
  return {
    id: row.id,
    generation: row.generation,
    llmRunId: row.llm_run_id,
    inputHash: row.input_hash,
    priority: coercePriority(row.priority),
    title: row.title,
    why: row.why,
    suggestedAction: row.suggested_action,
    signalIds: parseJsonArray(row.signal_ids_json, 'signal_ids_json'),
    relatedEntityIds: parseJsonArray(row.related_entity_ids_json, 'related_entity_ids_json'),
    relatedSpaceIds: parseJsonArray(row.related_space_ids_json, 'related_space_ids_json'),
    recommendedAgent: row.recommended_agent,
    status: coerceStatus(row.status),
    expiresAt: row.expires_at,
    sourceKind: row.source_kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- AttentionItem 写入 ----------

export type InsertAttentionItemInput = {
  id: string;
  generation: number;
  llmRunId: string | null;
  inputHash: string;
  llmItem: AttentionLLMItem;
  now: string;
};

/**
 * 把一个 LLM 输出的 AttentionLLMItem 落库。
 * raw_json 字段保存完整 LLM item 留底审计。
 */
export function insertAttentionItem(input: InsertAttentionItemInput): AttentionItem {
  const { id, generation, llmRunId, inputHash, llmItem, now } = input;
  const row: AttentionItemRow = {
    id,
    generation,
    llm_run_id: llmRunId,
    input_hash: inputHash,
    priority: llmItem.priority,
    title: llmItem.title,
    why: llmItem.why,
    suggested_action: llmItem.suggestedAction ?? null,
    signal_ids_json: JSON.stringify(llmItem.signalIds ?? []),
    related_entity_ids_json: JSON.stringify(llmItem.relatedEntityIds ?? []),
    related_space_ids_json: JSON.stringify(llmItem.relatedSpaceIds ?? []),
    recommended_agent: llmItem.recommendedAgent ?? null,
    status: 'live',
    expires_at: llmItem.expiresAt ?? null,
    source_kind: 'attention',
    raw_json: JSON.stringify(llmItem),
    created_at: now,
    updated_at: now,
  };
  dbInsertAttentionItem(row);
  return rowToAttentionItem(row);
}

// ---------- AttentionItem 读取 ----------

export function getAttentionItem(id: string): AttentionItem | null {
  const row = dbGetAttentionItem(id);
  return row ? rowToAttentionItem(row) : null;
}

export function listLiveAttentionItems(limit = 100): AttentionItem[] {
  return dbListLiveAttentionItems(limit).map(rowToAttentionItem);
}

export function updateAttentionItemStatus(
  id: string,
  status: AttentionStatus,
  now: string
): AttentionItem | null {
  const row = dbUpdateAttentionItemStatus(id, status, now);
  return row ? rowToAttentionItem(row) : null;
}

/**
 * 在 attentionEngine 每次成功 run 后、插入新 items 前调用。
 * 把同 input_hash 的旧 live 项标 superseded，避免重复推理产生双倍出货。
 * 返回标 superseded 的条数。
 */
export function markAttentionItemsSupersededByHash(
  inputHash: string,
  now: string
): number {
  return dbMarkSupersededByHash(inputHash, now);
}

/**
 * TTL 兜底：把 created_at 早于 beforeIso 的 live 项标 'expired'。
 * 每次 tick 开始前调用。
 */
export function markAttentionItemsExpired(beforeIso: string, now: string): number {
  return dbMarkExpired(beforeIso, now);
}

// ---------- AttentionEngineRun 写入与查询 ----------

export type StartEngineRunInput = {
  id: string;
  generation: number;
  trigger: AttentionRunTrigger;
  inputHash: string;
  inputSummary: AttentionInputSummary;
  promptVersion: string;
  startedAt: string;
};

export function startEngineRun(input: StartEngineRunInput): void {
  const row: AttentionEngineRunRow = {
    id: input.id,
    generation: input.generation,
    trigger: input.trigger,
    input_hash: input.inputHash,
    input_summary_json: JSON.stringify(input.inputSummary),
    prompt_version: input.promptVersion,
    model_id: null,
    status: 'ok', // 占位，必须由 finishEngineRun 覆盖
    output_text: null,
    error: null,
    items_emitted: 0,
    started_at: input.startedAt,
    completed_at: null,
  };
  dbInsertEngineRun(row);
}

export type FinishEngineRunInput = {
  id: string;
  status: AttentionRunStatus;
  itemsEmitted?: number;
  outputText?: string | null;
  modelId?: string | null;
  error?: string | null;
  completedAt: string;
};

export function finishEngineRun(input: FinishEngineRunInput): void {
  dbUpdateEngineRun(input.id, {
    status: input.status,
    items_emitted: input.itemsEmitted ?? 0,
    output_text: input.outputText ?? null,
    model_id: input.modelId ?? null,
    error: input.error ?? null,
    completed_at: input.completedAt,
  });
}

/**
 * 直接写一条完成态 run（cache_hit / skipped_no_change 用），避免两次 round-trip。
 */
export function writeTerminalEngineRun(input: {
  id: string;
  generation: number;
  trigger: AttentionRunTrigger;
  inputHash: string;
  inputSummary: AttentionInputSummary;
  promptVersion: string;
  status: AttentionRunStatus;
  itemsEmitted?: number;
  outputText?: string | null;
  modelId?: string | null;
  error?: string | null;
  startedAt: string;
  completedAt: string;
}): void {
  const row: AttentionEngineRunRow = {
    id: input.id,
    generation: input.generation,
    trigger: input.trigger,
    input_hash: input.inputHash,
    input_summary_json: JSON.stringify(input.inputSummary),
    prompt_version: input.promptVersion,
    model_id: input.modelId ?? null,
    status: input.status,
    output_text: input.outputText ?? null,
    error: input.error ?? null,
    items_emitted: input.itemsEmitted ?? 0,
    started_at: input.startedAt,
    completed_at: input.completedAt,
  };
  dbInsertEngineRun(row);
}

export function findRecentSuccessfulRunByInputHash(
  inputHash: string,
  ttlMinutes: number
): AttentionEngineRunRow | null {
  return dbFindRecentRunByInputHash(inputHash, ttlMinutes);
}

export function getLastEngineRun(): AttentionEngineRunRow | null {
  return dbGetLastEngineRun();
}

export function nextGeneration(): number {
  return dbNextGeneration();
}
