# MVP16-A IM 双向消息接入技术方案（单聊 + 群聊）

> 路线图 A→B→C 的第一阶段。本文档同时包含整个 MVP16 的跨阶段上线策略（见末尾"上线策略与跨阶段考量"一节），后续 B / C 文档不再重复。
>
> 本方案分两个子阶段：A-1（单聊侧）改动小、收益大；A-2（群聊侧）需要新增一次 Lark 调用并合并数据。可以分开上线。

## 背景

调查"程圣淳催促 starling 发布状态"卡片误判时，对照 raw 数据发现：

- commitment `7124adbe` 由 event `65f0198f`（p2p_burst 7 条）触发生成。
- event `65f0198f` 与 `dd1fdee3` 的 `raw_json.msgs` **全部来自程圣淳**，message_position 序列存在断点（160、161、165、166、168、170、171 缺失）。
- 直接原因在 [imCollector.ts:70-77](../apps/server/src/collectors/imCollector.ts) 的 `isWanted()`：

```ts
function isWanted(msg: ImMessage, myOpenId: string): boolean {
  if (!msg.message_id) return false;
  if (msg.deleted) return false;
  if (msg.msg_type === 'system') return false;
  // exclude my own messages
  if (msg.sender?.id === myOpenId) return false;   // ← 用户消息在这里被丢弃
  return true;
}
```

但通过 `lark-cli im +messages-search` 实测发现：**Lark 接口在不同入口上对 me 侧消息的默认行为不一样**：

| API 调用 | 默认是否返回 me 侧 |
|---|---|
| `messages-search --chat-type p2p` | ✅ 返回（实测约 30-40%） |
| `messages-search --chat-type group` | ❌ 0 条 |
| `messages-search`（不限 chat-type） | ❌ 0 条 |
| `im +chat-messages-list --chat-id <group>` | ❌ 0 条 |
| `messages-search --sender <我的 open_id>` | ✅ 返回（72h 内群里 11 条） |

也就是说：

- **单聊**：`isWanted` 自过滤是唯一阻断点，去掉就能拿到双向。
- **群聊**：默认 API 路径本身就不返回 me 侧，需要 **额外做一次 `messages-search --sender=me --chat-type=group` 调用并合并** 才能拿到。

`messages-search --sender=me` 返回的字段完整（含 `message_id` / `message_position` / `create_time` / `chat_id` / `sender.name` / `mentions` / `content`），与原路径 schema 一致，合并不需要做字段适配。

最终效果：所有 IM 信号都是"单边"的，Triage / Attention LLM 永远看不到用户自己的回复。任何"你已经回了 / 已经在做了"的语义都无法被识别。

## 目标

1. 让 IM collector 采集双方完整消息序列：
   - 单聊：去掉 `isWanted` self-filter（A-1）。
   - 群聊：新增 `listMyGroupMessages` + 合并到 perChat（A-2）。
2. 处理 Lark 的 `thread_replies` 嵌套子结构。
3. 让 Triage / Attention 输入显式区分"我"与"对方"，LLM 能识别一段对话的来回。
4. 不引入新的 attention 卡品类——用户自己发出的消息不应单独产生 signal 卡片。
5. 数据库 schema 不变；仅在文本渲染、entities 与信号过滤层做改造。

## 非目标

- 不在本阶段引入 thread / episode 聚合维度（留给 MVP16-B）。
- 不识别 commitment 状态（留给 MVP16-C）。
- 不改变 attention prompt 主体结构。

## 数据流改造概览

```
─── 单聊（A-1）─────────────────────────────────────────────────────
  messages-search --chat-type p2p
       │  默认含 me
       ▼
  isWanted（去掉 self-filter）
       │
       ▼  expand thread_replies → tag is_me → stable sort
  prepareMessages
       │
       ▼  filter
  signals (p2p / p2p_burst，必须含对方消息)

─── 群聊（A-2）─────────────────────────────────────────────────────
  chat-list + chat-messages-list(per chat)         messages-search
       │  仅 peer                                   --sender=me
       ▼                                            --chat-type=group
  perChat[].msgs (peer-only)                       │  仅 me，全局一次
       │                                            ▼
       │            mergeMyMessagesIntoPerChat ◄────┘
       │              (按 chat_id 分组 + 去重 + 重排)
       ▼
  prepareMessages
       │
       ▼  filter
  signals (group_* / at_me，必须含对方消息)
```

