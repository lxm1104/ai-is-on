import { getCard, db, expandTruncatedId, matchMatterId, type EventRow } from '../db.js';
import {
  findEventContextUnitId,
  getContextUnitById,
  listLinksFor,
} from '../context/contextStore.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import { getAttentionItem } from '../attention/attentionStore.js';

/**
 * MVP29D：解析某条 attention item 的 signalIds 前，先剔除"本条 matterId 自己的值"。
 * LLM 常把 matter id 同时写进 matterId 和 signalIds，而 matter 不是原始信号（解不出原文）；
 * 且 echo 36 位 uuid 时可能截断或改错一位，使其在库里查不到 → 显示"未解析的 signal"。
 * matchMatterId 只能认出库里仍存在的 matter id；这层按 matterId 同值，连被改坏、查不到的也兜住。
 * 各读取入口（"查看原始信息"路由 / 卡片投影 / ContextPanel）统一走这里，行为一致。
 */
export function signalIdsForOrigin(item: { signalIds: string[]; matterId?: string | null }): string[] {
  const mid = item.matterId ?? '';
  return mid ? item.signalIds.filter((s) => s !== mid) : item.signalIds;
}

/**
 * MVP14 Step3：attention item 的 signalIds 来自 LLM，id 可能指向以下任一表：
 *   1) context_units.id  → 直接 ContextUnit
 *   2) cards.id (source_kind='agent_run') → 解开找 raw_event_id → event ContextUnit
 *   3) events.id          → 找对应的 minimal event ContextUnit
 * 三层兜底：哪种命中就用哪种。
 */
function resolveAttentionSignals(rawIds: string[]): ContextUnit[] {
  // MVP29C/D：丢掉误混进 signalIds 的 matter id（matter 不是原始信号），再还原被截断的 8 位前缀
  const ids = rawIds.filter((id) => !matchMatterId(id)).map(expandTruncatedId);
  const seen = new Set<string>();
  const out: ContextUnit[] = [];
  for (const sid of ids) {
    if (seen.has(sid)) continue;
    seen.add(sid);

    // (1) 直接是 ContextUnit
    const direct = getContextUnitById(sid);
    if (direct) {
      out.push(direct);
      continue;
    }

    // (2) agent_run card → raw_event_id → event ContextUnit
    const card = getCard(sid);
    if (card) {
      if (card.raw_event_id) {
        const evUnitId = findEventContextUnitId(card.raw_event_id);
        if (evUnitId && !seen.has(evUnitId)) {
          seen.add(evUnitId);
          const u = getContextUnitById(evUnitId);
          if (u) out.push(u);
        }
      }
      // card 本身没有 ContextUnit 表示，但我们想把它作为可识别的项返回。
      // 简化：包装为一个虚拟 ContextUnit，前端 ContextPanel 仍然按 kind/title 渲染。
      const virt: ContextUnit = {
        id: card.id,
        subjectId: 'me',
        scope: 'work',
        origin: { kind: 'agent_run', refId: card.source_ref_id ?? card.id },
        kind: 'action_result',
        title: card.title,
        content: card.summary,
        entities: [],
        actionability: 'notify',
        confidence: 0.8,
        version: 1,
        status: 'active',
        createdAt: card.created_at,
        updatedAt: card.updated_at,
      };
      out.push(virt);
      continue;
    }

    // (3) 当 event.id 处理
    const evRow = db
      .prepare(`SELECT id FROM events WHERE id = ?`)
      .get(sid) as { id?: string } | undefined;
    if (evRow?.id) {
      const evUnitId = findEventContextUnitId(evRow.id);
      if (evUnitId && !seen.has(evUnitId)) {
        seen.add(evUnitId);
        const u = getContextUnitById(evUnitId);
        if (u) out.push(u);
      }
    }
  }
  return out;
}

export type CardContextProjection = {
  cardId: string;
  eventContextUnitId: string | null;
  relatedUnits: ContextUnit[];
};

