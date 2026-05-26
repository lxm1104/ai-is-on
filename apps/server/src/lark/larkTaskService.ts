import { randomUUID, createHash } from 'node:crypto';
import {
  getCard,
  getExternalTaskBindingByIdempotency,
  updateCardStatus,
  upsertExternalTaskBinding,
} from '../db.js';
import { writeAudit } from '../boundary/auditLog.js';
import {
  getContextUnitById,
  linkContextUnits,
  upsertContextUnit,
} from '../context/contextStore.js';
import type { ContextEntityRef, ContextUnit } from '../context/ContextUnit.js';
import { runLarkCliJson } from '../util/larkCli.js';
import { getMyOpenId } from '../util/identity.js';
import { getAttentionItem, updateAttentionItemStatus } from '../attention/attentionStore.js';
import { projectAttentionItemToCard } from '../attention/attentionProjection.js';
import { recordAttentionInteraction } from '../attention/attentionInteractions.js';
import { rowToCard } from '../cards/cardsService.js';
import { broadcast } from '../ws.js';
import type { SignalCard } from '../claude/protocol.js';

export type CreateLarkTaskInput = {
  cardId: string;
  summary?: string;
  description?: string;
  dueAt?: string;
  tasklistId?: string;
  confirm: boolean;
};

export type CreateLarkTaskResult = {
  task: {
    guid: string;
    url?: string;
    summary: string;
  };
  commitmentUnitId: string;
  resultUnitId: string;
  bindingId: string;
  card?: SignalCard;
  reused: boolean;
};

type CardSource = {
  sourceKind: 'attention' | 'card';
  sourceRefId: string;
  title: string;
  summary: string;
  reason?: string;
  suggestedAction?: string;
  sourceUrl?: string;
  signalIds: string[];
  relatedEntityIds: string[];
  card: SignalCard;
};

type LarkTaskCliResponse = Record<string, unknown>;
type LarkTaskDeps = {
  getOpenId?: () => Promise<string>;
  runLarkCliJson?: (args: string[]) => Promise<LarkTaskCliResponse>;
};

