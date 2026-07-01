import { randomUUID } from 'node:crypto';
import { claudeRuntime, type SendUserMessageOptions } from '../claude/ClaudeRuntime.js';
import {
  type ChatTopicRow,
  getChatTopic,
  insertChatTopic,
  insertRuntimeMessage,
  listChatTopics,
  updateChatTopic,
  hasAiPushTopicForMatter,
  countAiPushTopicsSince,
} from '../db.js';
import { recordUserMessage } from '../messageBus.js';
import { broadcast } from '../ws.js';
import { config } from '../config.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import type { Matter } from '../matter/matterTypes.js';
import type { Recommendation } from '../investigation/investigationPrompt.js';

export type ChatTopic = {
  id: string;
  title: string;
  sourceKind: string;
  sourceRefId?: string;
  opencodeSessionId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
};

export type SendTopicMessageInput = {
  topicId?: string;
  text: string;
  sourceKind?: string;
  sourceRefId?: string;
  title?: string;
  skipContext?: boolean;
};

export function toChatTopic(row: ChatTopicRow): ChatTopic {
  return {
    id: row.id,
    title: row.title,
    sourceKind: row.source_kind,
    sourceRefId: row.source_ref_id ?? undefined,
    opencodeSessionId: row.opencode_session_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at ?? undefined,
  };
}

export function listTopics(limit = 100): ChatTopic[] {
  return listChatTopics(limit).map(toChatTopic);
}

/**
 * MVP75 P1-5：自动开会话——**只插一条 AI(assistant)消息，绝不 spawn opencode turn**。
 * 故：不抢单并发 gate、不跑 aiisn-chat(无 bash、无代发可能)。用户在该会话里回一句 → 才由既有
 * sendTopicMessage/TopicSession 起 turn（用户在环 + 用户愿意花 gate）。
 */
/** 往某 topic 插一条 AI(assistant) 消息（不起 turn）。 */
export function postAiMessageToTopic(topicId: string, text: string): void {
  const now = new Date().toISOString();
  const msg = { id: randomUUID(), topicId, role: 'assistant' as const, text, createdAt: now };
  insertRuntimeMessage({ id: msg.id, topic_id: topicId, role: 'assistant', text, raw_json: JSON.stringify(msg), created_at: now });
  updateChatTopic(topicId, { updated_at: now, last_message_at: now });
  broadcast({ type: 'message_added', message: msg } as never);
}
export function postAiMessageToNewTopic(input: { title: string; sourceRefId?: string; text: string }): ChatTopic {
  const topic = createChatTopic({ title: input.title, sourceKind: 'ai_push', sourceRefId: input.sourceRefId });
  postAiMessageToTopic(topic.id, input.text);
  broadcast({ type: 'topic_updated', topic: { ...topic, updatedAt: topic.createdAt, lastMessageAt: topic.createdAt } });
  return topic;
}

/**
 * MVP75 P1-5：达标建议 + 高价值 matter → 自动在右侧开会话**并自动推进**（用户明确要"自动开始 turn、不用确认"）。
 * 流程：①开会话贴"我查到X+我的建议Y"；②**自动跑一个沙箱 push turn**（aiisn-push，全 deny 权限——
 * 物理上无法发消息/改任何东西，只产出文字草稿）把建议里该起草的交付物**直接起草出来**，贴进同一会话。
 * 用户看到的是"AI 已替我做好的成品（草稿）"，要发才一键发（代发硬红线仍由用户点）。
 * 硬闸：总开关 + stance∈{do,escalate,decide} + priority∈{P0,P1} + 同 matter 幂等 + 日配额（限自动跑 turn 的量）。
 */
