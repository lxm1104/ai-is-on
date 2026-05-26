# MVP16-B 单聊 Thread 聚合技术方案

> MVP16 路线图的第二阶段，依赖 MVP16-A 已上线（双向消息可见、稳定排序、平铺 thread_replies）。
> 跨阶段上线策略、成本测算、隐私边界、历史数据回放等共性内容见 MVP16-A 文档末尾的"上线策略与跨阶段考量"章节，本文不再重复。

## 背景

MVP16-A 已让用户自己的消息进入系统，但 collector 的聚合粒度依然是"每次扫窗（默认 3 分钟） × chat × 对方消息数 ≥ 阈值"。在真实对话中这会产生几个问题：

1. **窗口切割语义**：一段连续对话被多次扫窗切成多个 burst signal。比如对话从 16:11 持续到 16:18，会被切成 `chat:…:agg:T0` 与 `chat:…:agg:T1` 两条 event（见调查中 `65f0198f` 与 `dd1fdee3`），LLM 看到的是两个独立 burst，无法识别它们属于同一段语义。
2. **聚合触发依赖单边计数**：阈值是"对方消息数"，对方密集但你也在回时（典型快速对话），可能多个扫窗各自只看到 1-2 条对方消息，根本不触发 burst，全部退化成单条 p2p signal——Triage 逐条处理，更难捕捉对话主线。
3. **聚合的 `windowStart` 是扫窗起点不是会话起点**：导致 LLM 看到"自 16:11 起 7 条"这种和真实对话边界不对齐的描述。
4. **重复成本**：每次扫窗重新拉同一段 chat 的消息会产生潜在的重复 signal；当前靠 `contentHash` 与 `tryInsertEvent` 做去重，但相同消息出现在不同 agg 窗口里会算出不同的 hash。

MVP16-B 把单聊（及群聊）的聚合维度从"扫窗 × 计数"重构为"chat thread × 沉默间隔"，使一段连续对话**始终对应一个 signal**。

## 目标

1. 单聊 / 群聊里一段连续对话对应一条 signal（`p2p_thread` / `group_thread` / `group_thread_at_me`），而不是按扫窗切片。
2. 通过"消息间沉默时间"自动判断对话边界，沉默 ≥ `threadSilenceMinutes` 即收束当前 thread。
3. 当 thread 仍在进行中（最后一条消息距 now < silence 阈值）时，**延迟产出 signal**：不发出"半截的对话"，让下一次扫窗在对话结束后产出完整 thread。
4. 同一 thread 若跨多个扫窗仍只对应一条 event。在 chat_threads 表中**累积缓存消息 payload**，避免 lookback 不足导致的文本丢失。
5. thread_key 使用 **chat_id + 首消息 message_id**（不是时间戳），消除时间漂移导致的 key 不稳定问题。
6. 兼容 MVP16-A 的"me/peer 区分"。Thread 触发判断综合双向消息密度，但 peer 角度的"对方未回"语义仍可被表达。

## 非目标

- 不修改 attention / triage 调用频率或队列结构。
- 不引入实时 WebSocket 推送（仍是 poll 模型）。
- 不识别 commitment status（留给 MVP16-C）。
- 不重写群聊的"按活跃度选 chat"策略，只改单 chat 内的聚合维度。

## 概念定义

- **Thread / 对话 episode**：同一 chat_id 下，相邻两条消息时间差 < `threadSilenceMinutes`（默认 10 分钟）的最大连续消息序列。
- **Thread 关闭**：episode 内最后一条消息距 `now` ≥ `threadSilenceMinutes`，认为对话已自然结束，可以"封口"成 signal。
- **Thread 待定**：episode 仍在 silence 窗口内，**本轮不发 signal**。下一次扫窗再判断；如果继续有新消息加入，episode 边界外延；如果沉默够久，下一轮才发。
- **Thread Key**：`thread:<chat_id>:<first_message_id>`。first_message_id 是 episode 的第一条消息的 Lark message_id（如 `om_x100b6e60652044acc4f46c8e1c6dc96`），稳定唯一，**与时间无关**。
- **Payload 累积**：chat_threads 表持续保存 thread 期间收到的全部消息 JSON。封口时直接从表里取，不依赖本轮 lookback 是否完整。

