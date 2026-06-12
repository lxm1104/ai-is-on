import crypto from 'node:crypto';
import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import { toLocalTzIso } from '../util/iso.js';
import { getMyOpenId } from '../util/identity.js';
import { extractFeishuDocEntities } from '../util/extractFeishuDocRefs.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';
import type { CollectResult, Collector, RawSignal } from './types.js';

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
  // 飞书「回复」消息：指向被回复消息的 message_id（chat-messages-list /
  // messages-search 都返回，非回复消息为 null/缺省）。丢掉它会让顺序平铺的
  // 渲染把回复读成对前一条消息的延续。
  reply_to?: string | null;
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

// ---------- reply threading (引用回复还原) ----------
//
// 真实误判案例：用户 6-11 晚提了图片预览需求；6-12 下午丘晓骁先发了字体清单链接，
// 4 分钟后「回复」昨天那条需求消息说"这个有需求文档不 下周启动"。顺序平铺渲染下，
// LLM 把"这个"理解成紧邻的字体清单。修复：渲染对话行时把被回复消息内嵌成引用
// 标注 `（回复 <sender> <time>「<snippet>」）<content>`，结构上还原对话指向。
// 被回复消息常在 context 窗口（默认 2h horizon）之外——本地找不到时用
// messages-mget 按 id 反查（soft-fail，失败退化为"回复更早的一条消息"）。

export type ReplyIndex = Map<string, ImMessage>;

const REPLY_SNIPPET_MAX = 60;

// 本地索引：msgs 里所有有 message_id 的消息。纯函数，便于单测。
export function buildReplyIndex(msgs: ImMessage[]): ReplyIndex {
  const index: ReplyIndex = new Map();
  for (const m of msgs) {
    if (m.message_id) index.set(m.message_id, m);
  }
  return index;
}

// 被回复但不在本地索引里的 message_id（去重）。纯函数，便于单测。
export function collectUnresolvedReplyTargets(
  msgs: ImMessage[],
  index: ReplyIndex
): string[] {
  const out = new Set<string>();
  for (const m of msgs) {
    if (m.reply_to && !index.has(m.reply_to)) out.add(m.reply_to);
  }
  return [...out];
}

type MessagesMgetResp = {
  ok?: boolean;
  data?: { messages?: ImMessage[] };
};

// 防御上限：单 tick 反查的被回复消息数。正常对话里 unresolved 引用是个位数，
// 超出多半是异常数据，宁可少标注也不放大 API 压力。
const REPLY_MGET_MAX = 100;

async function fetchMessagesByIds(ids: string[]): Promise<ImMessage[]> {
  const out: ImMessage[] = [];
  const capped = ids.slice(0, REPLY_MGET_MAX);
  for (let i = 0; i < capped.length; i += 50) {
    const chunk = capped.slice(i, i + 50);
    const resp = await runLarkCliJson<MessagesMgetResp>([
      'im',
      '+messages-mget',
      '--as',
      'user',
      '--no-reactions',
      '--message-ids',
      chunk.join(','),
      '--format',
      'json',
    ]);
    if (resp.ok && resp.data?.messages) out.push(...resp.data.messages);
  }
  return out;
}

