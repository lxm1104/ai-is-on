# AI is ON：MVP2-MVP6 Context 连续性系统开发执行方案

> 目标读者：后续负责产品设计、架构演进和开发执行的 coding agent / human builder
> 基础前提：MVP0/MVP1 已按 `docs/MVP0-MVP1-开发执行方案.md` 跑通“飞书 context 自动流入 + Claude Code 处理 + 卡片触达”。
> 核心目标：把 AI is ON 从“信息流 triage demo”推进成“Context 持续流动、触发 Agent、结果回流”的系统。

---

## 1. 从原点重新定义后续 MVP

### 1.1 产品原点

AI is ON 的原点不是“有很多 Agent”，而是：

> 人在连续变化的世界里，需要维持“我是谁、我在做什么、什么重要、下一步该发生什么”的连续性。

所以后续 MVP 的主线不是不断堆工具，而是逐步建立一个 **Context Continuity System**：

```text
Context 被捕获
→ Context 被理解为动态情境模型
→ 系统判断其中的目标、张力、风险、机会、承诺和情绪意义
→ 触发合适的 Agent
→ Agent 处理、行动、沟通或陪伴
→ 结果回流为新的 Context
```

### 1.2 最关键的工程转向

MVP0/MVP1 的最小闭环是：

```text
Raw Signal → Triage JSON → Signal Card
```

MVP2 之后必须升级为：

```text
Raw Signal
→ Context Unit
→ Context Graph / Active Context
→ Trigger
→ Agent Run
→ Action Proposal / Card / Memory Update
→ Context Update
```

也就是：**卡片不再是系统核心产物，卡片只是 context 需要人介入时的一种呈现。**

### 1.3 核心设计原则

1. **Context 是主语，Agent 是谓语**
   Agent 是 context 变化后的处理函数，不是孤立工具列表。

2. **先让 Context 变厚，再让 Agent 变主动**
   主动性来自对目标、关系、承诺、约束和历史的理解，而不是更激进的 prompt。

3. **所有 Agent 输出必须回流**
   任何建议、草稿、用户选择、执行结果、失败原因，都要写回 context。

4. **宁可少推，不要乱推**
   打扰会破坏信任。后续每个 MVP 都要记录“为什么推、用户怎么反馈”。

5. **个人与工作不是两套系统**
   Personal / Work / Team 是同一套 context 模型在不同主体、关系和 boundary 下的投影。

---

## 2. Context 底层模型

### 2.1 Context 包含的 12 类信息

后续所有版本都围绕这 12 类 context 逐步补全，不要把它们拆成互不相干的功能。

| 类别 | 回答的问题 | 示例 |
|------|------------|------|
| 主体 Context | 这是对谁的 context？ | 用户身份、角色、偏好、状态、能力边界 |
| 目标 Context | 主体想要什么？ | 本周完成方案、今天少被打扰、想被理解 |
| 状态 Context | 现在是什么局面？ | 项目阶段、任务状态、用户能量、关系状态 |
| 事件 Context | 什么新东西发生了？ | 日程变化、消息 @我、文档更新、用户输入 |
| 时间 Context | 什么时候、持续多久、节奏如何？ | 截止时间、周期、等待时长、最佳行动窗口 |
| 关系 Context | 人、事、任务如何相连？ | 负责人、依赖方、上下级、任务阻塞关系 |
| 承诺 Context | 谁答应了什么？ | 周三给反馈、会后补 PRD、今晚缴费 |
| 资源 Context | 可以用什么？ | 时间、精力、权限、工具、资料、人力 |
| 约束 Context | 什么不能做、必须遵守什么？ | 隐私、权限、预算、审批、用户边界 |
| 情绪意义 Context | 这件事对主体意味着什么？ | 焦虑、被忽视、掌控感、认可感、压力 |
| 记忆 Context | 过去形成了什么理解？ | 历史决策、偏好、反复出现的模式 |
| 不确定性 Context | 哪些未知、冲突或过期？ | 置信度、假设、冲突来源、待确认项 |

### 2.2 ContextUnit 标准结构

MVP2 开始，所有 raw signal、对话、卡片反馈、Agent 结果都应尽量归一为 `ContextUnit`。

```ts
type ContextUnit = {
  id: string;
  subjectId: string;
  scope: 'personal' | 'work' | 'team';

  // —— Provenance：ContextUnit 可以从 raw event / chat / card action / agent run 任何一处来
  // 不要再用单一 `rawEventId`，统一用 origin 二元组
  origin: {
    kind: 'event' | 'chat' | 'card_action' | 'agent_run' | 'manual' | 'system';
    refId: string;   // 对应 events.id / runtime_messages.id / cards.id / agent_runs.id
  };

  // —— kind 是 §2.1 十二类的"工程化子集"。十二类是产品语言，kind 是 schema 语言。映射：
  //   主体 → subjectId（不进 kind）
  //   目标 → 'goal' | 'intent'
  //   状态 → 'state'                 （项目/任务/能量/关系任意"当前局面"，区分用 entities + meaning）
  //   事件 → 'event'
  //   时间 → time 字段
  //   关系 → 'relationship'          （或 'event' 配合 entities）
  //   承诺 → 'commitment'
  //   资源 → 'state'（带 resource 标签）
  //   约束 → 'constraint'
  //   情绪意义 → 'emotion'
  //   记忆 → 'memory'
  //   不确定性 → 'uncertainty'
  //   Agent 处理结果 → 'action_result'
  kind:
    | 'event'
    | 'state'
    | 'goal'
    | 'intent'
    | 'commitment'
    | 'relationship'
    | 'memory'
    | 'emotion'
    | 'constraint'
    | 'uncertainty'
    | 'action_result';

  title: string;
  content: string;
  entities: ContextEntityRef[];        // 通过独立关联表 context_unit_entities 落库
  relations: ContextRelationRef[];

  time?: {
    occurredAt?: string;
    startsAt?: string;
    endsAt?: string;
    dueAt?: string;
    expiresAt?: string;                // 默认值见 §4.3.1（数据保留）
  };

  emotion?: {
    valence?: 'positive' | 'neutral' | 'negative' | 'mixed';
    labels?: string[];
    intensity?: number;
  };
  meaning?: string;
  actionability: 'none' | 'record' | 'notify' | 'ask' | 'act';
  confidence: number;

  // —— Merge / 版本化：context 连续性的核心
  // 同一个语义实体（如"周三给 PRD 反馈"这条承诺）在多源/多次出现时应"合并而非新增"。
  mergeKey?: string;                  // 由 contextExtractor 计算，见 §4.3.2
  version: number;                    // 每次合并/更新 +1
  supersedes?: string[];              // 被合并掉的旧 ContextUnit.id（保留审计）

  status: 'active' | 'archived' | 'superseded';

  createdAt: string;
  updatedAt: string;
};
```