## 数据模型变化

### `events.source_id` 与 `kind`

新增三个 kind：
- `p2p_thread`：单聊 thread 收束信号。
- `group_thread`：群聊 thread 收束信号（未 @ 我）。
- `group_thread_at_me`：群聊 thread 收束信号且 thread 内出现过 @ 我。

旧 kind (`p2p_burst` / `group_burst` / `group_burst_at_me` / `p2p` / `group_message` / `at_me`) 在 `IM_USE_THREAD_AGGREGATION=true` 时不再产生，但历史 events 保留。下游消费者盘点（[grep 验证](../apps/server/src/collectors/imCollector.ts)）确认无代码 switch 依赖这些 kind 字符串，只 prompt 文本会提及——上线时同步更新 prompt 即可。

`source_id` 规则：`thread:<chat_id>:<first_message_id>`。

### 新增 `chat_threads` 工作表

```sql
CREATE TABLE IF NOT EXISTS chat_threads (
  thread_key TEXT PRIMARY KEY,         -- 'thread:<chat_id>:<first_message_id>'
  chat_id TEXT NOT NULL,
  first_message_id TEXT NOT NULL,      -- thread 第一条消息的 Lark message_id
  thread_start_at TEXT NOT NULL,       -- ISO，首条消息时间（仅作展示）
  last_seen_at TEXT NOT NULL,          -- ISO，episode 最后一条消息时间
  last_message_id TEXT NOT NULL,
  state TEXT NOT NULL,                 -- 'pending' | 'closed'
  signal_event_id TEXT,                -- closed 后写入：events.id
  msg_count INTEGER NOT NULL DEFAULT 0,
  peer_msg_count INTEGER NOT NULL DEFAULT 0,
  me_msg_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '[]',  -- 累积的全部 ImMessage[]，封口时直接读
  has_at_me INTEGER NOT NULL DEFAULT 0,     -- 群聊 thread 内是否出现过 @ 我
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_chat_state ON chat_threads(chat_id, state);
CREATE INDEX IF NOT EXISTS idx_chat_threads_last_seen ON chat_threads(last_seen_at);
```

这是一张 **collector 私有的工作表**，不进入 context_units 检索路径；只用于跨扫窗追踪并 stage 消息。

> **payload_json 体积控制**：单 thread 一般 < 50 条 × < 1KB/条 = < 50KB，最大不会超过 200KB（人对话不会比这更密集）。pending 表中同时存在的 thread 上限按 chat 数估算约 100 个，总体磁盘占用 < 20MB。可接受。

## 实现步骤

### 1. Schema 创建

[apps/server/src/db.ts](../apps/server/src/db.ts) 沿用 idempotent + `ensureColumn` 模式（参见 [imCollector.ts](../apps/server/src/collectors/imCollector.ts) 同级 db.ts 的现有写法），追加：

```sql
CREATE TABLE IF NOT EXISTS chat_threads (...);
CREATE INDEX IF NOT EXISTS idx_chat_threads_chat_state ON chat_threads(chat_id, state);
CREATE INDEX IF NOT EXISTS idx_chat_threads_last_seen ON chat_threads(last_seen_at);
```

无版本号依赖，新部署直接创建，旧部署首次启动时自动建表。

### 2. Thread Repo

新建文件：`apps/server/src/collectors/chatThreadRepo.ts`

```ts
export type ChatThread = {
  threadKey: string;
  chatId: string;
  firstMessageId: string;
  threadStartAt: string;
  lastSeenAt: string;
  lastMessageId: string;
  state: 'pending' | 'closed';
  signalEventId: string | null;
  msgCount: number;
  peerMsgCount: number;
  meMsgCount: number;
  payload: ImMessage[];            // 反序列化后的累积消息
  hasAtMe: boolean;
};

export function getPendingThreadForChat(chatId: string): ChatThread | null;
export function upsertPendingThread(t: ChatThread): void;
export function closeThread(threadKey: string, signalEventId: string | null): void;
export function listStalePendingThreads(beforeIso: string): ChatThread[];
```

`upsertPendingThread` 用 `INSERT … ON CONFLICT(thread_key) DO UPDATE`，payload 字段做 JSON.stringify。

### 3. Thread 划分核心算法

