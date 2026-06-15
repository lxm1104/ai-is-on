/**
 * MVP34 — 执行腿第一个「对外发送」动作：AI 代发飞书 IM 回复。
 *
 * 设计原则（对外、不可逆，故极保守）：
 *  1. confirm 必填 —— 没有用户显式一键确认绝不发送。
 *  2. 目标会话/消息**服务端从卡片自身数据确定性解析**，不信前端传来的 chatId/messageId
 *     （防篡改、防误发）；解析出多于一个会话 → 直接拒绝，绝不猜。
 *  3. 回复正文（text）允许前端传（用户可能编辑过草稿），但必须非空、限长。
 *  4. lark-cli --idempotency-key 兜底 Feishu 端去重（防重复发送），本地发完即把卡片置 acted。
 *  5. 发送后写一条 silent action_result + 挂到 Matter 作证据；真实"我发出的消息"由 im collector
 *     自然采回，交给 reducer 推进事项状态（避免在这里就替用户判定办结）。
 *
 * previewImReply 仅解析目标、不发送 —— 供前端在用户点「发送」前展示"回复给谁/回应哪条原话"，
 * 让任何解析错误在不可逆动作发生前就暴露给用户。
 */
import { createHash } from 'node:crypto';
import {
  getCard,
  getEventById,
  matchMatterId,
  updateCardStatus,
} from '../db.js';
import { writeAudit } from '../boundary/auditLog.js';
import { getContextUnitById, upsertContextUnit } from '../context/contextStore.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';
import { runLarkCli } from '../util/larkCli.js';
import {
  getAttentionItem,
  updateAttentionItemStatus,
} from '../attention/attentionStore.js';
import { projectAttentionItemToCard } from '../attention/attentionProjection.js';
import { recordAttentionInteraction } from '../attention/attentionInteractions.js';
import { rowToCard } from '../cards/cardsService.js';
import { attachMatterContextLink, getMatterById } from '../matter/matterStore.js';
import { enqueueAttentionTickSoon } from '../attention/attentionEngine.js';
import { broadcast } from '../ws.js';
import type { SignalCard } from '../claude/protocol.js';

const MAX_TEXT_LEN = 4000;

export type ImReplyTarget = {
  chatId: string;
  chatName?: string;
  /** 锚定回复的对方具体消息（om_）；无则走 send-to-chat。 */
  messageId?: string;
  replyToActor?: string;
  replyToText?: string;
};

type ImReplySource = {
  sourceKind: 'attention' | 'card';
  sourceRefId: string;
  title: string;
  matterId?: string;
  signalIds: string[];
  rawEventId?: string;
  draftReply?: string;
  suggestedAction?: string;
  card: SignalCard;
};

export type ImReplyDeps = {
  runLarkCli?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
};

export type SendImReplyInput = {
  cardId: string;
  text?: string;
  confirm: boolean;
  /** dry-run：让真实 lark-cli 走一遍鉴权+目标校验+命令受理（--dry-run，不真正发送），
   *  用于生产验证执行路径而不产生不可逆的对外消息。dry-run 不写回/不标记/不审计为已发。 */
  dryRun?: boolean;
};

export type SendImReplyResult = {
  ok: true;
  target: ImReplyTarget;
  sentMessageId?: string;
  resultUnitId: string;
  card?: SignalCard;
  dryRun?: boolean;
};

// ---- 卡片来源解析（attention / 老 cards 表）----

function resolveSource(cardId: string): ImReplySource {
  const attn = getAttentionItem(cardId);
  if (attn) {
    return {
      sourceKind: 'attention',
      sourceRefId: attn.id,
      title: attn.title,
      matterId: attn.matterId ?? undefined,
      signalIds: attn.signalIds,
      draftReply: undefined,
      suggestedAction: attn.suggestedAction ?? undefined,
      card: projectAttentionItemToCard(attn),
    };
  }
  const row = getCard(cardId);
  if (!row) throw new Error('card not found');
  return {
    sourceKind: 'card',
    sourceRefId: row.id,
    title: row.title,
    signalIds: [],
    rawEventId: row.raw_event_id ?? undefined,
    draftReply: row.draft_reply ?? undefined,
    suggestedAction: row.suggested_action ?? undefined,
    card: rowToCard(row),
  };
}

