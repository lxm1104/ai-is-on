import { randomUUID } from 'node:crypto';
import { claudeRuntime } from './claude/ClaudeRuntime.js';
import { insertRuntimeMessage, updateRuntimeMessage } from './db.js';
import { broadcast } from './ws.js';
import type { ChatMessage, RuntimeEvent } from './claude/protocol.js';

// Track the latest tool_use id -> message id, so tool_result can update it.
const toolUseIdToMessageId = new Map<string, string>();
const toolUseIdToName = new Map<string, string>();

function nowIso() {
  return new Date().toISOString();
}

function messageText(msg: ChatMessage): string {
  return msg.role === 'tool'
    ? `${msg.toolName}: ${msg.summary}`
    : msg.role === 'system'
      ? msg.text
      : msg.text;
}

function addMessage(msg: ChatMessage) {
  insertRuntimeMessage({
    id: msg.id,
    topic_id: msg.topicId ?? null,
    role: msg.role,
    text: messageText(msg),
    raw_json: JSON.stringify(msg),
    created_at: msg.createdAt,
  });
  broadcast({ type: 'message_added', message: msg });
}

function updateMessage(msg: ChatMessage) {
  updateRuntimeMessage({
    id: msg.id,
    topic_id: msg.topicId ?? null,
    role: msg.role,
    text: messageText(msg),
    raw_json: JSON.stringify(msg),
    created_at: msg.createdAt,
  });
  broadcast({ type: 'message_updated', message: msg });
}

function summarizeToolInput(toolName: string, input: unknown): string {
  if (toolName === 'Bash' && input && typeof input === 'object') {
    const cmd = (input as { command?: string }).command;
    if (typeof cmd === 'string') return cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd;
  }
  if (toolName === 'WebFetch' && input && typeof input === 'object') {
    const url = (input as { url?: string }).url;
    if (typeof url === 'string') return url;
  }
  if (toolName === 'WebSearch' && input && typeof input === 'object') {
    const q = (input as { query?: string }).query;
    if (typeof q === 'string') return q;
  }
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return '(input)';
  }
}

function summarizeToolOutput(output: unknown, isError: boolean): string {
  let text = '';
  if (typeof output === 'string') text = output;
  else if (Array.isArray(output)) {
    text = output
      .map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? ''))
      .join('');
  } else if (output && typeof output === 'object') {
    text = JSON.stringify(output);
  }
  text = text.trim();
  if (text.length > 240) text = text.slice(0, 240) + '…';
  return (isError ? '[error] ' : '') + (text || '(empty)');
}

export function userMessage(text: string, topicId?: string): ChatMessage {
  return { id: randomUUID(), topicId, role: 'user', text, createdAt: nowIso() };
}

export function recordUserMessage(text: string, topicId?: string) {
  const msg = userMessage(text, topicId);
  addMessage(msg);
  return msg;
}

export function startMessageBus() {
  claudeRuntime.on('status', (status) => {
    broadcast({ type: 'runtime_status', status });
  });

  claudeRuntime.on('runtime_event', (e: RuntimeEvent) => {
    switch (e.type) {
      case 'assistant_text': {
        addMessage({
          id: randomUUID(),
          topicId: e.topicId,
          role: 'assistant',
          text: e.text,
          createdAt: nowIso(),
        });
        return;
      }
      case 'tool_start': {
        const id = randomUUID();
        const raw = e.raw as { id?: string } | null;
        const toolUseId = raw?.id;
        if (typeof toolUseId === 'string') {
          toolUseIdToMessageId.set(toolUseId, id);
          toolUseIdToName.set(toolUseId, e.toolName);
        }
        addMessage({
          id,
          topicId: e.topicId,
          role: 'tool',
          toolName: e.toolName,
          summary: summarizeToolInput(e.toolName, e.input),
          status: 'running',
          createdAt: nowIso(),
        });
        return;
      }
      case 'tool_result': {
        const raw = e.raw as { tool_use_id?: string } | null;
        const toolUseId = raw?.tool_use_id;
        const id =
          (typeof toolUseId === 'string' && toolUseIdToMessageId.get(toolUseId)) || randomUUID();
        const toolName =
          (typeof toolUseId === 'string' && toolUseIdToName.get(toolUseId)) || e.toolName;
        if (typeof toolUseId === 'string') {
          toolUseIdToMessageId.delete(toolUseId);
          toolUseIdToName.delete(toolUseId);
        }
        const summary = summarizeToolOutput(e.output, e.isError);
        updateMessage({
          id,
          topicId: e.topicId,
          role: 'tool',
          toolName,
          summary,
          status: e.isError ? 'failed' : 'done',
          createdAt: nowIso(),
        });
        return;
      }
      case 'turn_done': {
        // status already flipped to ready in runtime; nothing extra
        return;
      }
      case 'system_info': {
        // suppress in chat stream
        return;
      }
      case 'runtime_error': {
        addMessage({
          id: randomUUID(),
          topicId: e.topicId,
          role: 'system',
          text: e.error,
          level: 'error',
          createdAt: nowIso(),
        });
        return;
      }
    }
  });
}
