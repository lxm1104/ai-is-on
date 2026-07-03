/**
 * MVP78 —— 回复闭环：你在 AI is ON 的 bot 会话里直接回一句，事情就被推进。
 *
 * 之前的断点：推送（MVP77）是单向的——你收到「🙋需要你补一手」后必须点链接回 web 面板操作。
 * 现在：直接在飞书回复即可。三类回复：
 *  1) **引用回复**某条推送 → 按被引用消息的 messageId（audit notify_pushed 留底）路由到对应事项，
 *     走 MVP69/71 KEYSTONE 回填（origin=card_action 证据 + kickInvestigation 近实时重查），AI 带着你补的接着办。
 *  2) **命令**：「确认清理 / 保留 2 5 / 忽略 / 恢复 <关键词>」→ 积压大扫除批次操作（backlogSweeper）。
 *  3) **普通回复**（没引用）→ 恰好只有一张在场求助卡时按它路由（ack 里披露挂到了哪件事）；
 *     否则兜底到最近 24h 的即时推送；再不行回一条引导（请引用要补充的那条消息）。
 *
 * 安全/稳健：
 * - 只读 bot 自己的 P2P 会话（chat_id 由 sendBotDm 成功时落 settings）；bot/其它应用的消息一律跳过。
 * - create_time 只有分钟精度 → 水位回看 3 分钟重叠扫 + 已处理 message_id 环去重（最近 200 条）。
 * - 每条消息处理失败也进环（绝不因一条毒消息卡死循环）；ack 用线程回复 + 幂等键。
 * - 该会话里还有并行 Claude 会话发的消息——路由只认 audit 里有留底的推送，其余走引导，不乱猜。
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import { writeAudit } from '../boundary/auditLog.js';
import {
  getLastInstantNotifyPush,
  getNotifyPushByMessageId,
  getSetting,
  setSetting,
} from '../db.js';
import { makeIdempotencyKey, sendBotDm } from './larkNotifyService.js';
import { upsertContextUnit } from '../context/contextStore.js';
import { attachMatterContextLink, getMatterById } from '../matter/matterStore.js';
import { kickInvestigation } from '../investigation/investigationKick.js';
import { listLiveAttentionItems, updateAttentionItemStatus } from '../attention/attentionStore.js';
import { recordAttentionInteraction } from '../attention/attentionInteractions.js';
import {
  applyPendingSweepBatch,
  ignorePendingSweepBatch,
  restoreSweptMatter,
} from '../matter/backlogSweeper.js';

const CHAT_ID_KEY = 'notify:botChatId';
const WATERMARK_KEY = 'notify:botReplyWatermark';
const PROCESSED_KEY = 'notify:botReplyProcessedIds';
const OVERLAP_MS = 3 * 60_000; // create_time 分钟精度 → 重叠扫 + id 去重双保险
const FIRST_RUN_LOOKBACK_MS = 10 * 60_000;

// 与升卡前缀的稳定契约（同 larkNotifyService 的理由：字面量避免环形依赖）。
const NEEDHELP_PREFIX = 'proposal:matter-needhelp:';
const DANGLING_PREFIX = 'proposal:matter-dangling:';

export type BotChatMessage = {
  message_id: string;
  chat_id?: string;
  content?: string;
  create_time?: string; // "YYYY-MM-DD HH:mm" 或 ISO
  msg_type?: string;
  parent_id?: string;
  root_id?: string;
  sender?: { id?: string; id_type?: string; sender_type?: string };
};

type ListFn = (args: string[]) => Promise<Record<string, unknown>>;
type ReplyFn = (args: string[]) => Promise<Record<string, unknown>>;
export type BotReplyDeps = { listFn?: ListFn; replyFn?: ReplyFn };

export function parseCreateTime(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

export function extractText(content: string | undefined): string {
  const c = (content ?? '').trim();
  if (!c) return '';
  if (c.startsWith('{')) {
    try {
      const o = JSON.parse(c) as { text?: unknown };
      if (typeof o.text === 'string') return o.text.trim();
    } catch {
      /* fall through：当纯文本用 */
    }
  }
  return c;
}

async function replyAck(
  msg: BotChatMessage,
  markdown: string,
  deps: BotReplyDeps
): Promise<void> {
  const replyFn = deps.replyFn ?? ((args: string[]) => runLarkCliJson(args));
  try {
    await replyFn([
      'im',
      '+messages-reply',
      '--as',
      'bot',
      '--message-id',
      msg.message_id,
      '--markdown',
      markdown,
      // 飞书幂等键硬限 50 字符（2026-07-03 实测：裸拼 om_ id 达 51 字符→整单被拒→用户"没反应"）。
      '--idempotency-key',
      makeIdempotencyKey('ack', msg.message_id),
    ]);
  } catch (err) {
    // 回执绝不允许无声失败（用户以为没反应=信任崩塌）：留底 + 降级普通 DM 兜底再送一次。
    writeAudit({
      action: 'notify_failed',
      reason: `回执线程回复失败，降级普通 DM 重试：${err instanceof Error ? err.message.slice(0, 150) : String(err)}`,
      payload: { kind: 'reply_ack', refId: msg.message_id },
    });
    await sendBotDm(markdown, {
      kind: 'reply_ack',
      refId: msg.message_id,
      idempotencyKey: makeIdempotencyKey('ack-fb', msg.message_id),
    });
  }
}