/**
 * For a card, surface the ContextUnits the system associated with the
 * underlying raw event — i.e. "为什么相关". MVP2.2:
 *   card → raw_event_id → event ContextUnit → context_links{from} → related units
 *
 * We deliberately do NOT chase further hops here; one level keeps it readable.
 *
 * MVP14 Step 3: 同一个 id 命名空间下也允许传 attention_item id。
 *   attention item → signalIds → 直接列出对应 ContextUnit（不需要走 event→links 链）
 *   这样 ContextPanel 对 attention 流的卡片也能展示"为什么相关"。
 */
export function projectCardContext(cardId: string): CardContextProjection {
  // 优先看 attention：现在前端唯一来源是 attention，命中率最高
  const attn = getAttentionItem(cardId);
  if (attn) {
    const out = resolveAttentionSignals(signalIdsForOrigin(attn));
    const anchor = out.find((u) => u.kind === 'event') ?? null;
    return {
      cardId,
      eventContextUnitId: anchor?.id ?? null,
      relatedUnits: out,
    };
  }

  // 旧路径：cards 表（专项 agent 残留卡）
  const card = getCard(cardId);
  if (!card) {
    return { cardId, eventContextUnitId: null, relatedUnits: [] };
  }
  const eventId = card.raw_event_id;
  if (!eventId) {
    return { cardId, eventContextUnitId: null, relatedUnits: [] };
  }
  const eventUnitId = findEventContextUnitId(eventId);
  if (!eventUnitId) {
    return { cardId, eventContextUnitId: null, relatedUnits: [] };
  }
  const links = listLinksFor(eventUnitId);
  const seen = new Set<string>([eventUnitId]);
  const out: ContextUnit[] = [];
  for (const l of links) {
    const otherId = l.from_context_id === eventUnitId ? l.to_context_id : l.from_context_id;
    if (seen.has(otherId)) continue;
    seen.add(otherId);
    const unit = getContextUnitById(otherId);
    if (unit) out.push(unit);
  }
  return { cardId, eventContextUnitId: eventUnitId, relatedUnits: out };
}

/**
 * MVP14 后续：给前端"查看原始信息"用。
 * 把 attention_items.signal_ids_json 里的 id 解开成「人类可看的原始信号」列表，
 * 关键是带上 events.url（飞书原文链接），让用户能跳出去看具体哪条记录有新进展。
 *
 * 兼容三种 id 来源（与 resolveAttentionSignals 一致）：
 *   1) context_units.id  → 若 origin.kind='event'，回查 events 拿 url
 *   2) cards.id          → raw_event_id 回查 events
 *   3) events.id         → 直接查
 *
 * 去重：以最终落到的 events.id 或 context_unit.id 为 key。
 */
export type AttentionSignalDetail = {
  signalId: string;            // 原始 signalIds 里的 id
  kind: 'event' | 'context_unit' | 'card' | 'unknown';
  source?: string;             // events.source: 'drive'|'im'|'mail'|'calendar'|...
  title: string;
  occurredAt?: string;         // ISO
  url?: string;                // 飞书原文链接（events.url）
  excerpt?: string;            // 内容预览，截断到 200 字符
  text?: string;               // 完整原文（events.text 或 context_unit.content），不截断
};

function getEventRowById(id: string): EventRow | null {
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as
    | EventRow
    | undefined;
  return row ?? null;
}

/**
 * IM 事件的 events.text 是为 LLM Triage 准备的结构化对话片段
 * （由 imCollector 的 summarizeOne / summarizeOneWithContext / summarizeAggregate 生成），
 * 形如：
 *   会话：单聊 · 詹育帆
 *   焦点消息：詹育帆 @ 2026-05-27 21:07
 *   ---
 *   ★ [2026-05-27 21:07] 詹育帆: 这里肯定有问题
 *
 * 这种文本里会话名、发送者、时间在三处重复，"查看原始信息" 抽屉的 row header
 * 已经把这些元数据展示出来了，原文不需要再啰嗦一遍。本函数把这些元行剔掉，
 * 每条对话行只留 [可选的 ★] + sender + content（行内时间也去掉）。
 *
 * 注意：只清洗用于「展示」的字段，不动 events.text 本身，Triage prompt 仍读原始结构。
 */
