import { useEffect, useRef, useState } from 'react';
import { StatusBar } from './components/StatusBar';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { CardList } from './components/CardList';
import { ContextPanel } from './components/ContextPanel';
import { SpacesPanel } from './components/SpacesPanel';
import { RulesPanel } from './components/RulesPanel';
import { WorkMapPanel } from './components/WorkMapPanel';
import { MyCollaboratorsPanel } from './components/MyCollaboratorsPanel';
import {
  fetchAttentionCards,
  fetchCollectors,
  fetchMessages,
  fetchTopicStatusSnapshot,
  fetchTopics,
  interruptRuntime,
  postCardAction,
  restartRuntime,
  runCollectorsOnce,
  type RunOnceResult,
  sendChat,
} from './lib/api';
import { connectWs } from './lib/ws';
import type {
  ChatMessage,
  ChatTopic,
  CollectorStatus,
  RuntimeStatus,
  ServerEvent,
  SignalCard,
  TopicStatus,
} from './types';

export function App() {
  // MVP18 Stage 1: `status` 已收窄为 runtime 进程健康度（不再含 'busy'）。
  // per-topic 的忙闲态走 topicStatus map。
  const [status, setStatus] = useState<RuntimeStatus>('starting');
  const [topicStatus, setTopicStatus] = useState<Record<string, TopicStatus>>({});
  const [topics, setTopics] = useState<ChatTopic[]>([]);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cards, setCards] = useState<SignalCard[]>([]);
  const [collectors, setCollectors] = useState<CollectorStatus[]>([]);
  const [sending, setSending] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [bootstrapCompletedAt, setBootstrapCompletedAt] = useState<string | null>(null);
  const [bootstrapBannerDismissed, setBootstrapBannerDismissed] = useState(false);
  const seenIds = useRef<Set<string>>(new Set());
  const activeTopic = topics.find((t) => t.id === activeTopicId) ?? null;

  function upsertTopic(topic: ChatTopic) {
    setTopics((prev) => {
      const idx = prev.findIndex((t) => t.id === topic.id);
      const next = idx >= 0 ? prev.slice() : [topic, ...prev];
      if (idx >= 0) next[idx] = { ...prev[idx], ...topic };
      return next.sort((a, b) => {
        const at = new Date(a.lastMessageAt ?? a.updatedAt ?? a.createdAt).getTime();
        const bt = new Date(b.lastMessageAt ?? b.updatedAt ?? b.createdAt).getTime();
        return bt - at;
      });
    });
  }

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
    Promise.allSettled([
      fetchTopics(),
      fetchAttentionCards(),
      fetchCollectors(),
      // MVP18 Stage 1: 启动时一次性拉 topic_status 快照，避免冷启动时
      // 某些 topic 已经在 busy（如服务重启前的卡片 ask_agent 还没跑完）但前端不知道。
      fetchTopicStatusSnapshot(),
    ]).then(([t, c, col, ts]) => {
      if (t.status === 'fulfilled') {
        setTopics(t.value);
      }
      if (c.status === 'fulfilled') setCards(c.value);
      if (col.status === 'fulfilled') setCollectors(col.value);
      if (ts.status === 'fulfilled') {
        setTopicStatus(
          Object.fromEntries(ts.value.topics.map((row) => [row.topicId, row.status]))
        );
      }
    });

    const client = connectWs((e: ServerEvent) => {
      switch (e.type) {
        case 'runtime_status':
          setStatus(e.status);
          return;
        case 'topic_status':
          // MVP18 Stage 1: per-topic 状态变化即时入桶。Stage 2 之后还会
          // 在 onOpen 回调里再拉一次快照，进一步覆盖 WS 重连缝隙。
          setTopicStatus((prev) => ({ ...prev, [e.topicId]: e.status }));
          return;
        case 'message_added':
          if (e.message.topicId === activeTopicId) applyMessage(e.message, 'add');
          return;
        case 'message_updated':
          if (e.message.topicId === activeTopicId) applyMessage(e.message, 'update');
          return;
        case 'topic_created':
          upsertTopic(e.topic);
          return;
        case 'topic_updated':
          upsertTopic(e.topic);
          return;
        case 'card_updated':
          // MVP14 Step 3: 现在只有 attention 流，所有 card_updated 都来自 attention 路由
          applyCard(e.card, 'update');
          return;
        case 'collector_status':
          applyCollector(e.collector);
          return;
        case 'attention_updated':
          // 新 tick 完成，重新拉取整个 live 列表
          fetchAttentionCards()
            .then((cs) => setCards(cs))
            .catch(() => {});
          return;
        case 'error':
          setTopError(e.message);
          return;
      }
    });
    return () => client.close();
  }, [activeTopicId]);

  useEffect(() => {
    if (!activeTopicId) {
      seenIds.current = new Set();
      setMessages([]);
      return;
    }
    fetchMessages(activeTopicId)
      .then((ms) => {
        seenIds.current = new Set(ms.map((r) => r.id));
        setMessages(ms);
      })
      .catch((err) => setTopError(err instanceof Error ? err.message : String(err)));
  }, [activeTopicId]);

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
      const topic = await sendChat(text, { topicId: activeTopicId ?? undefined });
      upsertTopic(topic);
      setActiveTopicId(topic.id);
      const ms = await fetchMessages(topic.id);
      seenIds.current = new Set(ms.map((r) => r.id));
      setMessages(ms);
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

  async function onInterrupt() {
    // MVP18 Stage 1: 只中断当前 active topic。没有 activeTopicId（新会话占位）时不动作。
    // 不能走无参 interruptRuntime() —— 后端会一次中断所有 busy session，把后台并发跑的
    // 别的 topic 也一起打断。
    if (!activeTopicId) return;
    setTopError(null);
    try {
      await interruptRuntime(activeTopicId);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCardAction(
    cardId: string,
    actionId: string,
    opts?: { extraPrompt?: string }
  ) {
    try {
      const result = await postCardAction(cardId, actionId, opts);
      if (result.topic) {
        upsertTopic(result.topic);
        setActiveTopicId(result.topic.id);
        const ms = await fetchMessages(result.topic.id);
        seenIds.current = new Set(ms.map((r) => r.id));
        setMessages(ms);
      }
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
  // MVP18 Stage 1: 'busy' 从 runtime 进程态搬到 per-topic 态。Stage 1 期间只有一个 active
  // topic，所以读 topicStatus[activeTopicId] 单值；Stage 2+ 多 tab 时这一行仍然有效。
  const activeTopicBusy = activeTopicId ? topicStatus[activeTopicId] === 'busy' : false;
  const thinking =
    activeTopicBusy &&
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
      {!bootstrapCompletedAt && !bootstrapBannerDismissed && (
        <div className="banner banner--info">
          <span>
            还没填 Work Map。花 5 分钟告诉 Agent "我是谁、负责什么、不希望被什么打扰"，
            后续判断会更聪明。
          </span>
          <button
            className="btn btn--ghost"
            onClick={() => setBootstrapBannerDismissed(true)}
          >
            稍后
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
          <WorkMapPanel
            onBootstrapChange={(t) => setBootstrapCompletedAt(t)}
          />
          <MyCollaboratorsPanel />
          <SpacesPanel />
          <RulesPanel />
          <ContextPanel />
        </aside>
        <section className="pane pane--chat">
          <TopicHeader
            topics={topics}
            activeTopic={activeTopic}
            onSelect={(id) => setActiveTopicId(id)}
            onNew={() => setActiveTopicId(null)}
          />
          <MessageList messages={messages} thinking={thinking} />
          <Composer
            onSend={onSend}
            disabled={sending || status === 'stopped'}
            thinking={thinking || activeTopicBusy}
            onInterrupt={onInterrupt}
            mode={activeTopic ? 'reply' : 'new'}
            topicTitle={activeTopic?.title}
          />
        </section>
      </main>
    </div>
  );
}

function TopicHeader(props: {
  topics: ChatTopic[];
  activeTopic: ChatTopic | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="topicbar">
      <div className="topicbar__main">
        <div className="topicbar__label">
          {props.activeTopic ? '正在继续话题' : '新会话入口'}
        </div>
        <div className="topicbar__title">
          {props.activeTopic?.title ?? '直接输入会创建一个新的 session'}
        </div>
        {props.activeTopic && (
          <div className="topicbar__meta">
            来源：{sourceLabel(props.activeTopic.sourceKind)}
          </div>
        )}
      </div>
      <div className="topicbar__actions">
        <select
          className="topicbar__select"
          value={props.activeTopic?.id ?? ''}
          onChange={(e) => {
            const id = e.target.value;
            if (id) props.onSelect(id);
            else props.onNew();
          }}
          title="选择已有话题继续对话"
        >
          <option value="">新建会话</option>
          {props.topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        {props.activeTopic && (
          <button type="button" className="btn btn--ghost" onClick={props.onNew}>
            新建会话
          </button>
        )}
      </div>
    </div>
  );
}

function sourceLabel(kind: string): string {
  if (kind === 'manual') return '右侧输入';
  if (kind === 'card') return '卡片';
  if (kind === 'attention') return '左侧面板';
  if (kind === 'agent_run') return 'Agent 执行';
  return kind;
}

function collectorErrorHint(cs: CollectorStatus[]): string | undefined {
  const bad = cs.filter((c) => c.lastError);
  if (bad.length === 0) return undefined;
  return `数据源失败：${bad.map((c) => `${c.name}（${c.lastError}）`).join('；')}`;
}
