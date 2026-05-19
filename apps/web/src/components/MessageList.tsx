import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../types';
import { Markdown } from './Markdown';

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function ToolBubble(props: { msg: Extract<ChatMessage, { role: 'tool' }> }) {
  const { msg } = props;
  const statusLabel =
    msg.status === 'running' ? '正在调用' : msg.status === 'done' ? '完成' : '失败';
  const statusClass = `tool tool--${msg.status}`;
  return (
    <div className={statusClass}>
      <div className="tool__head">
        <span className="tool__dot" />
        <span className="tool__name">{msg.toolName}</span>
        <span className="tool__status">{statusLabel}</span>
        <span className="tool__time">{fmtTime(msg.createdAt)}</span>
      </div>
      <pre className="tool__body">{msg.summary}</pre>
    </div>
  );
}

export function MessageList(props: { messages: ChatMessage[]; thinking: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [props.messages.length, props.thinking]);

  if (props.messages.length === 0 && !props.thinking) {
    return (
      <div className="msglist msglist--empty" ref={ref}>
        <div className="empty">
          <h2>AI is ON</h2>
          <p>我会帮你看飞书日历和 @你消息。你可以先问下面任何一个：</p>
          <ul className="empty__suggestions">
            <li>今天有什么必须处理？</li>
            <li>查一下我今天的日程，并判断有什么需要我提前准备</li>
            <li>有没有人 @我？</li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="msglist" ref={ref}>
      {props.messages.map((m) => {
        if (m.role === 'user') {
          return (
            <div key={m.id} className="bubble bubble--user">
              <div className="bubble__meta">你 · {fmtTime(m.createdAt)}</div>
              <div className="bubble__text">{m.text}</div>
            </div>
          );
        }
        if (m.role === 'assistant') {
          return (
            <div key={m.id} className="bubble bubble--assistant">
              <div className="bubble__meta">AI · {fmtTime(m.createdAt)}</div>
              <Markdown>{m.text}</Markdown>
            </div>
          );
        }
        if (m.role === 'tool') {
          return <ToolBubble key={m.id} msg={m} />;
        }
        return (
          <div key={m.id} className={`system system--${m.level}`}>
            <span className="system__meta">系统 · {fmtTime(m.createdAt)}</span>
            <span className="system__text">{m.text}</span>
          </div>
        );
      })}
      {props.thinking && (
        <div className="thinking">
          <span className="thinking__dot" />
          <span className="thinking__dot" />
          <span className="thinking__dot" />
          <span className="thinking__text">Claude 正在处理...</span>
        </div>
      )}
    </div>
  );
}