## 实现步骤

### 第 1 部分：通用基础（A-1 与 A-2 共用）

#### 1.1 ImMessage 类型扩展与 thread_replies 处理

文件：[apps/server/src/collectors/imCollector.ts](../apps/server/src/collectors/imCollector.ts)

```ts
type ImMessage = {
  // ... 原字段
  thread_id?: string;
  thread_replies?: ImMessage[];   // raw_json 里就有，类型只是没声明
  is_me?: boolean;                // collector 内部派生
};

/**
 * Lark 把同一条主消息的 thread 回复挂在 .thread_replies[]，
 * 但语义上它们是"同一段对话里的连续发言"，渲染时应平铺。
 */
function flattenThreadReplies(msgs: ImMessage[]): ImMessage[] {
  const out: ImMessage[] = [];
  for (const m of msgs) {
    out.push(m);
    if (Array.isArray(m.thread_replies) && m.thread_replies.length > 0) {
      for (const r of m.thread_replies) {
        if (!r.chat_id) r.chat_id = m.chat_id;
        if (!r.thread_id) r.thread_id = m.thread_id;
        out.push(r);
      }
    }
  }
  return out;
}

function tagSelf(msgs: ImMessage[], myOpenId: string): void {
  for (const m of msgs) {
    m.is_me = m.sender?.id === myOpenId;
  }
}
```

> **为什么递归 thread_replies 重要**：当前 events 表里 sender=我的 2 条数据（如 `4063f2c2`）就是因为我自己以 thread_reply 形式回复了群里 @我 的消息，被一并 dump 在 raw_json 里。如果不平铺，downstream 的"我"侧消息可能既出现在主消息流也藏在 thread_replies，渲染时会混乱。

#### 1.2 稳定排序

[imCollector.ts:455](../apps/server/src/collectors/imCollector.ts) 当前用 `create_time` 排序，精度仅到分钟，同分钟内顺序不稳。改为复合 key：

```ts
function sortMessagesStably(msgs: ImMessage[]): ImMessage[] {
  return [...msgs].sort((a, b) => {
    const ta = a.create_time ?? '';
    const tb = b.create_time ?? '';
    if (ta !== tb) return ta.localeCompare(tb);
    // 同 create_time 用 message_position 作 tiebreaker（飞书全局递增序号）
    const pa = Number(a.message_position ?? 0);
    const pb = Number(b.message_position ?? 0);
    return pa - pb;
  });
}
```

#### 1.3 统一 prepareMessages

```ts
function prepareMessages(rawMsgs: ImMessage[], myOpenId: string): ImMessage[] {
  const flat = flattenThreadReplies(rawMsgs);
  tagSelf(flat, myOpenId);
  const sorted = sortMessagesStably(flat);
  // 隐私边界保险丝（默认 true 即正常包含 me）
  if (!config.imIncludeMyMessages) {
    return sorted.filter((m) => !m.is_me).filter(isWanted);
  }
  return sorted.filter(isWanted);
}
```

#### 1.4 放开 `isWanted` 自过滤

```ts
function isWanted(msg: ImMessage): boolean {
  if (!msg.message_id) return false;
  if (msg.deleted) return false;
  if (msg.msg_type === 'system') return false;
  // me-side 消息不再过滤，下游用 is_me 区分
  return true;
}
```

去掉 `myOpenId` 参数，调用方同步改。

#### 1.5 渲染函数区分双向 + 首末快照

