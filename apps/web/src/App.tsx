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
import { TabBar, type HistoryTopic, type Tab } from './components/TabBar';
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

// MVP18 Stage 3: localStorage 持久化 tab 集合 + active id。
// 刷新 / 重启浏览器后恢复同样的 tab。load 失败兜底为空状态。
const LS_OPEN_TABS = 'aiisn.tabs.openTopicIds';
const LS_ACTIVE_TAB = 'aiisn.tabs.activeTopicId';

function loadOpenTabs(): string[] {
  try {
    const raw = localStorage.getItem(LS_OPEN_TABS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function loadActiveTab(): string | null {
  try {
    const raw = localStorage.getItem(LS_ACTIVE_TAB);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function persistOpen(ids: string[]): string[] {
  try {
    localStorage.setItem(LS_OPEN_TABS, JSON.stringify(ids));
  } catch {}
  return ids;
}

function persistActive(id: string | null): string | null {
  try {
    localStorage.setItem(LS_ACTIVE_TAB, JSON.stringify(id));
  } catch {}
  return id;
}

// MVP18 Stage 2: 抗竞态 merge —— fetchMessages 拉到的是 HTTP 调用时点之前的快照，
// WS 可能已经把后续消息塞进 messagesByTopic[tid] 桶里（因为 openTopicIds 先入桶、再 fetch）。
// 直接覆盖会丢这些"快照未包含但 cache 已收到"的消息，所以按 id diff 后追加。
function mergeSnapshot(
  prev: Record<string, ChatMessage[]>,
  tid: string,
  snapshot: ChatMessage[]
): Record<string, ChatMessage[]> {
  const existing = prev[tid] ?? [];
  const snapshotIds = new Set(snapshot.map((m) => m.id));
  const extras = existing.filter((m) => !snapshotIds.has(m.id));
  return { ...prev, [tid]: [...snapshot, ...extras] };
}

// MVP18 Stage 2: WS message_added / message_updated 进桶。
// 不再依赖 seenIds ref —— 直接按桶内 id 检查。mode==='update' 找不到 id 时丢弃，
// 避免迟到 update 写入空槽形成脏数据（与原 applyMessage 兜底等价）。
function applyMessageToBucket(
  prev: Record<string, ChatMessage[]>,
  tid: string,
  msg: ChatMessage,
  mode: 'add' | 'update'
): Record<string, ChatMessage[]> {
  const bucket = prev[tid] ?? [];
  const idx = bucket.findIndex((x) => x.id === msg.id);
  if (idx >= 0) {
    const next = bucket.slice();
    next[idx] = msg;
    return { ...prev, [tid]: next };
  }
  if (mode === 'update') return prev;
  return { ...prev, [tid]: [...bucket, msg] };
}

export function App() {
  // MVP18 Stage 1: `status` 已收窄为 runtime 进程健康度（不再含 'busy'）。
  // per-topic 的忙闲态走 topicStatus map。
  const [status, setStatus] = useState<RuntimeStatus>('starting');
  const [topicStatus, setTopicStatus] = useState<Record<string, TopicStatus>>({});
  const [topics, setTopics] = useState<ChatTopic[]>([]);
  // MVP18 Stage 3: openTopicIds 驱动 TabBar，关闭 tab 从集合移除；
  // 启动从 localStorage 恢复，所有写都通过 persistOpen 同步落地。
  const [openTopicIds, setOpenTopicIds] = useState<string[]>(() => loadOpenTabs());
  const [activeTopicId, setActiveTopicId] = useState<string | null>(() => loadActiveTab());
  // MVP18 Stage 2: messages 由单数组改为按 topicId 分桶。当前 UI 仍只渲染 activeTopicId 对应那一桶。
  const [messagesByTopic, setMessagesByTopic] = useState<Record<string, ChatMessage[]>>({});
  const [cards, setCards] = useState<SignalCard[]>([]);
  const [collectors, setCollectors] = useState<CollectorStatus[]>([]);
  // MVP18 Stage 2: sending 由单值改为按 topic 桶（key = activeTopicId ?? '__new__'）。
  // 新会话占位的 sending 用特殊 key __new__，等 sendChat 拿到 topic.id 再翻到该 id 上。
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [bootstrapCompletedAt, setBootstrapCompletedAt] = useState<string | null>(null);
  const [bootstrapBannerDismissed, setBootstrapBannerDismissed] = useState(false);
  // MVP18 Stage 2: refs 给 WS handler 看，避免空依赖 useEffect 闭包过期
  const openIdsRef = useRef<string[]>([]);
  const messagesByTopicRef = useRef<Record<string, ChatMessage[]>>({});
  useEffect(() => {
    openIdsRef.current = openTopicIds;
  }, [openTopicIds]);
  useEffect(() => {
    messagesByTopicRef.current = messagesByTopic;
  }, [messagesByTopic]);
  const activeTopic = topics.find((t) => t.id === activeTopicId) ?? null;
  // MVP18 Stage 2: 渲染时从桶里取当前 active 的消息列表
  const activeMessages = activeTopicId ? messagesByTopic[activeTopicId] ?? [] : [];

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

  // MVP18 Stage 2: applyMessage 已搬到模块顶部的 applyMessageToBucket 工具函数；
  // 原 seenIds ref 删除——桶内 id 检查就够去重。



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

  // MVP18 Stage 2: 启动时一次性拉初始数据（topics / cards / collectors / topic-status）。
  // 跟 WS 连接拆开两个 useEffect：WS 用空依赖避免切 tab 时整段重连。
  useEffect(() => {
    Promise.allSettled([
      fetchTopics(),
      fetchAttentionCards(),
      fetchCollectors(),
      fetchTopicStatusSnapshot(),
    ]).then(([t, c, col, ts]) => {
      if (t.status === 'fulfilled') setTopics(t.value);
      if (c.status === 'fulfilled') setCards(c.value);
      if (col.status === 'fulfilled') setCollectors(col.value);
      if (ts.status === 'fulfilled') {
        setTopicStatus(
          Object.fromEntries(ts.value.topics.map((row) => [row.topicId, row.status]))
        );
      }
    });
  }, []);

  // MVP18 Stage 2: WS handler 改空依赖 + ref 读 openTopicIds，避免切 tab 时整段重连。
  // onOpen 回调里再拉一次 topic_status 快照（修 R1：重连期间漏掉的 status 变化）。
  useEffect(() => {
    const client = connectWs(
      (e: ServerEvent) => {
        switch (e.type) {
          case 'runtime_status':
            setStatus(e.status);
            return;
          case 'topic_status':
            setTopicStatus((prev) => ({ ...prev, [e.topicId]: e.status }));
            return;
          case 'message_added':
          case 'message_updated': {
            const tid = e.message.topicId;
            if (!tid) return;
            // 仅缓存当前 openTopicIds 集合里的 topic 消息。未 touched 的 topic 事件丢弃 ——
            // 重新打开（setActiveTopicId）会触发 fetchMessages 全量补回。
            if (!openIdsRef.current.includes(tid)) return;
            setMessagesByTopic((prev) =>
              applyMessageToBucket(prev, tid, e.message, e.type === 'message_added' ? 'add' : 'update')
            );
            return;
          }
          case 'topic_created':
          case 'topic_updated':
            upsertTopic(e.topic);
            return;
          case 'card_updated':
            applyCard(e.card, 'update');
            return;
          case 'collector_status':
            applyCollector(e.collector);
            return;
          case 'attention_updated':
            fetchAttentionCards()
              .then((cs) => setCards(cs))
              .catch(() => {});
            return;
          case 'error':
            setTopError(e.message);
            return;
        }
      },
      // onOpen: WS 每次（re-）建连都拉一次 topic_status 快照，覆盖重连缝隙
      () => {
        void fetchTopicStatusSnapshot()
          .then((snap) =>
            setTopicStatus(Object.fromEntries(snap.topics.map((t) => [t.topicId, t.status])))
          )
          .catch((err) => console.warn('topic-status snapshot failed:', err));
      }
    );
    return () => client.close();
  }, []);

  // MVP18 Stage 2: activeTopicId 变化 → 加入 openTopicIds（如果还没在里面）
  // → 若桶里已有该 topic 的消息则跳过 fetch（cache hit），否则拉一次并 merge。
  useEffect(() => {
    if (!activeTopicId) return;
    setOpenTopicIds((prev) =>
      prev.includes(activeTopicId) ? prev : persistOpen([...prev, activeTopicId])
    );
    if (messagesByTopicRef.current[activeTopicId] !== undefined) return; // cache hit
    fetchMessages(activeTopicId)
      .then((ms) => setMessagesByTopic((prev) => mergeSnapshot(prev, activeTopicId, ms)))
      .catch((err) => setTopError(err instanceof Error ? err.message : String(err)));
  }, [activeTopicId]);

  // re-render countdown
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function onSend(text: string) {
    // MVP18 Stage 2: sending 按 topic 桶。新会话占位用 '__new__' 临时 key，
    // 等拿到 topic.id 后把状态翻到该 id 上，再清掉 '__new__'。
    const startKey = activeTopicId ?? '__new__';
    setSending((prev) => ({ ...prev, [startKey]: true }));
    setTopError(null);
    try {
      const topic = await sendChat(text, { topicId: activeTopicId ?? undefined });
      upsertTopic(topic);
      // 先把新 topic 加入 open 集合，再 setActiveTopicId / fetch —— 保证 fetchMessages
      // 期间到达的 WS message_added 已经能通过 openIdsRef.current.includes 的过滤
      // 写入 messagesByTopic[topic.id] 的中间桶。
      setOpenTopicIds((prev) =>
        prev.includes(topic.id) ? prev : persistOpen([...prev, topic.id])
      );
      setActiveTopicId(persistActive(topic.id));
      if (!messagesByTopicRef.current[topic.id]) {
        const ms = await fetchMessages(topic.id);
        // mergeSnapshot 而非直接覆盖：sendTopicMessage 已立即返回、turn 在后台跑，
        // message_added WS 事件可能先于本 fetch 拿到响应到达。
        setMessagesByTopic((prev) => mergeSnapshot(prev, topic.id, ms));
      }
    } catch (err) {
      setTopError(err instanceof Error ? err.message : String(err));
    } finally {
      // 清掉 start key（不论是 __new__ 还是 activeTopicId）
      setSending((prev) => {
        const next = { ...prev };
        delete next[startKey];
        return next;
      });
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
        // MVP18 Stage 2: 卡片 ask_agent / draft_reply → 自动加入 open 集合并切到该 topic。
        // Stage 3 这一行会换成显式的 openTab() helper，行为等价。
        setOpenTopicIds((prev) =>
          prev.includes(result.topic!.id) ? prev : persistOpen([...prev, result.topic!.id])
        );
        setActiveTopicId(persistActive(result.topic.id));
        if (!messagesByTopicRef.current[result.topic.id]) {
          const ms = await fetchMessages(result.topic.id);
          setMessagesByTopic((prev) => mergeSnapshot(prev, result.topic!.id, ms));
        }
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

  // MVP18 Stage 3 ─── TabBar 操作 ───

  /** 切到已打开的 tab。 */
  function selectTab(id: string) {
    setActiveTopicId(persistActive(id));
  }

  /** 关闭 tab：从 openTopicIds 移除，清掉该桶的消息缓存。
   *  关键约束（doc Stage 3 第 3 条）：不调 interrupt——后台 turn 继续跑，事件落库。
   *  topicStatus 不清——它代表后端真实状态；重开 tab 时仍能看到正确的 busy/idle。
   */
  function closeTab(topicId: string) {
    setOpenTopicIds((prev) => persistOpen(prev.filter((id) => id !== topicId)));
    setMessagesByTopic((prev) => {
      if (!(topicId in prev)) return prev;
      const next = { ...prev };
      delete next[topicId];
      return next;
    });
    if (activeTopicId === topicId) {
      // 退到剩下的第一个 tab；都没了就回新会话占位
      const remaining = openTopicIds.filter((id) => id !== topicId);
      setActiveTopicId(persistActive(remaining[0] ?? null));
    }
  }

  /** 点 "+ 新会话"：清空 activeTopicId，UI 切到新会话占位状态。 */
  function newTab() {
    setActiveTopicId(persistActive(null));
  }

  /** 从"⏱ 历史"下拉打开一条历史会话：加进 openTopicIds + 切过去。
   *  与 selectTab 不同——selectTab 假设 id 已经在 openTopicIds 里；这里负责"先加再切"。
   *  消息懒加载靠 activeTopicId useEffect 命中 fetch。 */
  function openHistoricTopic(id: string) {
    setOpenTopicIds((prev) =>
      prev.includes(id) ? prev : persistOpen([...prev, id])
    );
    setActiveTopicId(persistActive(id));
  }

  // 构造 TabBar 渲染数据
  const tabs: Tab[] = openTopicIds
    .map((id) => {
      const topic = topics.find((t) => t.id === id);
      if (!topic) return null;
      return {
        id,
        title: topic.title,
        status: topicStatus[id] ?? 'idle',
        active: activeTopicId === id,
      } as Tab;
    })
    .filter((x): x is Tab => x !== null);

  // 历史会话 = topics 里所有还没在 openTopicIds 的，按 lastMessageAt 倒序
  const historyTopics: HistoryTopic[] = topics
    .filter((t) => !openTopicIds.includes(t.id))
    .map((t) => ({
      id: t.id,
      title: t.title,
      lastMessageAt: t.lastMessageAt ?? t.updatedAt ?? t.createdAt,
      status: topicStatus[t.id] ?? 'idle',
    }));

  // MVP18 Stage 2: lastMsg / thinking 从 activeMessages（桶视图）计算
  const lastMsg = activeMessages[activeMessages.length - 1];
  const activeTopicBusy = activeTopicId ? topicStatus[activeTopicId] === 'busy' : false;
  const thinking =
    activeTopicBusy &&
    (!lastMsg ||
      lastMsg.role === 'user' ||
      (lastMsg.role === 'tool' && lastMsg.status === 'running'));
  // MVP18 Stage 2: sending 按桶取（与 onSend 的 key 约定一致）
  const sendingKey = activeTopicId ?? '__new__';
  const isSending = !!sending[sendingKey];

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
          {/* MVP18 Stage 3: TabBar 取代 TopicHeader 下拉框 */}
          <TabBar
            tabs={tabs}
            onSelect={selectTab}
            onClose={closeTab}
            onNew={newTab}
            isNewActive={activeTopicId === null}
            history={historyTopics}
            onOpenHistory={openHistoricTopic}
          />
          <MessageList messages={activeMessages} thinking={thinking} />
          <Composer
            onSend={onSend}
            disabled={isSending || status === 'stopped'}
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

// MVP18 Stage 3: 旧的 TopicHeader / sourceLabel 随 TabBar 上线一起删掉。
// 来源（manual/card/attention/agent_run）的视觉表达本期暂不在 TabBar 里展示——
// 详见 docs/MVP18 §R7 polish。

function collectorErrorHint(cs: CollectorStatus[]): string | undefined {
  const bad = cs.filter((c) => c.lastError);
  if (bad.length === 0) return undefined;
  return `数据源失败：${bad.map((c) => `${c.name}（${c.lastError}）`).join('；')}`;
}