### 2.3 变化类型是触发 Agent 的根

后续 Trigger Engine 不应只看“是否有新事件”，而要看 context 变化类型。

| 变化类型 | 可触发的 Agent 工作 |
|----------|---------------------|
| 新事实进入 | 标准化、关联目标、判断是否需要记录或提醒 |
| 状态改变 | 更新项目/个人状态，判断计划是否失效 |
| 目标出现或改变 | 创建 intent，拆解任务，规划下一步 |
| 关系改变 | 同步相关人，更新依赖，提示沟通风险 |
| 承诺产生/临近/逾期/完成 | 跟踪、提醒、追问、升级、总结 |
| 冲突出现 | 标记不一致，生成澄清卡片 |
| 风险上升 | 预警、准备材料、建议调整计划 |
| 机会出现 | 建议推进长期目标或合并处理事项 |
| 信息过期或缺失 | 刷新、补问、降低置信度 |
| 情绪意义变化 | 陪伴、降噪、帮助整理、避免强推任务 |

---

## 3. 后续 MVP 总览

| 版本 | 名称 | 要验证的核心问题 | 用户感知 |
|------|------|------------------|----------|
| MVP2 | Context Foundation | 系统能否把碎片信号沉淀成可查询、可关联、可更新的 context？ | “它不只是看到了消息，它开始记得事情之间的关系。” |
| MVP3 | Triggered Agent Loop | Context 变化能否自动触发合适的 Agent 工作，而不依赖用户主动问？ | “它知道什么时候该准备、追踪、提醒或问我。” |
| MVP4 | Personal Life + Caring | 同一套 context 能否服务个人生活事务和情感陪伴？ | “它懂我最近的状态，也能帮我处理生活小事。” |
| MVP5 | Team Context Sync | 系统能否降低团队间 context 分叉，提升协作效率？ | “它知道谁需要知道什么，哪里没对齐。” |
| MVP6 | Boundary Learning + Limited Autonomy | 用户反馈能否逐步变成边界规则，让 Agent 自动处理低风险事项？ | “这类事它以后可以自己来，我只看结果。” |

---

## 4. MVP2：Context Foundation

### 4.1 目标

把 MVP1 的 `events / triage_results / cards` 升级为真正的 context 层。

MVP2 验证：

> 系统是否能从飞书事件、对话输入和卡片反馈中提取出目标、承诺、关系、状态、记忆和不确定性，并形成可回流的 Context Store。

### 4.2 范围

MVP2 拆三个递进切片（每片可独立合入、独立验收，避免一次性 1-2 周做完所有事）：

#### MVP2.0：落表 + 被动收集（~3 天）

- 引入 `context_units / context_entities / context_relations / context_unit_entities / context_links` 五张表。
- collector 写 `events` 后，**直接由 collector 同步写一条最小 ContextUnit**（kind=event，无 LLM 调用），先让 store 跑起来。
- 增加 `GET /api/context/units|entities|relations` 调试接口与 Context Inspector 调试视图。
- 不动 triage 链路，旧表全部保留。

#### MVP2.1：LLM 提取 + 合并（~4 天）

- 改造 **triage prompt 同时输出 `contextUpdates`**（详见 §4.6），把 triage 与 contextExtractor 合并为一次 LLM 调用，避免再多一次后台 Claude 子进程。
- 实现 `contextStore.upsert(mergeKey)` 合并语义：相同 mergeKey 命中既有 ContextUnit 时，version++、updatedAt 刷新、`supersedes` 收回。
- 实现 `entityResolver`：人名/项目名/文档名最小归一（trim + lower + alias 表）；不做向量。
- 在 collector 链路里替换 MVP2.0 的"最小 ContextUnit" 为 triage 产出的富 ContextUnit。

#### MVP2.2：active_context 注入对话（~2 天）

- 实现 `GET /api/context/active`（评分见 §4.6.1，含 token 预算与裁剪规则）。
- 改造 `ClaudeRuntime.sendUserMessage(text, opts?)`：每条用户消息发出前，把 active context 摘要拼到消息前面（不是 system prompt）。
- 在卡片详情页展示"为什么相关"。
- 卡片动作增加"理解错了"入口，写回 `context_feedback`。

不做：

- 不做复杂图数据库，SQLite 足够。
- 不做多用户。
- 不做自动写飞书。
- 不追求全量记忆向量检索。
- MVP2 不实现归档 worker（只设 `expiresAt` 字段+读路径过滤即可），归档放到 MVP3 之后。

### 4.3 数据模型增量

```sql
CREATE TABLE IF NOT EXISTS context_units (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL DEFAULT 'me',
  scope TEXT NOT NULL,

  -- provenance：单一来源旧字段废弃，用 origin_kind + origin_ref_id
  origin_kind TEXT NOT NULL,           -- 'event'|'chat'|'card_action'|'agent_run'|'manual'|'system'
  origin_ref_id TEXT NOT NULL,

  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  meaning TEXT,
  emotion_json TEXT,
  time_json TEXT,
  actionability TEXT NOT NULL DEFAULT 'record',
  confidence REAL NOT NULL DEFAULT 0.7,

  -- 合并 / 版本化（§4.3.2）
  merge_key TEXT,                      -- 命中既有 ContextUnit 时合并而非新增
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_json TEXT,                -- JSON array of context_unit.id

  -- 数据保留（§4.3.1）
  expires_at TEXT,                     -- NULL 表示长期；查询时自动过滤已过期
  status TEXT NOT NULL DEFAULT 'active', -- 'active'|'archived'|'superseded'

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_units_merge_key ON context_units(merge_key);
CREATE INDEX IF NOT EXISTS idx_context_units_kind_status ON context_units(kind, status);
CREATE INDEX IF NOT EXISTS idx_context_units_expires_at ON context_units(expires_at);

CREATE TABLE IF NOT EXISTS context_entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT,
  source TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(type, name)
);

-- ContextUnit ↔ Entity 关联表（Codex 指出的缺失）
CREATE TABLE IF NOT EXISTS context_unit_entities (
  context_unit_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  role TEXT,                           -- 例：'subject'|'actor'|'target'|'about'
  confidence REAL NOT NULL DEFAULT 0.7,
  PRIMARY KEY (context_unit_id, entity_id, role)
);

CREATE TABLE IF NOT EXISTS context_relations (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  context_unit_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  valid_from TEXT,
  valid_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_links (
  id TEXT PRIMARY KEY,
  from_context_id TEXT NOT NULL,
  to_context_id TEXT NOT NULL,
  link_type TEXT NOT NULL,             -- 'updates'|'contradicts'|'follows'|'about'
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL
);

-- 用户对系统理解的负反馈（MVP2.2 "理解错了" 入口写入）
CREATE TABLE IF NOT EXISTS context_feedback (
  id TEXT PRIMARY KEY,
  context_unit_id TEXT,
  card_id TEXT,
  reason TEXT NOT NULL,                -- 'wrong_entity'|'wrong_priority'|'wrong_meaning'|'other'
  comment TEXT,
  created_at TEXT NOT NULL
);
```

