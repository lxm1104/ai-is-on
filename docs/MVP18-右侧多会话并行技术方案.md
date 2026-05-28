# MVP18 右侧多会话并行技术方案

> v3 — 在 v2 基础上根据第二轮 review 修订。修订点见末尾 *修订说明*。

## 背景

当前右侧聊天窗格一次只显示一个会话（topic）。前端通过下拉框在已有 topic 间切换，每次切换都整段重拉 `messages`。

数据模型与 API 早已按 topic 切分：

- `chat_topics` / `runtime_messages` 表都带 `topic_id`（[db.ts:12-31](../apps/server/src/db.ts#L12-L31)）
- `POST /api/chat` 接受 `topicId`（[chat.ts:33-49](../apps/server/src/routes/chat.ts#L33-L49)）
- `RuntimeEvent` 中 `assistant_text` / `tool_*` / `turn_done` / `runtime_error` 都带 `topicId?`（[protocol.ts:10-15](../apps/server/src/claude/protocol.ts#L10-L15)）
- opencode CLI 原生支持 `-s <sessionId>` 复用 session（[ClaudeRuntime.ts:159-161](../apps/server/src/claude/ClaudeRuntime.ts#L159-L161)），不同 sessionId 之间天然并发安全（**待烟雾测试验证，见 R2**）

真正卡住并行的是五处全局/阻塞点：

1. **`claudeRuntime` 单例** — 一份 `status`、一份 `activeChild`（[ClaudeRuntime.ts:27,29,309](../apps/server/src/claude/ClaudeRuntime.ts#L27-L29)），一次只能跑一个 turn。
2. **`POST /api/chat` 阻塞** — `sendTopicMessage` 整段 `await` 到 turn 结束（[chatTopics.ts:111-118](../apps/server/src/chat/chatTopics.ts#L111-L118)），第二个 tab 的 send HTTP 调用会一直挂住。这是"前端看着多 tab 但仍假并行"的最大陷阱。
3. **`ServerEvent.runtime_status` 全局值** — 前端无法区分谁在 busy（[protocol.ts:88](../apps/server/src/claude/protocol.ts#L88)）。
4. **`toolUseIdToMessageId/Name` 模块级 Map** — 两个 turn 同跑会撞 tool_use_id（[messageBus.ts:8-9](../apps/server/src/messageBus.ts#L8-L9)）。
5. **前端 `App.tsx` 单值 state** — `activeTopicId / messages / status` 都是单值，WS 用 `activeTopicId === e.message.topicId` 过滤（[App.tsx:117-120](../apps/web/src/App.tsx#L117-L120)）。

## 目标

1. 右侧支持以 Tab 形式同时打开 N 个会话，可视化切换。
2. 不同 topic 的 turn 在后端真正并发执行（独立 opencode 子进程）。
3. 每个 tab 独立显示 busy 状态、独立中断、独立输入框 enable/disable。
4. 顶部 StatusBar 收窄为"runtime 进程健康度"，不再随单个 turn 闪烁。
5. 关闭 tab 不中断后台 turn；重新打开能看到完整记录。
6. 单 tab 行为完全等价于现状（向后兼容）。

## 非目标

- 不做按 topic 过滤的 `buildActiveContext`（暂保留全局上下文池）。
- 不为多会话设计独立的 attention/cards/collectors 视图（左侧仍是全局）。
- 不支持同一个 topic 内并行多 turn（opencode `-s` 不允许）；同 topic 第二次提交直接拒绝。
- 不做云端会话同步、不做多设备打开 tab 状态同步。

## 现状关键障碍清点

| 层 | 现状 | 多会话障碍 |
|---|---|---|
| DB | `chat_topics` / `runtime_messages` 带 topicId | ✅ 无 |
| `POST /api/chat` 路由本身 | 已按 topicId 路由 | ✅ 无 |
| `POST /api/chat` 等待语义 | 整段 await 到 turn 结束 | ❌ 必改：拆成同步返回 topic + 后台跑 turn |
| `RuntimeEvent` 子类型 | 已带 `topicId?` | ⚠️ 类型需收紧为必填 |
| `opencode run -s <sessionId>` | 每 topic 一个 sessionId | ⚠️ 需烟雾测试 |
| `claudeRuntime` 实例 | 单例 + 单 activeChild | ❌ 必改 |
| `ServerEvent.runtime_status` | 全局 enum 含 `busy` | ❌ 必改：拆出 `topic_status`、收窄 enum |
| `messageBus` tool 映射 | 模块级全局 Map | ❌ 必改：按 topic 分桶 |
| `interrupt()` / `restart()` | 全局 kill | ❌ interrupt 必改：按 topic |
| 前端 `App.tsx` state | 单值 | ❌ 必改：按 topicId 分桶 |
| `buildActiveContext()` | 全局 | ⚠️ 不阻塞并发，本期不动 |
| `cards / attention / collectors` 广播 | 全局 | ✅ 维持，左侧 pane 本来就是全局视图 |

## 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    ChatRuntimeManager                       │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐     │
│  │ TopicSession │   │ TopicSession │   │ TopicSession │     │
│  │  topicA      │   │  topicB      │   │  topicC      │     │
│  │  status=busy │   │  status=idle │   │  status=busy │     │
│  │  activeChild │   │  activeChild │   │  activeChild │     │
│  │   (pid 123)  │   │     null     │   │   (pid 456)  │     │
│  └──────────────┘   └──────────────┘   └──────────────┘     │
│  processStatus: 'ready'                                     │
└─────────────────────────────────────────────────────────────┘
            │                  │                  │
            │ runtime_event    │ topic_status     │
            ▼                  ▼                  ▼
        messageBus  ──→  ws.broadcast  ──→  WebSocket clients
                                            (每客户端订阅全部事件，前端按 topicId 路由)
```

前端：

```
App
├── StatusBar (runtimeStatus: 进程健康度, 不含 'busy')
├── 左侧 pane (cards / spaces / rules / context, 全局)
└── 右侧 pane
    ├── TabBar  ([topicA*, topicB, topicC*, +])  ← * 表示该 tab 在 busy
    └── ActiveChatSurface  (仅渲染 activeTopicId 对应的内容)
        ├── MessageList (messagesByTopic[active])
        └── Composer    (disabled = topicStatus[active]==='busy')
```

state 由"单值"升级为"按 topicId 分桶 + 当前激活 id"。WS handler 按 `topicId` 落到对应 bucket，与"哪个 tab 在前台"解耦。

---

## 后端改造

### 0. 协议变更（破坏性，先列在这里方便对照）

文件：[apps/server/src/claude/protocol.ts](../apps/server/src/claude/protocol.ts)

```ts
// RuntimeStatus 含义收窄为"runtime 进程健康度"，移除 'busy'
export type RuntimeStatus = 'idle' | 'starting' | 'ready' | 'stopped' | 'error';

// 新增 per-topic 状态
export type TopicStatus = 'idle' | 'busy';
// 注：'error' 不持久化，turn 失败时 emit runtime_error 后直接回 'idle'。
// 这样 enum 实际只有两态，把状态机降到最小复杂度。

// RuntimeEvent.topicId 由可选改为必填
export type RuntimeEvent =
  | { type: 'assistant_text'; topicId: string; text: string; raw: unknown }
  | { type: 'tool_start'; topicId: string; toolName: string; input: unknown; raw: unknown }
  | { type: 'tool_result'; topicId: string; toolName: string; output: unknown; isError: boolean; raw: unknown }
  | { type: 'turn_done'; topicId: string; result?: string; raw: unknown }
  | { type: 'system_info'; topicId: string; text: string; raw: unknown }
  | { type: 'runtime_error'; topicId: string; error: string; raw?: unknown };

export type ServerEvent =
  | { type: 'runtime_status'; status: RuntimeStatus }                 // 不再含 'busy'
  | { type: 'topic_status'; topicId: string; status: TopicStatus }    // ★ 新增
  | { type: 'message_added'; message: ChatMessage }
  | { type: 'message_updated'; message: ChatMessage }
  | { type: 'topic_created'; topic: unknown }
  | { type: 'topic_updated'; topic: unknown }
  | { type: 'card_created'; card: SignalCard }
  | { type: 'card_updated'; card: SignalCard }
  | { type: 'collector_status'; collector: CollectorStatus }
  | { type: 'attention_updated'; generation: number; itemsEmitted: number }
  | { type: 'error'; message: string };
```

**破坏性影响点**：

- `RuntimeStatus` 移除 `'busy'` → [StatusBar.tsx:10-26](../apps/web/src/components/StatusBar.tsx#L10-L26) 的 `LABEL` / `DOT_COLOR` 表需要删 `busy` 行；[App.tsx:236-240](../apps/web/src/App.tsx#L236-L240) 的 `thinking` 计算改用 `topicStatus`。
- `RuntimeEvent.topicId` 必填 → 所有 `this.emitEvent({ type: ..., topicId: ?, ... })` 调用点（[ClaudeRuntime.ts:73,85,100,138,225,274,285,293](../apps/server/src/claude/ClaudeRuntime.ts#L73)）必须保证传入。TopicSession 内部 `this.topicId` 一定有，因此搬迁后由 ts 编译器强校验。
- `ChatMessage.topicId` 仍保持可选（保留对 legacy 行的兼容，[db.ts:418-428](../apps/server/src/db.ts#L418-L428) 提到老消息迁到 `legacy-global-chat`），但所有新写入路径都必须填。**这个可选性纯粹是为了反序列化 legacy `runtime_messages.raw_json`** —— 改造后所有新 emit 的 RuntimeEvent.topicId 必填，messageBus 也不会再写出无 topicId 的消息行；可选只是给 `JSON.parse(r.raw_json)` 的兜底。protocol.ts 里应当加注释明确这一点，避免未来读代码的人困惑"为何 RuntimeEvent 必填、ChatMessage 还是可选"。

### 1. 新增 `TopicSession`

新文件：`apps/server/src/claude/TopicSession.ts`

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import type { RuntimeEvent, TopicStatus } from './protocol.js';
import { buildActiveContext } from '../context/activeContext.js';

export type SendOptions = {
  skipContext?: boolean;
  sessionId?: string | null;
  topicId: string;                            // ← 必填
  onSessionId?: (sessionId: string) => void;
};

export class TopicSession extends EventEmitter {
  readonly topicId: string;
  private status: TopicStatus = 'idle';
  private activeChild: ChildProcess | null = null;

  constructor(topicId: string) {
    super();
    this.topicId = topicId;
  }

  getStatus(): TopicStatus { return this.status; }

  private setStatus(s: TopicStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);                   // manager 转发为 topic_status
  }

  async sendUserMessage(text: string, opts: SendOptions): Promise<void> {
    if (this.status === 'busy') {
      throw new Error(`topic ${this.topicId} 上一轮还在执行，请先中断或等待`);
    }

    let content = text;
    if (!opts.skipContext) {
      try {
        const snap = buildActiveContext();
        if (snap.summary) content = `${snap.summary}\n\n${text}`;
      } catch (err) {
        console.warn('[opencode chat] buildActiveContext failed:', String(err));
      }
    }

    this.setStatus('busy');
    try {
      // 主模型 → 副模型 fallback：与现状一致
      // 关键：主模型失败仅 console.warn，不 emit；只有副模型也失败才 emit runtime_error。
      try {
        await this.runTurn(content, config.opencodeModel, opts);
      } catch (primaryErr) {
        const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        console.warn(`[opencode chat] primary failed, fallback: ${primaryMsg.slice(0, 300)}`);
        try {
          await this.runTurn(content, config.opencodeFallbackModel, opts);
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          this.emitEvent({
            type: 'runtime_error',
            topicId: this.topicId,
            error: `opencode 两次调用均失败。\n[primary]: ${primaryMsg}\n[fallback]: ${fallbackMsg}`,
          });
        }
      }
    } finally {
      // 无论成败：runTurn 内部 child.exit 已经把 activeChild 清空，这里只兜底状态
      this.setStatus('idle');
    }
  }

  async interrupt(): Promise<{ ok: boolean; method: 'sigint' | 'restart' | 'noop' }> {
    if (this.status !== 'busy' || !this.activeChild) return { ok: false, method: 'noop' };
    // 与现 ClaudeRuntime.interrupt 逻辑等价（SIGINT → 1.5s → SIGTERM），
    // 期间发 system_info 消息携带 this.topicId。
    // ...
  }

  /** 给 manager.restartAll / shutdown 用：硬 kill + 解绑监听，发一条 system 消息让用户感知 */
  forceKill(reason: 'restart' | 'shutdown') {
    if (this.activeChild) {
      const c = this.activeChild;
      // 关键：先解绑所有 child 监听器，避免 SIGTERM 后子进程的迟到 stdout
      // 仍然 emit runtime_event 流向 messageBus 而写出孤立的 tool 消息。
      // 这是 forceKill 与 interrupt() 的本质区别 —— interrupt 是温和 SIGINT，
      // 应当让事件流自然收尾；forceKill 是强制结束，丢弃后续输出。
      c.stdout?.removeAllListeners();
      c.stderr?.removeAllListeners();
      c.removeAllListeners('exit');
      c.removeAllListeners('error');
      try { c.kill('SIGTERM'); } catch {}
      this.activeChild = null;
      this.emitEvent({
        type: 'system_info',
        topicId: this.topicId,
        text: reason === 'restart' ? 'Runtime 已重启，本轮被中止' : 'Runtime 关闭，本轮被中止',
        raw: null,
      });
    }
    this.setStatus('idle');
  }

  private runTurn(content, model, opts): Promise<void> { /* 见 §1.1 */ }
  private handleOpencodeEvent(msg, opts): string { /* 与现状等价 */ }
  private emitEvent(e: RuntimeEvent) { this.emit('runtime_event', e); }
}
```

要点：

- 同一 topic 串行（`status==='busy'` 时 reject）。这是 opencode `-s` 的硬约束。
- **fallback 语义保持现状**：主模型失败仅日志，副模型失败才 emit `runtime_error`，避免用户看到误报。
- `forceKill(reason)` 区分 'restart' / 'shutdown' 两种来源，分别发不同 system 消息——满足 *Issue 5* 的"用户感知"要求。
- `interrupt()` 是用户主动 → 发"已中断"system 消息，保留 child 监听器让事件流自然收尾；`forceKill()` 是被动 → 发"已重启/关闭"，**解绑监听器并丢弃 SIGTERM 后的子进程输出**。两类语义不要混（见 §中断/重启表）。

#### 1.1 `runTurn` 与现状的差异

`runTurn` 的逻辑与现 [ClaudeRuntime.ts:148-243](../apps/server/src/claude/ClaudeRuntime.ts#L148-L243) 等价，仅做两处实例化改动：

- `this.activeChild = child` 而非全局 `claudeRuntime.activeChild`。
- `handleOpencodeEvent` 传入的 `topicId` 改为 `this.topicId`（由编译器保证非空）。

### 2. `ClaudeRuntime` → `ChatRuntimeManager`（保留旧 API）

文件：[apps/server/src/claude/ClaudeRuntime.ts](../apps/server/src/claude/ClaudeRuntime.ts)

旧调用方（**不要漏列！代码复核后清单**）：

- [index.ts:42](../apps/server/src/index.ts#L42) `claudeRuntime.getStatus()`（/api/health 端点）
- [index.ts:80-85](../apps/server/src/index.ts#L80-L85) `claudeRuntime.start().then(...).catch(...)`（启动钩子）
- [index.ts:114](../apps/server/src/index.ts#L114) `claudeRuntime.stop()`（进程 shutdown）
- [messageBus.ts:93,97](../apps/server/src/messageBus.ts#L93) `claudeRuntime.on('status' | 'runtime_event', ...)`
- [chatTopics.ts:111](../apps/server/src/chat/chatTopics.ts#L111) `claudeRuntime.sendUserMessage(text, opts)`
- [runtime.ts:7,12,22](../apps/server/src/routes/runtime.ts#L7) `claudeRuntime.getStatus()` / `restart()` / `interrupt()`

manager 必须为所有这些方法提供等价签名（或包装），否则编译就挂。

```ts
export class ChatRuntimeManager extends EventEmitter {
  private sessions = new Map<string, TopicSession>();
  private processStatus: RuntimeStatus = 'starting';   // 含义已在协议变更里收窄，不会再为 'busy'

  // —— 兼容旧 API —— //
  /** 旧调用方读的"runtime 状态"。现在仅反映进程健康度，绝不返回 'busy'。 */
  getStatus(): RuntimeStatus { return this.processStatus; }

  /** 旧 shutdown 钩子（index.ts:102）。等价于 stopAll。 */
  async stop(): Promise<void> { await this.stopAll(); }

  /** 旧全局 restart（routes/runtime.ts:12）。等价于 restartAll。 */
  async restart(): Promise<void> { await this.restartAll(); }

  /** 旧全局 interrupt（routes/runtime.ts:22）。无参时中断所有 busy session。 */
  async interrupt(topicId?: string) {
    if (topicId) {
      return this.sessions.get(topicId)?.interrupt() ?? { ok: false, method: 'noop' as const };
    }
    const results = [];
    for (const s of this.sessions.values()) {
      if (s.getStatus() === 'busy') results.push(await s.interrupt());
    }
    return { ok: true, count: results.length };
  }

  // —— 新 API —— //
  private getOrCreate(topicId: string): TopicSession {
    let s = this.sessions.get(topicId);
    if (!s) {
      s = new TopicSession(topicId);
      s.on('status', (st) => this.emit('topic_status', { topicId, status: st }));
      s.on('runtime_event', (e) => this.emit('runtime_event', e));
      this.sessions.set(topicId, s);
    }
    return s;
  }

  async start() {
    this.setProcessStatus('ready');
  }

  async stopAll() {
    for (const s of this.sessions.values()) s.forceKill('shutdown');
    this.setProcessStatus('stopped');
  }

  async restartAll() {
    for (const s of this.sessions.values()) s.forceKill('restart');
    this.sessions.clear();   // 清空 session map；下次 sendUserMessage 时按 topicId 重建
    await new Promise((r) => setTimeout(r, 100));
    this.setProcessStatus('ready');
  }

  async sendUserMessage(text: string, opts: SendOptions): Promise<void> {
    return this.getOrCreate(opts.topicId).sendUserMessage(text, opts);
  }

  /** 给前端 reconnect 时拉一次全量状态用（R1 修复） */
  getAllTopicStatus(): Array<{ topicId: string; status: TopicStatus }> {
    return Array.from(this.sessions.entries()).map(([topicId, s]) => ({
      topicId, status: s.getStatus(),
    }));
  }

  private setProcessStatus(s: RuntimeStatus) {
    if (this.processStatus === s) return;
    this.processStatus = s;
    this.emit('process_status', s);
  }

  // 'status' 事件已经被 messageBus 监听，这里保留一个 alias 转发到 process_status
  // 以避免改动 messageBus 订阅名（也可以同时改两边，看 PR 大小取舍）
}

// 保留旧导出名，所有 import 不动
export const claudeRuntime = new ChatRuntimeManager();
```

**保留 vs 兼容名清单**：

| 旧符号 | 行为 | 兼容方式 |
|---|---|---|
| `claudeRuntime` | 全局实例 | 导出名不变 |
| `.getStatus()` | 返回进程态 | 保留，行为收窄为不返回 'busy' |
| `.start()` | 启动 runtime | 保留，调 setProcessStatus('ready')。[index.ts:80](../apps/server/src/index.ts#L80) 调用 |
| `.stop()` | 进程 shutdown | 保留，调 stopAll |
| `.restart()` | 全局重启 | 保留，调 restartAll |
| `.interrupt()` | 全局中断 | **签名变**：增加可选 topicId 参数；无参时退化为 interruptAll |
| `.sendUserMessage()` | 发消息 | 保留，按 opts.topicId 路由到 getOrCreate(topicId).sendUserMessage |
| `.on('status', ...)` | 进程态事件 | 保留事件名，仅在 setProcessStatus 时 emit |
| `.on('runtime_event', ...)` | RuntimeEvent 透传 | 保留 |
| **新增**：`.on('topic_status', ...)` | per-topic 态 | 新事件名，messageBus 订阅 |
| **新增**：`.getAllTopicStatus()` | 状态快照 | 新 API，给 reconnect 用 |

**注册时序约定**：`startMessageBus()` 在 [index.ts:70](../apps/server/src/index.ts#L70) 启动时调一次，此时 manager 还没创建任何 TopicSession，但因 manager 是 module-level singleton（[ClaudeRuntime.ts:309](../apps/server/src/claude/ClaudeRuntime.ts#L309) `export const claudeRuntime = new ChatRuntimeManager()`），监听器先注册不会丢未来 emit 的事件。

### 3. `messageBus` 改 per-topic 工具映射

文件：[apps/server/src/messageBus.ts](../apps/server/src/messageBus.ts)

```ts
type ToolMaps = { idToMsg: Map<string,string>; idToName: Map<string,string> };
const toolMapsByTopic = new Map<string, ToolMaps>();

function mapsFor(topicId: string): ToolMaps {
  let m = toolMapsByTopic.get(topicId);
  if (!m) { m = { idToMsg: new Map(), idToName: new Map() }; toolMapsByTopic.set(topicId, m); }
  return m;
}

// startMessageBus 内：
claudeRuntime.on('status', (status: RuntimeStatus) => {
  broadcast({ type: 'runtime_status', status });
});

claudeRuntime.on('topic_status', ({ topicId, status }: { topicId: string; status: TopicStatus }) => {
  broadcast({ type: 'topic_status', topicId, status });
  if (status === 'idle') {
    // topic 回到 idle 时清理 tool maps（inflight 工具一定已结束）
    toolMapsByTopic.delete(topicId);
  }
});

claudeRuntime.on('runtime_event', (e: RuntimeEvent) => {
  // e.topicId 现在是必填，编译器保证
  switch (e.type) {
    case 'tool_start': {
      const id = randomUUID();
      const toolUseId = (e.raw as { id?: string } | null)?.id;
      if (typeof toolUseId === 'string') {
        const m = mapsFor(e.topicId);
        m.idToMsg.set(toolUseId, id);
        m.idToName.set(toolUseId, e.toolName);
      }
      addMessage({ id, topicId: e.topicId, role: 'tool', /* ... */ });
      return;
    }
    case 'tool_result': {
      const m = mapsFor(e.topicId);
      const toolUseId = (e.raw as { tool_use_id?: string } | null)?.tool_use_id;
      const id = (typeof toolUseId === 'string' && m.idToMsg.get(toolUseId)) || randomUUID();
      const toolName = (typeof toolUseId === 'string' && m.idToName.get(toolUseId)) || e.toolName;
      if (typeof toolUseId === 'string') {
        m.idToMsg.delete(toolUseId);
        m.idToName.delete(toolUseId);
      }
      // ...
    }
    // 其它分支不变，只是 e.topicId 不再可能 undefined
  }
});
```

**注意**：现有 `claudeRuntime.on('status', ...)` 在新协议下含义已是进程态（不会再有 busy）。这一行不需要改，只是它发出的事件值集合变了。

### 4. 路由层：`POST /api/chat` 改为非阻塞 + interrupt 加 topicId

#### 4.1 `POST /api/chat` 拆分（**Stage 0 关键**）

现状：[chatTopics.ts:75-119](../apps/server/src/chat/chatTopics.ts#L75-L119) `sendTopicMessage` 整段 await。

改造目标：HTTP 响应立刻拿到 topic，turn 在后台跑。

```ts
// chat/chatTopics.ts
export type SendTopicMessageResult = {
  topic: ChatTopic;
  /** 后台 turn 的 Promise，调用方一般不 await（仅测试场景需要）。错误已通过 runtime_event 表达。 */
  turn: Promise<void>;
};

export function sendTopicMessage(input: SendTopicMessageInput): SendTopicMessageResult {
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

  const runtimeOpts: SendOptions = {
    topicId: topic.id,
    sessionId: topic.opencodeSessionId ?? null,
    skipContext: input.skipContext,
    onSessionId: (sessionId) => { /* 同现状，更新 topic + broadcast topic_updated */ },
  };

  // ⭐ 关键：不 await。错误通过 TopicSession.emitEvent('runtime_error') 进入消息流。
  const turn = claudeRuntime.sendUserMessage(input.text, runtimeOpts)
    .catch((err) => {
      // sendUserMessage 内部已经 emit runtime_error 了，这里只兜底日志。
      // 唯一会漏的情况是 TopicSession 抛"上一轮还在执行"的同步错误 —— 这种情况下没有 emit。
      console.warn(`[chatTopics] background turn error topic=${topic.id}: ${String(err)}`);
      // 兜底广播一条 system message，避免静默丢失
      // ...（见下面"同 topic 重复提交"处理）
    })
    .finally(() => {
      const doneAt = new Date().toISOString();
      updateChatTopic(topic.id, { updated_at: doneAt, last_message_at: doneAt });
      const latest = requireTopic(topic.id);
      broadcast({ type: 'topic_updated', topic: { ...latest, updatedAt: doneAt, lastMessageAt: doneAt } });
    });

  return { topic, turn };
}
```

路由层：

```ts
// routes/chat.ts
chatRouter.post('/chat', async (req, res) => {
  // ... 同现状解析 text/topicId
  try {
    const { topic } = sendTopicMessage({ topicId, text, sourceKind: 'manual' });
    res.json({ ok: true, topic });   // 立即返回，不等 turn
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

**调用方影响**：

- [cardsService.ts:278](../apps/server/src/cards/cardsService.ts#L278) `applyCardAction` 中的 `await sendTopicMessage(...)` 改为 `const { topic } = sendTopicMessage(...)`（去 await）。原本它也是阻塞等 turn，去掉后卡片操作立即返回，turn 在后台跑——这正是多会话期望的行为。
- 同理 [cardsService.ts:328](../apps/server/src/cards/cardsService.ts#L328) attention 分支。
- 两处 try/catch **保留但语义收窄**：只兜底"建 topic / requireTopic / recordUserMessage"这一段同步路径的抛错。turn 内部错误（含同 topic 重复提交的同步 throw）已经在 chatTopics.ts 的 `.catch` 写成 system 消息（见下"同 topic 重复提交兜底"），**不会再进 cardsService 的 catch**。

改后的 `applyCardAction` ask_agent 分支示例（[cardsService.ts:270-293](../apps/server/src/cards/cardsService.ts#L270-L293)）：

```ts
if (action.kind === 'ask_agent' || action.kind === 'draft_reply') {
  const userPrompt = opts?.extraPrompt?.trim();
  const prompt = userPrompt || action.prompt?.trim() || buildDefaultPrompt(row, action.kind);
  try {
    // ⭐ 不再 await。`turn` Promise 已被 chatTopics.ts 内部 .catch 兜住，丢弃即可。
    const { topic } = sendTopicMessage({
      text: prompt,
      sourceKind: 'card',
      sourceRefId: row.id,
      title: row.title,
      skipContext: true,
    });
    const updated = updateCardStatus(cardId, newStatus, now);
    if (!updated) return { ok: false, error: 'update failed' };
    const card = rowToCard(updated);
    broadcast({ type: 'card_updated', card });
    return { ok: true, card, topic };
  } catch (err) {
    // 只会接到建 topic / 写 user 消息阶段的同步抛错（如 requireTopic 找不到 topic）
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

**attention 分支的额外注意**（[cardsService.ts:319-343](../apps/server/src/cards/cardsService.ts#L319-L343)）：`recordAttentionInteraction(attn, 'ask_agent', now)` 和 `updateAttentionItemStatus(attn.id, 'acted', now)` 改为**主线程同步执行**（不再等 turn 完成）——这是产品语义变更：

- **改前**：turn 跑完才标 acted（用户点完到状态翻转可能要 30s）。
- **改后**：点完立即标 acted，turn 在后台跑。**turn 失败不会回滚 acted 状态**，用户能看到 attention item 已经"acted"但右侧 tab 里有 system error 消息。

如果产品上不接受这个语义，需要单独加一条"turn 失败时反推 attention status 回 'live'"的逻辑（本期不做，留待用户反馈）。

**同 topic 重复提交的兜底**：TopicSession.sendUserMessage 在 status='busy' 时同步 throw。这个 throw 会被上面 `.catch` 接住。需要在 catch 里 emit 一条 system 消息让用户看到：

```ts
.catch((err) => {
  const errMsg = err instanceof Error ? err.message : String(err);
  // 写一条 system 消息到该 topic，避免静默
  insertRuntimeMessage({ /* role: 'system', level: 'error', text: errMsg, topic_id: topic.id, ... */ });
  broadcast({ type: 'message_added', message: { /* ... */ } });
});
```

#### 4.2 `POST /api/runtime/interrupt` 加 topicId

文件：[apps/server/src/routes/runtime.ts](../apps/server/src/routes/runtime.ts)

```ts
runtimeRouter.post('/runtime/interrupt', async (req, res) => {
  const topicId = typeof req.body?.topicId === 'string' ? req.body.topicId : undefined;
  try {
    const r = await claudeRuntime.interrupt(topicId);   // 无参 = 中断所有
    res.json({ ...r, status: claudeRuntime.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

复核：[index.ts:39](../apps/server/src/index.ts#L39) 已经全局挂了 `app.use(express.json({ limit: '1mb' }))`，所有 router 共享，**无需额外配置**。

#### 4.3 新增 `GET /api/runtime/topic-status`

给前端 WS reconnect 时同步用：

```ts
runtimeRouter.get('/runtime/topic-status', (_req, res) => {
  res.json({ topics: claudeRuntime.getAllTopicStatus() });
});
```

---

## 前端改造

### 1. App.tsx state 重构

文件：[apps/web/src/App.tsx](../apps/web/src/App.tsx)

```tsx
const [openTopicIds, setOpenTopicIds] = useState<string[]>(() => loadOpenTabs());
const [activeTopicId, setActiveTopicId] = useState<string | null>(() => loadActiveTab());
const [topics, setTopics] = useState<ChatTopic[]>([]);
const [messagesByTopic, setMessagesByTopic] = useState<Record<string, ChatMessage[]>>({});
const [topicStatus, setTopicStatus] = useState<Record<string, TopicStatus>>({});
const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>('starting');  // 仅进程态
const [cards, setCards] = useState<SignalCard[]>([]);
const [collectors, setCollectors] = useState<CollectorStatus[]>([]);
const [sending, setSending] = useState<Record<string, boolean>>({});
const [topError, setTopError] = useState<string | null>(null);
```

localStorage key：

- `aiisn.tabs.openTopicIds` → `string[]`
- `aiisn.tabs.activeTopicId` → `string | null`

load/save 都用 try/catch 包，JSON 解析失败时 fallback 为 `[]` / `null`（Issue 6 R6 修复）。

### 2. WS handler 解耦 active + 重连补拉

```tsx
const openIdsRef = useRef<string[]>(openTopicIds);
useEffect(() => { openIdsRef.current = openTopicIds; }, [openTopicIds]);

useEffect(() => {
  const client = connectWs((e: ServerEvent) => {
    switch (e.type) {
      case 'runtime_status':
        setRuntimeStatus(e.status);
        return;
      case 'topic_status':
        setTopicStatus(prev => ({ ...prev, [e.topicId]: e.status }));
        return;
      case 'message_added':
      case 'message_updated': {
        const tid = e.message.topicId;
        if (!tid) return;
        // 仅缓存当前打开 tab 的消息。未打开 topic 的事件丢弃 ——
        // 重新打开时由 fetchMessages 全量拉回。
        if (!openIdsRef.current.includes(tid)) return;
        setMessagesByTopic(prev => applyMessageToBucket(prev, tid, e.message, e.type));
        return;
      }
      case 'topic_created':
      case 'topic_updated':
        upsertTopic(e.topic as ChatTopic);
        // ↑ 即使该 topic 没在 openTopicIds，左侧 topic 列表仍然会刷新 lastMessageAt 排序
        return;
      case 'card_updated':
        applyCard(e.card, 'update');
        return;
      case 'attention_updated':
        fetchAttentionCards().then(setCards).catch(()=>{});
        return;
      case 'collector_status':
        applyCollector(e.collector);
        return;
      case 'error':
        setTopError(e.message);
        return;
    }
  },
  // ↓ connectWs 的第二个参数是 onOpen（[ws.ts:7](../apps/web/src/lib/ws.ts#L7) 已实现，
  //   无需扩展）。每次 (re)open 都会触发，拉一次 topic_status 快照修复 R1 漂移。
  () => {
    void fetchTopicStatusSnapshot()
      .then(snap => setTopicStatus(
        Object.fromEntries(snap.topics.map(t => [t.topicId, t.status]))
      ))
      .catch(err => console.warn('topic-status snapshot failed:', err));
  });
  return () => client.close();
}, []);   // ← 空依赖：WS 终生只连一次
```

**关键差异**：

- 依赖数组从 `[activeTopicId]` 改为 `[]`，WS 不再因为切 tab 而重连。
- 通过 `openIdsRef` 拿到最新 openTopicIds，避免闭包过期。
- WS open 时拉一次 `/api/runtime/topic-status` 同步（修复 R1）。

### 3. 打开 / 切换 / 关闭 tab

抗竞态 merge 抽成工具函数，`openTab` 和后面 §5 `onSend` 共用：

```tsx
/**
 * 把 fetchMessages 拉到的快照 merge 进 messagesByTopic[tid]。
 *
 * 为什么不直接覆盖：fetchMessages 拉到的是 HTTP 调用时点之前的列表，
 * 但 WS 可能在期间已经把新到达的消息塞进 messagesByTopic[tid] 的中间桶
 * （openTab 先把 tid 加进 openIdsRef、再 fetch；onSend 同理）。
 * 直接覆盖会丢这些"快照未包含但 cache 已收到"的消息。
 */
function mergeSnapshot(
  prev: Record<string, ChatMessage[]>,
  tid: string,
  snapshot: ChatMessage[]
): Record<string, ChatMessage[]> {
  const existing = prev[tid] ?? [];
  const snapshotIds = new Set(snapshot.map(m => m.id));
  const extras = existing.filter(m => !snapshotIds.has(m.id));
  return { ...prev, [tid]: [...snapshot, ...extras] };
}

async function openTab(topicId: string) {
  // 顺序关键：先加进 openIdsRef，再触发 fetchMessages。
  // 这样 fetchMessages 期间到达的 WS message_added 已经能通过 openIdsRef.current.includes
  // 的过滤，写入 messagesByTopic[topicId] 的中间桶（可能初始为空数组）。
  if (!openTopicIds.includes(topicId)) {
    setOpenTopicIds(prev => persistOpen([...prev, topicId]));
  }
  setActiveTopicId(persistActive(topicId));
  if (!messagesByTopic[topicId]) {
    try {
      const ms = await fetchMessages(topicId);
      setMessagesByTopic(prev => mergeSnapshot(prev, topicId, ms));
    } catch (err) { setTopError(String(err)); }
  }
}

function closeTab(topicId: string) {
  // 不发 interrupt — 后台让它继续跑
  setOpenTopicIds(prev => persistOpen(prev.filter(id => id !== topicId)));
  setMessagesByTopic(prev => { const c = {...prev}; delete c[topicId]; return c; });
  // topicStatus[topicId] 不清 — 它代表后端真实状态；重开 tab 时仍显示 busy
  if (activeTopicId === topicId) {
    const remaining = openTopicIds.filter(id => id !== topicId);
    setActiveTopicId(persistActive(remaining[0] ?? null));
  }
}

function newTab() {
  setActiveTopicId(persistActive(null));   // null 表示"新会话占位"
}
```

**性能权衡说明**（Issue 7）：每次 openTab 都 `fetchMessages` 全量拉一次（最多 500 条）。这是 O(关闭次数) 的网络成本，本期接受。未来如果体感慢，可以保留 LRU cache（容量 ~5 个 topic）。

### 4. UI 组件

新建 `apps/web/src/components/TabBar.tsx`：

```tsx
type Tab = { id: string; title: string; busy: boolean; active: boolean };

export function TabBar(props: {
  tabs: Tab[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="tabbar">
      <div className="tabbar__scroll">
        {props.tabs.map(t => (
          <div key={t.id}
               className={`tab ${t.active ? 'tab--active' : ''}`}
               onClick={() => props.onSelect(t.id)}
               title={t.title}>   {/* hover 显示完整 */}
            {t.busy && <span className="tab__spinner" aria-label="正在生成" />}
            <span className="tab__title">{truncate(t.title, 14)}</span>
            <button className="tab__close"
                    onClick={(e) => { e.stopPropagation(); props.onClose(t.id); }}
                    aria-label="关闭会话">×</button>
          </div>
        ))}
      </div>
      <button className="tab tab--new" onClick={props.onNew}>+ 新会话</button>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
```

**Tab 显示策略**（Issue 6）：

- title 在视觉上截到 14 字符 + ellipsis，`title` 属性保留完整以便 hover。
- 容器横向滚动（`overflow-x: auto`），不溢出菜单。tab 数过多时用户横拖。
- 已打开 5 个 tab 时，"+ 新会话"按钮始终钉在右侧（flex 布局）。

### 5. `onSend` 改造

```tsx
async function onSend(text: string, tid: string | null) {
  setTopError(null);
  const key = tid ?? '__new__';
  setSending(prev => ({ ...prev, [key]: true }));
  try {
    const { topic } = await sendChat(text, { topicId: tid ?? undefined });
    upsertTopic(topic);
    if (!openTopicIds.includes(topic.id)) {
      setOpenTopicIds(prev => persistOpen([...prev, topic.id]));
    }
    setActiveTopicId(persistActive(topic.id));
    if (!messagesByTopic[topic.id]) {
      const ms = await fetchMessages(topic.id);
      // ⭐ 必须用 mergeSnapshot 而非直接覆盖（同 openTab 的理由）：
      // newTab（tid===null）→ onSend 路径下，sendTopicMessage 已立即返回、turn 在后台跑，
      // message_added WS 事件完全可能先于 sendChat 的 HTTP 响应到达。
      // 此时 openTopicIds 还没包含新 topic.id（被 §2 的 openIdsRef 过滤丢弃 → 不会写桶），
      // 但等下面 setOpenTopicIds + setMessagesByTopic 都生效后，
      // fetchMessages 的快照可能比某些 WS 事件还旧——直接覆盖会丢。
      setMessagesByTopic(prev => mergeSnapshot(prev, topic.id, ms));
    }
  } catch (err) {
    setTopError(err instanceof Error ? err.message : String(err));
  } finally {
    setSending(prev => { const c = {...prev}; delete c[key]; return c; });
  }
}
```

**注意**：`sendChat` 现在立即返回（POST /api/chat 不阻塞），所以 `setSending` 的 lifetime 很短（只覆盖建 topic + fetchMessages 的时间）。真正的 thinking 由 `topicStatus[tid] === 'busy'` 表达。

### 6. `thinking` / `disabled` 复合公式

现状 [App.tsx:237-241](../apps/web/src/App.tsx#L237-L241) 的 `thinking` 是 `status` + 最后一条消息状态的复合判断；[App.tsx:294-301](../apps/web/src/App.tsx#L294-L301) Composer 的 `disabled` 同时考察 `sending` 和 `status`。分桶后需要全部按 topicId 改写：

```tsx
const activeMessages = activeTopicId ? messagesByTopic[activeTopicId] ?? [] : [];
const lastMsg = activeMessages[activeMessages.length - 1];
const activeTopicBusy = activeTopicId ? topicStatus[activeTopicId] === 'busy' : false;
const sendingKey = activeTopicId ?? '__new__';

// thinking 公式（与现状等价，只是 status 换成 topicStatus[active]）
const thinking =
  activeTopicBusy &&
  (!lastMsg ||
    lastMsg.role === 'user' ||
    (lastMsg.role === 'tool' && lastMsg.status === 'running'));

// Composer 传参
<Composer
  onSend={(text) => onSend(text, activeTopicId)}
  disabled={!!sending[sendingKey] || runtimeStatus === 'stopped'}
  thinking={thinking || activeTopicBusy}
  onInterrupt={() => onInterrupt(activeTopicId)}   // ⭐ 见 §7
  mode={activeTopic ? 'reply' : 'new'}
  topicTitle={activeTopic?.title}
/>
```

**关键差异**：
- `sending` 是 `Record<string, boolean>`，key 用 `activeTopicId ?? '__new__'`，与 §5 `onSend` 的写法对齐。
- `runtimeStatus === 'stopped'` 仍参与 disabled（进程都没了就别让用户敲）。
- `activeTopicBusy` 单值读取，**不做"任一 busy 聚合"**（重申 Stage 1 第 6 步的告警）。

### 7. `onInterrupt` 按 topic 中断

现状 [App.tsx:197-204](../apps/web/src/App.tsx#L197-L204) `onInterrupt` 调 `interruptRuntime()` 无参 → 全局中断。多 tab 模式下必须带 topicId：

```tsx
async function onInterrupt(topicId: string | null) {
  if (!topicId) return;   // 新会话占位时没东西可中断
  setTopError(null);
  try {
    await interruptRuntime(topicId);   // §8 lib/api.ts 已加 topicId 参数
  } catch (err) {
    setTopError(err instanceof Error ? err.message : String(err));
  }
}
```

Composer 内部点"停止"时调上面那个 `() => onInterrupt(activeTopicId)`。**绝不要走无参 interruptRuntime()**，否则会把其它 busy tab 也一起打断。

### 8. `seenIds` ref 删除

[App.tsx:44](../apps/web/src/App.tsx#L44) 的 `seenIds = useRef<Set<string>>(new Set())` 在改造后**整体删除**。它原本的作用是跟踪当前 topic 已看过的消息 id，防止 WS 与 fetchMessages 快照重复——但分桶后：

- `messagesByTopic` 的 setter 用 id 去重（见下面 §9 `applyMessageToBucket`），WS message_added 重复到达直接被丢弃。
- `mergeSnapshot`（§3）专门处理 fetchMessages 快照与 WS cache 的去重 merge。

继续保留 seenIds 会出现两套去重逻辑打架（一个按 ref、一个按 state），且按 ref 的那一套在切 tab 时会过期。**删干净**。一并清掉 [App.tsx:158](../apps/web/src/App.tsx#L158)、[App.tsx:179](../apps/web/src/App.tsx#L179)、[App.tsx:217](../apps/web/src/App.tsx#L217) 三处赋值。

### 9. `applyMessageToBucket` 实现

WS message_added / message_updated 进桶逻辑（替代现状 [App.tsx:60-72](../apps/web/src/App.tsx#L60-L72) 的 `applyMessage`）：

```tsx
function applyMessageToBucket(
  prev: Record<string, ChatMessage[]>,
  tid: string,
  msg: ChatMessage,
  mode: 'add' | 'update'
): Record<string, ChatMessage[]> {
  const bucket = prev[tid] ?? [];
  const idx = bucket.findIndex(x => x.id === msg.id);
  if (idx >= 0) {
    // 已存在 → in-place 替换（add/update 同样处理，幂等）
    const next = bucket.slice();
    next[idx] = msg;
    return { ...prev, [tid]: next };
  }
  // 不存在
  if (mode === 'update') {
    // 迟到的 update（对应消息可能在 fetchMessages 之前被驱逐了）→ 丢弃
    // 这与现状 applyMessage 的兜底等价
    return prev;
  }
  return { ...prev, [tid]: [...bucket, msg] };
}
```

**与现状 applyMessage 的差异**：
- 不再依赖 `seenIds.current` ref，直接按桶内 id 检查。
- `mode === 'update'` 找不到时丢弃（与现状一致），避免 fetchMessages 之前到达的孤立 update 写入空槽形成脏数据。

### 10. `lib/api.ts` 改动

```ts
export async function interruptRuntime(topicId?: string): Promise<{ ok: boolean; method?: string; count?: number }> {
  const r = await fetch('/api/runtime/interrupt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(topicId ? { topicId } : {}),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchTopicStatusSnapshot(): Promise<{ topics: Array<{ topicId: string; status: TopicStatus }> }> {
  const r = await fetch('/api/runtime/topic-status');
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// sendChat 返回值不变（仍是 { ok, topic }），但服务端现在立即返回，不再卡 30s
```

### 11. StatusBar 改动

文件：[apps/web/src/components/StatusBar.tsx](../apps/web/src/components/StatusBar.tsx)

```tsx
// 删 busy 行
const LABEL: Record<RuntimeStatus, string> = {
  idle: '空闲',
  starting: '启动中',
  ready: '在线',
  stopped: '离线',
  error: '错误',
};

const DOT_COLOR: Record<RuntimeStatus, string> = {
  idle: '#9ca3af',
  starting: '#fbbf24',
  ready: '#22c55e',
  stopped: '#9ca3af',
  error: '#ef4444',
};
```

可选 polish（本期不强制）：右侧加一个"`{busyCount} / {openCount} 进行中`"小标签，给用户多 tab 总览感。

---

## 边界与一致性

### 1. `buildActiveContext` 与并发

[ClaudeRuntime.ts:110-122](../apps/server/src/claude/ClaudeRuntime.ts#L110-L122) 在每个 turn 前同步调用（纯读 SQLite，无副作用）。两个 topic 并行 send 时各自调一次，得到几乎相同的快照——不阻塞、无竞态。本期不动。

### 2. 卡片 ask_agent / draft_reply 动作

[cardsService.ts:270-293](../apps/server/src/cards/cardsService.ts#L270-L293) 与 [cardsService.ts:319-343](../apps/server/src/cards/cardsService.ts#L319-L343) 在改造后：

- `await sendTopicMessage(...)` → `const { topic } = sendTopicMessage(...)`（同步拿 topic）。
- 路由响应仍返回 `{ ok, topic }`，前端 [App.tsx:212-218](../apps/web/src/App.tsx#L212-L218) 收到后调 `openTab(topic.id)`——自动添加并切到该 tab，符合"卡片操作把对话流引到右侧"的现有设计。
- [cardsService.ts:290-292](../apps/server/src/cards/cardsService.ts#L290-L292) 与 [cardsService.ts:341-343](../apps/server/src/cards/cardsService.ts#L341-L343) 的 `try/catch` **保留不变**，但语义从"捕获 turn 失败"**收窄为"捕获建 topic / 写 user message 阶段的同步错误"**。turn 本身的失败已经通过 TopicSession 的 `runtime_error` 事件写一条 system 消息到该 topic——和 `POST /api/chat` 路径完全统一，无需在卡片路由层重复处理。

### 3. 中断 / 重启 / 关闭完整语义表

| 操作 | 用户感知 | 实现 |
|---|---|---|
| Tab 内点"中断" | 该 tab 出现 system 消息"已中断当前回应" | `POST /api/runtime/interrupt {topicId}` → session.interrupt() (SIGINT→SIGTERM)，emit system_info |
| Tab 内中断未生效（1.5s 内） | 出现"已强制结束本轮"system 消息 | session.interrupt 走 SIGTERM 分支 |
| 关闭 Tab | 该 tab 从 UI 移除，不打扰其它 tab | 不调 interrupt；前端从 openTopicIds 移除；后台 turn 继续，事件落库 |
| StatusBar 的"重启" | **每个 busy tab** 出现"Runtime 已重启，本轮被中止"system 消息 | `POST /api/runtime/restart` → manager.restartAll → 每个 session.forceKill('restart') 各发一条 |
| 服务端进程崩重启 | 重连 WS 后 tab 仍在，重新发消息能继续 | sessions Map 空载；DB 保留 sessionId；首次 send 时按 topicId getOrCreate |
| 同一 topic 二次提交（前次未完成）| 该 tab 出现 system error"上一轮还在执行" | TopicSession.sendUserMessage 同步 throw → chatTopics.catch 写 system error 消息 |
| Tab 同 topicId 重复打开 | 无副作用 | openTab 去重 + 切 active |
| 浏览器关闭/刷新 | localStorage 保留打开的 tab；刷新后恢复 | 见 §前端 §1 |

### 4. 资源上限（L2，可选后置）

并行 N 个 opencode 子进程消耗 API quota / CPU / 内存。本期**不**强制做并发上限——日常打开 tab < 10。若日后观察到资源问题，可在 manager 加 `maxConcurrent`，超出时 reject 并在前端提示用户"过多并发"。

### 5. WS 广播放大

WS 现在广播给所有连接的客户端（[ws.ts:17-26](../apps/server/src/ws.ts#L17-L26)）。多会话后事件量增加 ~N 倍。前端按 topicId 过滤，渲染端无放大；后端 broadcast 仅 websocket 文本写，开销可忽略。**不做服务端按 topic 订阅**。

### 6. localStorage 多窗口

如果用户同时开两个浏览器窗口的 web，localStorage 共享，会互相覆盖 tab 状态。每个窗口启动时各自 load 一次，运行期各自写回，最后写赢。**已知边界，本期不支持跨窗口同步**。

---

## 落地分阶段

每个 Stage 独立部署、独立可回滚。单 tab 行为在每个 checkpoint 必须等价于现状。

### Stage 0 ｜ POST /api/chat 去阻塞（前置必做）

不依赖任何后续改动，先解掉 R4 阻塞陷阱。

1. `sendTopicMessage` 改为同步返回 `{ topic, turn }`，`turn` 不被路由层 await。
2. `POST /api/chat` 收到 topic 后立即 res.json。
3. `cardsService` 两处 `await sendTopicMessage` 去 await。
4. catch 链补"同 topic 重复提交时写 system error 消息"。
5. **验收**：手动 POST 两次相同 topic，第二次立即返回 200 + topic，**system 错误消息** 通过 WS 到前端；改前是 HTTP 卡 30s 才返回。

### Stage 1 ｜ 后端 TopicSession 拆分 + 新协议

1. 新建 `TopicSession.ts`，把 `sendUserMessage / runTurn / interrupt / handleOpencodeEvent` 实例化。
2. `ClaudeRuntime` 改写为 `ChatRuntimeManager`，**保留 `claudeRuntime` 导出名 + `getStatus / stop / restart / interrupt` 四个旧方法**。
3. `protocol.ts`：移除 `RuntimeStatus.'busy'`；新增 `TopicStatus`、`topic_status` 事件；`RuntimeEvent.topicId` 改必填。
4. `messageBus` 改 per-topic tool maps + 订阅 `topic_status`。
5. `POST /api/runtime/interrupt` 加 topicId 参数；新增 `GET /api/runtime/topic-status`。
6. **前端最小同步动作**（不是"兼容"，是必要改动，否则 ts 不过）：
   - `types.ts` 同步协议变更。
   - `App.tsx` 订阅 `topic_status` 事件维护一个 `topicStatus: Record<string, TopicStatus>`；把现有 [App.tsx:237,297](../apps/web/src/App.tsx#L237) 的 `status === 'busy'` 判定**替换为** `topicStatus[activeTopicId] === 'busy'`。Stage 1 期间打开的 topic 也只有 active 这一个，行为等价于现状——**不要做"任一 busy 聚合"**，否则后台 turn 跑别的 topic 时会错误冻住当前输入。具体复合公式见 §前端 §6 "thinking / disabled 计算"。
   - `StatusBar.tsx` 删 busy 分支。
7. **验收**：单 tab 跑大任务、卡片 ask_agent、interrupt、restart 行为与改前一致；运行下面的 *并发烟雾测试* 确认两个 topic 真并行。

### Stage 2 ｜ 前端 state 分桶（仍单 tab 视图）

1. App.tsx 把 `messages / status / sending` 改成 by-topic 结构。
2. WS handler 改空依赖 + ref；加 onOpen 重连同步。
3. `openTopicIds` / `activeTopicId` 仍只用一个 id，但内部已经按桶存。
4. **验收**：单 tab 路径完全等价；切换 topic 时若 cache 命中不再 fetch。

### Stage 3 ｜ Tab UI 上线

1. 新建 `TabBar.tsx`，替换 `pane--chat` 顶部 TopicHeader。
2. localStorage 持久化打开的 tab。
3. 关闭 tab 不发 interrupt。
4. 卡片 `ask_agent` 路径调 `openTab(topic.id)` 自动打开 tab。
5. CSS：tabbar 横向滚动、tab--active、tab__spinner、tab__close 样式。
6. **验收**：人工跑下面 10 个测试用例。

### Stage 4（可选）｜ L2 并发上限

manager 加 `maxConcurrent`，超出 reject。当前不做。

---

## 回归与测试

### 并发烟雾测试（Stage 1 必跑） — **已通过 ✅**

验证 opencode 本身支持并发（消除 R2 的不确定性）。

> ⚠️ **首次起 session 不要预生成 `-s` UUID**：opencode CLI 的 `-s <id>` 要求 session **已存在**于其本地存储，传入未创建过的随机 UUID 会立刻报 `Error: Session not found` 退出。正确做法：首次调用**不传 `-s`**，让 opencode 自己建 session 并在事件流里发出 `sessionID`；后续 turn 才用 `-s <捕获到的 id>` 复用。这也跟服务器内部 [chatTopics.ts:91](../apps/server/src/chat/chatTopics.ts#L91) 的逻辑一致（`opencode_session_id: null` 初值，首轮通过 `onSessionId` 回调回填）。

```bash
# 并发跑两个全新 session（不传 -s 让 opencode 自建）
rm -f /tmp/oc-{A,B}.{ndjson,err}
opencode run --agent aiisn-chat --format json -- "用一句话介绍你自己 A" > /tmp/oc-A.ndjson 2>/tmp/oc-A.err &
PID_A=$!
opencode run --agent aiisn-chat --format json -- "用一句话介绍你自己 B" > /tmp/oc-B.ndjson 2>/tmp/oc-B.err &
PID_B=$!
wait $PID_A; EA=$?
wait $PID_B; EB=$?
echo "exit_A=$EA exit_B=$EB"

# 纯度检查：A 文件只能含一个 sessionID，B 文件含另一个
grep -oE '"sessionID":"[^"]+"' /tmp/oc-A.ndjson | sort -u
grep -oE '"sessionID":"[^"]+"' /tmp/oc-B.ndjson | sort -u
```

**通过标准**（**全部满足才算通过**）：

1. 两个 PID 都 exit 0。
2. `/tmp/oc-A.ndjson` 中 `sessionID` 唯一且与 B 文件完全不同。**绝不能出现 A 文件里夹带 B 的 sessionID（这是并发不安全的典型表征）**。
3. A 文件的 `text` 事件内容语义与 prompt A 对应；B 同理（人工通读）。
4. 两个进程的实际墙钟时间 < 单独跑两次的总和（即真的并行）。

**2026-05-27 实测结果**（main HEAD `7b1c3c3` 上跑）：

| 验收 | 结果 |
|---|---|
| exit code | `exit_A=0 exit_B=0` ✅ |
| sessionID 纯度 | A=`ses_1969d0b47ffeR4YSH4VfpGf3Xo`、B=`ses_1969d0ba6ffeMqUWLN1zJgRR1k`，零交叉 ✅ |
| 文本语义 | 两条 self-intro 各自独立、与 prompt 对应 ✅ |
| 墙钟时间 | 并行 13s（单次实测 ~30s，串行预期 ~60s） ✅ |

→ **结论：Stage 1 走 L1 真并行路径**，无需降级到 L0 串行锁。

**失败应对**（R2 fallback → L0 路径，**本期不触发**，仅作为预案保留）：如果未来回归测试有任一项不通过：

- 保留所有后端协议变更（TopicSession / topic_status / tool maps per-topic）——这些不依赖 opencode 并发。
- 在 `ChatRuntimeManager` 加全局串行锁：所有 session 共享同一个 `Promise.then` 链，`sendUserMessage` 排队进入。
- 前端 UI 仍按多 tab 实现，但任一时刻只有一个 tab 实际在 busy；其它 tab 的 send 会被排队，新增"等待中"状态以避免误以为卡住。
- 这相当于 L0 + UI 多 tab，工作量增加 ~半天。

### 单元测试（建议补，本期不强制）

- `TopicSession` 串行约束：mock spawn，发两次，第二次同步 throw。
- `messageBus` per-topic tool map 互不污染：模拟两 topic 的 tool_start/tool_result 交叉发送，断言各自 map 独立。

### 手动用例

1. **基础并行**：开两 tab 分别发"写 5 段文章"。两 tab spinner 同时转，消息流互不交叉。
2. **抢占输入**：Tab A 大任务跑着，立刻在 Tab B 提交问题——Tab B Composer 不 disabled。
3. **独立中断**：Tab A 中断 → Tab A 出现"已中断"system 消息回 idle，Tab B 不受影响。
4. **关闭仍跑**：Tab A 大任务跑着，关闭 Tab A → 等 20s → 从左侧 topic 列表重开 → 看到完整 assistant 回复已落库。
5. **全局重启**：3 个 tab 全 busy → 顶部 restart → 三个 tab 各自出现"Runtime 已重启，本轮被中止"system 消息回 idle。
6. **同 topic 重复提交**：Tab A busy，用 curl 绕过 disabled POST 同 topicId → HTTP 200 立即返回，**该 tab 出现 system error**"上一轮还在执行"。
7. **刷新页面**：打开多个 tab → 刷新 → 仍恢复同样的 tab 集合与 active；topic_status 通过 WS onOpen 拉回正确值。
8. **WS 断连恢复**：DevTools Network throttle 离线 5s → 恢复 → 各 tab 的 topic_status 与服务端一致（即使期间某个 tab 完成了 turn）。
9. **卡片打开 tab**：点卡片"让 AI 处理"（参 [attentionProjection.ts:74,82](../apps/server/src/attention/attentionProjection.ts#L74)）→ 自动新 tab 弹出并 active；事件流向新 tab。
10. **单 tab 回归**：只用一个 tab，所有操作与改前一致。

---

## 风险与未决问题

### R1 · WS 重连后 topic_status 漂移 — **已修复**

通过 `GET /api/runtime/topic-status` + WS `onOpen` 钩子拉一次全量同步。详见 §4.3 / 前端 §2。

### R2 · opencode 是否真的并发安全 — **已验证 ✅（2026-05-27）**

烟雾测试在 main HEAD `7b1c3c3` 实测通过：两个并发 `opencode run` 的 sessionID 完全独立、文本互不交叉、墙钟 13s 完成（< 串行的 ~60s）。Stage 1 走 L1 真并行路径，L0 fallback 不触发但保留为未来回归预案。详见 *并发烟雾测试* 节。

### R3 · DB 写入并发 — 无风险

better-sqlite3 同步写 + Node 单线程事件循环 → 实际串行执行，无竞态。

### R4 · POST /api/chat 阻塞 — **已通过 Stage 0 修复**

见上。

### R5 · localStorage 反序列化失败

load 函数包 try/catch，失败 fallback 空状态。已在 §前端 §1 注明。

### R6 · 老 `legacy-global-chat` topic 的兼容

[db.ts](../apps/server/src/db.ts) 在升级时把无 topicId 的旧消息归到 `legacy-global-chat`。多 tab 模式下：

- 该 topic 在 topic 列表里和其它平等。
- 老消息没有 sessionId（[chatTopics.ts:91](../apps/server/src/chat/chatTopics.ts#L91) 的 `opencodeSessionId ?? null`），所以再发新消息会创建新 session——这是现有逻辑，不变。

### R7 · sourceLabel 与 Tab 来源图标

[App.tsx:357-363](../apps/web/src/App.tsx#L357-L363) 的 `sourceLabel` 返回"右侧输入 / 左侧面板 / 卡片"。Tab 标题前可加小图标（📥 / 💡 / 🃏）显示来源——本期不做，留 polish。

**`sourceLabel` 函数本期归宿**：跟着 [TopicHeader](../apps/web/src/App.tsx#L308-L355)（被 TabBar 取代）一起删除。如果未来要在 hover tooltip 显示来源，再恢复。删之前确认 [App.tsx:325](../apps/web/src/App.tsx#L325) 这个唯一调用点同时清掉。

---

## 改动清单（文件维度）

### 后端

| 文件 | 改动 |
|---|---|
| 新增 `apps/server/src/claude/TopicSession.ts` | 新类，搬迁 sendUserMessage / runTurn / interrupt / handleOpencodeEvent，加 forceKill（含 removeAllListeners） |
| 重写 `apps/server/src/claude/ClaudeRuntime.ts` | 改为 ChatRuntimeManager，**保留 `claudeRuntime` 导出名 + `start/getStatus/stop/restart/interrupt/sendUserMessage` 旧方法签名**，新增 `getAllTopicStatus` |
| 改 `apps/server/src/claude/protocol.ts` | RuntimeStatus 移除 'busy'；新增 TopicStatus、topic_status 事件；RuntimeEvent.topicId 改必填；ChatMessage.topicId 保留可选（legacy 反序列化兜底）并加注释 |
| 改 `apps/server/src/messageBus.ts` | per-topic tool maps；订阅 topic_status；topic idle 时清理 maps |
| 改 `apps/server/src/chat/chatTopics.ts` | sendTopicMessage 改为同步返回 `{ topic, turn }`，turn 不被外部 await；catch 链补 "同 topic 重复提交" system 消息 |
| 改 `apps/server/src/routes/chat.ts` | POST /chat 立即返回 |
| 改 `apps/server/src/routes/runtime.ts` | POST /runtime/interrupt 加 topicId 参数；新增 GET /runtime/topic-status |
| 改 `apps/server/src/cards/cardsService.ts` | 两处 `await sendTopicMessage` 去 await；try/catch 语义收窄为只兜建 topic 同步抛错；attention 分支 acted 状态改为同步更新（产品语义：turn 失败不回滚） |

### 前端

| 文件 | 改动 |
|---|---|
| 改 `apps/web/src/App.tsx` | state 分桶（messagesByTopic / topicStatus / sending: Record<>）；WS 空依赖 + openIdsRef；TabBar 接入；openTab/closeTab/newTab；onSend 改 mergeSnapshot；onInterrupt 改按 topicId；thinking/disabled 复合公式重写；**删 seenIds ref**；**删 TopicHeader 与 sourceLabel**；新增 mergeSnapshot / applyMessageToBucket 工具函数 |
| 新增 `apps/web/src/components/TabBar.tsx` | tab 列表 + spinner + close + new |
| 改 `apps/web/src/components/StatusBar.tsx` | LABEL/DOT_COLOR 删 busy 行 |
| 改 `apps/web/src/components/Composer.tsx`（可能） | 如果 Composer 内部把 onInterrupt 当无参回调用，需要改成 prop 由父级传 `() => onInterrupt(activeTopicId)`。不动 Composer 内部 API 也行（父级传 closure 即可），按 PR 大小取舍 |
| 改 `apps/web/src/lib/api.ts` | interruptRuntime 加 topicId；新增 fetchTopicStatusSnapshot |
| 改 `apps/web/src/types.ts` | 同步协议变更（RuntimeStatus 收窄、TopicStatus、topic_status 事件） |
| 改 `apps/web/src/styles.css` | .tabbar / .tab / .tab--active / .tab__spinner / .tab__close / .tab--new 样式 |

预计开发工作量：**Stage 0 半天 + Stage 1 一天 + Stage 2-3 一天 + 半天回归**，合计 **3 工作日**。

---

## 修订说明（v1 → v2）

基于 self-review 的 12 项问题 + 代码复核：

1. ✅ Stage 0 拆出，POST /api/chat 去阻塞从"风险条目"升级为前置必做。
2. ✅ `RuntimeEvent.topicId` 类型由可选改必填，明确编译期强校验。
3. ✅ Stage 1 第 6 步表述改为"必要前端同步动作"，不再说"兼容"。
4. ✅ TopicSession fallback 模型语义写清：主失败仅日志，副失败才 emit。
5. ✅ restartAll 通过 `forceKill('restart')` 给每个 busy tab 发 system 消息，用户可感知。
6. ✅ Tab 显示策略：title 截 14 字 + ellipsis + hover 完整 + 横向滚动。
7. ✅ messages cache 不缓存关闭 tab — 已加性能权衡说明。
8. ✅ 并发烟雾测试加 4 条明确通过标准；L0 fallback 实现写出。
9. ✅ `gcIdle` 移除（YAGNI）。
10. ✅ 未打开 topic 的 message_added 丢弃说明 + 解释左侧 topic 列表仍会刷新 lastMessageAt。
11. ✅ 链接路径保留 `../apps/...`（GitHub UI 兼容）。
12. ✅ R2 在烟雾测试不通过时的 L0 实现路径写明。

代码复核新发现并修：

- `claudeRuntime.getStatus() / stop() / restart() / interrupt()` 都被外部调用，manager 必须保留方法签名（不只是导出名）。
- 中断路由实际是 `/api/runtime/interrupt`、`/api/runtime/restart`，不是 v1 里写的 `/api/interrupt`。
- StatusBar 的 `LABEL` 和 `DOT_COLOR` 表都有 `busy` 行，要一起删。
- `sendTopicMessage` 在 cardsService 中也有两处 await，Stage 0 要一并改。

## 修订说明（v2 → v3）

基于第二轮 review 的 8 项问题 + 二次代码复核：

- **N1**（🔴）：`connectWs` 的 onOpen 是 positional 第二参数（[ws.ts:7](../apps/web/src/lib/ws.ts#L7)），文档之前误写成 `{ onOpen }` 选项对象形式。前端 §2 代码与改动清单的 ws.ts 行均已修正/删除。
- **N2**（🔴）：Stage 1 第 6 步原写"任一 topic busy 聚合成 thinking"，这会让后台跑别的 topic 时错误冻住当前输入框。改为读 `topicStatus[activeTopicId]` 单值。
- **N3**（🟡）：`forceKill` 增加 `removeAllListeners`，避免 SIGTERM 后子进程的迟到 stdout 流向 messageBus 写出孤立 tool 消息。并在要点里区分了 `interrupt()`（保留监听器，让事件流自然收尾）vs `forceKill()`（解绑+丢弃）的语义。
- **N4**（🟡）：cardsService 的 try/catch 改动后语义从"捕获 turn 失败"收窄为"捕获同步错误"，turn 错误统一走 `runtime_error` 事件，与 chat 路由对齐。已在边界§2 加注。
- **N5**（🟢）：删 `RuntimeProcessStatus` alias，直接用 `RuntimeStatus`。
- **N6**（🟢）：删"runtimeRouter 加 body parser"提示，`express.json` 已在 [index.ts:39](../apps/server/src/index.ts#L39) 全局挂载。
- **N7**（🟢）：openTab 改 merge 写入，避免 fetchMessages 期间到达的 WS 事件被快照覆盖丢失；并阐明顺序（先入 openIdsRef、再 fetch）。
- **N8**（🟢）：改动清单删 `lib/ws.ts` 那一行——onOpen 参数已存在，文件不需要改。

## 修订说明（v3 → v4）

基于第三轮 review（针对 main HEAD `e459ecb` 的全文逐行代码对账）的 12 项问题：

- **M1**（🔴）：兼容清单遗漏 [index.ts:80](../apps/server/src/index.ts#L80) `claudeRuntime.start()`。manager 必须保留 `start()` 方法签名，否则启动钩子直接挂。已在"保留 vs 兼容名清单"补上 `.start()` 与 `.sendUserMessage()` 两行，并加"注册时序约定"说明 startMessageBus 监听器先于任何 TopicSession 创建。
- **M2**（🔴）：§5 `onSend` 的 fetchMessages 写入是直接覆盖（`setMessagesByTopic(prev => ({ ...prev, [topic.id]: ms }))`），与 §3 `openTab` 的 N7 merge 修复不一致。newTab → onSend 路径下会丢消息。已抽 `mergeSnapshot` 工具函数，§3 / §5 共用。
- **M3**（🔴）：`seenIds` ref（[App.tsx:44](../apps/web/src/App.tsx#L44)）在分桶后会与新的桶内 id 去重打架，且按 ref 切 tab 时会过期。新增 §前端 §8 明确删除（含 App.tsx:158/179/217 三处赋值）。
- **M4**（🔴）：`onInterrupt`（[App.tsx:197-204](../apps/web/src/App.tsx#L197-L204)）多 tab 模式下不能走无参 interruptRuntime()，否则会一次中断所有 busy tab。新增 §前端 §7 给出按 topicId 中断的实现。
- **M5**（🔴）：`thinking` 是 status + lastMsg 状态的复合判断（[App.tsx:237-241](../apps/web/src/App.tsx#L237-L241)），Composer disabled 同时考察 sending 和 status（[App.tsx:294-301](../apps/web/src/App.tsx#L294-L301)）。Stage 1 第 6 步只说"把 status === 'busy' 换成 topicStatus[active] === 'busy'"过于模糊，复合公式没贴。新增 §前端 §6 完整公式，并把 sending 的 key 约定（`activeTopicId ?? '__new__'`）与 §5 onSend 对齐。
- **M6**（🔴）：§4.1 cardsService 改造只有文字描述"去 await"，没贴改后代码示例。容易遗漏 (a) 不再 await 时 `{ topic, turn }` 中 turn 的处理，(b) try/catch 语义收窄为只兜同步抛错。已补完整示例代码 + 边界说明。
- **M7**（🔴）：attention 分支去 await 后，`recordAttentionInteraction` 和 `updateAttentionItemStatus('acted')` 改为主线程同步执行——这是产品语义变更（用户点完立即标 acted，turn 失败不回滚）。已在 cardsService 改造段加"产品语义变更"提示。
- **M8**（🟡）：测试用例 #9 写"点卡片"问 AI"…"——当前按钮文案是"让 AI 处理"（[attentionProjection.ts:74,82](../apps/server/src/attention/attentionProjection.ts#L74)）。统一文案。
- **M9**（🟡）：`applyMessageToBucket` 在前端 §2 被引用但没贴实现——遗漏 `mode === 'update'` 找不到 id 时的丢弃兜底，多 tab 切换会出现孤立 update 写入空槽的脏数据。新增 §前端 §9 完整实现。
- **M10**（🟡）：`sourceLabel`（[App.tsx:357-363](../apps/web/src/App.tsx#L357-L363)）跟着 TopicHeader 一起删，但 R7 没明确去留。已在 R7 加"本期归宿"说明。
- **M11**（🟢）：`ChatMessage.topicId` 保留可选纯粹是 legacy raw_json 反序列化兜底，新写入路径不会再有空值。已在 §0 协议变更里加注释说明。
- **M12**（🟢）：行号漂移 5 处（index.ts:37→39、index.ts:40→42、index.ts:102→114、App.tsx:295→297、App.tsx:355-361→357-363），已全部更新。

---

> **行号脚注**：本文档所有 `apps/...:NNN` 行号引用以 main HEAD `e459ecb`（[`git log --oneline -1`](#)）为准。如果代码后续有改动导致行号漂移，请运行 `grep -n "<key 字符串>"` 重新定位，或参考文档 §修订说明每次 review 时一并更新。