```ts
function senderLabel(m: ImMessage): string {
  if (m.is_me) return '我';
  return m.sender?.name || m.sender?.id || '?';
}

function summarizeOne(msg: ImMessage, chatName: string): string {
  const lines: string[] = [];
  if (chatName) lines.push(`会话：${chatName}`);
  const senderTypeLabel = msg.is_me ? 'me' : (msg.sender?.sender_type ?? '?');
  lines.push(`发送者：${senderLabel(msg)}（${senderTypeLabel}）`);
  if (msg.create_time) lines.push(`时间：${msg.create_time}`);
  const content = (msg.content ?? '').trim();
  if (content) {
    lines.push(`内容：${content.length > 600 ? content.slice(0, 600) + '…' : content}`);
  }
  return lines.join('\n');
}

function summarizeAggregate(
  chatName: string,
  msgs: ImMessage[],
  windowStart: string,
): string {
  const lines: string[] = [];
  lines.push(`会话：${chatName}`);
  lines.push(`自 ${windowStart} 以来新增 ${msgs.length} 条消息`);
  lines.push('---');
  const TAIL_MAX = 12;
  const previews =
    msgs.length <= TAIL_MAX
      ? msgs
      : [msgs[0], { __ellipsis: true } as any, ...msgs.slice(-(TAIL_MAX - 1))];
  for (const m of previews) {
    if ((m as any).__ellipsis) {
      lines.push(`- ……（中间省略 ${msgs.length - TAIL_MAX} 条）……`);
      continue;
    }
    const content = (m.content ?? '').replace(/\s+/g, ' ').trim();
    const short = content.length > 120 ? content.slice(0, 120) + '…' : content;
    lines.push(`- [${m.create_time ?? '?'}] ${senderLabel(m)}: ${short}`);
  }
  return lines.join('\n');
}
```

#### 1.6 Entities：用户不进 actor

```ts
function aggregateSenderEntities(msgs: ImMessage[]): ContextEntityRef[] {
  const out: ContextEntityRef[] = [];
  const seenPersonName = new Set<string>();
  let seenBot = false;
  for (const m of msgs) {
    if (m.is_me) continue;          // 用户自己不写成 actor
    // ... 其余逻辑不变
  }
  return out;
}
```

#### 1.7 信号过滤：me-only 消息不单独成卡

```ts
// 单条 p2p / group_message 循环
for (const m of msgs) {
  if (m.is_me) continue;            // me 单条不发信号
  // ...
}

// 聚合 burst：用 peerMsgs 触发但 text 用全量
const peerMsgs = msgs.filter((m) => !m.is_me);
if (peerMsgs.length >= config.imAggregateThreshold) {
  const text = summarizeAggregate(chatName, msgs, startLocal);    // 全量入文本
  const entities: ContextEntityRef[] = [chatEnt];
  entities.push(...aggregateSenderEntities(msgs));                // me 已在内部 skip
  entities.push(...extractFeishuDocEntities(text));
  signals.push({
    // ...
    actor: peerMsgs[peerMsgs.length - 1]?.sender?.name,            // actor 永远是对方
    url: peerMsgs[peerMsgs.length - 1]?.message_app_link,
    // ...
  });
}
// peerMsgs.length === 0 → 不触发 burst；单条循环又会因 if(is_me) continue 全 skip → 0 signal
```

---

### 第 2 部分：A-1 单聊侧改造

在 collect 主流程 (`apps/server/src/collectors/imCollector.ts` 第 442-501 行) p2p 路径：

```ts
const p2pMsgs = prepareMessages(
  await listP2pMessages(startLocal, endLocal),
  myOpenId,
);
```

这一行替换原来的 `listP2pMessages(...).filter((m) => isWanted(m, myOpenId))`。其余 p2p 分组、聚合逻辑直接复用第 1 部分的 helpers，**无其他改动**。

**就这些**——单聊 A-1 的全部工作。因为 Lark `messages-search --chat-type p2p` 默认返回 me 侧，去掉 self-filter 就够了。

---

### 第 3 部分：A-2 群聊侧改造

#### 3.1 新增 `listMyGroupMessages`