并对**现有 `events` 表**加一个字段（用 `ensureColumn` 平滑迁移，不要改 processed_at 的语义）：

```sql
ALTER TABLE events ADD COLUMN context_extracted_at TEXT;
```

- `events.processed_at`：保留旧含义，"triage 已处理"。
- `events.context_extracted_at`：MVP2 新含义，"已生成对应 ContextUnit"。两者解耦。

#### 4.3.1 数据保留默认值

| kind | 默认 expiresAt | 备注 |
|------|----------------|------|
| `event` | createdAt + 30 天 | 原始事件类，常被合并到更稳定的 commitment/state 后即可过期 |
| `commitment` | dueAt + 14 天（无 dueAt 时 createdAt + 60 天） | 关于"答应了什么"的长期事实 |
| `goal` / `intent` | createdAt + 90 天 | 用户主动建立的目标 |
| `state` / `relationship` / `routine` / `memory` | NULL | 长期事实，靠手动 archive 或被 superseded |
| `emotion` / `self_narrative` | createdAt + 14 天 | 高敏 + 易变，默认短期，超过即归档；用户可手动续期 |
| `uncertainty` / `action_result` | createdAt + 30 天 | |

MVP2 只在读路径过滤 `expires_at < now` 的行，不删除；归档 worker 放到 MVP3 之后。

#### 4.3.2 mergeKey 计算

`contextExtractor`（§4.6）输出每条 ContextUnit 时必须给 `mergeKey`，规则：

```text
mergeKey = sha1(
  subjectId + '|' +
  kind + '|' +
  canonical(primaryEntityIds.sort().join(',')) + '|' +
  canonical(salientPhrase)
)
```

其中 `salientPhrase`：
- commitment / intent：动作短语（"给反馈"/"补 PRD"），由 LLM 直接给一个 ≤20 字的 canonical 短语。
- event：日历 event_id 或 IM message_id（来源已唯一）。
- state / relationship：直接用首要 entityId。
- emotion：固定串 `emotion`（同 subject 当天合并）。

落库流程：

```text
upsert(mergeKey):
  if exists with same mergeKey and status='active':
    新行写入，旧行 status='superseded', supersedes_json 反向引用
    或：原地 UPDATE 后 version+=1（MVP2 选这条更简单，但要记 update_at）
  else:
    insert new (version=1)
```

MVP2 选**原地 UPDATE** 简化实现；MVP3 引入 trigger 后改成"insert + supersede"以便审计 diff。

### 4.4 后端任务

按 §4.2 切片标 phase。

#### MVP2.0（落表 + 被动收集）

- [ ] `db.ts` 增加 5 张 context_* 表 + `events.context_extracted_at` 列（用 `ensureColumn`，不破坏既有 MVP1 数据库）。
- [ ] 新增 `apps/server/src/context/ContextUnit.ts`：类型 + mergeKey 计算 helper。
- [ ] 新增 `apps/server/src/context/contextStore.ts`：`insert / upsertByMergeKey / listActive / get / setExpiresAt / addFeedback`。
- [ ] 修改 collector：每写一条 `events` 同步写一条 kind=event 的最小 ContextUnit（无 LLM，title/content 直接来自 event）。
- [ ] 新增路由：`GET /api/context/units|entities|relations|feedback`、`POST /api/context/feedback`。

#### MVP2.1（LLM 提取 + 合并）

- [ ] 改造 `triage/triagePrompt.ts`：JSON 输出增加 `contextUpdates: ContextUnitDraft[]`（schema 见 §4.6）。
- [ ] 改造 `triage/triageQueue.ts.persistOne`：写完 `triage_results` / `cards` 后，遍历 `contextUpdates` 走 `contextStore.upsertByMergeKey`，并把 collector 提前写入的 event ContextUnit 用 `context_links{link_type:'updates'}` 关联。
- [ ] 新增 `apps/server/src/context/entityResolver.ts`：trim/lower/alias 表，先不接向量。
- [ ] 在 `events.context_extracted_at` 上打时间戳，表示 ContextUnit 已生成。

#### MVP2.2（active_context 注入对话）

- [ ] 新增 `apps/server/src/context/activeContext.ts`：实现 §4.6.1 的评分与裁剪。
- [ ] 新增 `GET /api/context/active`：返回 `{ items: ContextUnit[], summary: string, tokenEstimate: number }`。
- [ ] 改造 `ClaudeRuntime.sendUserMessage(text, opts?: { skipContext?: boolean })`：把 `summary` 作为前置 user 消息块拼到当前消息前面（不是 system prompt，便于在前端透明展示"我现在带的 context 是什么"）。`skipContext: true` 用于卡片动作触发的内部 prompt 避免重复注入。
- [ ] 新增 `apps/server/src/cards/contextProjection.ts`：卡片详情时拼接关联 ContextUnit/entity（"为什么相关"）。

### 4.5 前端任务

- [ ] 增加 "Context" 调试 tab（MVP2.0 起可用）。
- [ ] 展示最近 ContextUnit 列表，按 `kind / origin.kind / actionability` 过滤。
- [ ] 展示轻量 entity/relations 列表（不需要画图）。
- [ ] 卡片详情展示 "为什么相关"：目标、承诺、关系、时间、置信度（MVP2.2）。
- [ ] 卡片动作增加 "理解错了" 入口，POST `/api/context/feedback`（MVP2.2）。
- [ ] 顶部 status bar 增加 "active context: N items, ~M tokens" 小标记，让用户随时能看到"AI 现在带了哪些 context"。

### 4.5.1 旧表迁移与兼容

**不删除 `events / triage_results / cards / user_rules`**。MVP2 的关系：

| 旧表 | MVP2 后定位 |
|------|------------|
| `events` | 仍是 raw signal 唯一事实源，**新增 `context_extracted_at`** 表示已生成 ContextUnit |
| `triage_results` | 保留为审计层（"Claude 当时对这条 event 的原始判断"），新触发链路读 ContextUnit |
| `cards` | **schema 升级**：废弃 `triage_id` 单源绑定，新增 `source_kind ('triage'\|'agent_run'\|'manual') / source_ref_id`；用 `ensureColumn` 平滑迁移，旧 `triage_id` 仍可读 |
| `user_rules` | MVP6 升级为 `boundary_rules`，**不直接重命名**：MVP6 新建 `boundary_rules` 表 + 一次性把 `user_rules WHERE active=1` 映射到结构化条件（条件无法结构化的标 `migrated=false`，由用户在 boundary 视图复核） |

