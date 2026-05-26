import { randomUUID } from 'node:crypto';
import { claudeRuntime, type SendUserMessageOptions } from '../claude/ClaudeRuntime.js';
import {
  type ChatTopicRow,
  getChatTopic,
  insertChatTopic,
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

export async function sendTopicMessage(input: SendTopicMessageInput): Promise<ChatTopic> {
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
  await claudeRuntime.sendUserMessage(input.text, runtimeOpts);

  const latest = requireTopic(topic.id);
  const doneAt = new Date().toISOString();
  updateChatTopic(topic.id, { updated_at: doneAt, last_message_at: doneAt });
  const updated = { ...latest, updatedAt: doneAt, lastMessageAt: doneAt };
  broadcast({ type: 'topic_updated', topic: updated });
  return updated;
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