```ts
/**
 * 拉取窗口内所有"我自己发到群聊"的消息。
 * Lark 的 chat-messages-list 默认不返回 me 侧，必须用 messages-search 显式按 sender 过滤。
 */
async function listMyGroupMessages(
  startLocal: string,
  endLocal: string,
  myOpenId: string,
): Promise<ImMessage[]> {
  const args: string[] = [
    'im',
    '+messages-search',
    '--as',
    'user',
    '--chat-type',
    'group',
    '--sender',
    myOpenId,
    '--start',
    startLocal,
    '--end',
    endLocal,
    '--page-all',
    '--page-limit',
    String(config.imMyGroupMessagesPageLimit),
    '--format',
    'json',
  ];
  const resp = await runLarkCliJson<MessagesSearchResp>(args);
  return resp.ok && resp.data?.messages ? resp.data.messages : [];
}
```

#### 3.2 合并到 perChat

[imCollector.ts:363-440](../apps/server/src/collectors/imCollector.ts) 群聊采集主流程改造：

```ts
// 第 363 行：原来的 perChat 拉取（peer-only）
const perChatPeer: ChatHit[] = (
  await fetchInParallel(
    groups,
    async (chat) => {
      if (!chat.chat_id) return { chat, msgs: [] };
      const msgs = await listMessagesInChat(chat.chat_id, sinceIso, now.toISOString());
      return { chat, msgs };           // 不再在这里 filter(isWanted)，延迟到 prepareMessages
    },
    config.imChatFetchConcurrency,
  )
).filter((x): x is ChatHit => !!x);     // 注意：me-only chat 也要保留入口

// 新增：一次性拉所有 me 侧群消息
const myGroupMsgs = await listMyGroupMessages(startLocal, endLocal, myOpenId);

// 按 chat_id 索引 me 消息
const myMsgsByChat = new Map<string, ImMessage[]>();
for (const m of myGroupMsgs) {
  if (!m.chat_id) continue;
  const arr = myMsgsByChat.get(m.chat_id) ?? [];
  arr.push(m);
  myMsgsByChat.set(m.chat_id, arr);
}

// 合并：把 me 消息塞回对应 perChat；不存在的 chat 新建条目
const allChatIds = new Set<string>([
  ...perChatPeer.map((x) => x.chat?.chat_id ?? '').filter(Boolean),
  ...myMsgsByChat.keys(),
]);

const perChat: ChatHit[] = [];
for (const chatId of allChatIds) {
  const peerHit = perChatPeer.find((x) => x.chat?.chat_id === chatId);
  const peerMsgs = peerHit?.msgs ?? [];
  const meMsgs = myMsgsByChat.get(chatId) ?? [];

  // 去重：按 message_id 合并
  const seen = new Set<string>();
  const merged: ImMessage[] = [];
  for (const m of [...peerMsgs, ...meMsgs]) {
    if (!m.message_id || seen.has(m.message_id)) continue;
    seen.add(m.message_id);
    merged.push(m);
  }

  // 该 chat 的 meta：优先用 peerHit.chat（含 chat-list 的 name 等），
  // 否则用 me 消息上的 chat_name 兜底
  const chat = peerHit?.chat ?? {
    chat_id: chatId,
    name: meMsgs[0]?.chat_name,
  };

  // 通过 prepareMessages 做 thread_replies 平铺 + tag is_me + sort + filter
  const prepared = prepareMessages(merged, myOpenId);
  if (prepared.length === 0) continue;
  perChat.push({ chat, msgs: prepared });
}
```

#### 3.3 群聊单条 / 聚合循环

由于 `prepareMessages` 已经在每条消息上打了 `is_me`，[imCollector.ts:386-440](../apps/server/src/collectors/imCollector.ts) 后续的群聊聚合 / 单条逻辑直接复用第 1.7 节的"me-only 不单独成卡 + peerMsgs 触发"模板，**结构与单聊侧完全对称**。

---

### 第 4 部分：Triage / Attention prompt 调整

#### 4.1 Triage system prompt

[triagePrompt.ts](../apps/server/src/triage/triagePrompt.ts) "contextUpdates 提取规则"末尾追加第 11 条：