`createCardsFromTriage` 仍保留为兼容入口，MVP2.1 起新加 `createCardFromProposal(proposal)` / `createCardFromContext(unit)` 两个投影函数，统一进 `cards` 表。

### 4.6 Prompt 增量

MVP2 **不新增一个独立的 contextExtractor 后台进程**，而是把 context 提取并进 triage 的同一次 LLM 调用，避免 2x 后台 Claude 子进程成本。改造 `triagePrompt.ts` 输出 schema：

```jsonc
{
  "items": [
    {
      "sourceEventId": "...",
      "relevant": true,
      "priority": "P1",
      "title": "...",
      "summary": "...",
      "reason": "...",
      "suggestedAction": "...",
      "draftReply": "...",
      "confidence": 0.8,
      "shouldCreateCard": true,
      "cardActions": [ /* ... 同 MVP1 ... */ ],

      // —— MVP2 新增字段
      "contextUpdates": [
        {
          "kind": "commitment",        // §2.2 kind 枚举
          "title": "周三前补 MVP2 方案",
          "content": "原始消息：...",
          "entities": [
            { "type": "person", "name": "小李" },
            { "type": "project", "name": "AI is ON" }
          ],
          "time": { "dueAt": "2026-05-20T23:59:59+08:00" },
          "actionability": "ask",
          "confidence": 0.85,
          "mergeHint": "周三前补 MVP2 方案",   // 用于 §4.3.2 mergeKey 计算
          "emotion": null,
          "meaning": null
        }
      ]
    }
  ]
}
```

**`scope` / `subjectId` 默认来源**：LLM 不需要也不应该在 `contextUpdates` 里填这两个字段。`triageQueue.persistOne` 在调用 `contextStore.upsertByMergeKey` 时按下面规则补齐，避免各端自解释：

- `subjectId`：固定为 `'me'`（MVP2 单用户）。MVP5 多人 Space 时改为 event/space 推导。
- `scope`：默认从来源继承——
  - `event.source ∈ {calendar, im, mail, drive}` → `'work'`
  - `event.source = 'manual'` 且 composer mode = 'life' / 'check-in' → `'personal'`
  - `event.source = 'agent'` → 继承触发该 agent run 的 trigger 的 scope
  - 其他 → `'work'`
- `origin`：同样由后端补，不交给 LLM。`origin = { kind: 'event', refId: event.id }`（triage 路径）；其它入口见 §2.2 注释。

LLM 只需要输出"语义"字段（kind/title/content/entities/time/emotion/meaning/actionability/confidence/mergeHint）。

提取规则（追加到 triage system prompt）：

```text
对每条信号，除了 triage 字段外，再尽量提取 contextUpdates：
1. 事实事件：仅当事件本身值得长期记忆时给一条 kind=event；常规日历/IM 信号 collector 已写过最小 ContextUnit，这里不重复给。
2. 用户目标或意图：kind=goal / intent
3. 承诺：谁答应了什么、什么时候 —— kind=commitment（必须有 mergeHint 和 dueAt 如果文本里有）
4. 关系：涉及的人、项目、文档、任务 —— 放进 entities，不要单独造一条 kind=relationship 除非确实在描述关系本身
5. 约束或边界：kind=constraint
6. 情绪意义：明确证据时才给 kind=emotion；不确定就 null。**严禁脑补**
7. 不确定性：信息冲突或需要确认的，kind=uncertainty

每条 contextUpdate 必须有 confidence ∈ [0,1]，宁可少提取不要乱提取。
mergeHint 是一个 ≤20 字的语义短语，相同的承诺在多源出现时应给出相同 mergeHint。
```

#### 4.6.1 active_context 评分与裁剪

`GET /api/context/active` 返回当前最相关的 ContextUnit 切片，规则：

```ts
score(unit) =
    weight_recency      * exp(-ageHours / 48)          // 近期权重，48 小时半衰
  + weight_actionability * actionabilityWeight(unit)    // ask/act 高于 record/none
  + weight_due          * dueProximityWeight(unit)      // dueAt 临近 +分
  + weight_priority     * priorityFromLinkedCard(unit)  // 关联 card 的 P0/P1 +分
  + weight_confidence   * unit.confidence
  + weight_user_pinned  * (unit.pinned ? 1 : 0)
  - weight_dismissed_kind * dismissedSimilarRecently(unit)

权重初值: { recency: 1.0, actionability: 0.8, due: 0.9, priority: 0.7, confidence: 0.3, pinned: 1.5, dismissed: 0.6 }
```

**Token 预算**：单次注入硬上限 1500 tokens（≈3000 字中文）。裁剪规则：

1. 按 score 倒序拿 top N。
2. 估算 token = `unit.title.length + unit.content.length / 2`（粗估即可）。
3. 累加 ≤ 1500 后截断。
4. 截断尾部用一行 `...还有 K 条更低相关性 context 未带入。` 提示。
5. 输出 `summary` 时按 kind 分组（commitments / goals / state / recent events / uncertainties），每组 ≤3 条。

裁剪后的 `summary` 必须是**人也能读懂的文本**，因为它会直接拼到 user message 前面（见 §4.4 MVP2.2 改造）。

### 4.7 验收标准

按切片验收：

**MVP2.0 验收**

```text
跑一轮 collector，应产生：
1. events 中有 raw event；
2. context_units 中至少有 1 条 kind=event（来自 collector 直写）；
3. /api/context/units 能列出；
4. 前端 Context tab 能看到这条。
```

**MVP2.1 验收**

```text
制造一条 @我消息："周三前麻烦你补一下 AI is ON 的 MVP2 方案。"

应产生：
1. context_units 中至少有 1 条 kind=commitment，mergeHint 包含 "MVP2 方案"；
2. context_entities 识别出相关人或项目；
3. context_unit_entities 关联表写入；
4. 同一句话第二次出现时，commitment 不新增，version+=1；
5. events.context_extracted_at 不为空。
```

**MVP2.2 验收**

```text
1. /api/context/active 在工作时间和深夜返回不同 score 排序；
2. 在前端发送 "我这周答应了什么"，请求 payload 中 user message 前面带着 active context summary，且 ≤1500 token；
3. Claude 回答里至少包含 MVP2.1 那条承诺；
4. 卡片详情页能展示关联的 ContextUnit；
5. 点 "理解错了" 写入 context_feedback。
```

### 4.8 成功指标 + 评测约定

每个版本起都按 §4.9 的 fixture/eval 约定测一次，不再依赖手感。

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| Context 提取召回率 | ≥70% 的承诺/目标在 fixture 集中被识别 | fixture 标注 + 自动比对 mergeKey 命中 |
| 承诺识别准确率 | ≥60% 不"乱编" | fixture 集人工标 false-positive 比例 |
| active_context 命中率 | 在 fixture 问答里 Claude 答案覆盖关键承诺/事件 | 人工 review 答案 |
| 打扰率 | 用户对卡片的 dismiss/ack 比例 ≤30% | 持续从 cards.status 算 |
| 调试可解释性 | 每张卡片能追溯到 origin + ContextUnit + entity | 抽查 |