export async function createLarkTaskFromCard(
  input: CreateLarkTaskInput,
  deps: LarkTaskDeps = {}
): Promise<CreateLarkTaskResult> {
  if (!input.confirm) {
    throw new Error('confirm is required before creating a Lark task');
  }
  const source = resolveCardSource(input.cardId);
  const summary = sanitizeSummary(input.summary ?? source.title);
  if (!summary) throw new Error('task summary is required');
  const description = buildDescription(source, input.description);
  const idempotencyKey = buildIdempotencyKey(source, summary);

  const existing = getExternalTaskBindingByIdempotency('lark', idempotencyKey);
  if (existing && existing.commitment_unit_id && existing.result_unit_id) {
    const card = markSourceActed(source);
    return {
      task: {
        guid: existing.external_guid,
        url: existing.external_url ?? undefined,
        summary,
      },
      commitmentUnitId: existing.commitment_unit_id,
      resultUnitId: existing.result_unit_id,
      bindingId: existing.id,
      card,
      reused: true,
    };
  }

  let raw: LarkTaskCliResponse;
  try {
    raw = await callLarkTaskCreate({
      summary,
      description,
      dueAt: normalizeDueAt(input.dueAt),
      tasklistId: cleanOptional(input.tasklistId),
      idempotencyKey,
    }, deps);
  } catch (err) {
    writeAudit({
      action: 'lark_task_failed',
      reason: `创建飞书任务失败：${summary}`,
      cardId: source.sourceRefId,
      payload: { sourceKind: source.sourceKind, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }

  const identity = extractTaskIdentity(raw);
  const taskEntityName = `lark_task:${identity.guid}`;
  const taskEntities: ContextEntityRef[] = [
    {
      type: 'task',
      name: taskEntityName,
      aliases: identity.url ? [identity.url] : undefined,
      role: 'target',
      confidence: 1.0,
    },
  ];

  const commitment = upsertContextUnit({
    kind: 'commitment',
    title: summary,
    content: `飞书任务：${summary}${identity.url ? `\n链接：${identity.url}` : ''}`,
    entities: taskEntities,
    scope: 'work',
    origin: { kind: 'card_action', refId: source.sourceRefId },
    time: input.dueAt ? { dueAt: normalizeDueAt(input.dueAt) } : undefined,
    actionability: 'act',
    confidence: 0.9,
    mergeHint: `lark_task:${identity.guid}`,
  }).unit;

  const result = upsertContextUnit({
    kind: 'action_result',
    title: '已创建飞书任务',
    content: [
      `已在飞书创建任务：${summary}`,
      identity.url ? `链接：${identity.url}` : '',
      `来源：${source.title}`,
    ].filter(Boolean).join('\n'),
    entities: taskEntities,
    scope: 'work',
    origin: { kind: 'card_action', refId: source.sourceRefId },
    actionability: 'record',
    confidence: 0.95,
    mergeHint: `lark_task_result:${identity.guid}`,
  }).unit;

  linkIfPresent(result, commitment, 'about');

  const now = new Date().toISOString();
  const bindingId = randomUUID();
  upsertExternalTaskBinding({
    id: bindingId,
    provider: 'lark',
    external_guid: identity.guid,
    external_url: identity.url ?? null,
    source_kind: source.sourceKind,
    source_ref_id: source.sourceRefId,
    commitment_unit_id: commitment.id,
    result_unit_id: result.id,
    status: 'created',
    idempotency_key: idempotencyKey,
    raw_json: JSON.stringify(raw),
    created_at: now,
    updated_at: now,
  });

  writeAudit({
    action: 'lark_task_created',
    reason: `已创建飞书任务：${summary}`,
    cardId: source.sourceRefId,
    payload: {
      sourceKind: source.sourceKind,
      taskGuid: identity.guid,
      taskUrl: identity.url,
      commitmentUnitId: commitment.id,
      resultUnitId: result.id,
    },
  });

  const card = markSourceActed(source);
  return {
    task: { guid: identity.guid, url: identity.url, summary },
    commitmentUnitId: commitment.id,
    resultUnitId: result.id,
    bindingId,
    card,
    reused: false,
  };
}

function resolveCardSource(cardId: string): CardSource {
  const attn = getAttentionItem(cardId);
  if (attn) {
    const card = projectAttentionItemToCard(attn);
    return {
      sourceKind: 'attention',
      sourceRefId: attn.id,
      title: attn.title,
      summary: attn.why,
      suggestedAction: attn.suggestedAction ?? undefined,
      signalIds: attn.signalIds,
      relatedEntityIds: attn.relatedEntityIds,
      card,
    };
  }

  const row = getCard(cardId);
  if (!row) throw new Error('card not found');
  const card = rowToCard(row);
  return {
    sourceKind: 'card',
    sourceRefId: row.id,
    title: row.title,
    summary: row.summary,
    reason: row.reason,
    suggestedAction: row.suggested_action ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    signalIds: row.raw_event_id ? [row.raw_event_id] : [],
    relatedEntityIds: [],
    card,
  };
}

async function callLarkTaskCreate(input: {
  summary: string;
  description: string;
  dueAt?: string;
  tasklistId?: string;
  idempotencyKey: string;
}, deps: LarkTaskDeps): Promise<LarkTaskCliResponse> {
  const assignee = await (deps.getOpenId ?? getMyOpenId)();
  const args = [
    'task',
    '+create',
    '--summary',
    input.summary,
    '--description',
    input.description,
    '--assignee',
    assignee,
    '--idempotency-key',
    input.idempotencyKey,
    '--format',
    'json',
  ];
  if (input.dueAt) args.push('--due', input.dueAt);
  if (input.tasklistId) args.push('--tasklist-id', input.tasklistId);
  const runJson = deps.runLarkCliJson ?? runLarkCliJson<LarkTaskCliResponse>;
  return runJson(args);
}

function extractTaskIdentity(raw: LarkTaskCliResponse): { guid: string; url?: string } {
  const guid =
    findStringByKey(raw, ['guid', 'task_guid', 'taskGuid']) ??
    findStringByKey(raw, ['id', 'task_id', 'taskId']);
  if (!guid) throw new Error('lark task create response missing guid');
  const url = findStringByKey(raw, ['url', 'app_link', 'appLink', 'task_url', 'taskUrl']);
  return { guid, url };
}

function findStringByKey(raw: unknown, keys: string[], depth = 0): string | undefined {
  if (!raw || typeof raw !== 'object' || depth > 5) return undefined;
  const obj = raw as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = findStringByKey(item, keys, depth + 1);
        if (found) return found;
      }
    } else if (v && typeof v === 'object') {
      const found = findStringByKey(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function buildDescription(source: CardSource, override?: string): string {
  const lines = [
    cleanOptional(override),
    `来源：AI is ON ${source.sourceKind}`,
    `标题：${source.title}`,
    source.summary ? `摘要：${source.summary}` : '',
    source.reason ? `原因：${source.reason}` : '',
    source.suggestedAction ? `建议：${source.suggestedAction}` : '',
    source.sourceUrl ? `原文：${source.sourceUrl}` : '',
    source.signalIds.length ? `相关 context：${source.signalIds.slice(0, 6).join(', ')}` : '',
  ].filter(Boolean);
  return lines.join('\n').slice(0, 4000);
}

function sanitizeSummary(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function cleanOptional(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}

function normalizeDueAt(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  const v = input.trim();
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toISOString();
}

function buildIdempotencyKey(source: CardSource, summary: string): string {
  const raw = `${source.sourceKind}:${source.sourceRefId}:${summary}`;
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 24);
  return `ai-is-on:${hash}`;
}

function linkIfPresent(from: ContextUnit, to: ContextUnit, linkType: 'about'): void {
  if (!getContextUnitById(from.id) || !getContextUnitById(to.id)) return;
  linkContextUnits(from.id, to.id, linkType, 0.9);
}

function markSourceActed(source: CardSource): SignalCard | undefined {
  const now = new Date().toISOString();
  if (source.sourceKind === 'attention') {
    const attn = getAttentionItem(source.sourceRefId);
    if (!attn) return undefined;
    recordAttentionInteraction(attn, 'create_task', now);
    const updated = updateAttentionItemStatus(attn.id, 'acted', now);
    if (!updated) return undefined;
    const card = projectAttentionItemToCard(updated);
    broadcast({ type: 'card_updated', card });
    return card;
  }

  const row = updateCardStatus(source.sourceRefId, 'done', now);
  if (!row) return undefined;
  const card = rowToCard(row);
  broadcast({ type: 'card_updated', card });
  return card;
}
