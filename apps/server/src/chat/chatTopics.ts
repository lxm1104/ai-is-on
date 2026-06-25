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
export function postAiMessageToNewTopic(input: { title: string; sourceRefId?: string; text: string }): ChatTopic {
  const topic = createChatTopic({ title: input.title, sourceKind: 'ai_push', sourceRefId: input.sourceRefId });
  const now = new Date().toISOString();
  const msg = { id: randomUUID(), topicId: topic.id, role: 'assistant' as const, text: input.text, createdAt: now };
  insertRuntimeMessage({ id: msg.id, topic_id: topic.id, role: 'assistant', text: input.text, raw_json: JSON.stringify(msg), created_at: now });
  updateChatTopic(topic.id, { updated_at: now, last_message_at: now });
  broadcast({ type: 'message_added', message: msg } as never);
  broadcast({ type: 'topic_updated', topic: { ...topic, updatedAt: now, lastMessageAt: now } });
  return topic;
}

/**
 * MVP75 P1-5：达标建议 + 高价值 matter → 自动在右侧开一条会话，把"过程+建议+提议接着做"亮给用户。
 * 硬闸（缺一不可）：总开关 + stance∈{do,escalate,decide} + priority∈{P0,P1} + 同 matter 幂等 + 日配额。
 * 只插一条 AI 消息、不起 turn（见 postAiMessageToNewTopic）。用户回一句才推进。
 */
export function maybeQueueAutoConversation(matter: Matter, rec: Recommendation, factSummary: string): boolean {
  if (!config.investigationAutoTopicEnabled) return false;
  if (rec.stance !== 'do' && rec.stance !== 'escalate' && rec.stance !== 'decide') return false;
  if (matter.priority !== 'P0' && matter.priority !== 'P1') return false;
  if (hasAiPushTopicForMatter(matter.id)) return false; // 同 matter 只自动开一次
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (countAiPushTopicsSince(todayStart.toISOString()) >= config.investigationAutoTopicDailyMax) return false;
  const text = [
    `我查到：${factSummary.slice(0, 220)}`,
    `\n💡 我的建议：${rec.advice}（因为 ${rec.because}）`,
    rec.nextStep
      ? `\n要不要我接着帮你做（只读/起草，绝不对外发）：${rec.nextStep}？回我一句就行。`
      : `\n要不要我接着帮你推进？回我一句就行。`,
  ].join('\n');
  postAiMessageToNewTopic({ title: `AI 推进：${matter.title.slice(0, 36)}`, sourceRefId: matter.id, text });
  return true;
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