export function sanitizeImTextForDisplay(rawText: string): string {
  if (!rawText) return '';
  const out: string[] = [];
  for (const raw of rawText.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    // 顶部元数据行
    if (line.startsWith('会话：')) continue;
    if (line.startsWith('焦点消息：')) continue;
    if (line.startsWith('发送者：')) continue;
    if (line.startsWith('时间：')) continue;
    if (line.startsWith('自 ') && line.includes('以来新增')) continue;
    if (line === '---') continue;
    // summarizeOne 的 "内容：xxx" → 直接取 xxx
    if (line.startsWith('内容：')) {
      out.push(line.slice('内容：'.length).trim());
      continue;
    }
    // 对话行： "★ [time] sender: content" 或 "- [time] sender: content"
    const dialog = line.match(/^([★\-])\s+\[[^\]]*\]\s+([^:：]+?)[:：]\s?(.*)$/);
    if (dialog) {
      const isFocus = dialog[1] === '★';
      const sender = dialog[2].trim();
      const content = dialog[3].trim();
      out.push(`${isFocus ? '★ ' : ''}${sender}: ${content}`);
      continue;
    }
    // ellipsis line: "- ……（中间省略 N 条）……"
    if (line.startsWith('- ……')) {
      out.push(line.slice(2));
      continue;
    }
    // 其它（非 IM 模板里出现的内容）：原样保留
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * 抽屉里的"单行预览"：优先用焦点行（★），否则首条非空行。
 * 截到 200 字符避免极端长消息撑爆。
 */
function pickImExcerpt(sanitized: string): string | undefined {
  if (!sanitized) return undefined;
  const lines = sanitized.split('\n');
  const focus = lines.find((l) => l.startsWith('★ '));
  const candidate = focus ?? lines.find((l) => l.trim());
  if (!candidate) return undefined;
  return candidate.length > 200 ? candidate.slice(0, 200) + '…' : candidate;
}

function eventRowToDetail(signalId: string, ev: EventRow): AttentionSignalDetail {
  const isIm = ev.source === 'im';
  const displayText = isIm ? sanitizeImTextForDisplay(ev.text) : ev.text;
  const excerpt = isIm
    ? pickImExcerpt(displayText)
    : ev.text
      ? ev.text.slice(0, 200)
      : undefined;
  return {
    signalId,
    kind: 'event',
    source: ev.source,
    title: ev.title ?? ev.text.slice(0, 80) ?? '(无标题)',
    occurredAt: ev.occurred_at,
    url: ev.url ?? undefined,
    excerpt,
    text: displayText || undefined,
  };
}

function unitToDetail(
  signalId: string,
  unit: ContextUnit,
  ev: EventRow | null
): AttentionSignalDetail {
  const rawFull = unit.content || ev?.text || '';
  const isIm = ev?.source === 'im';
  const displayText = isIm ? sanitizeImTextForDisplay(rawFull) : rawFull;
  const excerpt = isIm
    ? pickImExcerpt(displayText)
    : rawFull
      ? rawFull.slice(0, 200)
      : undefined;
  return {
    signalId,
    kind: ev ? 'event' : 'context_unit',
    source: ev?.source,
    title: unit.title || ev?.title || '(无标题)',
    occurredAt: unit.time?.occurredAt ?? ev?.occurred_at ?? unit.createdAt,
    url: ev?.url ?? undefined,
    excerpt,
    text: displayText || undefined,
  };
}

// ---- "查看原始信息" 抽屉的对话合并 ----
//
// 同一 chat 下的多个 IM signals（每条 event 各带一个上下文窗口）会反复包含
// 重叠的消息。直接按 signal 一行行列出来既冗余又看不出时间顺序。
// 这里把同 chat 的 events 合并成一个 "conversation"，parse 每行 dialog
// 还原成 ParsedImMessage，跨 event 去重后按时间升序。
//
// 注意：本路径只影响 /api/attention/:id/signals 的展示投影。
// Attention engine / Triage 仍读 events.text 原文，不受影响。

export type ParsedImMessage = {
  time: string;       // 原始字符串（imCollector 写入的格式，例如 "2026-05-27 21:07"）
  sender: string;
  content: string;
  isFocus: boolean;   // 是否是某个 event 的 ★ 焦点消息
};

export type AttentionConversation = {
  groupKey: string;             // "im:chat:<chatId>"
  source: 'im';
  chatName: string;             // 例如 "单聊 · 詹育帆"
  url?: string;                 // 该 chat 组里最新 event 的 url（点开聊天用）
  latestAt?: string;            // 最新消息时间（用于块间排序）
  messages: ParsedImMessage[];  // 按 time 升序
  signalIds: string[];          // 合并进来的 signal ids（去重）
};

export type AttentionOriginItem =
  | { kind: 'conversation'; conversation: AttentionConversation; sortKey: string }
  | { kind: 'signal'; signal: AttentionSignalDetail; sortKey: string };

// 解析 events.text 里 "★ [time] sender: content" / "- [time] sender: content" 这种对话行
export function parseImTextLines(text: string): ParsedImMessage[] {
  if (!text) return [];
  const out: ParsedImMessage[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = line.match(/^([★\-])\s+\[([^\]]*)\]\s+([^:：]+?)[:：]\s?(.*)$/);
    if (!m) continue;
    out.push({
      isFocus: m[1] === '★',
      time: m[2].trim(),
      sender: m[3].trim(),
      content: m[4].trim(),
    });
  }
  return out;
}

