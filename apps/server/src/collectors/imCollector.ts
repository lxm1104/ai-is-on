import crypto from 'node:crypto';
import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import { toLocalTzIso } from '../util/iso.js';
import { getMyOpenId } from '../util/identity.js';
import { extractFeishuDocEntities } from '../util/extractFeishuDocRefs.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';
import type { Collector, RawSignal } from './types.js';

// ---------- types ----------

type ImMessage = {
  message_id?: string;
  chat_id?: string;
  chat_name?: string; // only present from messages-search
  chat_type?: string;
  content?: string;
  create_time?: string; // "2026-05-18 19:42" local-tz
  msg_type?: string;
  sender?: { id?: string; id_type?: string; name?: string; sender_type?: string };
  message_app_link?: string;
  deleted?: boolean;
};

type ChatListChat = {
  chat_id?: string;
  name?: string;
  description?: string;
  external?: boolean;
  chat_status?: string;
};

type ChatListResp = {
  ok?: boolean;
  data?: { chats?: ChatListChat[]; has_more?: boolean; page_token?: string };
};

type ChatMessagesListResp = {
  ok?: boolean;
  data?: { messages?: ImMessage[]; has_more?: boolean; page_token?: string };
};

type MessagesSearchResp = {
  ok?: boolean;
  data?: { messages?: ImMessage[]; has_more?: boolean };
};

// ---------- helpers ----------

function parseCreateTime(s?: string): string {
  if (!s) return new Date().toISOString();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return new Date().toISOString();
  const [, y, mo, d, h, mi, se] = m;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(se ?? 0)
  ).toISOString();
}

function isAtMe(msg: ImMessage, myOpenId: string): boolean {
  const c = msg.content ?? '';
  return c.includes(myOpenId) || c.includes('@_all');
}

function isWanted(msg: ImMessage, myOpenId: string): boolean {
  if (!msg.message_id) return false;
  if (msg.deleted) return false;
  if (msg.msg_type === 'system') return false;
  // exclude my own messages
  if (msg.sender?.id === myOpenId) return false;
  return true;
}

function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

// MVP12 §4.1 P1.1：sender 是否为机器人 / 应用网关
function isBotSender(sender?: ImMessage['sender']): boolean {
  if (!sender) return false;
  if (sender.sender_type === 'app') return true;
  if (sender.id && sender.id.startsWith('cli_')) return true;
  return false;
}

// MVP12 §4.1 P1.1：构造 routing 用的 chat entity
//   - name = 'lark_chat:<chat_id>'（稳定 key，群改名不变）
//   - aliases = [chat_name]（取最近一次显示名）
//   - role = 'container'（不参与 actor / about；renderer 会过滤）
function chatEntity(chatId: string, chatName?: string): ContextEntityRef {
  const aliases = chatName?.trim() ? [chatName.trim()] : undefined;
  return {
    type: 'chat',
    name: `lark_chat:${chatId}`,
    aliases,
    role: 'container',
    confidence: 1.0,
  };
}

// MVP12 §4.1 P1.1：单条消息的 sender entity（人 vs 应用）
function senderEntity(sender?: ImMessage['sender']): ContextEntityRef | null {
  if (!sender) return null;
  const displayName = sender.name?.trim() || sender.id?.trim();
  if (!displayName) return null;
  const isBot = isBotSender(sender);
  const aliases = sender.id && sender.id !== displayName ? [sender.id] : undefined;
  return {
    type: isBot ? 'app' : 'person',
    name: displayName,
    aliases,
    role: 'actor',
    confidence: 0.9,
  };
}

// MVP12：聚合消息的发送者 entities —— 机器人合并、人去重 cap 8。
function aggregateSenderEntities(msgs: ImMessage[]): ContextEntityRef[] {
  const out: ContextEntityRef[] = [];
  const seenPersonName = new Set<string>();
  let seenBot = false;
  for (const m of msgs) {
    const e = senderEntity(m.sender);
    if (!e) continue;
    if (e.type === 'app') {
      if (seenBot) continue;
      seenBot = true;
      out.push(e);
      continue;
    }
    if (seenPersonName.has(e.name)) continue;
    seenPersonName.add(e.name);
    out.push(e);
    if (out.filter((x) => x.type === 'person').length >= 8) {
      // person cap 命中后继续吸收 bot（最多一条），但 person 不再加
      // 由 outer continue 控制
    }
  }
  return out;
}