### 4.9 评测 / Fixture 约定（跨版本通用）

MVP2 起每个版本必须有：

1. **Fixture 集**：`apps/server/test/fixtures/<mvpX>/` 下放至少 10 条标注后的 raw signal（日历 / IM / mail / 用户输入），覆盖典型 + 边缘场景。
2. **Golden expectation**：每条 fixture 配一个 `expected.json`，至少标注：相关 ContextUnit 的 kind、mergeHint、主要 entity 名称、是否应该出卡片、应有的优先级。
3. **离线评测脚本**：`apps/server/scripts/eval.ts <mvpX>` 跑一遍 triage + context 提取，与 expected 对比，输出召回 / 准确 / 打扰指标。
4. **接受门槛**：本版本验收前 eval 必须跑过，**结果允许低于目标**但必须**在 PR 描述里明示数字**，让人能判断是否回归。
5. **打扰率必须从真实数据算**：在 `cards` 上加一个 `dismissed_at` 时间戳，定期统计 `dismissed / total`。

不要把 eval 做成"会上线后再补"。MVP2 验收时同步交付 fixture 集和最小评测脚本。

---

## 5. MVP3：Triggered Agent Loop

### 5.1 目标

让 Agent 不再只由用户问题或 collector batch 触发，而是由 context 变化触发。

MVP3 验证：

> 当 context 中出现承诺临近、风险上升、信息冲突、目标阻塞、机会窗口时，系统能否自动选择合适的 Agent 工作。

### 5.2 核心链路

```text
ContextUnit created/updated
→ Trigger Evaluator
→ Trigger created
→ Agent Job enqueued
→ Agent Run
→ Action Proposal / Result Card / Context Update
```

### 5.3 Trigger 范围

MVP3 **首期只实现 2 类**（commitment_due / meeting_prepare），其余 3 类是 MVP3 的"目标覆盖"，等到 fixture 数据足够再加。一次铺 5 类会重复 MVP2 工程量低估的坑。

| Trigger | 优先级 | 输入条件 | Agent 行为 | 输出 |
|---------|--------|----------|------------|------|
| `commitment_due` | **MVP3 必做** | 承诺有 dueAt 且 dueAt-now < 24h，或已逾期 ≤7d | 检查是否完成（关联 action_result / context_links），生成提醒或追问草稿 | 卡片 |
| `meeting_prepare` | **MVP3 必做** | 重要会议（关键字 "评审/汇报/客户/1on1"，或与 P0/P1 commitment 关联）30-60 分钟内开始 | 查相关 context，准备会前摘要 | 卡片 |
| `context_conflict` | MVP3.x 延伸 | 文档/消息/日程出现冲突（依赖 §7 divergence 能力） | 标记冲突，生成澄清问题 | 卡片 |
| `goal_blocked` | MVP3.x 延伸 | 目标相关承诺逾期或依赖缺失 | 生成 unblock 建议 | 卡片 |
| `low_noise_batch` | MVP3.x 延伸 | 多条 P2/P3 累积超过 N 条或时长超过 6h | 压缩为日报/半日报摘要 | 摘要卡片 |

### 5.4 数据模型增量

```sql
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  context_unit_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  trigger_id TEXT,
  agent_type TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_proposals (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT,
  proposal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reversible INTEGER NOT NULL DEFAULT 1,
  impact_scope TEXT NOT NULL DEFAULT 'self',
  requires_approval INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 5.5 后端任务

**Trigger Evaluator 必须同时实现 push + pull 两条路径**：

- **Push**：`contextStore.upsertByMergeKey` 写完后同步调用 `triggerEvaluator.evaluate(unit)`，对刚变化的 ContextUnit 立即评估。覆盖"承诺产生/更新"这类事件触发。
- **Pull**：一个后台 worker（每 60s 扫一次）对 `context_units WHERE time_json.dueAt < now + lead_time` 评估。覆盖"承诺到期/会议临近"这类基于时间的触发。

两条路径共用 evaluator 函数，输出统一进 `triggers` 表，evaluator 自己负责幂等（相同 `(trigger_type, context_unit_id, due_at_bucket)` 不重复创建 pending trigger）。

- [ ] 新增 `apps/server/src/triggers/triggerEvaluator.ts`：纯函数 `evaluate(unit | dueAtRow): TriggerDraft[]`，便于离线 fixture 测试。
- [ ] 新增 `apps/server/src/triggers/triggerScheduler.ts`：60s 轮询的 pull worker。
- [ ] 在 `contextStore.upsertByMergeKey` 调用点接 push 钩子。
- [ ] 新增 `apps/server/src/agents/agentRegistry.ts`，**先只注册 2 类**：
  - `prepare_meeting`
  - `track_commitment`
  （`resolve_conflict / daily_digest` 等到 MVP3.x）
- [ ] 新增 `apps/server/src/agents/AgentRunQueue.ts`，`concurrency = 1`，timeout 默认 90s，失败重试 1 次。
- [ ] 修改 `cards` schema（与 §4.5.1 一致）：`source_kind / source_ref_id` 替代 `triage_id`，新增 `createCardFromProposal()`。
- [ ] 新增 `GET /api/agent-runs`、`POST /api/triggers/run-once` 方便调试。
- [ ] 每个 trigger 在 `triggers.payload_json` 里记录 **reasoning**：哪条 ContextUnit 触发、命中什么规则；前端"Today"视图直接展示，避免"AI 突然出现"。

### 5.6 前端任务

- [ ] 卡片展示来源：`来自信息流判断` / `来自承诺追踪` / `来自会前准备`。
- [ ] 增加“Agent 正在后台处理”的轻量状态。
- [ ] 卡片详情展示 Agent Run 输入摘要和输出摘要。
- [ ] 对 `action_proposal` 类型卡片支持“确认执行 / 修改 / 放弃”。

### 5.7 验收标准

```text
创建一个 40 分钟后开始、标题包含“评审/汇报”的日程。