```text
11. IM 信号 text 字段可能包含双向对话，行前缀为「我」或对方姓名。提取规则：
    - 若对方提出请求且「我」已在同一段文本中明确回应（如"已发"/"在弄了"/
      "好的，今天发"），不要生成"对方催促我做 X"的 commitment；
      应改为提取「我」侧的 commitment（kind=commitment, entities.actor=我）或
      action_result（kind=action_result，content 描述已发生的事）。
    - 若「我」尚未回应，按原规则提取对方的 commitment / 催促语义。
    - mergeHint 保持以"做某事"为核心，不要把"我没回"或"对方在催"放进 mergeHint。
    - 「我」侧消息**只用于状态判断与语义合并**，不要把「我」说过的私人内容
      原文写进 contextUpdate.content，避免长期沉淀私人语料。
```

#### 4.2 Attention system prompt

[attentionPrompt.ts](../apps/server/src/attention/attentionPrompt.ts) 铁律列表末尾新增第 12 条：

```text
12. <recentEvents> 中 IM 类 event 的 text 包含「我」侧消息时：
    - 若用户在对话中已明确回应或承诺，对方的请求 priority 应至少降一档，
      避免再以"对方催促"为由出 P0/P1。
    - 若对方持续追问而用户长时间未回（≥30 min 内无 me-row），允许判 P1，
      但 `why` 必须明确引用 event id 与对话末尾的对方消息。
```

## 配置 / 开关

```ts
// apps/server/src/config.ts
imIncludeMyMessages: envBool('IM_INCLUDE_MY_MESSAGES', true),
imMyGroupMessagesPageLimit: envInt('IM_MY_GROUP_MESSAGES_PAGE_LIMIT', 5),    // 5 × 50 = 250 条上限/scan
imEnableMyGroupFetch: envBool('IM_ENABLE_MY_GROUP_FETCH', true),             // A-2 独立开关
```

- `IM_INCLUDE_MY_MESSAGES=false` → 整套 me 接入失效（回到现状），用于紧急回滚。
- `IM_ENABLE_MY_GROUP_FETCH=false` → 单聊 A-1 仍正常，群聊 A-2 不发起额外调用；用于先单独上 A-1 观察。

## 兼容性 / 回滚

- **数据库 schema 不变**：events / context_units / attention_items 字段无增删；raw_json 多了 `is_me` 字段。
- **历史信号**：MVP16-A 上线前生成的 commitment 不会自动修正。处理策略见末尾"历史数据回放"。
- **回滚**：
  - 单聊回滚：`IM_INCLUDE_MY_MESSAGES=false`，restart。
  - 群聊回滚：`IM_ENABLE_MY_GROUP_FETCH=false`，立即停止额外 Lark 调用。

## 下游消费者盘点（确认无破坏性影响）

执行 `grep -rn "p2p_burst\|group_burst\|kind === 'p2p\|kind === 'at_me" apps/`：
- [imCollector.ts](../apps/server/src/collectors/imCollector.ts) 本身（生产者）
- 无其它代码消费 IM kind 字符串

IM kind 仅作为 LLM 输入的文本元数据，不存在 switch / dispatch 路径。本阶段不改 kind 枚举值，**无下游代码改动**。

## 验证

### 单元测试

文件：`apps/server/test/collectors/imCollector.spec.ts`（若不存在则创建）

- `flattenThreadReplies`：构造主消息含 2 条 thread_replies，验证 output 长度与顺序。
- `tagSelf` + `sortMessagesStably`：含同分钟、含 thread_reply 的混合消息，验证最终顺序。
- `summarizeAggregate`：消息数 = 15 时输出含"首条 + 省略 + 末 11"，消息数 = 8 时全显示。
- 聚合阈值：peerMsgs=2、me=3、threshold=3 时不触发 burst；peerMsgs=3、me=0 时触发。
- me-only chat：peerMsgs=[] 时无 signal 产出。
- **群聊合并去重**：mock peerMsgs=[A,B,C]、meMsgs=[C,D]（C 重复 message_id），merged=[A,B,C,D]。
- **群聊新增 chat**：peerMsgs 为空但 meMsgs=[D] → perChat 仍含该 chat 但 prepareMessages 后 prepared.length 取决于其它消息，验证 me-only 群不出 signal。
- 隐私边界保险丝：`IM_INCLUDE_MY_MESSAGES=false` 时 is_me 消息被过滤。