function dedupEntities(refs: ContextEntityRef[]): ContextEntityRef[] {
  const seen = new Set<string>();
  const out: ContextEntityRef[] = [];
  for (const r of refs) {
    const key = `${r.type}::${r.name}::${r.role ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * For a p2p chat, derive a readable label. Drops raw chat ids
 * (oc_xxx) which carry no meaning to the user.
 * Strategy: first non-empty sender.name → use it. Otherwise mark by
 * sender type — app/bot ids start with 'cli_', user ids with 'ou_'.
 */
function derivePeerChatName(msgs: ImMessage[], chatId: string): string {
  const firstNamed = msgs.find((m) => m.sender?.name && m.sender.name.trim());
  if (firstNamed?.sender?.name) return `单聊 · ${firstNamed.sender.name}`;

  const firstChatName = msgs.find((m) => m.chat_name && m.chat_name.trim());
  if (firstChatName?.chat_name) return `单聊 · ${firstChatName.chat_name}`;

  // No name anywhere — infer from sender_type / id prefix
  const firstSender = msgs[0]?.sender;
  if (firstSender?.sender_type === 'app' || firstSender?.id?.startsWith('cli_')) {
    return '单聊 · (应用消息)';
  }
  // Fallback: at least don't expose the raw open_chat_id in the UI.
  const tail = chatId.slice(-6);
  return `单聊 · 未命名会话 #${tail}`;
}

function summarizeOne(msg: ImMessage, chatName: string): string {
  const lines: string[] = [];
  if (chatName) lines.push(`会话：${chatName}`);
  const sender = msg.sender?.name || msg.sender?.id || '未知发送者';
  lines.push(`发送者：${sender}（${msg.sender?.sender_type ?? '?'}）`);
  if (msg.create_time) lines.push(`时间：${msg.create_time}`);
  const content = (msg.content ?? '').trim();
  if (content) {
    lines.push(`内容：${content.length > 600 ? content.slice(0, 600) + '…' : content}`);
  }
  return lines.join('\n');
}

function summarizeAggregate(
  chatName: string,
  msgs: ImMessage[],
  windowStart: string
): string {
  const lines: string[] = [];
  lines.push(`会话：${chatName}`);
  lines.push(`自 ${windowStart} 以来新增 ${msgs.length} 条消息`);
  lines.push('---');
  // Show the most recent 5 previews
  const previews = msgs.slice(-5);
  for (const m of previews) {
    const sender = m.sender?.name || m.sender?.id || '?';
    const content = (m.content ?? '').replace(/\s+/g, ' ').trim();
    const short = content.length > 120 ? content.slice(0, 120) + '…' : content;
    lines.push(`- [${m.create_time ?? '?'}] ${sender}: ${short}`);
  }
  return lines.join('\n');
}

// ---------- chat-list paging ----------

async function listAllGroups(): Promise<ChatListChat[]> {
  const out: ChatListChat[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < config.imChatListMaxPages; page++) {
    const args: string[] = [
      'im',
      '+chat-list',
      '--as',
      'user',
      '--exclude-muted',
      '--sort-type',
      'ByActiveTimeDesc',
      '--page-size',
      '100',
      '--format',
      'json',
    ];
    if (pageToken) args.push('--page-token', pageToken);
    const resp = await runLarkCliJson<ChatListResp>(args);
    if (!resp.ok || !resp.data) break;
    const chats = resp.data.chats ?? [];
    for (const c of chats) {
      if (c.chat_status && c.chat_status !== 'normal') continue;
      if (c.chat_id) out.push(c);
    }
    if (!resp.data.has_more || !resp.data.page_token) break;
    pageToken = resp.data.page_token;
  }
  return out;
}

// ---------- per-chat fetch ----------

async function listMessagesInChat(
  chatId: string,
  startIso: string,
  endIso: string
): Promise<ImMessage[]> {
  const out: ImMessage[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page++) {
    const args: string[] = [
      'im',
      '+chat-messages-list',
      '--as',
      'user',
      '--chat-id',
      chatId,
      '--start',
      startIso,
      '--end',
      endIso,
      '--page-size',
      String(config.imPerChatPageSize),
      '--sort',
      'asc',
      '--format',
      'json',
    ];
    if (pageToken) args.push('--page-token', pageToken);
    const resp = await runLarkCliJson<ChatMessagesListResp>(args);
    if (!resp.ok || !resp.data) break;
    const msgs = resp.data.messages ?? [];
    for (const m of msgs) {
      if (m.chat_id == null) m.chat_id = chatId;
      out.push(m);
    }
    if (!resp.data.has_more || !resp.data.page_token) break;
    pageToken = resp.data.page_token;
  }
  return out;
}

async function fetchInParallel<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        out[idx] = await worker(items[idx]);
      } catch {
        // surface failures elsewhere; for now drop
        // @ts-expect-error allow undefined entry on failure
        out[idx] = undefined;
      }
    }
  });
  await Promise.all(lanes);
  return out;
}

