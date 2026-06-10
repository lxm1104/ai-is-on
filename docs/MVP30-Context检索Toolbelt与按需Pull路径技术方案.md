# MVP30 · Context 检索 Toolbelt 与按需 Pull 路径技术方案

> 目标：在「看到事项 → 让 AI 处理」的交互路径上，给通用 agent（`aiisn-chat`）一个**只读的 context 检索工具**，把"系统提前截断好、一次性喂过去（push）"改成"模型按当下任务自己拉（pull）"。
>
> 链路定位：`Event → Triage → Context → Trigger/Agent → Attention →` **`ask_agent`（本方案在此加 pull）**。批处理链（triage / attention engine / Matter reducer）保持 push 不动。
>
> 状态：草案 v1（已对照工作区代码核对；opencode 1.15.10 自定义工具链路已在本机实测跑通，可开工）
> 作者：刘昕明 + Claude
> 日期：2026-06-08

---

## 0. TL;DR

### 0.1 可复用基础（大部分已存在）

- **通用 agent 已就位**：`ask_agent` 跑的就是 `aiisn-chat`（[TopicSession.ts:187](../apps/server/src/claude/TopicSession.ts#L187) 写死 `opencode run --agent aiisn-chat`），它已有 `bash: allow` / `webfetch: allow`、`edit`/`write: deny`（[agents.ts:68-74](../apps/server/src/opencode/agents.ts#L68)）。
- **opencode 原生支持自定义工具**：`.opencode/tool/<name>.ts` 导出 `tool({description, args, execute})`（来自 `@opencode-ai/plugin`，仓库 `.opencode/node_modules` 里已装 `1.15.10`）。文件名即工具名，`opencode run` 自动发现、无需任何 `opencode.json`、无需在 agent 里显式授权（本机实测：建 `ctxprobe.ts` → `opencode run --agent aiisn-chat` 即被注册、execute 跑通、输出回到模型）。
- **Matter 句柄已经流到位**：`AttentionItem.matterId`（[attentionTypes.ts:74](../apps/server/src/attention/attentionTypes.ts#L74)）在 `buildRichAskAgentPrompt(attn)` 调用点（[cardsService.ts:331](../apps/server/src/cards/cardsService.ts#L331)）就在作用域里——但当前被原封不动丢弃。
- **短句柄机制已存在**：`matchMatterId()` / `expandTruncatedId()`（[db.ts:1402](../apps/server/src/db.ts#L1402)、[db.ts:1421](../apps/server/src/db.ts#L1421)），8 位 hex 前缀是事实标准，唯一前缀才展开、否则原样返回（fail-safe）。
- **全文 + url 的投影已存在**：`resolveAttentionSignalDetails()` / `resolveAttentionOriginItems()`（[contextProjection.ts](../apps/server/src/cards/contextProjection.ts)）已返回**完整原文 + 飞书 url**，且 IM 会话已做跨 event 去重合并（`mergeMessages`）。
- **Matter 全状态投影已存在**：`projectMatterDetail()`（[matterProjection.ts:134](../apps/server/src/matter/matterProjection.ts#L134)）给出全 timeline / evidence / entities / spaces。

### 0.2 数据流：push（不动）vs pull（本方案）

```text
┌────────────────────── 批处理链（push，本方案不动）──────────────────────┐
collectors → events → context_units → triage → attention engine → Matter reducer
  (raw)                (substrate)              assembleGlobalContextPacket
                          │                       （inputHash 幂等批处理）
                          │                              │
                          │                              ▼
                          │                      attention_items（待处理事项）
                          │                              │  用户点「让 AI 处理」
                          │                              ▼
                          │   ┌──────────── 交互链（pull，本方案）────────────┐
                          │   │ buildRichAskAgentPrompt(attn)                  │
                          │   │   = 瘦锚点：摘要 + matterId/signal 短句柄        │
                          │   │        │ opencode run --agent aiisn-chat        │
                          │   │        ▼                                       │
   按当下任务重新组织        │   │   通用 agent（aiisn-chat）                      │
   拉 scoped-but-full ◄────┼───┤   context-query 工具（只读）                   │
                          │   │        │ fetch 127.0.0.1:8787                  │
                          │   │        ▼                                       │
                          │   │   /api/agent-context/*（只读路由）── 复用       │
                          │   │   projectMatterDetail / resolveAttentionSignal*│
                          │   └────────────────────────────────────────────────┘
                          ▼
              substrate（context_units / events 原文）
```

### 0.3 核心问题

> 现状不是"模型看不到原文"，而是"模型有 `bash`/`lark-cli`/`sqlite3` 全读能力、却只拿到一段 400 字 × 6 条的截断文本、连 url 和稳定句柄都没有、还不知道自己被允许去捞更多"——能力过剩、接口缺失，能不能拿到对的原文全看它即兴 shell 考古准不准（非确定性）。本方案不给新能力，而是把即兴 shell 换成**带句柄、schema 校验、只读**的检索工具，让检索从"看运气"变确定，顺带把 raw bash 的 blast radius 收小。

### 0.4 MVP 拆解

| 阶段 | 内容 | 行为变化 | 风险 |
| --- | --- | --- | --- |
| **MVP30-P0** | `askAgentPrompt` 瘦身：把 `matterId` 短句柄 + 每条 signal 短句柄 + `events.url` 带进 prompt | 模型从"瞎翻"变"按句柄精准 curl / 开原文"，零 opencode 改动 | 低 |
| **MVP30-P1** | 新增只读路由 `/api/agent-context/*` + 自定义工具 `.opencode/tool/context-query.ts` + system prompt 加"何时 pull"策略 | push→pull 正式落地：typed 工具、scoped-but-full | 中 |
| **MVP30-P2** | `aiisn-chat` 的 `bash` 从全开收成命令级白名单（放行 `lark-cli`，收掉裸 `sqlite3`/直读 db 文件） | 检索走干净工具后收紧后门，blast radius 变小 | 中 |
| **MVP30-P3（可选）** | `searchContext` 自由文本检索（新建 FTS5）+ `getRelatedUnits` 的 entity/graph facet | 补上唯一的能力空白（自由文本搜不存在） | 中高 |

### 0.5 重要约束 / 重要决定

- **「过滤」= 按 scope/相关性，不是按压缩**。工具过滤的是"回哪些 unit"，**不是**"每条留多少字"——返回 **scoped-but-full**，绝不二次截断。否则只是把 push 的有损投影改成 pull 的有损投影，白费一次 round-trip。
- **读 context substrate，不读 triage/attention 投影**。triage/attention 是 push 链的产物（已做完决定、已有损）；pull 要直达 `context_units` / `events` 原文。"系统先前怎么判的"可以是**其中一个、且明确标注成投影**的工具，绝不当默认数据源。
- **只服务交互/被指令路径**。批处理链（triage / attention engine / Matter reducer）是确定性批处理 + 结构化契约 + `inputHash` 幂等，**保持 push + 专用 agent**，绝不让手持工具的通用 agent 即兴去跑（非确定、毁缓存）。
- **工具只读 by construction**：execute() 只走只读路由；`edit`/`write` 本就 deny。
- **锚点是 Matter**：`attn.matterId` 在时优先作查询根；为 null 时退到 `signalIds[]`。
- **句柄收短**：工具入参收 8+ 位 hex 前缀，服务端 `matchMatterId`/`expandTruncatedId` 还原，避免模型逐字 echo 36 位 UUID 出错（见既有 attention-llm-uuid-echo 记忆）。

---

## 1. 问题定义

### 1.1 当前症状

「看到事项 → 让 AI 处理」整条链：用户点动作 → [cardsService.ts:328](../apps/server/src/cards/cardsService.ts#L328) 的 `ask_agent` 分支 → `buildRichAskAgentPrompt(attn)`（[cardsService.ts:331](../apps/server/src/cards/cardsService.ts#L331)）→ `sendTopicMessage({…, skipContext: true})`（[cardsService.ts:350](../apps/server/src/cards/cardsService.ts#L350)）→ [TopicSession.ts:187](../apps/server/src/claude/TopicSession.ts#L187) spawn `opencode run --agent aiisn-chat`。

模型拿到的 context 由 `buildRichAskAgentPrompt` 一次性拼死，硬上限（[askAgentPrompt.ts:19-22](../apps/server/src/attention/askAgentPrompt.ts#L19)）：

```ts
const UNIT_CONTENT_TRUNC = 400;     // 每条 signal 正文截到 400 字
const MAX_SIGNAL_UNITS = 6;         // 最多展开 6 条
const MAX_SPACE_COMMITMENTS = 3;
const MAX_RELATED_ENTITIES = 6;
```

并且：**不带 `events.url`、不带稳定句柄**（[askAgentPrompt.ts:24-64](../apps/server/src/attention/askAgentPrompt.ts#L24) 只展开 `signalIds`/`relatedSpaceIds`/`relatedEntityIds` 的渲染文本，连 `attn.matterId` 都没读）。

机器实测（见 §5.2）：`aiisn-chat` 其实有 `bash: allow`、`read` 默认 allow、`webfetch: allow`；本机 `data/ai-is-on.sqlite`（45MB，`events` 3932 行、3870 行带 url）、`lark-cli` 在 PATH、本地 API `127.0.0.1:8787` 全部可达；agent 系统 prompt 还明示它用 bash + lark-cli 查信息。

> 结论：模型**不是看不到原文，是看得到、甚至被鼓励看，但只能靠瞎翻**——没有 url、没有 event/matter id 句柄、没有"该 curl 哪个接口"的说明，只能对着 title 在 45MB 库里 `LIKE` 模糊搜、猜 id，brittle 且非确定（可能不捞、可能捞错行）。

### 1.2 为什么不是"调大 cap"

把 `UNIT_CONTENT_TRUNC`/`MAX_SIGNAL_UNITS` 调大只是"push 更多"：更费 token，且仍是**一个固定形状**。同一事项，"帮我起草回复"要的是完整谈判线程，"判断要不要催"要的是跨 context 兑现状态——一个 assembler 不可能两个都猜对。价值在于**让形状由当下任务决定**，这只能靠 pull。

### 1.3 push / pull 边界（务必只动交互路径）

| 路径 | 触发 | agent | 取数方式 | 是否本方案 |
| --- | --- | --- | --- | --- |
| attention 生成 | 定时批处理 | `aiisn-attention`（专用） | push：`assembleGlobalContextPacket`，`inputHash` 幂等 | ❌ 不动 |
| triage 分诊 | 事件流 | `aiisn-triage`（专用） | push：`TRIAGE_SYSTEM_PROMPT` + 结构化输出 | ❌ 不动 |
| Matter reducer | context upsert | `aiisn-matter-reducer`（专用） | push：reducer schema | ❌ 不动 |
| **ask_agent** | **用户点「让 AI 处理」** | **`aiisn-chat`（通用）** | **现 push（截断）→ 改 pull（工具）** | ✅ **本方案** |

---

## 2. 现有代码分层对照

| 目标能力 | 当前代码 / 表 | 当前状态 | 复用方式 |
| --- | --- | --- | --- |
| 交互 agent runtime | `aiisn-chat` + `TopicSession` | ✅ 已有，带 bash/webfetch | 直接复用，加工具 |
| 自定义工具承载 | `.opencode/tool/*.ts`（不存在） | ⚠️ opencode 支持、目录未建 | 新增目录 + 1 个工具文件 |
| Matter 锚点 | `attn.matterId` | ✅ 已流到调用点，被丢弃 | 小改：带进 prompt + 工具入参 |
| 短句柄解析 | `matchMatterId`/`expandTruncatedId` | ✅ 已有，fail-safe | 直接复用 |
| Matter 全状态 | `projectMatterDetail` | ✅ 已有 | 直接复用（getMatterDetail） |
| 原文 + url | `resolveAttentionSignalDetails` | ✅ 已有，全文+url | 直接复用（getOriginText） |
| IM 线程合并 | `resolveAttentionOriginItems`/`mergeMessages` | ✅ 已有 | 小改（getFullThread，见 §4.3 gap） |
| 相关单元（实体/图/链接） | `collectRelatedContext`(私有) / `assembleGraphContext` / `listLinksFor` / `listMattersForContextUnit` | ⚠️ 部分私有 | 小改：导出 + 加 matter/entity 反查 |
| 自由文本检索 | 无 | ❌ 无 FTS、无 content LIKE | 新增 FTS5（P3） |
| scope/subject 过滤 | `ContextUnit.scope`/`subjectId` 存在但 list 不支持 | ⚠️ 字段在、过滤靠内存 | 小改：list 加 WHERE 或工具层后过滤 |
| 只读 HTTP 入口 | `/api/attention/:id/signals` 已有 | ⚠️ 仅按 attention id | 新增 `/api/agent-context/*` |

---

## 3. 设计总览：三件套

```text
①工具（capability）   ②system prompt（policy）   ③锚点（handle）
─────────────────    ─────────────────────────   ──────────────────
context-query 工具    "默认信摘要；需要保真          askAgentPrompt 瘦身：
（只读，schema 入参）   （起草/判矛盾/确认闭环）       摘要 + matterId 短句柄
  │                    才 pull 原文"策略段            + 每条 signal 短句柄
  ▼                                                  + events.url
/api/agent-context/*  ←──────────── 三者缺一不可 ──────────────┘
（只读路由，复用现有投影函数）
```

三者任一缺失都失败：只给工具不给策略→模型要么不用要么乱用；给工具+策略但锚点无句柄→工具调用打不准；有句柄无工具→退回 raw bash 瞎翻。

---

## 4. 工具集设计

单一对外工具 `context-query`，用 `op`（operation）字段分流到 5 个语义动作。**对外 1 个工具名、内部 5 个 op**——降低模型选择负担，也便于 opencode 单文件承载。

### 4.1 工具签名（`.opencode/tool/context-query.ts`）

```ts
import { tool } from '@opencode-ai/plugin'
import { z } from 'zod'

export default tool({
  description:
    '只读检索当前用户的工作 context。用于在处理一个事项时，按需拉取完整原文 / 事项状态 / ' +
    '相关历史，而不是只看提示里被截断的摘要。所有返回均为完整内容（不截断），但仅限你有权访问的范围。',
  args: {
    op: z.enum(['matter_detail', 'origin_text', 'full_thread', 'related_units', 'search'])
      .describe('要执行的检索动作'),
    handle: z.string().optional()
      .describe('短句柄：matterId / signalId / entityId 的 8+ 位 hex 前缀，或完整 id'),
    query: z.string().optional().describe('op=search 时的自由文本'),
    limit: z.number().int().min(1).max(50).optional().describe('返回条数上限，默认按 op'),
  },
  async execute(args, ctx) {
    const url = new URL('http://127.0.0.1:8787/api/agent-context/' + args.op)
    if (args.handle) url.searchParams.set('handle', args.handle)
    if (args.query) url.searchParams.set('query', args.query)
    if (args.limit) url.searchParams.set('limit', String(args.limit))
    const res = await fetch(url, { signal: ctx.abort })
    if (!res.ok) return `检索失败（${res.status}）：${await res.text()}`
    return await res.text() // 服务端已渲染成模型友好的紧凑文本/JSON
  },
})
```

> 关键：execute() 跑在 opencode 子进程里，**不直接开 sqlite**（避免与服务端 better-sqlite3 句柄争用 / 读到陈旧），而是 `fetch` 已在运行的服务端只读路由（§7）。

### 4.2 五个 op 的语义与背后复用

| op | 语义 | 入参 | 返回（scoped-but-full） | 背后复用函数 |
| --- | --- | --- | --- | --- |
| `matter_detail` | 事项全状态 | `handle`=matterId 前缀 | 标题/状态/优先级/nextAction/due + **全 timeline** + 全 evidence（带 kind/title/reason/effect）+ entities + spaces | `matchMatterId` → `projectMatterDetail`（[matterProjection.ts:134](../apps/server/src/matter/matterProjection.ts#L134)） |
| `origin_text` | 单条原文 | `handle`=signalId 前缀 | **完整 events.text/content（不截断）+ 飞书 url** + source/time | `expandTruncatedId` → `resolveAttentionSignalDetails`（[contextProjection.ts:567](../apps/server/src/cards/contextProjection.ts#L567)） |
| `full_thread` | 整段会话 | `handle`=matterId/signalId | IM 跨 event 去重合并、按时序升序的完整对话 + 打开链接 | `resolveAttentionOriginItems`/`mergeMessages`（[contextProjection.ts:428](../apps/server/src/cards/contextProjection.ts#L428)）+ §4.3 桥接 |
| `related_units` | 相关单元 | `handle`=matterId/entityId | 同实体/同事项/图邻域的相关 ContextUnit（含人、blocker、决策链） | `listMattersForContextUnit` / `listLinksFor` / `collectRelatedContext` / `assembleGraphContext` |
| `search` | 自由文本（P3） | `query` | 命中 title/content/events.text 的单元 | **新增 FTS5**（§7.3 gap） |

### 4.3 已知能力空白（必须在 doc 里标清）

1. **`search` 不存在**：全库无 FTS、无 content/title LIKE（`LIKE` 仅用于 id 前缀与 `aliases_json`）。`collectRelatedContext` 是**实体重叠 + 时间分**，不是文本搜。→ `search` 排到 **P3**，需新建 FTS5 虚表。MVP 主体（P0/P1）不依赖它。
2. **`full_thread(chatId)` 无直达**：`chat_id` 埋在 `events.source_id`（`chat:<id>:…`）或 `raw_json`，**非索引列**。现状只能从某个 attention item 的 `signalIds` 反推线程。→ 第一刀 `full_thread` 只覆盖"该事项/信号关联的会话"，真正按 `chatId` 取全量留作后续（需派生 `chat_id` 列 + 索引）。
3. **`getEventRowById` 私有**：最深的原文源（`events.text` 全文 + `url` + `raw_json`）目前只在 [contextProjection.ts:161](../apps/server/src/cards/contextProjection.ts#L161) 作模块私有函数，`db.ts` 只导出 `listEvents*`。→ 需在 `db.ts` 导出 `getEventById(id)`。
4. **`collectRelatedContext` 私有**（[agentContextAssembler.ts](../apps/server/src/context/agentContextAssembler.ts)）+ 以 focal **ContextUnit id** 为键，不是 matter/entity 句柄。→ 需导出 + 加"matter→evidence→focal"、"entity→units 反查"的桥接（`context_unit_entities` 反查现仅内联 SQL）。
5. **scope/subject 非读层过滤**：`ContextUnit`/`Matter` 有 `subjectId`/`scope`，但 `listActiveContextUnits`/`listMatters` 不按其过滤；`events` 表**根本没有 scope/subject 列**。→ 工具层按"投影出的 ContextUnit"做内存后过滤（`subjectId==='me' && scope==='work'`），原文层的越权由"只能经 matter/signal 句柄进入"天然收敛（见 §10.3）。

---

## 5. 工具交付机制

### 5.1 选型：opencode 一方自定义工具

opencode 1.15.10 三条扩展路都支持，选**一方自定义工具**：

| 机制 | 是否选用 | 理由 |
| --- | --- | --- |
| `.opencode/tool/<name>.ts`（一方工具） | ✅ **选** | 依赖已装（`@opencode-ai/plugin@1.15.10`）；**无需任何 `opencode.json`**（本仓库刻意零根配置、全物化到 `.opencode/`）；`opencode run` 自动发现；typed + schema 校验 + 有 description，远比教它 shell incantation 可靠；只读 by construction |
| MCP `type:local` 服务 | ❌ | 1.15.10 支持，但更重：要在仓库本没有的 `opencode.json` 里加 `mcp` 块 + 单独写 stdio 进程；且 `opencode mcp add` 默认写**全局** `~/.config/opencode`（机器级泄漏），不适合项目级工具。仅当工具要跨 opencode 装置复用才选 |
| bash + curl 裸调 | ❌（仅 P0 兜底） | 今天就能用（`bash: allow`），是同日 stopgap，但模型要手搓 curl、无 arg schema——正是要逃的"即兴 shell 考古" |

### 5.2 实测证据（命门，已端到端验证）

在本机用服务端那条一模一样的命令验证（验证 agent 跑的，建后即删、git 干净）：

```text
# 建 .opencode/tool/ctxprobe.ts（default export tool({...})）后：
$ opencode run --agent aiisn-chat --format json -- "调用 ctxprobe，handle=ZZTEST123"
… service=tool.registry status=started ctxprobe
… service=tool.registry status=completed ctxprobe          # 二进制自动发现并注册
… {"tool":"ctxprobe","input":{"handle":"ZZTEST123"},
   "output":"CTXPROBE_OK marker=ZZTEST123","metadata":{"truncated":false}}  # schema 校验、execute 跑通
… (模型最终文本回显 CTXPROBE_OK marker=ZZTEST123)            # 输出回到模型
```

要点（均经二进制串/实跑确认）：
- **无需 grant**：`agents.ts` 只渲染 `permission:` 不渲染 `tools:`，所以新工具**自动**对 `aiisn-chat` 可用（也对所有 agent 可用——见风险 §14.4）。
- **发现规则**：二进制扫 `{tool,tools}/*.{js,ts}`（单复数目录、`.js`/`.ts` 均可），`basename` 即工具名。
- **调用命令不变**：[TopicSession.ts:187](../apps/server/src/claude/TopicSession.ts#L187) 现命令即自动加载 `.opencode/` 下工具/agent，无需新 flag。

### 5.3 服务端启动期同步（与现有 agent 物化对齐）

现有 `syncOpencodeAgents()`（[agents.ts:189](../apps/server/src/opencode/agents.ts#L189)）在 boot 时把 agent 物化到 `.opencode/agent/*.md`。`.opencode/tool/context-query.ts` 是**静态源文件**（不需要按运行时 prompt 重写），所以**直接提交进仓库**即可，不进 `syncOpencodeAgents`。仅需确保 `.opencode/node_modules` 里 `@opencode-ai/plugin` + `zod` 在（已在）。

---

## 6. 句柄设计

### 6.1 复用现有解析，收短入参

工具入参 `handle` 接受**完整 id 或 8+ 位 hex 前缀**，服务端按 op 解析：

```text
matter_detail / related_units(matter)  →  db.matchMatterId(handle)        // matters 表，唯一前缀
origin_text / full_thread / related_units(unit)  →  db.expandTruncatedId(handle)  // context_units/cards/events
```

- `matchMatterId`（[db.ts:1421](../apps/server/src/db.ts#L1421)）：先精确，再 `/^[0-9a-f-]{4,35}$/i` 门控下 `LIKE '<id>%' LIMIT 2`，唯一才返回、否则 `null`。
- `expandTruncatedId`（[db.ts:1402](../apps/server/src/db.ts#L1402)）：同门控，跨 `context_units`/`cards`/`events` 唯一前缀展开、否则原样返回。
- **8 位 hex** 是事实标准（[db.ts:1395](../apps/server/src/db.ts#L1395) 注释「缩成 8 位前缀」；debug 渲染都用 `id.slice(0,8)`）。

### 6.2 fail-safe（接既有 uuid-echo 记忆）

模型逐字 echo 36 位 UUID 会截断/改错一位。对策：
- **prompt 里就给短句柄**（8–12 位），不给裸 36 位 UUID——echo 短串更稳。
- 解析**唯一前缀才命中**，歧义/未命中返回空而非乱猜（`LIMIT 2` → 要求恰好 1 行）。
- 工具返回里**回显它解析到的完整 id + 短句柄**，让模型后续调用用规范句柄。

---

## 7. 只读 HTTP 路由设计

### 7.1 新增路由文件 `apps/server/src/routes/agentContext.ts`

挂在 `/api/agent-context`（与现有 `attentionRouter` 同在 `/api` 下，[index.ts:67](../apps/server/src/index.ts#L67) 一带挂载）。**全部 GET、只读、仅 `127.0.0.1`**（见 §10）。

```text
GET /api/agent-context/matter_detail?handle=<matterPrefix>
GET /api/agent-context/origin_text?handle=<signalPrefix>
GET /api/agent-context/full_thread?handle=<matterOrSignalPrefix>
GET /api/agent-context/related_units?handle=<matterOrEntityPrefix>&limit=20
GET /api/agent-context/search?query=<text>&limit=20         # P3
```

每个 handler 的职责：①解析短句柄；②调对应投影函数；③**按 `subjectId==='me' && scope==='work'` 内存过滤**；④渲染成紧凑、模型友好的文本（保留完整正文，不二次截断），回显规范句柄。

### 7.2 返回示例（`origin_text`，紧凑文本）

```text
[origin_text] signal=a1b2c3d4 (event/im) 2026-06-07 21:07  url=https://…/messages/…
会话：单聊 · 詹育帆
★ 詹育帆: 这版方案我看了，调度那块还有问题，明天能同步下吗
刘昕明: 可以，我整理下今晚发你
（完整对话 12 条，已按时序合并去重；如需相关事项用 op=related_units handle=a1b2c3d4）
```

### 7.3 `search` 的 schema（P3，FTS5）

```sql
-- P3 才建。content/title 来自 context_units，body 来自 events.text。
CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  unit_id UNINDEXED,        -- 回指 context_units.id
  title,                    -- ContextUnit.title
  content,                  -- ContextUnit.content
  body,                     -- 关联 events.text（origin.refId → events）
  tokenize = 'unicode61'    -- 中文按 unicode 切分；如需更好可换 jieba（评估）
);
-- 由 contextStore.upsertContextUnit 的 hook 增量维护（insert/update 时同步 FTS 行）。
```

> 不做 DB 触发器自动同步，沿用项目"在 `upsertContextUnit` 后置 hook 里物化派生数据"的既有范式（与 `materializeRoutingForUnit` 同位）。

---

## 8. system prompt 改造（policy 段）

在 `aiisn-chat` 的系统 prompt（[claude/prompts.ts](../apps/server/src/claude/prompts.ts)，经 `agents.ts` 物化）追加一段"何时 pull"策略。要义：**默认信任提示里的摘要；只有当任务需要保真时才 pull**。

```text
## 处理事项时的 context 检索

提示里给你的是事项摘要 + 短句柄（matterId / signalId），正文是截断的。
默认直接基于摘要回答。**只有当任务需要原始保真时**，才用 context-query 工具拉全量：

- 要起草对外回复 / 复述原话 → op=origin_text 或 full_thread 取完整原文，别凭摘要编。
- 要判断两条信息是否矛盾 / 进展到哪 → op=matter_detail 看全 timeline 与 evidence。
- 要确认某事是否已在别处闭环（避免催已完成的事）→ op=related_units 看相关事项状态。
- 句柄用提示里给的短句柄原样传；解析失败会返回空，不要自己编 id。

不要为了"多看点"无脑全拉——只拉这次任务真正需要的。工具是只读的，不会执行任何写操作。
```

---

## 9. 锚点改造（`askAgentPrompt` 瘦身 + 带句柄）

[askAgentPrompt.ts:24-64](../apps/server/src/attention/askAgentPrompt.ts#L24) `buildRichAskAgentPrompt(item)` 改动（**P0 即可独立上线**）：

1. **顶部带 Matter 短句柄**（当前完全没读 `item.matterId`）：
   ```text
   【事项句柄】matter=<matterId.slice(0,12)>（用 context-query op=matter_detail 取全状态）
   ```
2. **每条 signal 带短句柄 + url**（当前 `renderUnit` 无句柄无 url）：
   ```text
   - [im] 詹育帆：调度那块还有问题…  (signal=a1b2c3d4 · 2026-06-07 21:07)
     原文链接：https://…           ← 来自 events.url
     （摘要截断；完整原文用 op=origin_text handle=a1b2c3d4）
   ```
3. **正文截断可适度收紧**（既然能 pull，摘要不必塞 400 字）——降到 ~200 字省 token，把"要全文去 pull"写明。
4. **签名不破**：`attn` 已携带 `matterId`/`signalIds`（[attentionStore.ts:108](../apps/server/src/attention/attentionStore.ts#L108) round-trip），唯一调用点 [cardsService.ts:331](../apps/server/src/cards/cardsService.ts#L331) 无需改。

---

## 10. 安全与权限

### 10.1 `bash` 收紧（P2）——但别砍掉 `lark-cli`

现状 `aiisn-chat` 的 `bash: allow` 是为 `lark-cli`（[agents.ts:60-61](../apps/server/src/opencode/agents.ts#L60) 注释）。**不能一刀 deny**，否则砍掉主聊天查飞书实时信息的能力。用 opencode 的**命令级 permission glob**：

```yaml
# .opencode/agent/aiisn-chat.md（由 agents.ts 渲染）
permission:
  bash:
    "lark-cli *": allow      # 飞书实时查询照旧
    "sqlite3 *": deny        # 不再需要裸读库（检索走 context-query）
    "curl *": ask            # 仍可 webfetch，但裸 curl 本地库/接口要确认
    "*": ask                 # 其余命令降级为 ask
  edit: deny
  write: deny
  webfetch: allow
```

> 需扩 `AgentDef.permission` 类型 + `renderAgentFile`（[agents.ts:161-179](../apps/server/src/opencode/agents.ts#L161)）以支持 bash 的嵌套 glob map（当前是扁平 `Record<tool, 'allow'|'ask'|'deny'>`）。

### 10.2 只读 by construction

- 工具 execute() 只 `fetch` GET 路由；`/api/agent-context/*` 全部只读、无副作用。
- `edit`/`write` 本就 deny。
- 路由**绑 `127.0.0.1`**（服务端已 listen `127.0.0.1:8787`，[index.ts:79](../apps/server/src/index.ts#L79)），不对外暴露。

### 10.3 scope 收敛（blast radius）

- 原文/事项**只能经 matter/signal 句柄进入**——模型无法"列出所有人的所有 context"，只能从它正在处理的事项往外扩。
- 投影出 ContextUnit 后按 `subjectId==='me' && scope==='work'` 内存过滤（`events` 表无 scope，故越权防线在 ContextUnit 层，见 §4.3-gap5）。
- 对比现状（raw bash 直怼 45MB 全库 + `lark-cli` 以用户身份回捞任意飞书内容），blast radius 显著收小。

### 10.4 cwd 耦合（运营须知）

opencode 工具发现**相对 `opencode run` 的 cwd**（服务端 `process.cwd()`，[TopicSession.ts:194](../apps/server/src/claude/TopicSession.ts#L194)）。若服务端从别的目录启动，`.opencode/tool/` 与现有 `.opencode/agent/` 会**一起静默失效**（无报错）。→ 部署脚本须保证服务端 cwd = 仓库根；文档/启动检查里加一条断言。

---

## 11. MVP 拆解

### MVP30-P0：锚点带句柄（低风险）

#### 范围
- 改 `buildRichAskAgentPrompt`：带 `matterId` 短句柄、每条 signal 短句柄、`events.url`；正文截断收到 ~200 字。
- `db.ts` 导出 `getEventById(id)`（供后续路由用，本阶段先备好）。

#### 不做
- 不引入自定义工具、不改 opencode、不动 bash 权限。

#### 验收
- ask_agent 后，模型提示里可见 `matter=`/`signal=` 短句柄与原文链接；模型用既有 `bash`/`webfetch` 即可精准打开/curl，而非模糊搜。
- 回归：`cardsService` 既有 ask_agent / draft_reply 行为不变（仅 prompt 文本变化）。

### MVP30-P1：context-query 工具 + 只读路由 + policy（中风险）

#### 范围
- 新增 `apps/server/src/routes/agentContext.ts`（`matter_detail`/`origin_text`/`full_thread`/`related_units`），复用 §4.2 投影函数；§4.3 的 1～4 号 gap 配套（导出 `getEventById`、导出/桥接 `collectRelatedContext`、`full_thread` 先覆盖事项信号）。
- 新增 `.opencode/tool/context-query.ts`。
- `aiisn-chat` 系统 prompt 加"何时 pull"策略段。

#### 不做
- 不做 `search`（P3）；不做按 `chatId` 全量线程；不收 bash（P2）。

#### 验收
- 模型在一次 ask_agent turn 内能成功 `op=matter_detail`/`origin_text` 并基于全文作答（事件流里出现 `tool` 事件，[TopicSession.ts:300](../apps/server/src/claude/TopicSession.ts#L300) handleOpencodeEvent）。
- 拿一个"起草回复"场景对比 P0/P1：P1 回复引用了被截断掉的原文细节。
- 越权用例：传别的 subject/scope 的句柄 → 路由返回空。

### MVP30-P2：bash 命令级收紧（中风险）

#### 范围
- 扩 `AgentDef.permission` + `renderAgentFile` 支持 bash glob map；`aiisn-chat` 放行 `lark-cli *`、deny `sqlite3 *`、其余降 ask。

#### 不做
- 不动其他后台 agent 的 `READ_ONLY`（它们本就无 webfetch、且批处理可信）。

#### 验收
- ask_agent turn 里 `lark-cli` 仍可用；`sqlite3 data/ai-is-on.sqlite` 被拒。
- 检索全部走 context-query，无回退 raw bash。

### MVP30-P3（可选）：search + related 扩展（中高风险）

#### 范围
- 建 `context_fts`（FTS5）+ `upsertContextUnit` hook 增量维护 + `op=search`。
- `related_units` 补 entity→units 反查与 `assembleGraphContext` 图邻域 facet。

#### 不做
- 不做跨 subject 的全局搜（仍限 my work scope）。

#### 验收
- `op=search query="调度"` 命中含该词的 ContextUnit；FTS 行随 upsert 同步。

---

## 12. 与现有模块的具体改造点

### 12.1 `attention/askAgentPrompt.ts`（P0）
- `buildRichAskAgentPrompt`：读 `item.matterId` 渲染句柄行；`renderUnit` 带 `signal=<id8>` + `events.url`（需在 `renderSignals` 里把解析到的 unit/event 的 url 取出，复用 `resolveAttentionSignalDetails` 的取 url 逻辑或直接 join event）。

### 12.2 `db.ts`（P0/P1）
- 导出 `getEventById(id): EventRow | null`（消除 [contextProjection.ts:161](../apps/server/src/cards/contextProjection.ts#L161) 的私有重复）。
- （P3）`listMatters`/`listContextUnits` 可选加 `subjectId`/`scope` WHERE；或保持内存过滤。

### 12.3 新增 `routes/agentContext.ts`（P1）
- 4 个只读 handler；绑 `127.0.0.1`；挂 `/api/agent-context`（[index.ts:67](../apps/server/src/index.ts#L67) 旁加一行 `app.use('/api', agentContextRouter)`）。

### 12.4 `cards/contextProjection.ts`（P1）
- 导出 `getEventById` 或改用 `db.getEventById`；`full_thread` 复用 `resolveAttentionOriginItems` 的会话合并（可能需把"从 signalIds 合并"抽成可独立调用的小函数）。

### 12.5 `context/agentContextAssembler.ts`（P1/P3）
- 导出 `collectRelatedContext`；新增 entity→units 反查（把内联 `context_unit_entities` SQL 提成导出函数）。

### 12.6 新增 `.opencode/tool/context-query.ts`（P1）
- 静态提交；依赖 `@opencode-ai/plugin` + `zod`（已在 `.opencode/node_modules`）。

### 12.7 `opencode/agents.ts` + system prompt（P1/P2）
- P1：`CHAT_SYSTEM_PROMPT` 加 policy 段。
- P2：`AgentDef.permission` 支持 bash glob map；`renderAgentFile` 渲染嵌套。

---

## 13. 测试计划

### Unit Tests
- `matchMatterId`/`expandTruncatedId`：8 位唯一前缀命中、歧义前缀返回空、非 hex 串原样。
- 每个路由 handler：给 matter/signal 句柄→返回含完整正文 + url；越 scope→空；坏句柄→空且不抛。
- `buildRichAskAgentPrompt`：含 `matter=`/`signal=`/url；`matterId=null` 时优雅降级（无句柄行）。

### Regression Fixtures
- 录一条真实 attention item（带 matterId + 多 IM signal），断言 P0 prompt 文本快照、P1 工具返回快照。
- ask_agent 端到端回放：mock opencode 子进程，断言"起草回复"场景下模型发起 `op=origin_text` 调用（捕获 `tool_start` 事件）。

### Metrics（观测）
- ask_agent turn 内 context-query 调用次数分布（>0 说明 pull 在用；过高说明 policy 没收住）。
- 句柄解析失败率（高 → 句柄/echo 问题）。
- P0 前后 prompt token 数（应下降）。

---

## 14. 风险与防护

### 14.1 工具被滥拉（过度 pull）
风险：模型每事必全拉，token 暴涨、慢。
防护：policy 段明确"默认信摘要、只在需保真时 pull"；`limit` 上限 50；观测调用次数；必要时 `related_units` 默认 cap 收紧。

### 14.2 cwd 耦合静默失效
风险：服务端非仓库根启动 → 工具 + 现有 agent 一起消失、无报错。
防护：启动期断言 `process.cwd()` 含 `.opencode/`；部署脚本固定 cwd；文档显著标注。

### 14.3 工具跑在子进程、不共享服务端 DB 句柄
风险：若直接开 sqlite → 与 better-sqlite3 争用 / 读陈旧。
防护：**强制走 localhost 只读路由**，工具内禁止直连 DB（code review 守住）。

### 14.4 工具对所有 agent 自动可用
风险：`.opencode/tool/*.ts` 对每个 agent（含批处理 agent）都可见。
防护：工具只读、且批处理 agent 是 push 不会主动调；如需严格隔离，P2 顺带给批处理 agent 渲染 `tools: { context-query: false }`（需扩 `renderAgentFile`）。

### 14.5 `--pure` kill switch
风险：任何人给 `opencode run` 加 `--pure` 会跳过自定义工具/插件加载。
防护：[TopicSession.ts:187](../apps/server/src/claude/TopicSession.ts#L187) 当前不带；改动该命令需评审；测试里断言无 `--pure`。

### 14.6 bash 收紧误伤 lark-cli
风险：P2 一刀 deny bash 砍掉主聊天飞书查询。
防护：命令级 glob 放行 `lark-cli *`（§10.1）；P2 验收专测 lark-cli 仍可用。

### 14.7 越权读到他人 scope
风险：`events` 无 scope 列，原文层无法直接过滤。
防护：原文只能经 matter/signal 句柄进入（不能枚举）；投影到 ContextUnit 后按 `subjectId/scope` 内存过滤；句柄唯一前缀解析杜绝枚举猜测。

---

## 15. 命名建议

- 工具名 / op：`context-query`，op ∈ `matter_detail | origin_text | full_thread | related_units | search`（snake，跟 opencode 文件名风格一致）。
- 路由：`/api/agent-context/<op>`。
- 新模块：`apps/server/src/routes/agentContext.ts`、`.opencode/tool/context-query.ts`。
- 服务端检索聚合（如需）：`apps/server/src/attention/agentContextQuery.ts`（与 `askAgentPrompt.ts` 同层，只读纪律一致）。

---

## 16. 最小落地建议（第一刀做什么窄闭环）

**先做 P0 + P1 的 `matter_detail` 与 `origin_text` 两个 op**，跑通"起草回复"一个场景：

1. P0 改 prompt 带句柄 + url（半天，零 opencode 风险，立刻可感知）。
2. 新增 `/api/agent-context/matter_detail` + `origin_text`（复用 `projectMatterDetail` / `resolveAttentionSignalDetails`，几乎零新逻辑）。
3. 提交 `.opencode/tool/context-query.ts`（只接这两个 op）。
4. prompt 加 policy 段。

验证：一条带完整 IM 谈判线程的事项，让它"帮我起草回复"，确认它发起 `op=origin_text` 并引用了被 400 字截断掉的细节。跑通后再加 `full_thread`/`related_units`，最后才是 P2 收 bash 与 P3 的 search。

---

## 17. 代码锚点与复用清单

### 直接复用（零/极小改）
- `projectMatterDetail` [matterProjection.ts:134](../apps/server/src/matter/matterProjection.ts#L134) — `matter_detail`
- `resolveAttentionSignalDetails` [contextProjection.ts:567](../apps/server/src/cards/contextProjection.ts#L567) — `origin_text`（全文 + url）
- `resolveAttentionOriginItems`/`mergeMessages` [contextProjection.ts:428](../apps/server/src/cards/contextProjection.ts#L428) — `full_thread`
- `matchMatterId`/`expandTruncatedId` [db.ts:1421](../apps/server/src/db.ts#L1421)/[db.ts:1402](../apps/server/src/db.ts#L1402) — 句柄解析
- `listMatterContextLinks`/`listMattersForContextUnit`/`listLinksFor` — `related_units`
- `aiisn-chat` runtime（[TopicSession.ts](../apps/server/src/claude/TopicSession.ts)）— 不改

### 小改复用
- `buildRichAskAgentPrompt` [askAgentPrompt.ts:24](../apps/server/src/attention/askAgentPrompt.ts#L24) — 带句柄 + url + 收截断
- `db.ts` — 导出 `getEventById`
- `agentContextAssembler.ts` — 导出 `collectRelatedContext` + entity→units 反查
- `agents.ts` `renderAgentFile` [agents.ts:161](../apps/server/src/opencode/agents.ts#L161) — bash glob map（P2）

### 新增模块
- `routes/agentContext.ts`（只读路由）
- `.opencode/tool/context-query.ts`（opencode 一方工具）
- `context_fts`（FTS5，P3）
- `aiisn-chat` system prompt 的 "何时 pull" policy 段

---

> 一句话收尾：本方案不给模型新能力（它早有 bash/lark/sqlite 全读，甚至太宽），而是把"即兴 shell 考古"换成**带句柄、schema 校验、只读、scope 收敛**的检索工具——让"看到事项→处理"这条路上的取数从看运气变确定，同时把 raw bash 后门收小。Push 的批处理链一行不动。
