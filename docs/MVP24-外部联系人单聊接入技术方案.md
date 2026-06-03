# MVP24 外部联系人单聊接入技术方案

> 延续 MVP16-A（IM 双向消息接入）。MVP16-A 解决了"me 侧消息"，本方案解决"外部联系人（跨租户）单聊完全采集不到"的问题。

## 背景

用户反馈：希望 IM collector 也能读到与**外部联系人**（external，跨租户）的单聊与群聊上下文。

对当前 `imCollector.ts` 做了实测核验（user 身份，已授权 `im:message.p2p_msg:get_as_user` / `im:chat:read` / `search:message`），结论如下表：

| 采集路径 | 当前机制 | 外部联系人覆盖 | 实测证据 |
|---|---|---|---|
| 群聊 · 对方消息 | `chat-list`(无 types，仅群) → 逐群 `chat-messages-list` | ✅ **已覆盖** | `chat-list` 返回 85 群含 15 个 `external:true`；对外部群 `oc_43d9ef2d…` 调 `chat-messages-list` 拿到 17 条对方消息 |
| 群聊 · 我方消息 | `messages-search --chat-type group --sender=me`（MVP16-A A-2） | ❌ 外部群被排除 | `messages-search --sender=me` 结果中不含外部群 `oc_43d9ef2d…` |
| 单聊（双向） | `messages-search --chat-type p2p`（MVP16-A A-1） | ❌ **整体漏掉** | 对该接口在 2026-02~06 全窗口拉取，得 10 个 p2p 会话 60 条消息，**外部单聊「昕明儿」`oc_c8333b4a…` 完全不在结果中**——而该会话在窗口内确有消息 |

**核心结论**：

1. **外部单聊完全采集不到**——这是唯一需要本方案修复的真正缺口。根因是 p2p 路径只用 `messages-search --chat-type p2p`，而该接口不返回跨租户单聊。
2. **外部群的对方消息其实已经在采集**（走 `chat-list` + `chat-messages-list`，二者都不受 external 影响）。外部群唯一拿不到的是"我方在外部群发的消息"，因为 `chat-messages-list` 群聊默认省略 me 侧，而补偿用的 `messages-search --sender=me` 又排除外部群。

### 关键实测：外部单聊用 `chat-messages-list` 可拿双向

对外部单聊 `oc_c8333b4a…` 调 `chat-messages-list --sort asc`，返回 18 条：**我 8 条 + 对方 10 条**。

→ 与群聊不同，单聊的 `chat-messages-list` **默认就返回双方**，因此外部单聊**不需要** MVP16-A 群聊侧那种额外的 `--sender=me` 补偿调用，单次 per-chat 调用即可拿到完整双向序列。

## 目标

1. 让 IM collector 采集到**外部联系人单聊**的完整双向消息，并入现有 p2p 信号管线（`p2p` / `p2p_burst`）。
2. 对现有内部 p2p 路径（`messages-search`）**零改动、纯增量**，无回归风险。
3. 提供独立开关与上限，可一键回退、可控成本。
4. 数据库 schema 不变；复用 MVP16-A 已有的 `prepareMessages` / `mergeMessagesByMessageId` / 聚合渲染 helpers。

## 非目标

- **不处理"外部群的我方消息"**（已与用户确认）。飞书机制限制（`chat-messages-list` 群聊省略 me 侧 + `messages-search --sender=me` 不含外部群），低成本拿不到；且只影响外部群 burst 信号里"我是否已回复"的方向上下文，对方消息不受影响。本方案以代码注释标注为已知限制。
- 不改 attention / triage prompt（外部单聊复用现有 p2p 文本格式，prompt 无需感知 external）。
- 不改 kind 枚举（外部单聊仍发 `p2p` / `p2p_burst`）。

## 数据流改造概览

```
─── 单聊 p2p 路径（本方案改造点）──────────────────────────────────
  内部 p2p:  messages-search --chat-type p2p           (不变, 默认含双向, 排除外部)
                    │
  外部 p2p:  chat-list --types=p2p (筛 external)         (新增)
                    │  逐外部单聊
                    ▼
             chat-messages-list --chat-id (双向)          (复用 listMessagesInChat)
                    │
   mergeMessagesByMessageId(内部, 外部)  ◄────────────────┘   (按 message_id 去重)
                    │
                    ▼
             prepareMessages (flatten / tag is_me / sort / filter)   (不变)
                    │
                    ▼
             p2pByChat 分组 → p2p / p2p_burst 信号                    (不变)
```

群聊路径**完全不动**。

## 已接受的限制（评审拍板，按"接受 + 注释标注"处理）