// source_id 形如 "chat:<chatId>:msg:<msgId>" 或 "chat:<chatId>:agg:<sinceIso>"
// （仅 burst 路径用这种形式，imCollector 的单消息路径只写 message_id）
export function extractChatId(sourceId: string | null | undefined): string | null {
  if (!sourceId) return null;
  const m = sourceId.match(/^chat:([^:]+):/);
  return m ? m[1] : null;
}

/**
 * 把 events.raw_json 里挖出 chat_id（兜底用，针对 imCollector 单消息路径
 * source_id 只写 message_id 的情况）。raw 的形状跟 collector 路径相关：
 *   group burst:    { chat: { chat_id }, msgs }
 *   group single:   { chat: { chat_id }, msg, contextMsgs }
 *   p2p   burst:    { chatId, msgs }
 *   p2p   single:   { chatId, msg, contextMsgs }
 */
export function extractChatIdFromRaw(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null;
  try {
    const r = JSON.parse(rawJson) as Record<string, unknown>;
    if (typeof r.chatId === 'string' && r.chatId) return r.chatId;
    const chat = r.chat as Record<string, unknown> | undefined;
    if (chat && typeof chat.chat_id === 'string' && chat.chat_id) return chat.chat_id;
    const msg = r.msg as Record<string, unknown> | undefined;
    if (msg && typeof msg.chat_id === 'string' && msg.chat_id) return msg.chat_id;
    return null;
  } catch {
    return null;
  }
}

// 合一入口：先尝试 source_id，再退到 raw_json
function chatIdFromEvent(ev: EventRow): string | null {
  return extractChatId(ev.source_id) ?? extractChatIdFromRaw(ev.raw_json);
}

// 从 imCollector 写入的 title 里取一个合理的 chat 名（去掉 " · 新增 N 条消息" 这种尾巴）
export function extractChatName(title: string | null | undefined): string {
  if (!title) return '(未命名会话)';
  // imCollector：`${chatName}`、`${chatName} · 新增 N 条消息`
  // chatName 自身可能含 " · "（如 "单聊 · 詹育帆"），所以截掉 " · 新增" 这一段
  const idx = title.indexOf(' · 新增');
  return idx >= 0 ? title.slice(0, idx) : title;
}

function mostCommon<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  const counts = new Map<T, number>();
  for (const x of arr) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * 1-on-1 单聊里挑 peer 名当 chatName 用：
 * imCollector 的 derivePeerChatName 拿"窗口里第一个有名字的发送者"做 chatName，
 * 当窗口起点是 me 自己时就会出现"单聊 · 刘昕明"这种把自己当 peer 的尴尬情况。
 * 焦点消息（★）一般是 peer 发的（不然不会触发 attention），所以挑 focus sender
 * 最多的那个名字。
 * 群聊不走这条路（标题不带"单聊 · "前缀），直接选最常见的 title。
 */
export function pickPeerChatName(
  titleCandidates: string[],
  messages: ParsedImMessage[]
): string | undefined {
  if (titleCandidates.length === 0) return undefined;
  const allP2P = titleCandidates.every((c) => c.startsWith('单聊 · '));
  if (!allP2P) return mostCommon(titleCandidates);
  const focusSenders = messages.filter((m) => m.isFocus).map((m) => m.sender);
  const peer = mostCommon(focusSenders);
  if (peer) return `单聊 · ${peer}`;
  return mostCommon(titleCandidates);
}