// 本地索引 + mget 兜底。fetcher 可注入便于单测；失败 soft-fail（标注退化，采集不挂）。
export async function resolveReplyIndex(
  msgs: ImMessage[],
  myOpenId: string,
  fetcher: (ids: string[]) => Promise<ImMessage[]> = fetchMessagesByIds
): Promise<ReplyIndex> {
  const index = buildReplyIndex(msgs);
  const missing = collectUnresolvedReplyTargets(msgs, index);
  if (missing.length === 0) return index;
  try {
    const fetched = await fetcher(missing);
    tagSelf(fetched, myOpenId);
    for (const p of fetched) {
      if (p.message_id && !index.has(p.message_id)) index.set(p.message_id, p);
    }
  } catch (err) {
    console.warn(
      `[im] reply target mget failed (annotation falls back): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return index;
}

// 对话行的 content 渲染：120 字截断 + 引用回复标注。标注放 content 开头，
// 不破坏 "- [time] sender: content" 行结构（contextProjection 的解析正则不受影响）。
export function renderMsgContent(m: ImMessage, replyIndex?: ReplyIndex): string {
  const content = (m.content ?? '').replace(/\s+/g, ' ').trim();
  const short = content.length > 120 ? content.slice(0, 120) + '…' : content;
  if (!m.reply_to) return short;
  const parent = replyIndex?.get(m.reply_to);
  if (!parent) return `（回复更早的一条消息）${short}`;
  const ptext = (parent.content ?? '').replace(/\s+/g, ' ').trim();
  const snip =
    ptext.length > REPLY_SNIPPET_MAX ? ptext.slice(0, REPLY_SNIPPET_MAX) + '…' : ptext;
  const when = parent.create_time ? ` ${parent.create_time}` : '';
  return `（回复 ${senderLabel(parent)}${when}「${snip}」）${short}`;
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
  chatName: string,
  replyIndex?: ReplyIndex
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
    const short = renderMsgContent(m, replyIndex);
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
  // MVP30: 当 msgs 含「触发窗口之前」的回溯上下文时传入 sinceIsoUtc。"新增 N 条"只数 create_time
  //   晚于 novelty 边界(sinceIsoUtc)的消息；更早的往来（含「我」侧）照样渲染进列表，供 triage 判断
  //   我是否已参与。不传 = 旧行为（全部计入"新增"），保持 group 路径与历史测试不变。
  // replyIndex: 引用回复标注用的 message_id → 消息索引（见 renderMsgContent）。
  opts?: { sinceIsoUtc?: string; replyIndex?: ReplyIndex }
): string {
  const lines: string[] = [];
  lines.push(`会话：${chatName}`);
  if (opts?.sinceIsoUtc) {
    const sinceIsoUtc = opts.sinceIsoUtc;
    const novelCount = msgs.filter(
      (m) => parseCreateTime(m.create_time) > sinceIsoUtc
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
    const short = renderMsgContent(m, opts?.replyIndex);
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
  raw: unknown,
  replyIndex?: ReplyIndex
): RawSignal {
  const text = summarizeOneWithContext(m, chatMsgs, chatName, replyIndex);
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

// MVP33 U1：返回 hasMore（asc + 3 页截断 ⇒ 窗口最新段缺失），调用方据此 clamp 覆盖水位。
// resp 非 ok 也算覆盖不完整（hasMore=true）——抓了半截不能假装扫全了。
async function listMessagesInChat(
  chatId: string,
  startIso: string,
  endIso: string
): Promise<{ msgs: ImMessage[]; hasMore: boolean }> {
  const out: ImMessage[] = [];
  let pageToken: string | undefined;
  let hasMore = false;
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
    if (!resp.ok || !resp.data) {
      hasMore = page === 0 ? out.length > 0 || !resp.ok : true;
      break;
    }
    const msgs = resp.data.messages ?? [];
    for (const m of msgs) {
      if (m.chat_id == null) m.chat_id = chatId;
      out.push(m);
    }
    hasMore = resp.data.has_more === true && !!resp.data.page_token;
    if (!hasMore) break;
    pageToken = resp.data.page_token;
  }
  return { msgs: out, hasMore };
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
): Promise<{ msgs: ImMessage[]; hasMore: boolean }> {
  // messages-search with --chat-type p2p. MVP30: pageLimit raised by caller when the
  // window is widened for context lookback, so older me-side turns aren't truncated.
  // MVP33 U1：透出 hasMore（最新锚定 ⇒ has_more 时缺的是窗口最老段，2026-06-12 专利
  // 事故即此截断静默丢了回灌窗口最早 8h）。resp 非 ok 直接抛——novelty 覆盖不能装没事。
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
  if (!resp.ok) throw new Error('messages-search p2p returned ok=false');
  return { msgs: resp.data?.messages ?? [], hasMore: resp.data?.has_more === true };
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
// MVP33 U1：与 listP2pMessages 同形——透出 hasMore、非 ok 抛错。soft-fail 语义上移到
// collect()：novelty 段失败 → 水位 clamp 到 since（本轮不推进，下轮重扫）；context 段失败
// → 照旧吞掉（context 有损可接受）。
async function listMyGroupMessages(
  startLocal: string,
  endLocal: string,
  myOpenId: string
): Promise<{ msgs: ImMessage[]; hasMore: boolean }> {
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
  const resp = await runLarkCliJson<MessagesSearchResp>(args);
  if (!resp.ok) throw new Error('messages-search my-group returned ok=false');
  return { msgs: resp.data?.messages ?? [], hasMore: resp.data?.has_more === true };
}

// ---------- MVP33 U1: 覆盖水位工具 ----------

export type WindowFetch = (
  startMs: number,
  endMs: number
) => Promise<{ msgs: ImMessage[]; hasMore: boolean }>;

/**
 * 覆盖一个「最新锚定」搜索源的 novelty 窗口 (sinceMs, endMs]。
 * messages-search 无 sort 参数、has_more 时返回的是窗口**最新**的连续段（实测）——
 * 缺的是最老段，所以截断时只能收缩窗口末端重试（窗口够小则分页上限够用），
 * 不能像 asc 源那样 clamp。减半到 minWindowMs 仍超限 → 有界接受 + truncated=true
 * （病态：floor 窗口内消息数超过分页上限；丢失有界且调用方必须大声记录）。
 * 完整覆盖判定：!hasMore，或最老返回消息 ≤ sinceMs（返回集已盖住整个 novelty 窗口）。
 * 纯逻辑 + 注入 fetch，便于单测（mvp33-im-window-cover.test.ts）。
 */
export async function coverNewestAnchoredWindow(opts: {
  sinceMs: number;
  endMs: number;
  minWindowMs: number;
  fetch: WindowFetch;
}): Promise<{ msgs: ImMessage[]; coveredUntilMs: number; truncated: boolean }> {
  let endMs = opts.endMs;
  for (;;) {
    const { msgs, hasMore } = await opts.fetch(opts.sinceMs, endMs);
    if (!hasMore) return { msgs, coveredUntilMs: endMs, truncated: false };
    const oldestMs = msgs.length
      ? Math.min(...msgs.map((m) => Date.parse(parseCreateTime(m.create_time))))
      : Number.POSITIVE_INFINITY;
    if (oldestMs <= opts.sinceMs) return { msgs, coveredUntilMs: endMs, truncated: false };
    const span = endMs - opts.sinceMs;
    if (span <= opts.minWindowMs) return { msgs, coveredUntilMs: endMs, truncated: true };
    endMs = opts.sinceMs + Math.floor(span / 2);
  }
}

/** 水位发射不变量：每轮事件只产自 (since, coveredUntil]，跨轮窗口两两不相交。 */
export function dropBeyondWatermark(msgs: ImMessage[], coveredUntilIso: string): ImMessage[] {
  return msgs.filter((m) => parseCreateTime(m.create_time) <= coveredUntilIso);
}

// per-chat 抓取失败（异常 / ok=false 的空截断）的水位策略。
// 实测坑（2026-06-12）：某个群的 chat-messages-list 永久报错（lark-cli exit 1），若每次都把
// 全局水位 clamp 到 since，一个坏群就把整个 im 源卡死——无界停摆比有界、大声的 chat 级
// 损失更糟。策略：连续前 N 次按"未覆盖"处理（水位停在 since，给瞬时故障重试窗口），
// 超过 N 次降级为该群窗口数据损失（error 日志，不再阻塞全局水位）；成功一次即清零。
const CHAT_FETCH_FAIL_RETRY_TICKS = 2;
const chatFetchFailStreak = new Map<string, number>();

export function chatFailureClampDecision(
  chatId: string,
  retryTicks = CHAT_FETCH_FAIL_RETRY_TICKS,
  streaks: Map<string, number> = chatFetchFailStreak
): { shouldClamp: boolean; streak: number } {
  const streak = (streaks.get(chatId) ?? 0) + 1;
  streaks.set(chatId, streak);
  return { shouldClamp: streak <= retryTicks, streak };
}

export function noteChatFetchOk(
  chatId: string,
  streaks: Map<string, number> = chatFetchFailStreak
): void {
  streaks.delete(chatId);
}

// ---------- main collector ----------

export const imCollector: Collector = {
  name: 'im',
  intervalMs: config.imIntervalMs,
  async collect(since: Date | null): Promise<CollectResult> {
    const now = new Date();
    const lookbackMs = (config.imFirstScanHours || 1) * 60 * 60 * 1000;
    const sinceDate = since ?? new Date(now.getTime() - lookbackMs);
    const sinceMs = sinceDate.getTime();
    // MVP33 U1：有界追赶窗口。正常 tick（3min）远小于上限、行为不变；停摆后窗口截到
    // imMaxScanWindowMs，每轮排干一段，水位逐轮推进——回灌不再一口吞 19h 然后被分页截断。
    const hardEndMs = Math.min(now.getTime(), sinceMs + config.imMaxScanWindowMs);
    const hardEnd = new Date(hardEndMs);
    const startLocal = toLocalTzIso(sinceDate);
    const endLocal = toLocalTzIso(hardEnd);
    const sinceIso = sinceDate.toISOString();
    // MVP30: context-fetch window, decoupled from the [since, hardEnd] trigger window. Used to
    //   reach back for older turns so the user's own earlier messages are available; the
    //   actual context DEPTH is by-count (sliceContextAndNovelty, last imContextLookbackMsgs),
    //   and "新增" stays gated on sinceIso so older messages only enrich context, never re-fire.
    //   Time here is just a fetch ceiling (Lark search only takes start/end), not the unit.
    //   MVP33：context 段与 novelty 段分两次抓——novelty 段必须完整覆盖（收缩重试），
    //   context 段有损可接受（截断/失败都不影响水位）。
    const ctxFetchStartDate = new Date(
      Math.min(sinceMs, hardEndMs - config.imContextFetchHorizonMs)
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

    // MVP33 U1：各路径的覆盖 clamp。水位 = min(hardEnd, 所有 clamp)，且不倒退（≥ since）。
    const coverClampsMs: number[] = [];
    const clampCover = (ms: number, why: string) => {
      const clamped = Math.max(sinceMs, ms);
      coverClampsMs.push(clamped);
      console.warn(`[im] 覆盖水位 clamp → ${new Date(clamped).toISOString()}（${why}），下轮续扫`);
    };

    // ---- groups ----
    const groups = await listAllGroups();
    type ChatHit = { chat: ChatListChat; msgs: ImMessage[] };
    type PeerHit = { chat: ChatListChat; msgs: ImMessage[]; hasMore: boolean };

    // Step 1: fetch peer-side messages per group (defer filtering until merge).
    // MVP33：单 chat 抓取失败/截断 → hasMore=true，由 Step 3 clamp 水位，不再静默丢。
    const perChatPeer: PeerHit[] = (
      await fetchInParallel(
        groups,
        async (chat): Promise<PeerHit> => {
          if (!chat.chat_id) return { chat, msgs: [], hasMore: false };
          try {
            const r = await listMessagesInChat(chat.chat_id, sinceIso, hardEnd.toISOString());
            return { chat, msgs: r.msgs, hasMore: r.hasMore };
          } catch (err) {
            console.warn(
              `[im] group ${chat.chat_id} fetch failed: ${err instanceof Error ? err.message : String(err)}`
            );
            return { chat, msgs: [], hasMore: true };
          }
        },
        config.imChatFetchConcurrency
      )
    ).filter((x): x is PeerHit => !!x);

    // Step 2: fetch all my-group msgs in one call (A-2), bucket by chat_id.
    // Independent toggle imEnableMyGroupFetch lets us land A-1 alone.
    // MVP33：novelty 段（since→hardEnd）必须完整覆盖——coverNewestAnchoredWindow 收缩重试，
    //   失败 clamp 水位到 since（本轮不推进）。context 段（ctxStart→since）有损可接受。
    let myGroupMsgs: ImMessage[] = [];
    if (config.imIncludeMyMessages && config.imEnableMyGroupFetch) {
      try {
        const cover = await coverNewestAnchoredWindow({
          sinceMs,
          endMs: hardEndMs,
          minWindowMs: config.imMinScanWindowMs,
          fetch: (s, e) =>
            listMyGroupMessages(toLocalTzIso(new Date(s)), toLocalTzIso(new Date(e)), myOpenId),
        });
        if (cover.truncated) {
          console.error(
            `[im] my-group novelty 窗口收缩到 floor 仍超限，接受有界截断（覆盖到 ${new Date(cover.coveredUntilMs).toISOString()}）`
          );
        }
        if (cover.coveredUntilMs < hardEndMs) clampCover(cover.coveredUntilMs, 'my-group 窗口收缩');
        myGroupMsgs = cover.msgs;
      } catch (err) {
        console.warn(
          `[im] my-group novelty fetch failed（水位本轮不推进）: ${err instanceof Error ? err.message : String(err)}`
        );
        clampCover(sinceMs, 'my-group fetch 失败');
      }
      if (ctxFetchStartDate.getTime() < sinceMs) {
        try {
          const ctxSeg = await listMyGroupMessages(ctxFetchStartLocal, startLocal, myOpenId);
          myGroupMsgs = mergeMessagesByMessageId(myGroupMsgs, ctxSeg.msgs);
        } catch {
          /* context 段有损可接受 */
        }
      }
    }
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
      // MVP33：asc + 3 页截断 ⇒ 该 chat 窗口最新段缺失。
      // - 抓到了部分消息：clamp 到最后返回消息 −60s（分钟粒度：同分钟可能被分页切半，
      //   宁可下轮重扫一分钟）——诚实推进。
      // - 一条没抓到（异常/ok=false）：走失败 streak 策略，防一个永久坏群卡死整源。
      if (peerHit?.hasMore) {
        const last = peerMsgsRaw[peerMsgsRaw.length - 1];
        const lastMs = last ? Date.parse(parseCreateTime(last.create_time)) : NaN;
        if (Number.isFinite(lastMs)) {
          clampCover(lastMs - 60_000, `群 ${peerHit.chat.name ?? chatId} per-chat 截断`);
          noteChatFetchOk(chatId);
        } else {
          const d = chatFailureClampDecision(chatId);
          if (d.shouldClamp) {
            clampCover(sinceMs, `群 ${peerHit.chat.name ?? chatId} 抓取失败（连续第 ${d.streak} 次，重试中）`);
          } else {
            console.error(
              `[im] 群 ${peerHit.chat.name ?? chatId} 连续 ${d.streak} 次抓取失败，降级为该群窗口数据损失（不再阻塞全局水位）`
            );
          }
        }
      } else if (peerHit) {
        noteChatFetchOk(chatId);
      }
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

    // ---- p2p fetch ----
    // MVP33：fetch 上移到群信号循环之前——水位要等全部抓取路径的 clamp 才能定格，
    // 而两个信号循环都必须在水位定格后运行（事件只产自 (since, coveredUntil]）。
    //
    // MVP16-A: prepareMessages 让 me-side 打 is_me、thread_replies 平铺、稳定排序。
    // MVP24: messages-search --chat-type p2p 不返回跨租户(external)单聊，
    //   由 chat-list --types=p2p 枚举 + 逐个 chat-messages-list 补。
    // novelty 段（since→hardEnd）完整覆盖：最新锚定源截断时收缩重试（不能 clamp，
    //   has_more 缺的是最老段——2026-06-12 专利事故正是这里静默丢了回灌最早 8h）。
    // 硬失败直接抛 → 整轮失败、水位不动（与历史一致：此处原本就无 try/catch）。
    let internalP2pRaw: ImMessage[] = [];
    {
      const cover = await coverNewestAnchoredWindow({
        sinceMs,
        endMs: hardEndMs,
        minWindowMs: config.imMinScanWindowMs,
        fetch: (s, e) =>
          listP2pMessages(
            toLocalTzIso(new Date(s)),
            toLocalTzIso(new Date(e)),
            config.imP2pPageLimit
          ),
      });
      if (cover.truncated) {
        console.error(
          `[im] p2p novelty 窗口收缩到 floor 仍超限，接受有界截断（覆盖到 ${new Date(cover.coveredUntilMs).toISOString()}）`
        );
      }
      if (cover.coveredUntilMs < hardEndMs) clampCover(cover.coveredUntilMs, 'p2p 窗口收缩');
      internalP2pRaw = cover.msgs;
      // context 段（ctxStart→since）：有损可接受，失败/截断不影响水位。
      if (ctxFetchStartDate.getTime() < sinceMs) {
        try {
          const ctxSeg = await listP2pMessages(
            ctxFetchStartLocal,
            startLocal,
            config.imP2pPageLimit
          );
          internalP2pRaw = mergeMessagesByMessageId(internalP2pRaw, ctxSeg.msgs);
        } catch {
          /* context 段有损可接受 */
        }
      }
    }

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
            try {
              const r = await listMessagesInChat(chat.chat_id, sinceIso, hardEnd.toISOString());
              const last = r.msgs[r.msgs.length - 1];
              const lastMs = last ? Date.parse(parseCreateTime(last.create_time)) : NaN;
              if (r.hasMore && Number.isFinite(lastMs)) {
                clampCover(lastMs - 60_000, `外部单聊 ${chat.name ?? chat.chat_id} per-chat 截断`);
                noteChatFetchOk(chat.chat_id);
              } else if (r.hasMore) {
                const d = chatFailureClampDecision(chat.chat_id);
                if (d.shouldClamp) {
                  clampCover(sinceMs, `外部单聊 ${chat.name ?? chat.chat_id} 抓取失败（连续第 ${d.streak} 次，重试中）`);
                } else {
                  console.error(
                    `[im] 外部单聊 ${chat.name ?? chat.chat_id} 连续 ${d.streak} 次抓取失败，降级为该聊窗口数据损失`
                  );
                }
              } else {
                noteChatFetchOk(chat.chat_id);
              }
              return r.msgs;
            } catch (err) {
              console.warn(
                `[im] external p2p ${chat.chat_id} fetch failed: ${err instanceof Error ? err.message : String(err)}`
              );
              const d = chatFailureClampDecision(chat.chat_id);
              if (d.shouldClamp) {
                clampCover(sinceMs, `外部单聊 ${chat.name ?? chat.chat_id} 抓取失败（连续第 ${d.streak} 次，重试中）`);
              } else {
                console.error(
                  `[im] 外部单聊 ${chat.name ?? chat.chat_id} 连续 ${d.streak} 次抓取失败，降级为该聊窗口数据损失`
                );
              }
              return [];
            }
          },
          config.imChatFetchConcurrency
        );
        externalP2pRaw = hits.flatMap((h) => h ?? []); // fetchInParallel 失败项为 undefined
      } catch (err) {
        // MVP33：枚举失败不再静默放行——外部单聊窗口未覆盖，水位本轮不推进。
        console.warn(
          `[im] external p2p fetch failed（水位本轮不推进）: ${err instanceof Error ? err.message : String(err)}`
        );
        clampCover(sinceMs, '外部单聊枚举失败');
      }
    }

    const p2pMsgsAll = prepareMessages(
      mergeMessagesByMessageId(internalP2pRaw, externalP2pRaw),
      myOpenId
    );

    // ---- MVP33 U1：水位定格 + 发射过滤 ----
    // 不变量：每轮事件只产自 (since, coveredUntil]，跨轮窗口两两不相交（agg 不重复计数；
    // 超出水位的消息本轮丢弃、下轮以 novel 身份重来，单消息 UNIQUE 去重兜底）。
    const coveredUntilMs = Math.max(sinceMs, Math.min(hardEndMs, ...coverClampsMs));
    const coveredUntilIso = new Date(coveredUntilMs).toISOString();
    for (const hit of perChat) hit.msgs = dropBeyondWatermark(hit.msgs, coveredUntilIso);
    const perChatEmit = perChat.filter((x) => x.msgs.length > 0);
    const p2pMsgs = dropBeyondWatermark(p2pMsgsAll, coveredUntilIso);

    // 引用回复索引（全局，message_id 全局唯一）：本地消息 + mget 反查窗口外的被回复消息。
    const groupReplyIndex = await resolveReplyIndex(
      perChatEmit.flatMap((x) => x.msgs),
      myOpenId
    );

    for (const { chat, msgs } of perChatEmit) {
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
        const text = summarizeAggregate(chatName, ctx, startLocal, {
          sinceIsoUtc: sinceIso,
          replyIndex: groupReplyIndex,
        });
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
              buildSelfActionSignal(
                det,
                m,
                ctx,
                chatName,
                chatEnt,
                { chat, msg: m, contextMsgs: ctx },
                groupReplyIndex
              )
            );
            continue;
          }
          // MVP16-A hotfix: render with surrounding chat context so Triage can
          // see double-sided exchange even when only 1-2 peer msgs in window.
          const text = summarizeOneWithContext(m, ctx, chatName, groupReplyIndex);
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

    // ---- p2p signals ----
    // MVP33：fetch 已上移到水位定格之前；这里只做渲染与信号构建（msgs 已过滤到水位内）。
    // 引用回复索引（p2p 全量消息 + mget 反查）。真实案例：被回复消息在 2h fetch
    // horizon 之外（前一天的需求消息），只能靠 mget 拿到原文。
    const p2pReplyIndex = await resolveReplyIndex(p2pMsgs, myOpenId);
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
        const text = summarizeAggregate(chatName, ctx, startLocal, {
          sinceIsoUtc: sinceIso,
          replyIndex: p2pReplyIndex,
        });
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
              buildSelfActionSignal(
                det,
                m,
                ctx,
                chatName,
                chatEnt,
                { chatId, msg: m, contextMsgs: ctx },
                p2pReplyIndex
              )
            );
            continue;
          }
          // MVP16-A hotfix: render with surrounding double-sided context so
          // Triage can see whether the user already responded to this message.
          // raw.msg stays the single focused message; raw.contextMsgs carries
          // the context slice for downstream replay if needed.
          const text = summarizeOneWithContext(m, ctx, chatName, p2pReplyIndex);
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

    // MVP33 U1：信号上限语义变更——原先按优先级**永久丢弃**低优信号（数据丢失）；
    // 现按 occurredAt 保留最早一段、水位 clamp 到首条被丢信号 −60s：积压变成多轮排水，
    // 去重保证重扫幂等。边界：全部信号同分钟无法按时间切分 → 全保留（允许小幅超限）。
    let finalCoveredUntilMs = coveredUntilMs;
    if (signals.length > config.imMaxSignalsPerScan) {
      signals.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      const cutIso = signals[config.imMaxSignalsPerScan].occurredAt;
      const clampMs = Date.parse(cutIso) - 60_000;
      const kept = signals.filter((s) => Date.parse(s.occurredAt) <= clampMs);
      if (kept.length === 0) {
        console.warn(
          `[im] signal cap (${config.imMaxSignalsPerScan}) 命中但信号集中在同一分钟，全保留 ${signals.length} 条`
        );
      } else {
        finalCoveredUntilMs = Math.max(sinceMs, Math.min(finalCoveredUntilMs, clampMs));
        console.warn(
          `[im] signal cap 命中：保留最早 ${kept.length}/${signals.length} 条，` +
            `水位回退到 ${new Date(finalCoveredUntilMs).toISOString()}，下轮排水`
        );
        signals.length = 0;
        signals.push(...kept);
      }
    }

    return { signals, coveredUntil: new Date(finalCoveredUntilMs).toISOString() };
  },
};