1. **单聊 150 条/会话截断**：复用的 `listMessagesInChat` 为 3 页 × `imPerChatPageSize`(50)=150 条/会话上限。极活跃外部单聊在长 lookback 下会被截断（与群聊同款限制）。接受。
2. **信号上限竞争**：外部 p2p 信号 kind 为 `p2p`/`p2p_burst`（裁剪优先级 1），在 `imMaxSignalsPerScan`(默认 30) 裁剪时会挤占 `group_message`（优先级 3）。属预期行为，接受。
3. **`chat.name` 为空时丢失"（外部）"标记**：`externalP2pNames` 仅在 `chat.name` 非空时写入；为空回退 `derivePeerChatName`，外部标记丢失。实测外部单聊均有 name，影响极小，不处理。
4. **外部联系人进入 person entity / Work-Map**：外部联系人 sender 会被建为 `type:'person'` entity，进入 Work-Map。符合"读外部联系人上下文"诉求；观测期确认无低价值外部人节点噪声，必要时后续用 `boundary_rules` 过滤。

## 实现步骤

文件：[apps/server/src/collectors/imCollector.ts](../apps/server/src/collectors/imCollector.ts)

### 1. 类型扩展

`ChatListChat` 增加 p2p 相关字段（仅声明，runtime 已有）：

```ts
type ChatListChat = {
  chat_id?: string;
  name?: string;
  description?: string;
  external?: boolean;
  chat_status?: string;
  chat_mode?: string;          // 新增: 'p2p' | 'group' | 'topic'
};
```

### 2. 新增纯 helper `selectExternalP2pChats()`（可单测）+ `listExternalP2pChats()`

> **可测性约定**：仿照 MVP16-A，会 spawn lark-cli 的函数（`listExternalP2pChats`）不单测；把筛选 / 上限这类纯逻辑抽成**导出的纯函数** `selectExternalP2pChats`，由 `mvp24-external-p2p.test.ts` 直接测。

**纯函数（导出，供单测）**：

```ts
// MVP24: 从一页或多页 chat-list 结果中挑出"正常状态的外部单聊"，并施加硬上限。
// 纯函数：无 IO，便于单测。external=false 的内部单聊已由 messages-search 覆盖，这里剔除。
export function selectExternalP2pChats(
  chats: ChatListChat[],
  max: number
): ChatListChat[] {
  const out: ChatListChat[] = [];
  for (const c of chats) {
    if (c.chat_status && c.chat_status !== 'normal') continue;
    if (c.chat_mode && c.chat_mode !== 'p2p') continue;   // 防御：仅 p2p
    if (!c.external) continue;                            // 内部单聊跳过
    if (!c.chat_id) continue;
    out.push(c);
    if (out.length >= max) break;                        // 硬上限早停
  }
  return out;
}
```

**IO 包装（薄，不单测）**：

```ts
// 外部联系人单聊：messages-search --chat-type p2p 不返回跨租户单聊，
// 必须通过 chat-list --types=p2p 显式枚举 external 会话，再逐个 chat-messages-list。
async function listExternalP2pChats(): Promise<ChatListChat[]> {
  const collected: ChatListChat[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < config.imChatListMaxPages; page++) {
    const args: string[] = [
      'im', '+chat-list', '--as', 'user',
      '--types', 'p2p',
      // 注意：刻意不带 --exclude-muted。群聊路径降噪用了它，但外部单聊是用户
      // 主动诉求，被静音的外部联系人也要采集，故全收。
      '--sort-type', 'ByActiveTimeDesc',
      '--page-size', '100',
      '--format', 'json',
    ];
    if (pageToken) args.push('--page-token', pageToken);
    const resp = await runLarkCliJson<ChatListResp>(args);
    if (!resp.ok || !resp.data) break;
    collected.push(...(resp.data.chats ?? []));
    // 已累计够上限就不必再翻页（selectExternalP2pChats 会再精确截断）
    if (selectExternalP2pChats(collected, config.imExternalP2pMaxChats).length >=
        config.imExternalP2pMaxChats) break;
    if (!resp.data.has_more || !resp.data.page_token) break;
    pageToken = resp.data.page_token;
  }
  return selectExternalP2pChats(collected, config.imExternalP2pMaxChats);
}
```

> 说明：
> - `--types p2p` 只返回 p2p（omit 时才是"仅群"），不会与 `listAllGroups` 重复拉群。
> - `ByActiveTimeDesc` 让最活跃的外部单聊优先进上限。
> - **刻意不带 `--exclude-muted`**：群聊用它降噪，但外部单聊是用户主动诉求，静音的外部联系人也应采集。
> - 上限判断与最终截断都走 `selectExternalP2pChats`，保证"早停翻页"与"返回结果"用同一套规则。

### 3. p2p 主流程接入（collect 内）