// 跨 event 去重消息：同 (time, sender, content) 视为同一条；
// 任一副本带 ★ 就保留 ★（焦点信息更有价值）
export function mergeMessages(all: ParsedImMessage[]): ParsedImMessage[] {
  const byKey = new Map<string, ParsedImMessage>();
  for (const m of all) {
    const key = `${m.time}|${m.sender}|${m.content}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...m });
    } else if (m.isFocus && !prev.isFocus) {
      prev.isFocus = true;
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    // time 是字符串如 "2026-05-27 21:07"，字典序即可时序
    if (a.time < b.time) return -1;
    if (a.time > b.time) return 1;
    return 0;
  });
}

/**
 * 给 "查看原始信息" 抽屉用：把 signalIds 投影成混排 items（conversation + signal），
 * 块间按"最新动静"时间倒序。IM signals 合并成 conversation，其他来源（mail / drive /
 * calendar / 已弃的 cards 路径等）保持单条 signal。
 */
export function resolveAttentionOriginItems(
  rawIds: string[]
): AttentionOriginItem[] {
  // MVP29C/D：丢掉误混进 signalIds 的 matter id（matter 不是原始信号），再还原被截断的 8 位前缀
  const ids = rawIds.filter((id) => !matchMatterId(id)).map(expandTruncatedId);
  // 先按现有逻辑解出每个 sid 对应的 (signal, event?) ，IM 暂存待合并
  const standalone: AttentionSignalDetail[] = [];
  type Pending = { signal: AttentionSignalDetail; ev: EventRow };
  const imPending: Pending[] = [];
  const seenKey = new Set<string>();

  for (const sid of ids) {
    // (1) context_unit
    const unit = getContextUnitById(sid);
    if (unit) {
      let ev: EventRow | null = null;
      if (unit.origin.kind === 'event' && unit.origin.refId) {
        ev = getEventRowById(unit.origin.refId);
      }
      const key = ev ? `event:${ev.id}` : `unit:${unit.id}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      const signal = unitToDetail(sid, unit, ev);
      if (ev && ev.source === 'im') imPending.push({ signal, ev });
      else standalone.push(signal);
      continue;
    }
    // (2) cards.id（旧路径）
    const card = getCard(sid);
    if (card) {
      let ev: EventRow | null = null;
      if (card.raw_event_id) ev = getEventRowById(card.raw_event_id);
      const key = ev ? `event:${ev.id}` : `card:${card.id}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      if (ev) {
        const signal = eventRowToDetail(sid, ev);
        if (ev.source === 'im') imPending.push({ signal, ev });
        else standalone.push(signal);
      } else {
        standalone.push({
          signalId: sid,
          kind: 'card',
          title: card.title,
          occurredAt: card.created_at,
          url: card.source_url ?? undefined,
          excerpt: card.summary ? card.summary.slice(0, 200) : undefined,
          text: card.summary || undefined,
        });
      }
      continue;
    }
    // (3) events.id
    const ev = getEventRowById(sid);
    if (ev) {
      const key = `event:${ev.id}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      const signal = eventRowToDetail(sid, ev);
      if (ev.source === 'im') imPending.push({ signal, ev });
      else standalone.push(signal);
      continue;
    }
    // (4) 找不到
    standalone.push({
      signalId: sid,
      kind: 'unknown',
      title: `未解析的 signal（${sid.slice(0, 8)}）`,
    });
  }

  // IM signals 按 chatId 分组合并；解析不出 chatId 的退化为 standalone
  const byChat = new Map<string, { events: Pending[]; signalIds: string[] }>();
  for (const p of imPending) {
    const chatId = chatIdFromEvent(p.ev);
    if (!chatId) {
      standalone.push(p.signal);
      continue;
    }
    const bucket = byChat.get(chatId) ?? { events: [], signalIds: [] };
    bucket.events.push(p);
    bucket.signalIds.push(p.signal.signalId);
    byChat.set(chatId, bucket);
  }

  const conversations: AttentionConversation[] = [];
  for (const [chatId, bucket] of byChat) {
    const allMsgs: ParsedImMessage[] = [];
    for (const p of bucket.events) {
      allMsgs.push(...parseImTextLines(p.ev.text));
    }
    const messages = mergeMessages(allMsgs);
    // 该组最新 event 的 url 当作"打开聊天"链接
    const latestEv = bucket.events.reduce((a, b) =>
      (a.ev.occurred_at ?? '') > (b.ev.occurred_at ?? '') ? a : b
    );
    // chatName: imCollector 把 chat 名拼成 "单聊 · <某发送者名>"，但 <发送者>
    // 是窗口里第一个有名字的人 —— 如果窗口起点是 me 这一侧，chatName 会变成
    // "单聊 · 刘昕明"（即"自己"）。同一 chatId 下不同 event 选的可能不一样，
    // 这里挑一个"看上去不是 me"的 title：优先选不等于当前最常见冠名的，
    // 否则退到 latestEv.title。
    const candidates = bucket.events
      .map((p) => extractChatName(p.ev.title))
      .filter((n) => !!n);
    const chatName = pickPeerChatName(candidates, messages) ?? extractChatName(latestEv.ev.title);
    const latestAt =
      messages.length > 0 ? messages[messages.length - 1].time : latestEv.ev.occurred_at;
    conversations.push({
      groupKey: `im:chat:${chatId}`,
      source: 'im',
      chatName,
      url: latestEv.ev.url ?? undefined,
      latestAt,
      messages,
      signalIds: bucket.signalIds,
    });
  }

  // 块间按"最新动静"时间倒序：conversation 用 latestAt，signal 用 occurredAt
  const items: AttentionOriginItem[] = [
    ...conversations.map<AttentionOriginItem>((c) => ({
      kind: 'conversation',
      conversation: c,
      sortKey: c.latestAt ?? '',
    })),
    ...standalone.map<AttentionOriginItem>((s) => ({
      kind: 'signal',
      signal: s,
      sortKey: s.occurredAt ?? '',
    })),
  ];
  items.sort((a, b) => {
    if (a.sortKey < b.sortKey) return 1;
    if (a.sortKey > b.sortKey) return -1;
    return 0;
  });
  return items;
}