新建 `apps/server/src/collectors/threadSegmenter.ts`：

```ts
import { config } from '../config.js';
import type { ImMessage } from './imCollector.js';
import { parseCreateTime } from './imCollector.js';

export type ThreadSegment = {
  firstMessageId: string;
  threadStartAt: string;
  lastSeenAt: string;
  msgs: ImMessage[];
  isClosed: boolean;
};

/**
 * 把同一 chat 内、已经按 (create_time, message_position) 稳定排序的消息序列，
 * 按 silence 阈值切成多段 thread。
 *
 * `existingPending`：该 chat 当前在 chat_threads 里 state=pending 的 thread。
 *   若新拉到的最早消息能与 pending 拼接（间隔 < silence），则把它合并进
 *   pending（thread_key 取 pending 的 first_message_id，保持稳定）。
 */
export function segmentMessagesIntoThreads(
  msgs: ImMessage[],
  now: Date,
  existingPending: { firstMessageId: string; lastSeenAt: string; payload: ImMessage[] } | null,
): ThreadSegment[] {
  if (msgs.length === 0) return [];

  // 1) 若有 pending，按 pending.lastSeenAt 与新消息首条的差判断是否同 thread
  const silenceMs = config.imThreadSilenceMinutes * 60_000;
  let working: ImMessage[];
  let inheritedFirstId: string | null = null;
  let inheritedStartAt: string | null = null;

  if (existingPending) {
    const newFirstTs = new Date(parseCreateTime(msgs[0].create_time)).getTime();
    const pendingLastTs = new Date(existingPending.lastSeenAt).getTime();
    if (newFirstTs - pendingLastTs < silenceMs) {
      // 拼接：去重 message_id 后合并
      const seen = new Set(existingPending.payload.map((m) => m.message_id));
      const fresh = msgs.filter((m) => !seen.has(m.message_id));
      working = [...existingPending.payload, ...fresh];
      inheritedFirstId = existingPending.firstMessageId;
      // thread_start_at 用 pending 中最早消息的时间
      inheritedStartAt = parseCreateTime(existingPending.payload[0]?.create_time);
    } else {
      // pending 与新消息间隔超过 silence → pending 应被关闭（由 caller 处理）
      working = msgs;
    }
  } else {
    working = msgs;
  }

  // 2) 在 working 上按 silence 阈值切段
  const segments: ThreadSegment[] = [];
  let cur: ImMessage[] = [];
  let lastTs: number | null = null;

  for (const m of working) {
    const ts = new Date(parseCreateTime(m.create_time)).getTime();
    if (lastTs !== null && ts - lastTs >= silenceMs) {
      segments.push(buildSegment(cur, now, silenceMs, inheritedFirstId, inheritedStartAt));
      // 切段后丢弃继承标志：只有第一段能继承 pending
      inheritedFirstId = null;
      inheritedStartAt = null;
      cur = [];
    }
    cur.push(m);
    lastTs = ts;
  }
  if (cur.length > 0) {
    segments.push(buildSegment(cur, now, silenceMs, inheritedFirstId, inheritedStartAt));
  }

  return segments;
}

function buildSegment(
  msgs: ImMessage[],
  now: Date,
  silenceMs: number,
  inheritedFirstId: string | null,
  inheritedStartAt: string | null,
): ThreadSegment {
  const last = msgs[msgs.length - 1];
  const lastTs = new Date(parseCreateTime(last.create_time)).getTime();
  const isClosed = now.getTime() - lastTs >= silenceMs;
  return {
    firstMessageId: inheritedFirstId ?? msgs[0].message_id!,
    threadStartAt: inheritedStartAt ?? parseCreateTime(msgs[0].create_time),
    lastSeenAt: parseCreateTime(last.create_time),
    msgs,
    isClosed,
  };
}
```

### 4. Collector 主流程改写

[imCollector.ts:386-501](../apps/server/src/collectors/imCollector.ts) 群聊与 p2p 两段聚合逻辑统一改造。以 p2p 为例（群聊同构）：

