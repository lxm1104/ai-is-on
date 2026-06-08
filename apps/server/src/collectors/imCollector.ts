import crypto from 'node:crypto';
import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import { toLocalTzIso } from '../util/iso.js';
import { getMyOpenId } from '../util/identity.js';
import { extractFeishuDocEntities } from '../util/extractFeishuDocRefs.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';
import type { Collector, RawSignal } from './types.js';

// ---------- types ----------

export type ImMessage = {
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
  // MVP16-A: Lark embeds replies inside a parent message via .thread_replies[].
  // Type declared so we can recurse safely; runtime check `Array.isArray` still needed.
  thread_id?: string;
  thread_replies?: ImMessage[];
  // MVP16-A: collector-internal, derived from sender.id === myOpenId. Not from Lark.
  // Persisted into events.raw_json so downstream can re-derive without re-resolving identity.
  // Also annotated on `message_position` to support stable tiebreak sort.
  is_me?: boolean;
  message_position?: string;
};

type ChatListChat = {
  chat_id?: string;
  name?: string;
  description?: string;
  external?: boolean;
  chat_status?: string;
  // MVP24: present on chat-list --types=p2p results; used to defensively keep p2p only.
  chat_mode?: string;
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

function isWanted(msg: ImMessage): boolean {
  if (!msg.message_id) return false;
  if (msg.deleted) return false;
  if (msg.msg_type === 'system') return false;
  // MVP16-A: me-side messages no longer filtered here. Downstream uses `is_me`
  // to distinguish (set by tagSelf). The hard kill switch IM_INCLUDE_MY_MESSAGES
  // is applied in prepareMessages.
  return true;
}

// MVP16-A: Lark hangs in-thread replies under a parent message's .thread_replies.
// Semantically they're sequential utterances of the same conversation — flatten
// them so downstream rendering, is_me tagging and sort all treat them equally.
export function flattenThreadReplies(msgs: ImMessage[]): ImMessage[] {
  const out: ImMessage[] = [];
  for (const m of msgs) {
    out.push(m);
    if (Array.isArray(m.thread_replies) && m.thread_replies.length > 0) {
      for (const r of m.thread_replies) {
        // Inherit parent context fields the API sometimes omits on replies.
        if (!r.chat_id) r.chat_id = m.chat_id;
        if (!r.thread_id) r.thread_id = m.thread_id;
        out.push(r);
      }
    }
  }
  return out;
}

// MVP16-A: derive is_me purely from sender.id. Mutates msgs in place because the
// flag travels into events.raw_json via the same object references.
export function tagSelf(msgs: ImMessage[], myOpenId: string): void {
  for (const m of msgs) {
    m.is_me = m.sender?.id === myOpenId;
  }
}

// MVP16-A: create_time is local-tz to-the-minute, so multiple messages in the
// same minute compare as equal. Use message_position (Lark's global ascending
// sequence number) as tiebreaker so me→peer→me→peer ordering stays correct.
export function sortMessagesStably(msgs: ImMessage[]): ImMessage[] {
  return [...msgs].sort((a, b) => {
    const ta = a.create_time ?? '';
    const tb = b.create_time ?? '';
    if (ta !== tb) return ta.localeCompare(tb);
    const pa = Number(a.message_position ?? 0);
    const pb = Number(b.message_position ?? 0);
    return pa - pb;
  });
}

// MVP16-A: single pipeline that callers compose with their fetch step:
//   1) flatten thread_replies into a single sequence
//   2) tag is_me on every msg (including former replies)
//   3) stable sort by (create_time, message_position)
//   4) honour IM_INCLUDE_MY_MESSAGES kill switch (drops me-side entirely)
//   5) apply isWanted (deleted / system / no id)
export function prepareMessages(rawMsgs: ImMessage[], myOpenId: string): ImMessage[] {
  const flat = flattenThreadReplies(rawMsgs);
  tagSelf(flat, myOpenId);
  const sorted = sortMessagesStably(flat);
  if (!config.imIncludeMyMessages) {
    return sorted.filter((m) => !m.is_me).filter(isWanted);
  }
  return sorted.filter(isWanted);
}

// MVP16-A: render label as "我" for me-side, otherwise sender name (or id fallback).
function senderLabel(m: ImMessage): string {
  if (m.is_me) return '我';
  return m.sender?.name || m.sender?.id || '?';
}

// MVP16-A: merge two streams of messages keeping first occurrence per message_id.
// Used in A-2 to fold the my-group messages (from messages-search --sender=me)
// into the peer-only chat-messages-list results. message_id is Lark's globally
// unique stable id, so dedup is straightforward.
export function mergeMessagesByMessageId(
  ...streams: ImMessage[][]
): ImMessage[] {
  const seen = new Set<string>();
  const out: ImMessage[] = [];
  for (const stream of streams) {
    for (const m of stream) {
      if (!m.message_id || seen.has(m.message_id)) continue;
      seen.add(m.message_id);
      out.push(m);
    }
  }
  return out;
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
// MVP16-A: skip me-side messages so user does not become an actor entity in
// signals about themselves.
function aggregateSenderEntities(msgs: ImMessage[]): ContextEntityRef[] {
  const out: ContextEntityRef[] = [];
  const seenPersonName = new Set<string>();
  let seenBot = false;
  for (const m of msgs) {
    if (m.is_me) continue;
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

// MVP24: p2p 会话显示名。外部单聊用 chat-list 拿到的真实名 + （外部）标记；
// 否则回退到 derivePeerChatName（从 sender.name 推断）。纯函数，便于单测。
export function p2pChatDisplayName(
  chatId: string,
  msgs: ImMessage[],
  externalNames: Map<string, string>
): string {
  const explicit = externalNames.get(chatId);
  if (explicit) return `单聊 · ${explicit}（外部）`;
  return derivePeerChatName(msgs, chatId);
}

function summarizeOne(msg: ImMessage, chatName: string): string {
  const lines: string[] = [];
  if (chatName) lines.push(`会话：${chatName}`);
  // MVP16-A: explicit me/peer label so LLM can read conversation direction.
  const senderTypeLabel = msg.is_me ? 'me' : (msg.sender?.sender_type ?? '?');
  lines.push(`发送者：${senderLabel(msg)}（${senderTypeLabel}）`);
  if (msg.create_time) lines.push(`时间：${msg.create_time}`);
  const content = (msg.content ?? '').trim();
  if (content) {
    lines.push(`内容：${content.length > 600 ? content.slice(0, 600) + '…' : content}`);
  }
  return lines.join('\n');
}

// MVP16-A hotfix: for a single-message signal (one peer msg, peerCount < threshold),
// render the message inline with the full chat dialog so Triage can see whether
// the user already responded. Without this, kind='p2p'/'group_message' signals
// only carry the lone peer message text and the LLM cannot tell that a reply
// has happened.
//
// Differences from summarizeAggregate:
//   - The focused message is called out with a "★" pointer so the LLM knows
//     which line the signal is "about".
//   - chatMsgs is the full sorted chat sequence (含 me 侧), msg is one item of it.
export function summarizeOneWithContext(
  msg: ImMessage,
  chatMsgs: ImMessage[],
  chatName: string
): string {
  const lines: string[] = [];
  if (chatName) lines.push(`会话：${chatName}`);
  lines.push(`焦点消息：${senderLabel(msg)} @ ${msg.create_time ?? '?'}`);
  lines.push('---');
  // Render up to SUMMARY_TAIL_MAX of the surrounding context, anchored on `msg`.
  // For a long chat we still want to see what came right before/after the focus
  // message — so center the window on the focus index rather than taking only
  // first+tail.
  const focusIdx = chatMsgs.findIndex((m) => m.message_id === msg.message_id);
  let windowMsgs: ImMessage[];
  if (chatMsgs.length <= SUMMARY_TAIL_MAX) {
    windowMsgs = chatMsgs;
  } else if (focusIdx < 0) {
    // Defensive: focus not found (shouldn't happen) → fall back to tail.
    windowMsgs = chatMsgs.slice(-SUMMARY_TAIL_MAX);
  } else {
    // Centered window: ~half before, ~half after the focus.
    const half = Math.floor(SUMMARY_TAIL_MAX / 2);
    const lo = Math.max(0, focusIdx - half);
    const hi = Math.min(chatMsgs.length, lo + SUMMARY_TAIL_MAX);
    windowMsgs = chatMsgs.slice(lo, hi);
  }
  for (const m of windowMsgs) {
    const isFocus = m.message_id === msg.message_id;
    const content = (m.content ?? '').replace(/\s+/g, ' ').trim();
    const short = content.length > 120 ? content.slice(0, 120) + '…' : content;
    const prefix = isFocus ? '★' : '-';
    lines.push(`${prefix} [${m.create_time ?? '?'}] ${senderLabel(m)}: ${short}`);
  }
  return lines.join('\n');
}

// MVP16-A: first+tail snapshot strategy.
//   - For dialogues bigger than TAIL_MAX, show first message (sets opening
//     context) + ellipsis + last (TAIL_MAX-1) messages. Avoids losing the
//     opening turn when the conversation is long.
//   - Per-line cap 120 chars keeps total under ~2KB even with full TAIL_MAX.
export const SUMMARY_TAIL_MAX = 12;
export function summarizeAggregate(
  chatName: string,
  msgs: ImMessage[],
  windowStart: string,
  // MVP30: 当 msgs 含「触发窗口之前」的回溯上下文时传入此项。"新增 N 条"只数 create_time 晚于
  //   novelty 边界(sinceIsoUtc)的消息；更早的往来（含「我」侧）照样渲染进列表，供 triage 判断
  //   我是否已参与。不传 = 旧行为（全部计入"新增"），保持 group 路径与历史测试不变。
  opts?: { sinceIsoUtc: string }
): string {
  const lines: string[] = [];
  lines.push(`会话：${chatName}`);
  if (opts) {
    const novelCount = msgs.filter(
      (m) => parseCreateTime(m.create_time) > opts.sinceIsoUtc
    ).length;
    lines.push(
      `自 ${windowStart} 以来对方/我新增 ${novelCount} 条消息（下含更早往来上下文，供判断我是否已参与）`
    );
  } else {
    lines.push(`自 ${windowStart} 以来新增 ${msgs.length} 条消息`);
  }
  lines.push('---');
  type Preview = ImMessage | { __ellipsis: true; skipped: number };
  const previews: Preview[] =
    msgs.length <= SUMMARY_TAIL_MAX
      ? msgs
      : [
          msgs[0],
          { __ellipsis: true, skipped: msgs.length - SUMMARY_TAIL_MAX },
          ...msgs.slice(-(SUMMARY_TAIL_MAX - 1)),
        ];
  for (const m of previews) {
    if ('__ellipsis' in m) {
      lines.push(`- ……（中间省略 ${m.skipped} 条）……`);
      continue;
    }
    const content = (m.content ?? '').replace(/\s+/g, ' ').trim();
    const short = content.length > 120 ? content.slice(0, 120) + '…' : content;
    lines.push(`- [${m.create_time ?? '?'}] ${senderLabel(m)}: ${short}`);
  }
  return lines.join('\n');
}

// MVP30: turn a chat's full lookback slice into (a) the context window we render & judge
// over, and (b) the novelty subset that actually triggers signals. Context depth is by
// COUNT (last N messages), not time — robust to chat tempo. Guarantees novel ⊆ ctx: novel
// messages are the newest (msgs is sorted ascending), and ctx keeps at least the newest
// max(N, |novel|), so a tick with a big burst never drops a triggering message. Pure fn.
export function sliceContextAndNovelty(
  msgs: ImMessage[],
  sinceIsoUtc: string,
  maxContextMsgs: number
): { ctx: ImMessage[]; novelMsgs: ImMessage[] } {
  const isNovel = (m: ImMessage) => parseCreateTime(m.create_time) > sinceIsoUtc;
  const novelCount = msgs.reduce((n, m) => (isNovel(m) ? n + 1 : n), 0);
  const ctx = msgs.slice(-Math.max(maxContextMsgs, novelCount));
  return { ctx, novelMsgs: ctx.filter(isNovel) };
}

// ---------- MVP26.5: self-initiated action signal ----------
//
// 「我」在 IM 里主动推进事项的消息（已拉群 / @某人同步 / 发出方案 / 约时间）默认不出卡，
// 但它是 Matter 自动止催的关键 action_result 输入。detectSelfAction 只按消息**内在特征**
// 判断"这条我方消息像不像一个推进动作"，不查 Matter、不读 Matter 状态（避免 Matter→Event
// 反向依赖）；具体命中哪条 Matter 交给下游 triage + Matter Reducer。保守优先：宁可漏，也不要
// 把"我来 / 我同步"这类高频口语全部灌进 triage（§13.4）。

// 强完成态动作：过去式、明确工作动作，单独即可成信号。
const SELF_ACTION_STRONG = [
  '已发', '已发出', '发你了', '发出去了', '已拉群', '拉了群', '建好了群', '已建群',
  '已同步', '同步好了', '已联系', '联系好了', '已约', '约好了', '已创建', '已提交',
  '已发起', '已通知', '已确认', '已对接', '已安排', '已排期', '发方案了', '方案发你',
  '已艾特', '已@',
];
// 兜底正则：捕捉"已经…<动作>"这种动词与"已经"不相邻的完成态（如"已经在群里同步了"）。
const SELF_ACTION_STRONG_RE =
  /已经?[^。！？!?\n]{0,10}(发出|发你|拉群|拉了群|建群|建好群|同步|联系|约好|约了|创建|提交|发起|通知|确认|对接|安排好|安排了|艾特|@)/;

// 高频口语推进动词：需配合 disambiguator（mention / 链接 / 工作语义对象 / 对侧工作上下文）才成信号。
const SELF_ACTION_WEAK = [
  '我来', '我处理', '我同步', '我去', '我跟进', '我安排', '我对接', '我推进',
  '我负责', '我搞定', '我弄', '我发', '我约', '我建群', '我拉群', '我确认',
];

// 工作语义 token：用于 disambiguate weak 动词、判断对侧上下文是否工作相关。
const WORK_SEMANTIC = [
  '任务', '同步', '确认', '对齐', '评审', '审核', '方案', '排期', '会议', '日程',
  '对接', '跟进', '进度', '文档', '需求', '上线', '发布', '部署', '审批', '纪要',
  '复盘', '立项', '里程碑', '汇报', '评估', '拉群', '建群', '讨论', '对一下',
  '过一遍', '约', '提案', '验收',
];

// 寒暄 / 短 ack：供内部判定与测试可见。
const CASUAL_ACK = [
  '好的', '好', '收到', '嗯', '嗯嗯', 'ok', 'okay', '可以', '行', '是的', '对',
  '哈哈', '谢谢', '感谢', '辛苦了', '没问题', '好嘞', '好哒',
];

// Lark mention：content 里保留 @_user_/@_all/open_id（见 isAtMe），或渲染成 @名字。
const MENTION_RE = /@_user_|@_all|@[一-龥A-Za-z0-9]/;
const FEISHU_LINK_RE = /https?:\/\/[^\s]*(?:feishu\.cn|larksuite\.com|larkoffice\.com)\//;

export type SelfActionDetection = {
  kind: 'im_self_action' | 'im_self_action_with_context';
  reason: string;
};

function includesAny(hay: string, needles: string[]): boolean {
  return needles.some((n) => hay.includes(n));
}

/**
 * 判断一条「我」侧消息是否像一个 self-initiated 推进动作。
 * 返回 null = 不产信号（按 MVP16-A 原则照常跳过）。纯函数，便于单测。
 */
export function detectSelfAction(
  m: ImMessage,
  chatMsgs: ImMessage[],
  _myOpenId: string
): SelfActionDetection | null {
  if (!m.is_me) return null;
  const content = m.content ?? '';
  const text = content.trim();
  if (!text) return null; // 纯结构动作（只建群/加人、无文本）不产信号（§不做）

  const lower = text.toLowerCase();
  const hasStrong =
    includesAny(text, SELF_ACTION_STRONG) || SELF_ACTION_STRONG_RE.test(text);
  const hasWeak = includesAny(text, SELF_ACTION_WEAK);
  const hasMention = MENTION_RE.test(content);
  const hasLink = FEISHU_LINK_RE.test(text) || extractFeishuDocEntities(text).length > 0;
  const hasWorkSemantic =
    includesAny(text, WORK_SEMANTIC) || includesAny(lower, ['deadline', 'ddl']);
  // 同 chat 近窗口是否存在 peer-side 工作消息（→ with_context 变体 + weak disambiguator）
  const hasPeerWorkContext = chatMsgs.some(
    (p) => !p.is_me && includesAny(p.content ?? '', WORK_SEMANTIC)
  );

  const mk = (reason: string): SelfActionDetection => ({
    kind: hasPeerWorkContext ? 'im_self_action_with_context' : 'im_self_action',
    reason,
  });

  if (hasStrong) return mk('strong_action_verb');
  if (hasLink) return mk('work_object_link');
  if (hasMention && hasWorkSemantic) return mk('mention_with_work_semantic');
  if (hasWeak && (hasMention || hasLink || hasWorkSemantic || hasPeerWorkContext)) {
    return mk('weak_action_verb_with_disambiguator');
  }
  if (hasPeerWorkContext && hasWorkSemantic) return mk('peer_work_context');
  return null;
}

/**
 * 把命中的 self-action 渲染成 RawSignal。保留 chat routing entity 方便 Matter 召回；
 * actionability=record（不抬事件本身优先级）、skipTriage=false（必须过 triage 抽 action_result）、
 * semanticTags 标 signal_kind 让 triage / evaluator 区分。collector 不碰 Matter。
 */
function buildSelfActionSignal(
  det: SelfActionDetection,
  m: ImMessage,
  chatMsgs: ImMessage[],
  chatName: string,
  chatEnt: ContextEntityRef | null,
  raw: unknown
): RawSignal {
  const text = summarizeOneWithContext(m, chatMsgs, chatName);
  const entities: ContextEntityRef[] = [];
  if (chatEnt) entities.push(chatEnt);
  entities.push(...extractFeishuDocEntities(text));
  return {
    source: 'im',
    sourceId: m.message_id!,
    kind: det.kind,
    occurredAt: parseCreateTime(m.create_time),
    title: chatName,
    text,
    actor: '我',
    url: m.message_app_link,
    raw,
    contentHash: shortHash(
      `selfaction|${m.message_id}|${m.content ?? ''}|${m.create_time ?? ''}`
    ),
    entities: dedupEntities(entities),
    actionability: 'record',
    semanticTags: { signal_kind: det.kind, is_me: true, self_action_reason: det.reason },
    skipTriage: false,
  };
}

// 测试可见性
export const __selfActionInternal = {
  SELF_ACTION_STRONG,
  SELF_ACTION_STRONG_RE,
  SELF_ACTION_WEAK,
  WORK_SEMANTIC,
  CASUAL_ACK,
  buildSelfActionSignal,
};

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

// ---------- external p2p (MVP24) ----------

// MVP24: 从 chat-list 结果中挑出"正常状态的外部单聊"，并施加硬上限。
// 纯函数（无 IO，便于单测）。external=false 的内部单聊已由 messages-search 覆盖，这里剔除。
export function selectExternalP2pChats(
  chats: ChatListChat[],
  max: number
): ChatListChat[] {
  const out: ChatListChat[] = [];
  for (const c of chats) {
    if (c.chat_status && c.chat_status !== 'normal') continue;
    if (c.chat_mode && c.chat_mode !== 'p2p') continue; // 防御：仅 p2p
    if (!c.external) continue; // 内部单聊跳过
    if (!c.chat_id) continue;
    out.push(c);
    if (out.length >= max) break; // 硬上限早停
  }
  return out;
}

// MVP24: 外部联系人单聊枚举。messages-search --chat-type p2p 不返回跨租户单聊，
// 必须通过 chat-list --types=p2p 显式枚举 external 会话，再逐个 chat-messages-list。
// 刻意不带 --exclude-muted：群聊降噪用它，但外部单聊是用户主动诉求，静音的也要采。
async function listExternalP2pChats(): Promise<ChatListChat[]> {
  const collected: ChatListChat[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < config.imChatListMaxPages; page++) {
    const args: string[] = [
      'im',
      '+chat-list',
      '--as',
      'user',
      '--types',
      'p2p',
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
    collected.push(...(resp.data.chats ?? []));
    // 已累计够上限就不必再翻页（selectExternalP2pChats 会再精确截断）
    if (
      selectExternalP2pChats(collected, config.imExternalP2pMaxChats).length >=
      config.imExternalP2pMaxChats
    ) {
      break;
    }
    if (!resp.data.has_more || !resp.data.page_token) break;
    pageToken = resp.data.page_token;
  }
  return selectExternalP2pChats(collected, config.imExternalP2pMaxChats);
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

async function listP2pMessages(
  startLocal: string,
  endLocal: string,
  pageLimit = 3
): Promise<ImMessage[]> {
  // messages-search with --chat-type p2p. MVP30: pageLimit raised by caller when the
  // window is widened for context lookback, so older me-side turns aren't truncated.
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
    String(pageLimit),
    '--format',
    'json',
  ];
  const resp = await runLarkCliJson<MessagesSearchResp>(args);
  return resp.ok && resp.data?.messages ? resp.data.messages : [];
}

// MVP16-A: fetch the user's own messages sent into group chats in [start, end].
// Background:
//   - `chat-messages-list --chat-id <group>` and `messages-search --chat-type
//     group` both omit me-side messages by default (verified empirically against
//     a known active group).
//   - Only `messages-search --sender=<me>` returns them, and it returns them
//     with the same enriched fields (message_id / message_position / sender /
//     content / chat_id) so they can be merged into the per-chat lists with
//     just a dedup on message_id.
// This is a single call per scan tick — we group results by chat_id below.
async function listMyGroupMessages(
  startLocal: string,
  endLocal: string,
  myOpenId: string
): Promise<ImMessage[]> {
  const args: string[] = [
    'im',
    '+messages-search',
    '--as',
    'user',
    '--chat-type',
    'group',
    '--sender',
    myOpenId,
    '--start',
    startLocal,
    '--end',
    endLocal,
    '--page-all',
    '--page-limit',
    String(config.imMyGroupMessagesPageLimit),
    '--format',
    'json',
  ];
  try {
    const resp = await runLarkCliJson<MessagesSearchResp>(args);
    return resp.ok && resp.data?.messages ? resp.data.messages : [];
  } catch (err) {
    // Soft-fail: if the my-group call breaks, the peer-only path still works.
    // Next tick will retry. Log for ops visibility.
    console.warn(
      `[im] listMyGroupMessages failed (peer-only group fetch continues): ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
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
    // MVP30: context-fetch window, decoupled from the [since, now] trigger window. Used to
    //   reach back for older turns so the user's own earlier messages are available; the
    //   actual context DEPTH is by-count (sliceContextAndNovelty, last imContextLookbackMsgs),
    //   and "新增" stays gated on sinceIso so older messages only enrich context, never re-fire.
    //   Time here is just a fetch ceiling (Lark search only takes start/end), not the unit.
    //   p2p widens its bulk search; groups widen only the my-side bulk fetch (peer fetch stays
    //   narrow to avoid the asc + 3-page truncation trap on per-chat chat-messages-list).
    const ctxFetchStartDate = new Date(
      Math.min(sinceDate.getTime(), now.getTime() - config.imContextFetchHorizonMs)
    );
    const ctxFetchStartLocal = toLocalTzIso(ctxFetchStartDate);

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

    // Step 1: fetch peer-side messages per group (defer filtering until merge).
    const perChatPeer: ChatHit[] = (
      await fetchInParallel(
        groups,
        async (chat) => {
          if (!chat.chat_id) return { chat, msgs: [] };
          const msgs = await listMessagesInChat(chat.chat_id, sinceIso, now.toISOString());
          return { chat, msgs };
        },
        config.imChatFetchConcurrency
      )
    ).filter((x): x is ChatHit => !!x);

    // Step 2: fetch all my-group msgs in one call (A-2), bucket by chat_id.
    // Independent toggle imEnableMyGroupFetch lets us land A-1 alone.
    // MVP30: widen ONLY the my-side group fetch to the context horizon — this is the missing
    //   piece for groups ("did I already reply in an earlier window"). Peer fetch stays narrow
    //   ([since, now]) so the asc + 3-page per-chat fetch can't truncate away recent messages.
    const myGroupMsgs =
      config.imIncludeMyMessages && config.imEnableMyGroupFetch
        ? await listMyGroupMessages(ctxFetchStartLocal, endLocal, myOpenId)
        : [];
    const myMsgsByChat = new Map<string, ImMessage[]>();
    for (const m of myGroupMsgs) {
      if (!m.chat_id) continue;
      const arr = myMsgsByChat.get(m.chat_id) ?? [];
      arr.push(m);
      myMsgsByChat.set(m.chat_id, arr);
    }

    // Step 3: union of chat_ids (peer-side ∪ my-side), merge dedup by message_id,
    // then run prepareMessages on the merged list (flatten/tag/sort/filter).
    const allGroupChatIds = new Set<string>();
    for (const x of perChatPeer) {
      if (x.chat?.chat_id) allGroupChatIds.add(x.chat.chat_id);
    }
    for (const cid of myMsgsByChat.keys()) allGroupChatIds.add(cid);

    const perChat: ChatHit[] = [];
    for (const chatId of allGroupChatIds) {
      const peerHit = perChatPeer.find((x) => x.chat?.chat_id === chatId);
      const peerMsgsRaw = peerHit?.msgs ?? [];
      const meMsgsRaw = myMsgsByChat.get(chatId) ?? [];
      const merged = mergeMessagesByMessageId(peerMsgsRaw, meMsgsRaw);
      // Prefer the chat object from chat-list (carries name, external, owner_id),
      // fall back to a minimal stub built from chat_name on the my-msg side.
      const chat: ChatListChat = peerHit?.chat ?? {
        chat_id: chatId,
        name: meMsgsRaw[0]?.chat_name,
      };
      const prepared = prepareMessages(merged, myOpenId);
      if (prepared.length === 0) continue;
      perChat.push({ chat, msgs: prepared });
    }

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
      // MVP16-A: burst triggered by peer-only count so a chat where the user is
      // doing all the talking doesn't fabricate a "群里很热闹" signal.
      // MVP30: by-count context window + novelty subset (shared with p2p). burst triggers on
      // NEW peer messages only; ctx carries older turns (incl. my earlier replies) for context.
      const { ctx, novelMsgs } = sliceContextAndNovelty(
        msgs,
        sinceIso,
        config.imContextLookbackMsgs
      );
      if (novelMsgs.length === 0) continue;
      const novelPeer = novelMsgs.filter((m) => !m.is_me);
      if (novelPeer.length >= config.imAggregateThreshold) {
        // aggregated signal: one per chat per window
        const lastMsgId = ctx[ctx.length - 1]?.message_id ?? '';
        const lastPeer = novelPeer[novelPeer.length - 1];
        const text = summarizeAggregate(chatName, ctx, startLocal, { sinceIsoUtc: sinceIso });
        const entities: ContextEntityRef[] = [];
        if (chatEnt) entities.push(chatEnt);
        entities.push(...aggregateSenderEntities(ctx));
        entities.push(...extractFeishuDocEntities(text));
        signals.push({
          source: 'im',
          sourceId: `chat:${chat.chat_id}:agg:${sinceIso}`,
          // at_me classification looks at NEW peer msgs only — if @我 came from me
          // (in a self-mention edge case) it shouldn't count.
          kind: novelPeer.some((m) => isAtMe(m, myOpenId)) ? 'group_burst_at_me' : 'group_burst',
          occurredAt: parseCreateTime(novelMsgs[novelMsgs.length - 1]?.create_time),
          title: `${chatName} · 新增 ${novelMsgs.length} 条`,
          text,
          actor: undefined,
          url: lastPeer?.message_app_link ?? ctx[ctx.length - 1]?.message_app_link,
          raw: { chat, msgs: ctx },
          contentHash: shortHash(
            `agg|${chat.chat_id}|${novelMsgs.length}|${lastMsgId}|${sinceIso}`
          ),
          entities: dedupEntities(entities),
        });
      } else {
        for (const m of novelMsgs) {
          // MVP16-A: me-side single messages never become signals on their own —
          // 除非 MVP26.5 判定它是一个 self-initiated 推进动作（用户在别处办了事），
          // 那时升格成 im_self_action 信号，给 Matter Reducer 当 action_result 输入。
          // MVP30: 只对「新增」消息出信号；ctx（含回溯）作为渲染/disambiguation 上下文。
          if (m.is_me) {
            if (!config.imSelfActionEnabled) continue;
            const det = detectSelfAction(m, ctx, myOpenId);
            if (!det) continue;
            signals.push(
              buildSelfActionSignal(det, m, ctx, chatName, chatEnt, {
                chat,
                msg: m,
                contextMsgs: ctx,
              })
            );
            continue;
          }
          // MVP16-A hotfix: render with surrounding chat context so Triage can
          // see double-sided exchange even when only 1-2 peer msgs in window.
          const text = summarizeOneWithContext(m, ctx, chatName);
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
            raw: { chat, msg: m, contextMsgs: ctx },
            contentHash: shortHash(`${m.message_id}|${m.content ?? ''}|${m.create_time ?? ''}`),
            entities: dedupEntities(entities),
          });
        }
      }
    }

    // ---- p2p ----
    // MVP16-A: pass through prepareMessages so me-side msgs get is_me tagged,
    // thread_replies flattened, and stable sort applied. Lark's messages-search
    // --chat-type p2p returns both sides by default — no extra call needed.
    //
    // MVP24: messages-search --chat-type p2p 不返回跨租户(external)单聊。补一条路径：
    // chat-list --types=p2p 枚举 external 会话，逐个 chat-messages-list 拿双向，
    // 再 merge 进内部结果。内部 p2p 路径(listP2pMessages)完全不变，纯增量。
    const internalP2pRaw = await listP2pMessages(
      ctxFetchStartLocal,
      endLocal,
      config.imP2pPageLimit
    );

    let externalP2pRaw: ImMessage[] = [];
    const externalP2pNames = new Map<string, string>(); // chat_id → 真实会话名
    if (config.imEnableExternalP2p) {
      try {
        const extChats = await listExternalP2pChats();
        const hits = await fetchInParallel(
          extChats,
          async (chat): Promise<ImMessage[]> => {
            if (!chat.chat_id) return [];
            if (chat.name?.trim()) externalP2pNames.set(chat.chat_id, chat.name.trim());
            // MVP30: external p2p stays narrow — chat-messages-list is asc + 3-page capped, so
            // widening it risks truncating recent msgs; me-side here is a separate (pre-existing) gap.
            return listMessagesInChat(chat.chat_id, sinceIso, now.toISOString());
          },
          config.imChatFetchConcurrency
        );
        externalP2pRaw = hits.flatMap((h) => h ?? []); // fetchInParallel 失败项为 undefined
      } catch (err) {
        // soft-fail：外部 p2p 整体失败不影响内部 p2p（与 listMyGroupMessages 一致）
        console.warn(
          `[im] external p2p fetch failed (internal p2p continues): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const p2pMsgs = prepareMessages(
      mergeMessagesByMessageId(internalP2pRaw, externalP2pRaw),
      myOpenId
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
      // msgs is already stably sorted by prepareMessages.
      // MVP24: external p2p uses real chat name + （外部）marker; internal falls
      // back to derivePeerChatName (externalP2pNames.get returns undefined).
      const chatName = p2pChatDisplayName(chatId, msgs, externalP2pNames);
      const chatEnt = chatEntity(chatId, chatName);
      // MVP16-A: aggregation triggered by peer messages only — me-side messages
      // provide context but do not signal "对方在密集表达". peer-side also drives
      // actor/url so the card always points at the peer, never the user.
      // MVP30: by-count context window + novelty subset (shared with group). Gate "新增" on
      // the [since, now] trigger window so carried-over older turns only enrich context and
      // never re-fire; ctx (last N, incl. my earlier 「我」 turns) is what we render, killing
      // the false "我主动问、对方答完" burst (展弘单聊误催即此类).
      const { ctx, novelMsgs } = sliceContextAndNovelty(
        msgs,
        sinceIso,
        config.imContextLookbackMsgs
      );
      if (novelMsgs.length === 0) continue; // only carried-over context, nothing new → no signal
      const novelPeer = novelMsgs.filter((m) => !m.is_me);
      if (novelPeer.length >= config.imAggregateThreshold) {
        const lastMsgId = ctx[ctx.length - 1]?.message_id ?? '';
        const lastPeer = novelPeer[novelPeer.length - 1];
        const text = summarizeAggregate(chatName, ctx, startLocal, { sinceIsoUtc: sinceIso });
        const entities: ContextEntityRef[] = [chatEnt];
        entities.push(...aggregateSenderEntities(ctx));
        entities.push(...extractFeishuDocEntities(text));
        signals.push({
          source: 'im',
          sourceId: `chat:${chatId}:agg:${sinceIso}`,
          kind: 'p2p_burst',
          occurredAt: parseCreateTime(novelMsgs[novelMsgs.length - 1]?.create_time),
          title: `${chatName} · 新增 ${novelMsgs.length} 条`,
          text,
          actor: lastPeer?.sender?.name,
          url: lastPeer?.message_app_link,
          raw: { chatId, msgs: ctx },
          contentHash: shortHash(`p2p-agg|${chatId}|${novelMsgs.length}|${lastMsgId}|${sinceIso}`),
          entities: dedupEntities(entities),
        });
      } else {
        for (const m of novelMsgs) {
          // MVP16-A: skip me-side single messages — the user shouldn't get
          // attention cards about themselves talking. peer-side novel count = 0 case
          // is also covered: the burst branch above is skipped, and this loop only
          // iterates novel messages.
          // MVP26.5: 例外——若该 me-side 消息像一个 self-initiated 推进动作，升格成
          // im_self_action 信号（给 Matter Reducer 当 action_result 输入）。
          // MVP30: 只对「新增」消息出信号；ctx（含回溯）作为渲染/disambiguation 上下文传入。
          if (m.is_me) {
            if (!config.imSelfActionEnabled) continue;
            const det = detectSelfAction(m, ctx, myOpenId);
            if (!det) continue;
            signals.push(
              buildSelfActionSignal(det, m, ctx, chatName, chatEnt, {
                chatId,
                msg: m,
                contextMsgs: ctx,
              })
            );
            continue;
          }
          // MVP16-A hotfix: render with surrounding double-sided context so
          // Triage can see whether the user already responded to this message.
          // raw.msg stays the single focused message; raw.contextMsgs carries
          // the context slice for downstream replay if needed.
          const text = summarizeOneWithContext(m, ctx, chatName);
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
            raw: { chatId, msg: m, contextMsgs: ctx },
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
        // MVP26.5: self-action 是 reconcile 证据、非紧急 ask，排最后，cap 命中时优先丢。
        im_self_action_with_context: 4,
        im_self_action: 4,
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