### 端到端回放

#### A-1 单聊回放

1. 选取 `oc_732651ac767fc6f85c4f1af456879eec`（程圣淳）。
2. 清今日数据：
   ```sql
   DELETE FROM events
     WHERE source='im' AND raw_json LIKE '%oc_732651ac767fc6f85c4f1af456879eec%'
       AND occurred_at LIKE '2026-05-26%';
   DELETE FROM context_units
     WHERE merge_key='e17790aae1b2d8fffa9e8657bcfaa788882a56a0';
   ```
3. 重启 server，触发 IM collector。
4. 断言：新 event raw_json 中存在 `sender.id=ou_0e40039c5069cd982b21440cc0684244` 的条目。

#### A-2 群聊回放

1. 选一个本人活跃的群（如 `oc_0de9c051629f50f9c9794baf83ffe1b5`「Auto & Chatbot pm 大本营」，实测 72h 我发过 ≥ 2 条）。
2. 清近 24h 数据：
   ```sql
   DELETE FROM events
     WHERE source='im' AND raw_json LIKE '%oc_0de9c051629f50f9c9794baf83ffe1b5%'
       AND occurred_at LIKE '2026-05-26%';
   ```
3. 重启 server，触发 IM collector。
4. 断言：
   - 新 event raw_json 至少含 1 条 `sender.id=ou_0e40039c5069cd982b21440cc0684244` 的消息。
   - Lark CLI 请求日志能看到一次额外的 `messages-search --sender ou_0e40039c5069cd982b21440cc0684244 --chat-type group`。
   - perChat 合并后无重复 message_id。

### 观测指标（上线后 7 天）

- 单聊 events 中 `is_me=true` 的消息条数比例（预期 30-50%）。
- 群聊 events 中 `is_me=true` 的消息条数比例（预期 5-20%；群里 me 消息天然比 p2p 少）。
- 单聊 burst / 群聊 burst signal 数量较上线前的变化（预期持平）。
- attention 卡片"催促类"占比（预期下降）。
- Triage 平均输入 token 数（预期上升约 2x）。
- 每次 collector tick 的 Lark API 请求数（预期 +1 = 多一次 my-group 调用）。

## 已知风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| my-group 调用增加 Lark 配额压力 | 配额吃紧或限流 | 全局每 tick 仅 1 次调用；page-limit=5（250 条）足够覆盖 3 分钟内的活动；如不足可上调 |
| my-group 调用失败 | 群聊侧退回 peer-only | 用 try/catch 包裹，失败时记 warn 并不影响 peer 路径；下次 tick 自动重试 |
| 隐私边界扩大 | 用户私人发言进入 LLM context | 见跨阶段"隐私边界"章节 |
| Triage token 占用上升 | 单次推理变慢、成本升高 | 首末快照策略将单 signal 文本控制在 ~2KB |
| 排序仍可能不稳 | 极端情况下 LLM 看到的来回顺序错乱 | 复合 key (create_time, message_position) 已 95% 解决 |
| 群聊大量旧消息回流 | first-scan-hours 较长时 my-group 也会拉到很多旧消息 | 用同一个 `[startLocal, endLocal]` 窗口约束，与现有 chat-messages-list 对齐 |

---

## 上线策略与跨阶段考量

> 本节同时适用于 MVP16-B / MVP16-C，B/C 文档不再重复。

### 渐进上线决策门

```
MVP16-A-1（单聊侧）上线
    ↓ 观测 3-5 天
决策门 0：单聊侧的"催促类误判"是否显著下降？
  ├─ 是 → 上 A-2（群聊侧）
  └─ 否 → 先排查 Triage prompt 第 11 条是否生效，再决定下一步
    ↓
MVP16-A-2（群聊侧）上线
    ↓ 观测 1 周
决策门 1：A 整体解决了多少问题？
  ├─ "催促类误判"下降 ≥ 60% → 暂缓 B/C，观察 2 周再评估
  └─ 下降 < 60% 或仍有"对话被切割"投诉 → 进入 MVP16-B
    ↓
MVP16-B 上线 → 观测 1 周
    ↓
决策门 2：commitment 状态混淆是否仍频繁？
  ├─ 已经罕见 → 暂缓 C
  └─ 仍频繁 → 进入 MVP16-C
```