```ts
for (const [chatId, msgs] of p2pByChat) {
  const chatName = derivePeerChatName(msgs, chatId);
  const chatEnt = chatEntity(chatId, chatName);
  const pending = getPendingThreadForChat(chatId);
  const segments = segmentMessagesIntoThreads(msgs, now, pending);

  // 关键：若 pending 存在但本轮没拼接（间隔超 silence），先把它关闭
  if (pending && (segments.length === 0 || segments[0].firstMessageId !== pending.firstMessageId)) {
    emitSignalFromPending(pending);  // 见 5.1
    closeThread(pending.threadKey, /*signalEventId 由 scheduler 回写*/ null);
  }

  for (const seg of segments) {
    const threadKey = `thread:${chatId}:${seg.firstMessageId}`;

    if (!seg.isClosed) {
      // 4.1 仍在 silence 窗口内 → 只更新 pending，不发 signal
      upsertPendingThread({
        threadKey,
        chatId,
        firstMessageId: seg.firstMessageId,
        threadStartAt: seg.threadStartAt,
        lastSeenAt: seg.lastSeenAt,
        lastMessageId: seg.msgs[seg.msgs.length - 1].message_id!,
        state: 'pending',
        signalEventId: null,
        msgCount: seg.msgs.length,
        peerMsgCount: seg.msgs.filter((m) => !m.is_me).length,
        meMsgCount: seg.msgs.filter((m) => m.is_me).length,
        payload: seg.msgs,
        hasAtMe: seg.msgs.some((m) => isAtMe(m, myOpenId)),
      });
      continue;
    }

    // 4.2 thread 已封口
    if (signalAlreadyExists(threadKey)) continue;

    const peerMsgs = seg.msgs.filter((m) => !m.is_me);
    if (peerMsgs.length === 0) {
      closeThread(threadKey, null);
      continue;
    }

    const text = summarizeAggregate(chatName, seg.msgs, seg.threadStartAt);
    const entities: ContextEntityRef[] = [chatEnt];
    entities.push(...aggregateSenderEntities(seg.msgs));
    entities.push(...extractFeishuDocEntities(text));

    signals.push({
      source: 'im',
      sourceId: threadKey,
      kind: 'p2p_thread',
      occurredAt: parseCreateTime(seg.lastSeenAt),
      title: `${chatName} · 对话 ${seg.msgs.length} 条`,
      text,
      actor: peerMsgs[peerMsgs.length - 1]?.sender?.name,
      url: peerMsgs[peerMsgs.length - 1]?.message_app_link,
      raw: { chatId, threadKey, msgs: seg.msgs },
      contentHash: shortHash(`thread|${threadKey}|${seg.msgs.length}|${seg.lastSeenAt}`),
      entities: dedupEntities(entities),
    });
  }
}
```

群聊路径完全同构，差别仅在 kind 选择：

```ts
const kind = pending?.hasAtMe || seg.msgs.some((m) => isAtMe(m, myOpenId))
  ? 'group_thread_at_me'
  : 'group_thread';
```

### 5. 边界 case 处理

#### 5.1 emit from pending payload

新增 helper：

```ts
function emitSignalFromPending(pending: ChatThread): RawSignal {
  // 用 pending.payload 直接生成 signal，不再依赖本轮 lookback
  const msgs = pending.payload;
  const chatName = derivePeerChatName(msgs, pending.chatId);
  const peerMsgs = msgs.filter((m) => !m.is_me);
  // ...生成 signal，逻辑同 4.2
}
```

这是 **payload 累积方案** 的核心收益：即便用户笔电关机 3 天、下次开机 lookback 完全不覆盖那段对话，pending 表里已经存了完整 payload，封口仍能产出完整文本。

#### 5.2 stale pending 兜底

存在 case：用户与某 chat 长期沉默，但本轮扫窗没在 p2pByChat 里看到这个 chat（因为窗口内完全没新消息）。pending 永远不被触发关闭。

scheduler 每次 tick 末尾追加：

```ts
const staleBefore = new Date(now.getTime() - config.imThreadSilenceMinutes * 60_000).toISOString();
const stale = listStalePendingThreads(staleBefore);
for (const t of stale) {
  const sig = emitSignalFromPending(t);
  // 走与其它 signal 相同的入库路径
  ingestSignal(sig);
  closeThread(t.threadKey, /*scheduler 内回写 event id*/ null);
}
```

### 6. signal → events.id 回写 chat_threads