export function maybeQueueAutoConversation(matter: Matter, rec: Recommendation, factSummary: string): boolean {
  if (!config.investigationAutoTopicEnabled) return false;
  if (rec.stance !== 'do' && rec.stance !== 'escalate' && rec.stance !== 'decide') return false;
  if (matter.priority !== 'P0' && matter.priority !== 'P1') return false;
  if (hasAiPushTopicForMatter(matter.id)) return false; // 同 matter 只自动开一次
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (countAiPushTopicsSince(todayStart.toISOString()) >= config.investigationAutoTopicDailyMax) return false;
  // 结果先行：直接上"我的建议 + 起草好的成品全文"，**不**罗列"我查到 X / 查了几步"（用户要结果不要过程）。
  const topic = postAiMessageToNewTopic({
    title: `AI 推进：${matter.title.slice(0, 36)}`,
    sourceRefId: matter.id,
    text: `💡 我建议你：${rec.advice}\n依据：${rec.because}`,
  });
  if (rec.draft) {
    // 结论里已带 AI 起草好的成品 → 直接贴（同步、无需再跑 turn）。用户看全文 + 一键复制去发。
    postAiMessageToTopic(topic.id, `📝 我替你起草好了${rec.nextStep ? `（${rec.nextStep}）` : ''}，复制就能用：\n\n${rec.draft}`);
  } else if (config.investigationAutoPushEnabled) {
    // 结论没带成品 → 兜底跑全沙箱 aiisn-push 起草（异步，不阻塞 writeback；失败则只留建议）。
    void runAutoPushTurn(topic.id, matter, rec, factSummary).catch(() => {});
  }
  return true;
}

/** 自动推进：跑全沙箱 aiisn-push（无任何工具→不可能代发）起草交付物，贴进会话。 */
async function runAutoPushTurn(topicId: string, matter: Matter, rec: Recommendation, factSummary: string): Promise<void> {
  const directive = [
    `事项「${matter.title}」`,
    `排查结论：${factSummary.slice(0, 600)}`,
    `我已给用户的建议：${rec.advice}（因为 ${rec.because}）${rec.nextStep ? `；下一步：${rec.nextStep}` : ''}`,
    `请把这条建议里"该起草的交付物"完整起草出来（催办/回复话术 或 要问的问题清单 或 方案要点），让用户一键就能用。只起草，绝不声称已发已办。`,
  ].join('\n');
  let text = '';
  try {
    const r = await runOneShot(directive, { agentName: 'aiisn-push', lane: 'investigation', priority: false });
    text = (r.text || '').trim();
  } catch {
    return; // push 失败：会话里仍有①的建议，不影响
  }
  if (text) postAiMessageToTopic(topicId, text.slice(0, 4000));
}

export function createChatTopic(input: {
  title: string;
  sourceKind?: string;
  sourceRefId?: string;
}): ChatTopic {
  const now = new Date().toISOString();
  const row: ChatTopicRow = {
    id: randomUUID(),
    title: normalizeTitle(input.title),
    source_kind: input.sourceKind ?? 'manual',
    source_ref_id: input.sourceRefId ?? null,
    opencode_session_id: null,
    status: 'active',
    created_at: now,
    updated_at: now,
    last_message_at: null,
  };
  insertChatTopic(row);
  const topic = toChatTopic(row);
  broadcast({ type: 'topic_created', topic });
  return topic;
}

export type SendTopicMessageResult = {
  topic: ChatTopic;
  /**
   * 后台 turn 的 Promise。调用方一般不 await（HTTP 路由 / cardsService 都不等）。
   * 错误已通过 (a) runtime_event runtime_error 进 messageBus、(b) 本函数内部 .catch 写
   * system 消息这两条路径表达，外部 await 也拿不到额外信息。仅测试场景可能需要 await。
   */
  turn: Promise<void>;
};

/**
 * MVP18 Stage 0：HTTP 立即拿到 topic，turn 在后台跑。
 *
 * 同步路径（return 之前完成）：
 *   - requireTopic / createChatTopic
 *   - recordUserMessage（写入 user 消息行 + broadcast message_added）
 *   - updateChatTopic 时间戳 + broadcast topic_updated
 *
 * 后台路径（return 之后异步执行）：
 *   - claudeRuntime.sendUserMessage(...) 跑 opencode turn
 *   - .catch：捕获同步 busy throw → 写一条 system error 消息到该 topic
 *     （opencode fallback 全失败的情况已经在 ClaudeRuntime 内 emit runtime_error，
 *      messageBus 会转成 system 消息，**不会**走到这里的 .catch）
 *   - .finally：更新 topic.last_message_at 并 broadcast topic_updated
 */