export function resolveAttentionSignalDetails(
  rawIds: string[]
): AttentionSignalDetail[] {
  // MVP29C/D：丢掉误混进 signalIds 的 matter id（matter 不是原始信号），再还原被截断的 8 位前缀
  const ids = rawIds.filter((id) => !matchMatterId(id)).map(expandTruncatedId);
  const seenKey = new Set<string>();
  const out: AttentionSignalDetail[] = [];

  for (const sid of ids) {
    // (1) context_unit.id
    const unit = getContextUnitById(sid);
    if (unit) {
      let ev: EventRow | null = null;
      if (unit.origin.kind === 'event' && unit.origin.refId) {
        ev = getEventRowById(unit.origin.refId);
      }
      const key = ev ? `event:${ev.id}` : `unit:${unit.id}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      out.push(unitToDetail(sid, unit, ev));
      continue;
    }

    // (2) cards.id（旧路径）
    const card = getCard(sid);
    if (card) {
      let ev: EventRow | null = null;
      if (card.raw_event_id) ev = getEventRowById(card.raw_event_id);
      const key = ev ? `event:${ev.id}` : `card:${card.id}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      if (ev) {
        out.push(eventRowToDetail(sid, ev));
      } else {
        out.push({
          signalId: sid,
          kind: 'card',
          title: card.title,
          occurredAt: card.created_at,
          url: card.source_url ?? undefined,
          excerpt: card.summary ? card.summary.slice(0, 200) : undefined,
          text: card.summary || undefined,
        });
      }
      continue;
    }

    // (3) events.id
    const ev = getEventRowById(sid);
    if (ev) {
      const key = `event:${ev.id}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      out.push(eventRowToDetail(sid, ev));
      continue;
    }

    // (4) 完全找不到：留个壳，前端就不显示链接
    out.push({
      signalId: sid,
      kind: 'unknown',
      title: `未解析的 signal（${sid.slice(0, 8)}）`,
    });
  }

  return out;
}