[scheduler.ts:105-162](../apps/server/src/collectors/scheduler.ts) 在 IM signal 入库 events 表后，若 kind ∈ {`p2p_thread`, `group_thread`, `group_thread_at_me`}，从 `signal.sourceId` 解析 thread_key，调用 `closeThread(threadKey, ev.id)`。

### 7. 长期清理

加 cron / startup hook：

```ts
// 启动时清理：last_seen_at 超 7 天的 closed thread 直接删（events 表里事件还在，不影响）
db.prepare(`DELETE FROM chat_threads WHERE state='closed' AND last_seen_at < ?`)
  .run(sevenDaysAgo);

// pending 超 24h 强制关闭（极少见，但兜底防止表无限增长）
const veryStale = listStalePendingThreads(twentyFourHoursAgo);
for (const t of veryStale) {
  const sig = emitSignalFromPending(t);
  ingestSignal(sig);
  closeThread(t.threadKey, null);
}
```

## Prompt 调整

### Triage system prompt

[triagePrompt.ts](../apps/server/src/triage/triagePrompt.ts) 第 11 条之后追加：

```text
12. 对 kind ∈ {'p2p_thread', 'group_thread', 'group_thread_at_me'} 的信号，
    text 的内容是一段已结束的对话（沉默 ≥ 10 分钟后才会被收束）。处理时：
    - 必须把整段对话作为一个语义单元判断，而不是把每条消息当独立事件。
    - 区分"对话主题"（contextUpdates 的 kind=goal/commitment/state）与
      "对话表层事实"（kind=event 的话不要单独再写一条 contextUpdate）。
    - 若对话以「我」侧的明确回应/承诺结束，对方的请求不应再生成 commitment；
      改为提取「我」侧 commitment 或 action_result。
    - 若对话以对方的追问结束、「我」未回应，可生成对方的 commitment（actor=对方），
      并在 content 中明确"截至 <last_seen> 用户未回应"。
```

### Attention system prompt

[attentionPrompt.ts](../apps/server/src/attention/attentionPrompt.ts) 第 12 条之后追加：

```text
13. <recentEvents> 中 kind ∈ {'p2p_thread', 'group_thread', 'group_thread_at_me'} 的项，
    一条 event 即一段完整对话。判断 priority 时：
    - 把"对话末尾是谁、内容是什么"作为关键信号，不要被消息总数迷惑。
    - 同一 chat 出现连续多个 thread event（多段对话）应聚合判断"持续在
      催 / 反复跟进"。
    - 若对话已收束且双方达成共识，不要再因"出现过催促语义"而出 P0/P1。
    - kind='group_thread_at_me' 默认优先级不低于 P1（@我意味着对方点名），
      除非整段对话的「我」侧已明确回应。
```

## 配置

```ts
// apps/server/src/config.ts
imThreadSilenceMinutes: envInt('IM_THREAD_SILENCE_MINUTES', 10),

// 冷启动 lookback 独立配置，避免每次重启都拉 6 小时数据
imColdStartLookbackHours: envInt('IM_COLD_START_LOOKBACK_HOURS', 6),
// 稳态 lookback 保持原值（默认 2h），靠 collector_state.last_scan_at 增量
imFirstScanHours: envInt('IM_FIRST_SCAN_HOURS', 2),

imUseThreadAggregation: envBool('IM_USE_THREAD_AGGREGATION', true),
```

collector 启动时判断：

```ts
const lastScan = readCollectorState('im')?.lastScanAt;
const lookbackHours = lastScan ? config.imFirstScanHours : config.imColdStartLookbackHours;
```

## 兼容性 / 回滚

- 新表 `chat_threads` 与历史 events 表正交，不影响历史数据。
- 旧 kind (`p2p_burst` / `group_burst`) 不再产生但在 events / context_units 中保留；prompt 中保留对它们的兼容描述。
- 回滚：`IM_USE_THREAD_AGGREGATION=false`，并 `DELETE FROM chat_threads`。Prompt 的 thread 段落留着不会出错（无信号匹配自然不触发）。

## 下游消费者盘点

执行 `grep -rn "kind === 'p2p\|kind === 'at_me\|p2p_burst\|group_burst" apps/`：

- imCollector.ts（生产者）
- Triage prompt / Attention prompt（文本 reference）
- 无其它 switch / dispatch 代码