// ---- 目标会话/消息的确定性解析 ----

type ImMsg = {
  eventId: string;
  chatId: string;
  chatName?: string;
  messageId?: string;
  isMe: boolean;
  actor?: string;
  text?: string;
  occurredAt: string;
};

function collectCandidateEventIds(source: ImReplySource): string[] {
  const ids = new Set<string>();
  if (source.rawEventId) ids.add(source.rawEventId);
  for (const sid of source.signalIds) {
    const unit = getContextUnitById(sid);
    if (unit?.origin?.kind === 'event' && unit.origin.refId) {
      ids.add(unit.origin.refId);
    } else {
      // signalId 本身可能就是 event id（attentionEngine 允许引用 event）
      ids.add(sid);
    }
  }
  return [...ids];
}

function parseImEvent(eventId: string): ImMsg | null {
  const row = getEventById(eventId);
  if (!row || row.source !== 'im') return null;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(row.raw_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const msg = (raw.msg ?? {}) as Record<string, unknown>;
  const chat = (raw.chat ?? {}) as Record<string, unknown>;
  const chatId =
    (typeof msg.chat_id === 'string' && msg.chat_id) ||
    (typeof chat.chat_id === 'string' && chat.chat_id) ||
    '';
  if (!chatId) return null;
  const messageId =
    typeof msg.message_id === 'string' && msg.message_id.startsWith('om_')
      ? msg.message_id
      : row.source_id.startsWith('om_')
        ? row.source_id
        : undefined;
  return {
    eventId,
    chatId,
    chatName: typeof chat.name === 'string' ? chat.name : undefined,
    messageId,
    isMe: msg.is_me === true,
    actor: row.actor ?? undefined,
    text: row.text || undefined,
    occurredAt: row.occurred_at,
  };
}

/** 确定性解析回复目标；歧义（多会话）或无可回复消息一律抛错，绝不猜。 */
export function resolveImReplyTarget(source: ImReplySource): ImReplyTarget {
  const msgs = collectCandidateEventIds(source)
    .map(parseImEvent)
    .filter((m): m is ImMsg => m !== null);
  if (msgs.length === 0) {
    throw new Error('无法定位飞书会话目标：该卡片不含可回复的 IM 消息');
  }
  const chats = [...new Set(msgs.map((m) => m.chatId))];
  if (chats.length > 1) {
    throw new Error('目标会话不唯一，拒绝自动发送（请在飞书内手动处理）');
  }
  const chatId = chats[0];
  const chatName = msgs.find((m) => m.chatName)?.chatName;
  // 优先回复对方最近一条消息（非本人发的）；都没有则只指定会话
  const sorted = [...msgs].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const anchor = sorted.find((m) => !m.isMe && m.messageId) ?? sorted.find((m) => m.messageId);
  return {
    chatId,
    chatName,
    messageId: anchor?.messageId,
    replyToActor: anchor && !anchor.isMe ? anchor.actor : undefined,
    replyToText: anchor && !anchor.isMe ? anchor.text?.slice(0, 200) : undefined,
  };
}

// ---- 预览（不发送）----

export function previewImReply(cardId: string): {
  target: ImReplyTarget;
  suggestedText: string;
} {
  const source = resolveSource(cardId);
  const target = resolveImReplyTarget(source);
  const suggestedText = (source.draftReply || source.suggestedAction || '').trim();
  return { target, suggestedText };
}

// ---- 执行发送（confirm 门控）----

export async function sendImReplyFromCard(
  input: SendImReplyInput,
  deps: ImReplyDeps = {}
): Promise<SendImReplyResult> {
  // 2026-06-15：公司策略不允许 AI 代发飞书 IM。整个发送通道硬禁——绝不真发。
  // 起草仍走 previewImReply（解析"回复给谁"+草稿），用户复制后自行在飞书发送。
  void input;
  void deps;
  throw new Error('公司策略不允许 AI 代发飞书消息。请复制 AI 起草的回复，自行在飞书发送。');
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