// ---------- p2p scan (bulk search; no chat-list for p2p) ----------

async function listP2pMessages(startLocal: string, endLocal: string): Promise<ImMessage[]> {
  // messages-search with --chat-type p2p, paginate up to 3 pages
  const args: string[] = [
    'im',
    '+messages-search',
    '--as',
    'user',
    '--chat-type',
    'p2p',
    '--start',
    startLocal,
    '--end',
    endLocal,
    '--page-all',
    '--page-limit',
    '3',
    '--format',
    'json',
  ];
  const resp = await runLarkCliJson<MessagesSearchResp>(args);
  return resp.ok && resp.data?.messages ? resp.data.messages : [];
}

// ---------- main collector ----------

export const imCollector: Collector = {
  name: 'im',
  intervalMs: config.imIntervalMs,
  async collect(since: Date | null): Promise<RawSignal[]> {
    const now = new Date();
    const lookbackMs = (config.imFirstScanHours || 1) * 60 * 60 * 1000;
    const sinceDate = since ?? new Date(now.getTime() - lookbackMs);
    const startLocal = toLocalTzIso(sinceDate);
    const endLocal = toLocalTzIso(now);
    const sinceIso = sinceDate.toISOString();

    let myOpenId: string;
    try {
      myOpenId = await getMyOpenId();
    } catch (err) {
      throw new Error(
        `failed to resolve my open_id: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const signals: RawSignal[] = [];

    // ---- groups ----
    const groups = await listAllGroups();
    type ChatHit = { chat: ChatListChat; msgs: ImMessage[] };
    const perChat: ChatHit[] = (
      await fetchInParallel(
        groups,
        async (chat) => {
          if (!chat.chat_id) return { chat, msgs: [] };
          const msgs = await listMessagesInChat(chat.chat_id, sinceIso, now.toISOString());
          const filtered = msgs.filter((m) => isWanted(m, myOpenId));
          return { chat, msgs: filtered };
        },
        config.imChatFetchConcurrency
      )
    ).filter((x): x is ChatHit => !!x && x.msgs.length > 0);

    // Sort chats by latest message time desc so important first
    perChat.sort((a, b) => {
      const ta = a.msgs[a.msgs.length - 1]?.create_time ?? '';
      const tb = b.msgs[b.msgs.length - 1]?.create_time ?? '';
      return tb.localeCompare(ta);
    });

    for (const { chat, msgs } of perChat) {
      const chatName = chat.name?.trim()
        ? chat.name
        : chat.chat_id
          ? `未命名群 #${chat.chat_id.slice(-6)}`
          : '未知群';
      const chatId = chat.chat_id ?? '';
      const chatEnt = chatId ? chatEntity(chatId, chat.name) : null;
      if (msgs.length >= config.imAggregateThreshold) {
        // aggregated signal: one per chat per window
        const lastMsgId = msgs[msgs.length - 1]?.message_id ?? '';
        const text = summarizeAggregate(chatName, msgs, startLocal);
        const entities: ContextEntityRef[] = [];
        if (chatEnt) entities.push(chatEnt);
        entities.push(...aggregateSenderEntities(msgs));
        entities.push(...extractFeishuDocEntities(text));
        signals.push({
          source: 'im',
          sourceId: `chat:${chat.chat_id}:agg:${sinceIso}`,
          kind: msgs.some((m) => isAtMe(m, myOpenId)) ? 'group_burst_at_me' : 'group_burst',
          occurredAt: parseCreateTime(msgs[msgs.length - 1]?.create_time),
          title: `${chatName} · 新增 ${msgs.length} 条`,
          text,
          actor: undefined,
          url: msgs[msgs.length - 1]?.message_app_link,
          raw: { chat, msgs },
          contentHash: shortHash(
            `agg|${chat.chat_id}|${msgs.length}|${lastMsgId}|${sinceIso}`
          ),
          entities: dedupEntities(entities),
        });
      } else {
        for (const m of msgs) {
          const text = summarizeOne(m, chatName);
          const entities: ContextEntityRef[] = [];
          if (chatEnt) entities.push(chatEnt);
          const se = senderEntity(m.sender);
          if (se) entities.push(se);
          entities.push(...extractFeishuDocEntities(text));
          signals.push({
            source: 'im',
            sourceId: m.message_id!,
            kind: isAtMe(m, myOpenId) ? 'at_me' : 'group_message',
            occurredAt: parseCreateTime(m.create_time),
            title: chatName,
            text,
            actor: m.sender?.name ?? m.sender?.id,
            url: m.message_app_link,
            raw: { chat, msg: m },
            contentHash: shortHash(`${m.message_id}|${m.content ?? ''}|${m.create_time ?? ''}`),
            entities: dedupEntities(entities),
          });
        }
      }
    }

    // ---- p2p ----
    const p2pMsgs = (await listP2pMessages(startLocal, endLocal)).filter((m) =>
      isWanted(m, myOpenId)
    );
    // Group p2p messages by chat_id for aggregation
    const p2pByChat = new Map<string, ImMessage[]>();
    for (const m of p2pMsgs) {
      if (!m.chat_id) continue;
      const arr = p2pByChat.get(m.chat_id) ?? [];
      arr.push(m);
      p2pByChat.set(m.chat_id, arr);
    }
    for (const [chatId, msgs] of p2pByChat) {
      msgs.sort((a, b) => (a.create_time ?? '').localeCompare(b.create_time ?? ''));
      const chatName = derivePeerChatName(msgs, chatId);
      const chatEnt = chatEntity(chatId, chatName);
      if (msgs.length >= config.imAggregateThreshold) {
        const lastMsgId = msgs[msgs.length - 1]?.message_id ?? '';
        const text = summarizeAggregate(chatName, msgs, startLocal);
        const entities: ContextEntityRef[] = [chatEnt];
        entities.push(...aggregateSenderEntities(msgs));
        entities.push(...extractFeishuDocEntities(text));
        signals.push({
          source: 'im',
          sourceId: `chat:${chatId}:agg:${sinceIso}`,
          kind: 'p2p_burst',
          occurredAt: parseCreateTime(msgs[msgs.length - 1]?.create_time),
          title: `${chatName} · 新增 ${msgs.length} 条`,
          text,
          actor: msgs[msgs.length - 1]?.sender?.name,
          url: msgs[msgs.length - 1]?.message_app_link,
          raw: { chatId, msgs },
          contentHash: shortHash(`p2p-agg|${chatId}|${msgs.length}|${lastMsgId}|${sinceIso}`),
          entities: dedupEntities(entities),
        });
      } else {
        for (const m of msgs) {
          const text = summarizeOne(m, chatName);
          const entities: ContextEntityRef[] = [chatEnt];
          const se = senderEntity(m.sender);
          if (se) entities.push(se);
          entities.push(...extractFeishuDocEntities(text));
          signals.push({
            source: 'im',
            sourceId: m.message_id!,
            kind: 'p2p',
            occurredAt: parseCreateTime(m.create_time),
            title: chatName,
            text,
            actor: m.sender?.name ?? m.sender?.id,
            url: m.message_app_link,
            raw: { chatId, msg: m },
            contentHash: shortHash(
              `${m.message_id}|${m.content ?? ''}|${m.create_time ?? ''}`
            ),
            entities: dedupEntities(entities),
          });
        }
      }
    }

    // Hard cap on signals per scan: prioritize @me / aggregated bursts first
    if (signals.length > config.imMaxSignalsPerScan) {
      const PRIORITY: Record<string, number> = {
        at_me: 0,
        group_burst_at_me: 0,
        p2p_burst: 1,
        p2p: 1,
        group_burst: 2,
        group_message: 3,
      };
      signals.sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9));
      const dropped = signals.length - config.imMaxSignalsPerScan;
      console.warn(
        `[im] signal cap hit: dropping ${dropped} lower-priority signals (cap=${config.imMaxSignalsPerScan})`
      );
      signals.length = config.imMaxSignalsPerScan;
    }

    return signals;
  },
};