新增的 thread kind 只需要 prompt 同步更新（本方案已覆盖），不需要其它代码改动。

## 验证

### 单元测试

文件：`apps/server/test/collectors/threadSegmenter.spec.ts`

| 用例 | 输入 | 期望 |
|------|------|------|
| 单段连续 | 6 条消息，相邻间隔 ≤ 2 min | 1 segment，isClosed 取决于 now |
| 显式切段 | 4 条 @T0..T3（间隔 1 min）+ 4 条 @T0+30..T0+33 | 2 segments，firstMessageId 不同 |
| 待定段 | 末条距 now < silence | isClosed=false |
| 已关闭段 | 末条距 now ≥ silence | isClosed=true |
| pending 拼接 | existingPending.lastSeen 与新消息首条间隔 < silence | output[0].firstMessageId == pending.firstMessageId |
| pending 分离 | existingPending.lastSeen 与新消息首条间隔 ≥ silence | output[0].firstMessageId == 新消息首条 |
| 去重 | pending.payload 与 msgs 有重叠 message_id | 合并后无重复 |
| 群聊 @ 我 | 内含 isAtMe=true 的消息 | hasAtMe=true 一路传到 segment |

### 端到端回放

复用 MVP16-A 验证方法，但额外断言：

- 同一段对话（5/26 16:11-16:18 全部消息）现在只产出 **1 条** event（kind=`p2p_thread`），payload_json 包含完整 16:11-16:18 所有消息（含 me 侧）。
- `chat_threads` 中对应 thread_key 状态为 `closed`，`signal_event_id` 等于该 event 的 id。
- 触发 stale 路径：人为在测试库 insert 一条 pending 且 last_seen_at = now - 30 min；扫窗后断言它被自动 close 且产出 signal。
- 触发拼接路径：第一轮扫窗产生 pending（10 条消息），第二轮扫窗带 5 条新消息（与 pending 末条间隔 5 min），断言：threadKey 不变；payload 13 条（去重 2 条）；最终封口时 event raw.msgs 包含全部 13 条。

### 观测指标（上线后 7 天）

- IM signal 每日总数（预期下降约 30-50%）。
- 单聊 events 平均 `msgs.length`（预期上升约 2-3 倍）。
- Triage 单次输入 token 数（预期较 MVP16-A 再上升约 1.5x，但批数下降抵消，总成本见 A 文档"成本测算"表）。
- attention 卡片"同一对话被多次提及"的报告数（预期清零）。
- `chat_threads` 表 pending 行数稳态（预期 < 50；超 200 说明 silence 阈值设得太大或 stale 路径有 bug）。

## 已知风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| payload_json 撑爆单 chat（如自动化 bot 群刷屏 10000 条） | 单 thread payload > 1MB | 在 upsertPendingThread 加 `msgCount > 500` 时强制 close，把超长 thread 切成多段 |
| silence 阈值不适合所有 chat（如某些群天然慢节奏） | 同一会议被切多段 | 提供 per-chat 配置（boundary_rules 扩展），但默认 10 min 已覆盖绝大多数场景 |
| Thread 收束后用户又补了一句 | 这一句被算作下一个新 thread（first_message_id 不同）| 这是设计接受的代价；视为"新一轮对话"反而更符合用户预期 |
| 增量 last_scan_at 维护与现状冲突 | 冷启动 6h / 稳态 2h 衔接出错 | 用 collector_state.last_scan_at 作权威；若该列尚未维护，本方案需要先补齐写入（约 0.25 day） |
| Prompt 同时存在 burst/thread 两套描述 | LLM 困惑 | 上线时直接删除 burst 段落，prompt 只保留 thread 描述；回滚时再补回 |

## 工作量估计

| 任务 | 估计 |
|------|------|
| schema + chatThreadRepo（含 payload_json 读写）| 0.5 day |
| threadSegmenter + 单测（含 pending 拼接逻辑） | 1 day |
| collector 主流程改造（单聊 + 群聊 + at_me 融合）| 1 day |
| scheduler 回写 + stale 兜底 + 增量 last_scan_at | 0.75 day |
| prompt 调整与回放 | 0.5 day |
| collector_state.last_scan_at 补齐（若未实现） | 0.25 day |
| 合计 | **4 days** |
