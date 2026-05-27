import { randomUUID } from 'node:crypto';
import { claudeRuntime, type SendUserMessageOptions } from '../claude/ClaudeRuntime.js';
import {
  type ChatTopicRow,
  getChatTopic,
  insertChatTopic,
  insertRuntimeMessage,
  listChatTopics,
  updateChatTopic,
} from '../db.js';
import { recordUserMessage } from '../messageBus.js';
import { broadcast } from '../ws.js';

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