/** KEYSTONE 回填（与 cardsService needhelp/dangling 支路同款）：证据落库 + 挂 matter + 收卡 + 近实时重查。 */
function backfillMatterFromReply(matterId: string, text: string, sourceMessageId: string): string | null {
  const matter = getMatterById(matterId);
  if (!matter || matter.status === 'resolved' || matter.status === 'dropped') return null;
  const now = new Date().toISOString();
  const { unit } = upsertContextUnit({
    kind: 'action_result',
    origin: { kind: 'card_action', refId: `bot-reply:${sourceMessageId}` }, // card_action：过 hasNewExternalEvidenceSince 回声门 + 进 KEYSTONE userBackfills
    title: `补充：${matter.title.slice(0, 60)}`,
    content: text,
    scope: 'work',
    actionability: 'record',
    confidence: 1,
    mergeHint: `bot-reply-backfill:${sourceMessageId}:${randomUUID().slice(0, 8)}`,
    silent: true,
  });
  attachMatterContextLink({
    matterId,
    contextUnitId: unit.id,
    relation: 'evidence',
    effect: 'no_change', // 只补证据，绝不办结
    confidence: 1,
    reason: '用户在飞书 bot 会话里回复补充的信息',
    now,
  });
  // 该事项若有在场求助/悬置卡，视同已应答收起（与面板「补一句进展」同待遇）。
  for (const item of listLiveAttentionItems(200)) {
    if (item.inputHash === `${NEEDHELP_PREFIX}${matterId}` || item.inputHash === `${DANGLING_PREFIX}${matterId}`) {
      const updated = updateAttentionItemStatus(item.id, 'acted', now);
      if (updated) recordAttentionInteraction(item, 'mark_done', now);
    }
  }
  kickInvestigation(); // 近实时解封重查，不等 dispatcher 自然 tick
  return matter.title;
}