系统应：
1. 生成 meeting_prepare trigger；
2. 到触发时间后启动 prepare_meeting agent_run；
3. Agent 查询相关 ContextUnit；
4. 生成一张会前准备卡片；
5. 卡片说明准备依据、缺失信息和建议动作；
6. 结果写回 context_units，kind = action_result。
```

---

## 6. MVP4：Personal Life + Caring

### 6.1 目标

把同一套 context 模型从工作信息流扩展到个人生活和情感场景。

MVP4 验证：

> AI is ON 能否不仅帮用户处理“事”，也能维持用户内在 context 的连续性，让用户觉得被理解、被承接、被减负。

### 6.2 产品范围

必须做：

- 增加手动生活 context 输入入口：文本/语音均可复用现有 Composer。
- 增加每日轻量 check-in：状态、能量、情绪、今天关注。
- 增加 Caring Agent：对最近 context 做情绪意义和负荷分析。
- 增加 Life Task Agent：处理明确生活事务，如提醒、计划、清单、比较。
- 增加 Relationship Context：重要关系、承诺、沟通节奏。

不做：

- 不做医疗诊断。
- 不接入银行、支付、健康等高敏数据。
- 不自动联系现实中的朋友/家人。
- 不把情感场景做成“强行安慰”的聊天模板。

### 6.3 Context 增量

新增 `scope = personal` 的高价值 context 类型：

| 类型 | 说明 |
|------|------|
| emotion | 用户当前情绪、能量、压力、期待 |
| self_narrative | 用户对自己的判断，例如“最近什么都做不好” |
| relationship | 重要关系状态和最近互动 |
| routine | 作息、习惯、周期性事项 |
| life_commitment | 对自己或他人的生活承诺 |
| preference | 明确偏好和反感项 |

### 6.4 后端任务

- [ ] 扩展 `ContextUnit.kind`，支持 `emotion / routine / self_narrative`。
- [ ] 新增 `apps/server/src/caring/caringAnalyzer.ts`。
- [ ] 新增 `apps/server/src/caring/caringPrompt.ts`。
- [ ] 新增 `caring_notes` 的新版实现，关联到 ContextUnit。
- [ ] 新增每日 check-in trigger，可由 cron-like scheduler 本地触发。
- [ ] 新增 `relationship_entities` 的轻量标签，复用 `context_entities`，`type = person`。
- [ ] Agent 回答前读取 active caring notes，但必须区分“用户想解决问题”还是“用户想被听见”。

### 6.5 前端任务

- [ ] 在输入区增加轻量模式切换：`工作` / `生活` / `随便说说`。
- [ ] 增加今日状态 check-in 卡片，用户可快速选择能量和情绪。
- [ ] 对情感类卡片减少任务按钮，优先提供"聊聊 / 先记下 / 帮我整理"。
- [ ] 增加"不要分析这个"按钮，写入 boundary/user_rules。
- [ ] **顶部设置区一个硬开关：「暂停情绪分析」**。开启后：
  - `triagePrompt` 中的 emotion/self_narrative 提取规则被 system prompt 关掉。
  - 已有 `kind=emotion / self_narrative` 的 ContextUnit 立即从 active_context 注入中排除。
  - Caring Agent 整体不再启动。
  - 此开关状态写入本地配置文件，对后台 trigger / agent 也生效。
  这条是隐私/信任的硬约束，**不依赖**用户在每条卡片上点"忽略"。

### 6.6 Caring Agent 行为边界

Caring Agent 要做：

- 命名情绪，但不诊断。
- 识别模式，但不武断下结论。
- 降低用户负担，而不是制造更多待办。
- 当用户低能量时，优先提供更小的下一步。
- 在明确生活事务中，转给 Life Task Agent。

Caring Agent 不做：

- 不假装比用户更懂用户。
- 不主动评价用户人际关系对错。
- 不未经确认发送任何对外消息。
- 不在证据不足时推断心理状态。

### 6.7 验收标准

```text
用户连续三天输入：
“今天有点累，什么都不想做。”
“又拖延了，感觉自己不行。”
“明天还有评审，想到就烦。”