把原来的单行 p2p 拉取：

```ts
const p2pMsgs = prepareMessages(
  await listP2pMessages(startLocal, endLocal),
  myOpenId
);
```

改为"内部 + 外部"合并：

```ts
// 内部 p2p（不变）：messages-search 默认含双向、排除外部
const internalP2pRaw = await listP2pMessages(startLocal, endLocal);

// 外部 p2p（新增）：chat-list 枚举 external 单聊，逐个 chat-messages-list 拿双向
let externalP2pRaw: ImMessage[] = [];
const externalP2pNames = new Map<string, string>();   // chat_id → 真实会话名
if (config.imEnableExternalP2p) {
  try {
    const extChats = await listExternalP2pChats();
    const hits = await fetchInParallel(
      extChats,
      async (chat): Promise<ImMessage[]> => {
        if (!chat.chat_id) return [];
        if (chat.name?.trim()) externalP2pNames.set(chat.chat_id, chat.name.trim());
        return listMessagesInChat(chat.chat_id, sinceIso, now.toISOString());
      },
      config.imChatFetchConcurrency
    );
    externalP2pRaw = hits.flatMap((h) => h ?? []);   // fetchInParallel 失败项为 undefined
  } catch (err) {
    // soft-fail：外部 p2p 整体失败不影响内部 p2p（与 listMyGroupMessages 一致）
    console.warn(
      `[im] external p2p fetch failed (internal p2p continues): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const p2pMsgs = prepareMessages(
  mergeMessagesByMessageId(internalP2pRaw, externalP2pRaw),
  myOpenId
);
```

### 4. 外部单聊命名（抽纯 helper，可单测）

新增导出纯函数，命名逻辑与 IO 解耦：

```ts
// MVP24: p2p 会话显示名。外部单聊用 chat-list 拿到的真实名 + （外部）标记；
// 否则回退到现有 derivePeerChatName（从 sender.name 推断）。纯函数，便于单测。
export function p2pChatDisplayName(
  chatId: string,
  msgs: ImMessage[],
  externalNames: Map<string, string>
): string {
  const explicit = externalNames.get(chatId);
  if (explicit) return `单聊 · ${explicit}（外部）`;
  return derivePeerChatName(msgs, chatId);
}
```

p2p 分组循环里把原来的 `derivePeerChatName(msgs, chatId)` 一行替换为：

```ts
for (const [chatId, msgs] of p2pByChat) {
  const chatName = p2pChatDisplayName(chatId, msgs, externalP2pNames);
  // ... 其余聚合 / 单条逻辑完全不变
}
```

> 内部 p2p 的 `externalP2pNames.get(chatId)` 返回 undefined → 回退 `derivePeerChatName`，行为不变。

### 5. 配置 / 开关

文件：[apps/server/src/config.ts](../apps/server/src/config.ts)

```ts
// MVP24: 外部联系人单聊接入。messages-search 不返回跨租户单聊，
//   需 chat-list --types=p2p 枚举 external + 逐个 chat-messages-list。
imEnableExternalP2p: envBool('IM_ENABLE_EXTERNAL_P2P', true),
// 单轮最多处理多少个外部单聊（按 ByActiveTimeDesc 取前 N），防止外部单聊过多打爆
imExternalP2pMaxChats: envInt('IM_EXTERNAL_P2P_MAX_CHATS', 20),
```

文件：[apps/server/.env.example](../apps/server/.env.example) 同步追加：

```bash
# MVP24 外部联系人单聊：messages-search 拿不到跨租户单聊，改用 chat-list 枚举 + chat-messages-list
IM_ENABLE_EXTERNAL_P2P=true
# 单轮最多处理多少个外部单聊（ByActiveTimeDesc 取前 N）
IM_EXTERNAL_P2P_MAX_CHATS=20
```

### 6. 文档

[README.md](../README.md) 的"IM Collector 策略"段，单聊一行补充：外部单聊走 `chat-list --types=p2p` 枚举 + `chat-messages-list` 双向拉取。

## 兼容性 / 回滚

- **数据库 schema 不变**：外部单聊与内部走同一 `RawSignal` → `ingestSignal` 管线，去重靠 `UNIQUE(source, source_id, content_hash)`。外部单聊 `chat_id` 与内部不重叠，单条 sourceId=`message_id`（全局唯一），聚合 sourceId=`chat:<chatId>:agg:<sinceIso>` 也唯一 → **无碰撞**。
- **回滚**：`IM_ENABLE_EXTERNAL_P2P=false` + restart，立即停止所有外部单聊相关调用，退回 MVP16-A 行为。
- **内部 p2p 零改动**：`listP2pMessages` 调用与结果处理完全不变，仅在其结果上 `mergeMessagesByMessageId` 叠加外部消息。

## 下游消费者盘点

- 外部单聊产出的 kind 仍是 `p2p` / `p2p_burst`，与内部完全一致；无新增 kind、无 switch/dispatch 改动。
- `entities`：外部单聊 sender 走 `senderEntity`，外部联系人会被建为 `type:'person'` entity（与内部同人逻辑一致）。Work-Map 会因此多出外部联系人节点——**符合"读外部联系人上下文"的预期**，但需在观测期确认未引入噪声 person。

## 验证

### 单元测试

新建 `apps/server/test/mvp24-external-p2p.test.ts`（与现有 `mvp24-...` 兄弟一致；仓库用 `node:test` + `.test.ts`，**不 mock lark-cli spawn**，只测导出的纯 helper）。运行：`npx tsx --test apps/server/test/mvp24-external-p2p.test.ts`。

测试导出纯函数（均无 IO）：

- `selectExternalP2pChats` 过滤：混合 `external:true/false`、非 normal 状态、`chat_mode!=='p2p'`、缺 `chat_id` → 只保留正常的外部 p2p。
- `selectExternalP2pChats` 上限：传 30 个合格外部单聊、`max=20` → 返回恰好 20 个（且为前 20，验证按入参顺序即 `ByActiveTimeDesc` 截断）。
- `p2pChatDisplayName`：`externalNames` 命中 → 「单聊 · X（外部）」；未命中 → 回退 `derivePeerChatName` 的结果。
- `mergeMessagesByMessageId`（已导出、MVP16-A 已覆盖）：补一条"内部+外部含相同 message_id 时只留一条"的防御性断言。

> `listExternalP2pChats` / `collect` 这类 spawn lark-cli 的函数不进单测，由下面的端到端回放覆盖——与 MVP16-A 的测试边界一致。

### 端到端回放

1. 选外部单聊 `oc_c8333b4aeba59dba00065a45a042f8a5`（昕明儿）。
2. 清数据 **+ 重置 im collector state**（否则 `since=last_success_at` 仍是最近时刻，first-scan lookback 不生效，拉不到旧消息）：
   ```sql
   DELETE FROM events
     WHERE source='im' AND raw_json LIKE '%oc_c8333b4aeba59dba00065a45a042f8a5%';
   DELETE FROM collector_state WHERE collector_name='im';
   ```
3. 设 `IM_FIRST_SCAN_HOURS` 足够大（覆盖该会话最近消息），重启 server，`POST /api/collectors/run-once {name:'im'}`。
4. 断言：
   - 新 event raw_json 含 `chat_id=oc_c8333b4a…` 且同时存在对方与我方（`sender.id=ou_0e40039c…`）消息。
   - signal title 形如「单聊 · 昕明儿（外部）」。
   - `IM_ENABLE_EXTERNAL_P2P=false` 重跑时该会话**不产生**任何 event。

### 观测指标（上线后 7 天）

- 每 tick 额外 Lark 调用数：`chat-list` 翻页数（≤ `imChatListMaxPages`）+ 命中外部单聊数（≤ `imExternalP2pMaxChats`）的 `chat-messages-list`。
- 外部单聊 signal 占 p2p signal 的比例。
- collector tick 平均耗时变化（新增 per-chat 调用，受 `imChatFetchConcurrency` 约束）。

## 已知风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 外部单聊数量大 → per-chat 调用暴涨 | tick 变慢 / Lark 配额 | `imExternalP2pMaxChats=20` 上限 + `ByActiveTimeDesc` 优先活跃 + `imChatFetchConcurrency` 并发约束 |
| `chat-list --types=p2p` 翻页成本 | 每 tick 多若干次元数据调用 | 复用 `imChatListMaxPages`（默认 5 页）；元数据调用很轻 |
| 外部单聊整体失败 | 外部 p2p 缺失 | try/catch soft-fail，内部 p2p 不受影响，下 tick 重试 |
| 隐私边界扩大到外部会话 | 外部对话进入 LLM context | 这是用户主动诉求；`IM_ENABLE_EXTERNAL_P2P` 可一键关闭；沿用 MVP16-A 隐私软约束 |
| 外部联系人 person entity 噪声 | Work-Map 多出低价值外部节点 | 观测期评估；必要时后续用 boundary_rules 过滤特定外部 chat |

## 工作量估计

| 任务 | 估计 |
|------|------|
| `listExternalP2pChats` + 类型扩展 | 0.25 day |
| collect 内 p2p 合并接入 + 命名 | 0.25 day |
| config / .env.example / README | 0.1 day |
| 单元测试 + 端到端回放 | 0.4 day |
| **合计** | **~1 day** |