/** 处理一条用户消息，返回处理模式（audit/测试用）。 */
export async function handleUserReply(
  msg: BotChatMessage,
  deps: BotReplyDeps = {}
): Promise<string> {
  const text = extractText(msg.content);
  const ack = (md: string) => replyAck(msg, md, deps);
  if (!text || (msg.msg_type && !['text', 'post'].includes(msg.msg_type))) {
    await ack('这类消息我还看不懂（只认文字）。要补充某件事，请引用那条推送回复。');
    return 'unsupported';
  }
  // —— 命令 ——（积压大扫除批次操作）。每条命令都落审计：用户在飞书做的操作与面板同等可审。
  const auditCommand = (mode: string, result: string) =>
    writeAudit({
      action: 'notify_reply_handled',
      reason: `飞书命令「${text.slice(0, 20)}」已执行：${result.slice(0, 80)}`,
      payload: { mode, messageId: msg.message_id },
    });
  if (/^(确认清理|全部清理|清理确认|确认归档)/.test(text)) {
    const r = applyPendingSweepBatch();
    await ack(r.message);
    auditCommand('command:apply', r.message);
    return 'command:apply';
  }
  const keepMatch = text.match(/^保留[\s:：]*([0-9\s,，、]+)$/);
  if (keepMatch) {
    const keep = keepMatch[1]
      .split(/[\s,，、]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
    const r = applyPendingSweepBatch(keep);
    await ack(r.message);
    auditCommand('command:keep', r.message);
    return 'command:keep';
  }
  if (/^忽略/.test(text)) {
    const r = ignorePendingSweepBatch();
    await ack(r.message);
    auditCommand('command:ignore', r.message);
    return 'command:ignore';
  }
  const restoreMatch = text.match(/^恢复[\s:：]*(.+)$/);
  if (restoreMatch) {
    const r = restoreSweptMatter(restoreMatch[1]);
    await ack(r.message);
    auditCommand('command:restore', r.message);
    return 'command:restore';
  }
  // —— 引用回复 → 精确路由 ——
  const parentId = msg.parent_id ?? msg.root_id;
  if (parentId) {
    const push = getNotifyPushByMessageId(parentId);
    if (push?.refId && !['daily_report', 'sweep_list', 'reply_ack'].includes(push.kind)) {
      const title = backfillMatterFromReply(push.refId, text, msg.message_id);
      if (title) {
        await ack(`✅ 已把这句补进「${title.slice(0, 40)}」，AI 带着它接着查，有结果会再告诉你。`);
        writeAudit({
          action: 'notify_reply_handled',
          reason: `飞书回复已回填事项（引用路由）：${title.slice(0, 50)}`,
          payload: { mode: 'quote_backfill', matterId: push.refId, messageId: msg.message_id },
        });
        return 'quote_backfill';
      }
      await ack('这件事已经办结/归档了，你的补充我没有落进去。若要重开，回复「恢复 <标题关键词>」。');
      return 'quote_closed';
    }
    await ack('这条消息我路由不到具体事项（可能不是 AI is ON 的推送）。请引用「🙋需要你/🔧方案/💡建议」那几条回复。');
    return 'quote_unknown';
  }
  // —— 普通回复 → 唯一在场求助卡 / 最近即时推送 兜底 ——
  const liveNeedHelp = listLiveAttentionItems(200).filter(
    (i) => i.inputHash.startsWith(NEEDHELP_PREFIX) && i.matterId
  );
  let targetMatterId: string | null = null;
  if (liveNeedHelp.length === 1) {
    targetMatterId = liveNeedHelp[0].matterId!;
  } else {
    const recent = getLastInstantNotifyPush(new Date(Date.now() - 24 * 3600_000).toISOString());
    if (recent?.refId) targetMatterId = recent.refId;
  }
  if (targetMatterId) {
    const title = backfillMatterFromReply(targetMatterId, text, msg.message_id);
    if (title) {
      await ack(
        `✅ 已把这句补进「${title.slice(0, 40)}」（按最近的推送猜的——不对的话，请引用具体那条推送重发）。AI 接着查。`
      );
      writeAudit({
        action: 'notify_reply_handled',
        reason: `飞书回复已回填事项（兜底路由）：${title.slice(0, 50)}`,
        payload: { mode: 'fallback_backfill', matterId: targetMatterId, messageId: msg.message_id },
      });
      return 'fallback_backfill';
    }
  }
  await ack(
    '收到。我不确定这句该挂到哪件事——请**引用**要补充的那条推送回复（长按/右键→回复），或打开面板处理：' +
      config.webOrigin
  );
  return 'guidance';
}

let inflight = false;

/** 拉一轮 bot 会话新消息并处理。可注入 listFn/replyFn 供测试。 */
export async function tickBotReplyLoop(deps: BotReplyDeps = {}): Promise<number> {
  if (!config.notifyReplyLoopEnabled) return 0;
  const chatId = getSetting(CHAT_ID_KEY);
  if (!chatId) return 0; // 首条推送成功后 sendBotDm 会落 chat_id
  const listFn = deps.listFn ?? ((args: string[]) => runLarkCliJson(args));
  const wm = getSetting(WATERMARK_KEY);
  const startIso = wm
    ? new Date(Date.parse(wm) - OVERLAP_MS).toISOString()
    : new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString();
  const resp = (await listFn([
    'im',
    '+chat-messages-list',
    '--as',
    'bot',
    '--chat-id',
    chatId,
    '--start',
    startIso,
    '--order',
    'asc',
    '--page-size',
    '50',
    '--no-reactions',
  ])) as { data?: { messages?: BotChatMessage[] } };
  const messages = resp?.data?.messages ?? [];
  if (messages.length === 0) return 0;
  let ring: string[] = [];
  try {
    ring = JSON.parse(getSetting(PROCESSED_KEY) ?? '[]') as string[];
  } catch {
    ring = [];
  }
  const ringSet = new Set(ring);
  let processed = 0;
  let maxTs = wm ? Date.parse(wm) : 0;
  for (const msg of messages) {
    const ts = parseCreateTime(msg.create_time);
    if (ts && ts > maxTs) maxTs = ts;
    if (!msg.message_id || ringSet.has(msg.message_id)) continue;
    if (msg.sender?.sender_type === 'app') continue; // bot/其它应用的消息不处理（含自己的推送与 ack）
    try {
      const mode = await handleUserReply(msg, deps);
      console.log(`[bot-reply] handled ${msg.message_id}: ${mode}`);
    } catch (err) {
      console.warn('[bot-reply] handle failed:', err instanceof Error ? err.message : String(err));
    }
    // 成败都进环：绝不让一条毒消息卡死循环
    ring.push(msg.message_id);
    ringSet.add(msg.message_id);
    processed += 1;
  }
  if (maxTs > 0) setSetting(WATERMARK_KEY, new Date(maxTs).toISOString());
  setSetting(PROCESSED_KEY, JSON.stringify(ring.slice(-200)));
  return processed;
}

let loopTimer: NodeJS.Timeout | undefined;

export function startBotReplyLoop(): void {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    if (inflight) return;
    inflight = true;
    void tickBotReplyLoop()
      .catch((err) => console.warn('[bot-reply] tick failed:', err instanceof Error ? err.message : String(err)))
      .finally(() => {
        inflight = false;
      });
  }, config.notifyReplyPollMs);
  console.log(`[bot-reply] 回复闭环已启动（每 ${Math.round(config.notifyReplyPollMs / 1000)}s 拉一轮 bot 会话）`);
}

export function stopBotReplyLoop(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = undefined;
  }
}