三阶段不必串行赶工：A-1 大概率独立见效；A-2 与 B/C 视实际效果再决定。

### 成本测算

| 阶段 | 单 signal 文本均长 | Triage 单次输入 token | 月 LLM 成本估算 | 额外 Lark API |
|------|-------------------|---------------------|----------------|--------------|
| 现状 | ~500 B | ~2K tokens/批 × 30 批/天 | 基准 ×1 | 0 |
| +A-1 | ~1.2 KB（单聊含 me 行） | ~3.5K tokens/批 × 30 批/天 | 基准 ×1.8 | 0 |
| +A-2 | ~1.5 KB（含群聊 me 行） | ~5K tokens/批 × 30 批/天 | 基准 ×2.5 | +1/tick |
| +MVP16-B | ~3-5 KB（thread 整段对话）| ~10K tokens/批 × 20 批/天 | 基准 ×3.5 | 同上 |
| +MVP16-C | 同 B（status 字段开销可忽略）| 同 B | 基准 ×3.5 | 同上 |

> 正式落地时应在 A-1 上线一周后用真实 `triage_results` 表的 input_token 字段（若有）校准；如果没有该列，应在 MVP16-A 中顺手补 `triage_results.input_tokens` / `output_tokens` 两列（ensureColumn）以支持后续校准。

### 隐私边界

接入 me 侧消息意味着用户自己发出的全部 IM 消息进入 LLM context。处理策略：

1. **现有 `boundary_rules` 表**已支持按 chat 过滤，建议增加 `mode: 'peer_only'` 让用户能针对单个 chat 标记"只看对方发言"。本阶段不动 UI，但保留接口字段。
2. **Triage prompt 第 11 条最后一句**明确禁止把"我"侧消息原文写进 contextUpdate.content，只用作状态判断 / 合并依据。这是软约束，但能显著降低长期沉淀的隐私语料。
3. **Audit logs**：建议在 MVP16-A 上线后增加 audit type `im_self_msg_ingested`（记 message_id 与 chat_id，不记内容）以便用户事后审计。

### 历史数据回放

MVP16-A 上线前的"误判 commitment"在 context_units 表中以 status NULL 存在（MVP16-C 才引入 status 列）。本阶段不主动重写历史：

- 用户在 attention 卡片上点"这条没用" → 走现有 `attentionFeedback.not_relevant` 路径，降权对应 entity。
- 用户主动反馈某 commitment 已过时 → 暂无 UI，可手动 SQL 删除：
  ```sql
  DELETE FROM context_units
    WHERE kind='commitment'
      AND origin_kind='event'
      AND origin_ref_id IN (
        SELECT id FROM events
          WHERE source='im' AND occurred_at < '<MVP16-A 上线日期>'
      );
  ```
- **不建议自动批量重跑 Triage**：旧 raw_json 没有 me 侧数据，重跑无意义。

## 工作量估计

| 任务 | 估计 |
|------|------|
| A-1 单聊侧 |  |
| - 通用基础（thread_replies / 排序 / 渲染 / 过滤）| 0.5 day |
| - p2p collect 接入 prepareMessages | 0.25 day |
| - 单元测试（单聊部分）| 0.25 day |
| **小计 A-1** | **1 day** |
| A-2 群聊侧 |  |
| - listMyGroupMessages 实现 | 0.25 day |
| - perChat 合并去重逻辑 | 0.5 day |
| - 群聊单元测试 + 端到端回放 | 0.5 day |
| **小计 A-2** | **1.25 day** |
| 通用收尾 |  |
| - triage / attention prompt 调整 | 0.25 day |
| - `triage_results` token 列补齐 | 0.25 day |
| **小计** | **0.5 day** |
| **合计** | **2.75 day** |

可以选择只先做 A-1（1 day）观察效果，再决定是否做 A-2。
