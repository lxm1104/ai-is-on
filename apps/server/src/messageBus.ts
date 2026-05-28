import { randomUUID } from 'node:crypto';
import { claudeRuntime } from './claude/ClaudeRuntime.js';
import { insertRuntimeMessage, updateRuntimeMessage } from './db.js';
import { broadcast } from './ws.js';
import type { ChatMessage, RuntimeEvent, RuntimeStatus, TopicStatus } from './claude/protocol.js';

// MVP18 Stage 1: tool_use_id → message_id / tool_name 的映射按 topic 分桶，
// 防止两个 topic 并发跑时撞同名 tool_use_id（虽然 uuid 撞的概率极小，但不同 topic
// 的 tool 消息走 broadcast 在前端按 topicId 路由，桶级隔离能让"切桶清理"非常干净）。
type ToolMaps = { idToMsg: Map<string, string>; idToName: Map<string, string> };
const toolMapsByTopic = new Map<string, ToolMaps>();

function mapsFor(topicId: string): ToolMaps {
  let m = toolMapsByTopic.get(topicId);
  if (!m) {
    m = { idToMsg: new Map(), idToName: new Map() };
    toolMapsByTopic.set(topicId, m);
  }
  return m;
}

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
  claudeRuntime.on('status', (status: RuntimeStatus) => {
    broadcast({ type: 'runtime_status', status });
  });

  // MVP18 Stage 1: per-topic 状态广播。topic 回到 idle 时同时清理 tool maps —
  // 此时该 topic 的 inflight 工具一定已经全部 tool_result 完，map 本来也该空了，
  // 这是兜底（防止异常 turn 留下垃圾 key）。
  claudeRuntime.on(
    'topic_status',
    ({ topicId, status }: { topicId: string; status: TopicStatus }) => {
      broadcast({ type: 'topic_status', topicId, status });
      if (status === 'idle') {
        toolMapsByTopic.delete(topicId);
      }
    }
  );

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
          const m = mapsFor(e.topicId);
          m.idToMsg.set(toolUseId, id);
          m.idToName.set(toolUseId, e.toolName);
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
        const m = mapsFor(e.topicId);
        const id =
          (typeof toolUseId === 'string' && m.idToMsg.get(toolUseId)) || randomUUID();
        const toolName =
          (typeof toolUseId === 'string' && m.idToName.get(toolUseId)) || e.toolName;
        if (typeof toolUseId === 'string') {
          m.idToMsg.delete(toolUseId);
          m.idToName.delete(toolUseId);
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