系统应：
1. 生成 emotion / self_narrative / work commitment 相关 ContextUnit；
2. Caring Agent 识别出压力和自我否定模式，但标注置信度；
3. 当用户问“我最近怎么了？”时，能基于 context 温和总结；
4. 当明天评审临近时，Prepare Meeting Agent 应降低行动颗粒度，例如“先准备 3 个要点”，而不是给完整大计划。
```

---

## 7. MVP5：Team Context Sync

### 7.1 目标

从“帮我个人省心”扩展到“帮团队减少 context 分叉”。

MVP5 验证：

> 系统能否识别团队协作中的承诺、依赖、冲突和信息未同步，并生成合适的同步动作或草稿。

### 7.2 产品范围

必须做：

- 接入飞书文档/Wiki 最近更新。
- 接入任务或从会议/消息中提取待办。
- 建立项目级 Context Space。
- 识别团队承诺：谁负责、交付什么、什么时候。
- 识别 context divergence：会议说了 A，文档还是 B；A 改了信息，B 可能不知道。
- 生成同步卡片或消息草稿，但不自动发送。

不做：

- 不做全企业权限模型。
- 不自动代表用户对同事发消息。
- 不接入所有群聊，只从用户明确关注的项目/群开始。
- 不追求组织级 dashboard。

### 7.3 新增概念：Context Space

Context Space 是某个项目、主题或长期目标的上下文容器。

```ts
type ContextSpace = {
  id: string;
  type: 'project' | 'topic' | 'relationship' | 'personal_goal';
  name: string;
  description?: string;
  ownerSubjectId: string;
  entityIds: string[];
  activeGoalIds: string[];
  status: 'active' | 'paused' | 'archived';
  createdAt: string;
  updatedAt: string;
};
```

MVP5 只做 `type = project / topic`。

### 7.4 数据模型增量

```sql
CREATE TABLE IF NOT EXISTS context_spaces (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  owner_subject_id TEXT NOT NULL DEFAULT 'me',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_space_links (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  link_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_context_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 7.5 后端任务

- [ ] 新增 drive/wiki collector，先使用 `lark-cli drive +search --edited-since`。
- [x] 新增 task collector 或从 ContextUnit 中提取 `commitment` 作为任务替代。
      （已实现 `larkTaskCollector`：get-my-tasks ∪ get-related-tasks → kind='commitment' →
      attention 独立 tasks slice；集合差对账。详见 `docs/飞书任务Collector实现计划.md`。）
- [ ] 新增 `contextSpaceResolver.ts`，把相关 event/context 归入项目空间。
- [ ] 新增 `divergenceDetector.ts`，**MVP5 只覆盖两类不一致**（其余作为 MVP5.x 延伸）：
  - **承诺逾期但状态未更新**：context_units `kind=commitment, dueAt < now`，且关联 `kind=action_result` 缺失 / 文档未更新 timestamp 老于 dueAt。
  - **决策出现于消息但未沉淀到文档**：context_units `kind=decision`（MVP5 新增）从 IM/会议来，但相关 Space 的 doc collector 在 dueAt 前没看到对应变更。
  （"依赖方可能未被同步"等更软的判断放到 MVP5.x，因为它依赖更完整的关系图。）
- [ ] 新增 `syncDraftAgent`，生成飞书消息/文档评论草稿。
- [ ] 新增 `GET /api/context-spaces`、`GET /api/context-spaces/:id`。

### 7.6 前端任务

- [ ] 增加 Context Space 列表，展示项目/主题。
- [ ] Space 详情展示：
  - 当前目标；
  - 关键承诺；
  - 最近决策；
  - 风险/冲突；
  - 建议同步动作。
- [ ] 卡片支持“生成同步草稿”。
- [ ] 同步草稿必须有“复制/编辑/确认后发送”的边界，不直接发送。

### 7.7 验收标准

```text
场景：
1. 会议或消息中出现“本周三前完成 MVP2 方案”；
2. 文档仍停留在 MVP1；
3. 周三后没有新的完成信号。

系统应：
1. 在 AI is ON 项目空间中形成 commitment；
2. 到期后生成风险卡片；
3. 识别文档状态可能未同步；
4. 生成一段给相关人的同步/追问草稿；
5. 不自动发送。
```

---

## 8. MVP6：Boundary Learning + Limited Autonomy

### 8.1 目标

让用户反馈逐步沉淀成 Boundary，使 Agent 在低风险场景中可以自动处理。

MVP6 验证：

> 用户是否愿意把一类可逆、低影响、高确定性的事项交给 Agent 自动处理，并且系统能否清楚记录边界和审计。

### 8.2 Boundary 模型

`condition` 必须是**结构化字段**，不能塞自由文本：自由文本既无法可靠匹配，也没法审计。

```ts
type BoundaryCondition = {
  // 所有字段都是 AND；数组内是 OR；缺省字段表示不约束
  triggerType?: Array<
    | 'commitment_due'
    | 'meeting_prepare'
    | 'context_conflict'
    | 'goal_blocked'
    | 'low_noise_batch'
  >;
  source?: Array<'calendar' | 'im' | 'mail' | 'drive' | 'manual'>;
  priorityAtMost?: 'P0' | 'P1' | 'P2' | 'P3';     // e.g. P3 表示仅对 P3 生效
  scope?: Array<'personal' | 'work' | 'team'>;
  entityRef?: { type: string; nameLike?: string };  // 如 "对小李 / 项目 X" 这类
  kind?: Array<string>;                              // ContextUnit kind
  // 不可结构化的兜底（高级用户/迁移路径用）：
  rawDescription?: string;                           // 仅用于展示，evaluator 不读
};

type BoundaryRule = {
  id: string;
  scope: 'personal' | 'work' | 'team';
  condition: BoundaryCondition;
  allowedAction: 'record' | 'notify' | 'draft' | 'execute_reversible';
  requiresApproval: boolean;
  confidence: number;
  learnedFromCardId?: string;
  source: 'user_rule_migration' | 'card_action' | 'manual';   // 来源审计
  migrated?: boolean;                                          // 从 user_rules 迁移过来时为 true
  active: boolean;
  createdAt: string;
  updatedAt: string;
};
```

#### 8.2.1 user_rules → boundary_rules 迁移

MVP6 启动时跑一次性迁移：

1. 读 `user_rules WHERE active=1`。
2. 对每条记录，按 `rule_type` 映射：`dismiss_like` → `condition.kind=[...inferred], allowedAction='record', requiresApproval=false`。
3. 能从 `description / source_card_id` 解析到 source / priority / entity 的，填进结构化 condition；解析不出来的标 `migrated=true, condition.rawDescription=<原文>, active=false`，让用户在 boundary 视图复核激活。
4. 旧 `user_rules` 表不删除，作为审计层保留。
5. `cardsService.applyCardAction` 里的 dismiss 仍然先写 `user_rules`（兼容），同时 try-写 `boundary_rules`（结构化）；MVP7 再彻底切换。

### 8.3 MVP6 允许的自动动作

只允许可逆、低风险、影响范围为自己的动作：

- 自动标记低价值卡片为已读或合并进日报。
- 自动生成但不发送会议准备摘要。
- 自动创建本地 reminder。
- 自动把用户确认过的偏好写入 user_rules。
- 自动归档重复 context。

仍然必须确认的动作：

- 发消息、发邮件。
- 修改日程、取消会议。
- 修改共享文档。
- 对团队成员作出承诺。
- 任何涉及外部关系和不可逆后果的动作。

### 8.4 后端任务

- [ ] 将 `user_rules` 升级为 `boundary_rules`。
- [ ] 新增 `boundaryEvaluator.ts`，所有 action_proposal 执行前必须过 Boundary。
- [ ] 新增 `audit_logs`，记录 Agent 看到什么、决定什么、做了什么。
- [ ] 卡片动作增加“以后这类自动处理”。
- [ ] 同类事项自动处理后仍生成低优先级结果记录，方便回看。

### 8.5 验收标准

```text
用户对三张相似 P3 日程卡片都选择“忽略这类/以后合并到日报”。

系统应：
1. 生成 boundary_rule；
2. 下一次同类 P3 信号不再推即时卡片；
3. 该信号进入日报摘要；
4. audit_logs 能说明为什么没有打扰用户。
```

---

## 9. 统一工程分层

MVP2 后建议逐步把后端目录整理成：

```text
apps/server/src/
├── runtime/
│   ├── ClaudeRuntime.ts
│   ├── BackgroundClaudeRuntime.ts
│   └── protocol.ts
├── collectors/
│   ├── calendarCollector.ts
│   ├── imCollector.ts
│   ├── driveCollector.ts
│   └── collectorScheduler.ts
├── context/
│   ├── ContextUnit.ts
│   ├── contextStore.ts
│   ├── contextExtractor.ts
│   ├── activeContext.ts
│   ├── entityResolver.ts
│   └── relationResolver.ts
├── triggers/
│   ├── triggerEvaluator.ts
│   ├── triggerScheduler.ts
│   └── triggerStore.ts
├── agents/
│   ├── agentRegistry.ts
│   ├── AgentRunQueue.ts
│   ├── prepareMeetingAgent.ts
│   ├── commitmentAgent.ts
│   ├── caringAgent.ts
│   ├── lifeTaskAgent.ts
│   └── syncDraftAgent.ts
├── boundary/
│   ├── boundaryEvaluator.ts
│   ├── boundaryStore.ts
│   └── auditLog.ts
├── cards/
│   ├── cardStore.ts
│   └── cardProjector.ts
├── routes/
│   ├── chat.ts
│   ├── cards.ts
│   ├── context.ts
│   ├── triggers.ts
│   ├── agentRuns.ts
│   └── debug.ts
└── db.ts
```

关键边界：

- `collectors` 只负责拿 raw signal，不做复杂判断。
- `context` 负责语义化和关系化。
- `triggers` 只判断“是否该发生某类处理”。
- `agents` 负责处理，不直接操作 DB，尽量通过 store 接口。
- `boundary` 是所有 action 的闸门。
- `cards` 是呈现投影，不是业务事实源。

---

## 10. 统一 API 增量

MVP2-MVP6 建议补充（标注首次出现的 MVP 版本）：

```text
# MVP2.0
GET  /api/context/units
GET  /api/context/entities
GET  /api/context/relations
GET  /api/context/feedback
POST /api/context/feedback

# MVP2.2
GET  /api/context/active            ?budget=1500  # token 预算可调

# MVP3
GET  /api/triggers
POST /api/triggers/run-once
GET  /api/agent-runs
GET  /api/agent-runs/:id

# MVP5
GET  /api/context-spaces
GET  /api/context-spaces/:id

# MVP6
GET  /api/boundary/rules
POST /api/boundary/rules
PATCH /api/boundary/rules/:id
GET  /api/audit-logs

# MVP4
POST /api/caring/pause              { paused: true|false }   # §6.5 硬开关
```

---

## 11. 前端演进原则

MVP0/MVP1 的前端是：

```text
卡片流 + 对话流
```

MVP2 后要演进为：

```text
Today：现在需要看什么
Chat：我想主动说什么
Context：系统理解了什么
Spaces：项目/主题处在什么状态
Rules：以后哪些事可以自动
```

但默认第一屏仍然应该是 Today，而不是复杂 dashboard。

### 11.1 Today 视图

展示：

- 需要用户决策的卡片。
- Agent 已经处理好的结果。
- 今日承诺和临近会议。
- 低优先级摘要入口。

### 11.2 Context 调试视图

这是早期产品必须保留的“透明层”。

展示：

- 最近 ContextUnit。
- 系统识别的目标、承诺、关系、情绪意义。
- 置信度。
- 来源 raw event。
- 用户纠错入口。

### 11.3 Spaces 视图

用于工作协作：

- 每个项目/主题一个 Space。
- 展示目标、关键决策、承诺、风险、最近变化。
- 生成同步草稿。

---

## 12. 版本节奏建议

### MVP2：~2 周（拆三片，见 §4.2）

优先把 context store 建起来。不要急着增加更多数据源。

| 切片 | 大致工期 | 完成定义 |
|------|----------|----------|
| 2.0 落表 + 被动收集 | 3 天 | §4.7 MVP2.0 验收 + 5 张表 / events.context_extracted_at / Context tab |
| 2.1 LLM 提取 + 合并 | 4 天 | §4.7 MVP2.1 验收 + triagePrompt 升级 + entityResolver + mergeKey 命中验证 |
| 2.2 active_context 注入 | 2 天 | §4.7 MVP2.2 验收 + token 预算与裁剪 + ClaudeRuntime 改造 |
| 评测交付 | 1-2 天 | §4.9 fixture 集 + eval 脚本 + 数字写进合入 PR |

### MVP3：~2 周

优先做 2 个 trigger 跑通，不要一次性做很多 Agent。

完成顺序：

1. trigger 数据模型 + evaluator（push + pull 两路）。
2. `meeting_prepare`。
3. `commitment_due`。
4. agent_run 记录。
5. 卡片投影（`source_kind/source_ref_id` schema 升级 + 兼容旧 triage_id）和前端状态。
6. MVP3 评测：在 §4.9 fixture 上扩 5 条 trigger 触发场景。

### MVP4：1-2 周

优先做“用户自己手动喂生活/情绪 context”，不要急着接外部生活 API。

完成顺序：

1. 输入 scope 切换。
2. check-in。
3. emotion/self_narrative ContextUnit。
4. Caring Agent。
5. 生活事务 Agent。

### MVP5：~3-4 周（原 2-3 周低估了，drive collector + divergence + space resolver 都不便宜）

优先选一个真实项目做 Context Space，不做泛化企业系统。

完成顺序：

1. context_spaces。
2. drive/wiki collector。
3. commitment/decision 提取。
4. divergence detector。
5. sync draft。

### MVP6：1-2 周

优先让低风险规则生效。

完成顺序：

1. boundary_rules。
2. audit_logs。
3. “以后自动”卡片动作。
4. 自动合并低优先级事项到日报。
5. 回看和撤销规则。

---

## 13. 每个版本都必须验证的 5 个问题

1. **省心了吗？**
   用户看到结果时，是感觉减负，还是觉得又多了一件事？

2. **打扰了吗？**
   这张卡片如果没出现，会不会更好？

3. **理解对了吗？**
   系统提取的目标、承诺、关系、情绪意义是否有证据？

4. **边界清楚吗？**
   用户是否知道 Agent 能做什么、不能做什么、为什么没有自动做？

5. **回流了吗？**
   用户选择和 Agent 结果是否真的改变了后续 context？

---

## 14. 风险与取舍

### 14.1 最大产品风险

系统看起来“很智能”，但用户没有更省心。

应对：

- 每张卡片都记录用户反馈。
- P2/P3 默认摘要化。
- 打扰率比召回率更重要。

### 14.2 最大工程风险

Context 模型过早复杂化，导致 MVP 无法落地。

应对：

- MVP2 只用 SQLite。
- graph 先用关系表，不引入图数据库。
- prompt 提取失败也不阻塞主链路。

### 14.3 最大信任风险

Agent 主动性过强，让用户觉得越界。

应对：

- 所有对外写操作都必须确认。
- 每个 action_proposal 都经过 Boundary。
- 保留 audit log。

### 14.4 最大体验风险

情感场景被做成廉价安慰。

应对：

- 情感 Agent 先承接 context，不急着给建议。
- 明确区分“陪伴模式”和“解决问题模式”。
- 允许用户关闭分析和记忆。

---

## 15. 最小可执行路线

如果只能用最小成本推进，按下面顺序做（与 §4.2 切片对齐）：

```text
MVP2.0：5 张 context_* 表 + collector 直写最小 ContextUnit + Context 调试视图
MVP2.1：triagePrompt 输出 contextUpdates + entityResolver + mergeKey 合并
MVP2.2：active_context 评分 + token 预算 + ClaudeRuntime 注入 + "理解错了"
MVP3.1：commitment_due trigger（push + pull）+ track_commitment agent
MVP3.2：meeting_prepare trigger + prepare_meeting agent + cards 多来源 schema
MVP4.0：输入区 scope 切换 + 暂停情绪分析硬开关
MVP4.1：check-in + Caring Agent（仅在硬开关未暂停时）
MVP5.0：单项目 Context Space 数据模型 + drive collector
MVP5.1：divergence 仅两类（commitment 逾期未更新 / decision 未沉淀）
MVP6.0：BoundaryRule 结构化 + user_rules 一次性迁移
MVP6.1：低优先级事项自动合并到日报 + audit_logs
```

这条路线能保持一个连续飞轮：

```text
更多 context
→ 更准的触发
→ 更有用的 Agent 工作
→ 更多用户反馈
→ 更清楚的 Boundary
→ 更少打扰
→ 更强信任
```

最终要验证的不是“AI 能做多少事”，而是：

> Context 是否真的开始自己流动、自己触发处理、自己形成连续性，让用户只在需要判断和授权的时候出现。
