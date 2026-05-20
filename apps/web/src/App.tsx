import { useEffect, useRef, useState } from 'react';
import { StatusBar } from './components/StatusBar';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { CardList } from './components/CardList';
import { ContextPanel } from './components/ContextPanel';
import { SpacesPanel } from './components/SpacesPanel';
import {
  fetchCards,
  fetchCollectors,
  fetchMessages,
  postCardAction,
  restartRuntime,
  runCollectorsOnce,
  type RunOnceResult,
  sendChat,
} from './lib/api';
import { connectWs } from './lib/ws';
import type {
  ChatMessage,
  CollectorStatus,
  RuntimeStatus,
  ServerEvent,
  SignalCard,
} from './types';

export function App() {
  const [status, setStatus] = useState<RuntimeStatus>('starting');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cards, setCards] = useState<SignalCard[]>([]);
  const [collectors, setCollectors] = useState<CollectorStatus[]>([]);
  const [sending, setSending] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const seenIds = useRef<Set<string>>(new Set());

  function applyMessage(m: ChatMessage, mode: 'add' | 'update') {
    setMessages((prev) => {
      const idx = prev.findIndex((x) => x.id === m.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = m;
        return next;
      }
      if (mode === 'update') return prev;
      seenIds.current.add(m.id);
      return [...prev, m];
    });
  }

  function applyCard(c: SignalCard, mode: 'add' | 'update') {
    setCards((prev) => {
      const idx = prev.findIndex((x) => x.id === c.id);
      const visible = c.status !== 'dismissed' && c.status !== 'done';
      if (idx >= 0) {
        if (!visible) return prev.filter((x) => x.id !== c.id);
        const next = prev.slice();
        next[idx] = c;
        return next;
      }
      if (mode === 'update' || !visible) return prev;
      return [c, ...prev];
    });
  }

  function applyCollector(s: CollectorStatus) {
    setCollectors((prev) => {
      const idx = prev.findIndex((x) => x.name === s.name);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = { ...prev[idx], ...s };
        return next;
      }
      return [...prev, s];
    });
  }

  useEffect(() => {
    Promise.allSettled([fetchMessages(), fetchCards(), fetchCollectors()]).then(
      ([m, c, col]) => {
        if (m.status === 'fulfilled') {
          seenIds.current = new Set(m.value.map((r) => r.id));
          setMessages(m.value);
        }
        if (c.status === 'fulfilled') setCards(c.value);
        if (col.status === 'fulfilled') setCollectors(col.value);
      }
    );

    const client = connectWs((e: ServerEvent) => {
      switch (e.type) {
        case 'runtime_status':
          setStatus(e.status);
          return;
        case 'message_added':
          applyMessage(e.message, 'add');
          return;
        case 'message_updated':
          applyMessage(e.message, 'update');
          return;
        case 'card_created':
          applyCard(e.card, 'add');
          return;
        case 'card_updated':
          applyCard(e.card, 'update');
          return;
        case 'collector_status':
          applyCollector(e.collector);
          return;
        case 'error':
          setTopError(e.message);
          return;
      }
    });
    return () => client.close();
  }, []);

  // re-render countdown
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function onSend(text: string) {
    setSending(true);
    setTopError(null);
    try {
      await sendChat(text);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function onRestart() {
    setTopError(null);
    try {
      await restartRuntime();
    } catch (err) {
      setTopError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCardAction(cardId: string, actionId: string) {
    try {
      await postCardAction(cardId, actionId);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function onRunOnce() {
    setTopError(null);
    try {
      return await runCollectorsOnce();
    } catch (err) {
      setTopError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  const lastMsg = messages[messages.length - 1];
  const thinking =
    status === 'busy' &&
    (!lastMsg ||
      lastMsg.role === 'user' ||
      (lastMsg.role === 'tool' && lastMsg.status === 'running'));

  const collectorsHint = collectorErrorHint(collectors);

  return (
    <div className="app">
      <StatusBar status={status} collectors={collectors} onRestart={onRestart} />
      {topError && (
        <div className="banner banner--error">
          <span>{topError}</span>
          <button className="btn btn--ghost" onClick={() => setTopError(null)}>
            知道了
          </button>
        </div>
      )}
      <main className="main main--split">
        <aside className="pane pane--cards">
          <CardList
            cards={cards}
            onAction={onCardAction}
            onRunOnce={onRunOnce}
            collectorsHint={collectorsHint}
          />
          <SpacesPanel />
          <ContextPanel />
        </aside>
        <section className="pane pane--chat">
          <MessageList messages={messages} thinking={thinking} />
          <Composer onSend={onSend} disabled={sending || status === 'stopped'} />
        </section>
      </main>
    </div>
  );
}

function collectorErrorHint(cs: CollectorStatus[]): string | undefined {
  const bad = cs.filter((c) => c.lastError);
  if (bad.length === 0) return undefined;
  return `数据源失败：${bad.map((c) => `${c.name}（${c.lastError}）`).join('；')}`;
}