export function sendTopicMessage(input: SendTopicMessageInput): SendTopicMessageResult {
  const topic = input.topicId
    ? requireTopic(input.topicId)
    : createChatTopic({
        title: input.title ?? input.text,
        sourceKind: input.sourceKind ?? 'manual',
        sourceRefId: input.sourceRefId,
      });

  const now = new Date().toISOString();
  recordUserMessage(input.text, topic.id);
  updateChatTopic(topic.id, { updated_at: now, last_message_at: now });
  broadcast({ type: 'topic_updated', topic: { ...topic, updatedAt: now, lastMessageAt: now } });

  const runtimeOpts: SendUserMessageOptions = {
    topicId: topic.id,
    sessionId: topic.opencodeSessionId ?? null,
    skipContext: input.skipContext,
    onSessionId: (sessionId) => {
      const t = new Date().toISOString();
      updateChatTopic(topic.id, {
        opencode_session_id: sessionId,
        updated_at: t,
        last_message_at: t,
      });
      broadcast({
        type: 'topic_updated',
        topic: {
          ...topic,
          opencodeSessionId: sessionId,
          updatedAt: t,
          lastMessageAt: t,
        },
      });
    },
  };

  // ⭐ 不 await。turn 在后台跑，HTTP/cards 路径立刻返回。
  const turn = claudeRuntime
    .sendUserMessage(input.text, runtimeOpts)
    .catch((err) => writeBackgroundTurnError(topic.id, err))
    .finally(() => {
      const doneAt = new Date().toISOString();
      updateChatTopic(topic.id, { updated_at: doneAt, last_message_at: doneAt });
      const latestRow = getChatTopic(topic.id);
      if (latestRow) {
        broadcast({
          type: 'topic_updated',
          topic: { ...toChatTopic(latestRow), updatedAt: doneAt, lastMessageAt: doneAt },
        });
      }
    });

  return { topic, turn };
}

/**
 * 同 topic 重复提交 / busy guard 之类的同步抛错通过这里转成该 topic 内的 system error 消息。
 * 注意：opencode fallback 都失败的情形不会走到这里——ClaudeRuntime 内部已 emit
 * runtime_error，messageBus 会写 system 消息，sendUserMessage 仍 resolve。
 */
function writeBackgroundTurnError(topicId: string, err: unknown): void {
  const errMsg = err instanceof Error ? err.message : String(err);
  console.warn(`[chatTopics] background turn error topic=${topicId}: ${errMsg}`);
  const sysMsg = {
    id: randomUUID(),
    topicId,
    role: 'system' as const,
    text: errMsg,
    level: 'error' as const,
    createdAt: new Date().toISOString(),
  };
  try {
    insertRuntimeMessage({
      id: sysMsg.id,
      topic_id: topicId,
      role: 'system',
      text: errMsg,
      raw_json: JSON.stringify(sysMsg),
      created_at: sysMsg.createdAt,
    });
    broadcast({ type: 'message_added', message: sysMsg });
  } catch (writeErr) {
    console.warn(
      `[chatTopics] failed to persist system error for topic=${topicId}: ${
        writeErr instanceof Error ? writeErr.message : String(writeErr)
      }`
    );
  }
}

function requireTopic(id: string): ChatTopic {
  const row = getChatTopic(id);
  if (!row || row.status !== 'active') {
    throw new Error(`topic not found: ${id}`);
  }
  return toChatTopic(row);
}

function normalizeTitle(title: string): string {
  const oneLine = title.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '新会话';
  return oneLine.length > 48 ? `${oneLine.slice(0, 48)}...` : oneLine;
}
