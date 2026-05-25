# AI is ON：MVP7-MVP10 Agent 处理 Context 与冷启动执行方案（v2，经 Claude × Codex 联评后重写）

> 本版相对 v1 的主要变化：取消 `context_deltas` / `work_profile` / `bootstrap_sessions` 三张新表；取消 MVP9 预定义 7 类 operator；统一开发顺序为 MVP7 → MVP8 → MVP10，operator 抽象明确放到 MVP 后的工程重构。AgentContextPacket 改为按 agent slice 构造，autonomy 梯度从 5 级压到 3 级。所有 LLM 输入引入显式 redaction 与 size cap，反馈纠错引入 correction_journal。

---

## 1. 当前 MVP6 代码基线（不变）

### 1.1 已经成立的系统骨架

核心链路已经在生产数据上跑通：

```text
collector / manual input
→ events
→ minimal ContextUnit
→ triage contextUpdates
→ contextStore.upsert
→ triggerEvaluator
→ AgentRunQueue
→ agent handler
→ action_proposal
→ card
→ user feedback / boundary / audit
```

主要落地模块：

- `apps/server/src/context/*`：ContextUnit、mergeKey、activeContext、entityResolver、contextStore。
- `apps/server/src/triggers/*`：push + pull 触发，已有 commitment_due、meeting_prepare、check_in_due、daily_digest、context_divergence。
- `apps/server/src/agents/*`：track_commitment、prepare_meeting、caring、sync_draft、daily_digest。
- `apps/server/src/spaces/*`：Context Space、Space 关联、divergence detector。
- `apps/server/src/boundary/*`：BoundaryRule、Evaluator、migration、audit log。
- `apps/web/src/components/*`：Cards、ContextPanel、SpacesPanel、RulesPanel、Composer。

本地实际数据：

```text
events: 276
context_units: 302
context_entities: 152
triggers: 12
agent_runs: 34
cards: 63
context_spaces: 2
boundary_rules: 2
audit_logs: 4
```

### 1.2 当前真正的缺口

MVP6 已经解决了 "Context 能流动、Agent 能被触发、Boundary 能开始学习"。下一阶段的瓶颈不是 Agent 数量，而是 Agent 做判断时拿不到稳定的判断坐标系：

```text
我服务谁？用户当前负责什么？目标是什么？
哪些项目 / 人 / 文档是权威来源？
这条 context 变了什么？影响谁？是否缺信息？
Agent 能自动做到哪一步，哪里必须等用户确认？
```

这些信息目前散落在 triage prompt / activeContext scorer / ContextUnit kind / Space seed / BoundaryRule / 卡片反馈里，**没有形成一份 Agent 调用前可消费的统一坐标系**。

---

## 2. 思路与原点

后续版本不是 "多写几个 Agent"，而是：

> **Agent 正确处理 context = 在正确主体、正确目标、正确关系、正确边界、正确时间和正确置信度下，对 context 变化做可解释、可校正、可回流的处理。**

主链路升级为：

```text
ContextUnit created / updated
→ changeContext（轻量 diff，挂在 trigger payload 上）
→ AgentContextAssembler（按 agent slice 构造）
→ Agent handler（用 packet 而非裸 unit）
→ Action Proposal + handlingPolicy 推荐
→ BoundaryEvaluator 终审 + audit
→ Feedback Correction（含 correction_journal）
→ 回流到 ContextUnit / Space / BoundaryRule / Entity
```

四个关键转变：

1. **从 ContextUnit 到 changeContext**：Agent 同时关心 "有什么" 和 "什么变了"。changeContext 是 upsert 时计算的轻量 diff，不是新一张全量历史表。
2. **从 activeContext 到 sliced AgentContextPacket**：聊天注入用 activeContext；每次 Agent Run 拿一份按 agent 声明 slice 构造的 packet，复用 activeContext 的 scorer 与 cap，避免重写排序逻辑。
3. **从用户手工使用到结构化冷启动**：MVP7 通过最小 Work Map 给 Agent 装上世界模型；该 Work Map 全量写入既有 ContextUnit / Space / BoundaryRule。
4. **从 feedback 记录到 feedback 校正**：用户的 "理解错了" 不只是日志，而能直接修 entity / 修 priority / 修 actionability / 修 boundary，并带可撤销的 correction_journal。

非目标（明确不做）：

- 不做企业级组织架构同步。
- 不强制长问卷。
- 不主动给外部人发消息。
- 不在 MVP 阶段为延后再说的需求新建数据库表。

---

## 3. Lean Roadmap 决策

旧版有两个互相矛盾的顺序（§8 vs §9），且 MVP9 提前定义了 7 类 operator。新版统一为：

```text
MVP7  Work Map（7.0 手动 + 7.1 LLM 草稿）
MVP8  Sliced AgentContextPacket + 轻量 changeContext
MVP10 Feedback Correction + 3 级 Autonomy
Post-MVP（不再叫 MVP9）  Operator Consolidation —— 仅当 ≥2 个 agent 共享同一段逻辑时再抽
```

理由：

- 没有 Work Map，Agent 没有 "我是谁、负责什么、什么重要" 的判断坐标系。
- 没有 packet，Agent Run 还是只能基于局部 unit + prompt 猜。
- 没有 feedback correction，错误会沉淀成噪声而不是修正信号。
- Operator 是工程抽象，需要先有真实重复逻辑才能正确抽；旧版定义 7 个属于过早抽象。

下文每个 MVP 严格遵循这个顺序。

---

## 4. MVP7：Work Context Cold Start

### 4.1 目标

建立 Agent 处理工作 context 的初始坐标系。

MVP7 验证：

> 只通过一个 5–10 分钟的冷启动（手动或 LLM 草稿） + 用户确认，系统能否生成一份**全量存在于现有 ContextUnit / Space / BoundaryRule 中**、可重跑、可校正的 Work Map。

注意：MVP7 的验收不包含 "Agent 行为因此变好" —— 那属于 MVP8 的验收范畴。MVP7 只验证 "世界模型被结构化地记录下来了"。

### 4.2 产品范围

做：

- 增加工作冷启动入口。
- 建立 Work Profile：角色、团队、职责、协作对象、工作偏好。
- 建立 Work Map：当前项目 / 主题、目标、关键相关人、权威文档、近期 deadline、当前担心的风险。
- 支持 7.0 手动录入与 7.1 基于近期 context 的 LLM 草稿。
- 确认后**只写入 ContextUnit / ContextSpace / ContextSpaceLink / BoundaryRule**，并用 `settings.bootstrap_completed_at` 标记完成。
- 支持重跑：再次确认不会产生重复行。

不做：

- 不新建 `work_profile` 或 `bootstrap_sessions` 表。
- 不在后端持久化未确认的草稿（草稿活在前端，刷新会丢，是接受的代价）。
- 不向外部发任何东西。

### 4.3 数据建模（零新表）

| Work Map 字段 | 写入方式 |
|---|---|
| 用户角色 / 职责 | `kind=state`, `scope=work`, entity=user/team |
| 项目目标 | `kind=goal`, 关联 Context Space |
| 关键承诺 / deadline | `kind=commitment` |
| 协作关系 | `kind=relationship` 或 entity link |
| 权威文档 / 信息源 | Space seed entity / doc 链接，或 `kind=state` |
| 工作偏好 | `kind=preference` |
| 不希望打扰的事 | `boundary_rules` |
| 完成标记 | `settings.bootstrap_completed_at` |

**幂等性**：Work Map writer 必须使用稳定 `mergeHint`（如 `work_map:goal:<slug>` / `work_map:role:self`）→ 稳定 `mergeKey`，确保重跑 bootstrap 不会重复创建 goal/preference。Space 与 BoundaryRule 同理：Space 用 (name, scope) 做幂等键；BoundaryRule 用 `condition` 字段 hash 做幂等键，重跑只更新 `updatedAt`。

### 4.4 后端任务

新增模块（路径稳定，无新表）：

```text
apps/server/src/bootstrap/
  workMapTypes.ts       // WorkProfileDraft / ProjectMapDraft / StakeholderDraft / BoundarySeedDraft
  workMapDraftPrompt.ts // 7.1 LLM prompt（含 redaction 规则）
  workMapService.ts     // 调用 LLM、组装 draft、对外暴露
  workMapWriter.ts      // 唯一写入入口，负责幂等
apps/server/src/routes/bootstrap.ts
```

接口：

1. `POST /api/bootstrap/work-map/draft`
   - 输入：可选 `seedText`（用户 5–8 行自然语言）+ `lookbackDays`（默认 14） + `mode = full | incremental`。
   - 处理（见 §4.5 输入裁剪）后调用一次性 LLM，返回 draft。
   - **不写库**。

2. `GET /api/bootstrap/work-map/current`
   - 返回当前已确认 Work Map：work-scope 的角色 / 目标 / 承诺 / 关键人 / 偏好 / 当前 BoundaryRule 摘要。

3. `POST /api/bootstrap/work-map/confirm`
   - 输入：用户确认后的 draft。
   - `workMapWriter` 用 §4.3 的幂等键写入 ContextUnit / Space / SpaceLink / BoundaryRule，更新 `settings.bootstrap_completed_at`。

`activeContext.ts` 改造：work-scope 的 `kind in {state, goal, preference, relationship}` 默认按更高权重选入 summary（即 Work Map 高优先），但不另起一套打分逻辑，只是给现有 scorer 增加 `workMapBoost` 字段。

### 4.5 7.1 LLM 草稿的输入与 redaction

旧版未约束输入规模，302+ units 全文塞 prompt 会爆 token。新版规则：

- 候选池：复用 `activeContext.buildActiveContext` 的 scorer，先打分排序。
- 范围：仅 `scope='work'`；如果 `mode=incremental`，只取 `updatedAt > settings.bootstrap_completed_at` 的 unit + 当前已确认 Work Map 摘要。
- per-kind cap：goal / commitment / risk / decision 各 ≤10；event ≤20；其他 kind 合计 ≤30。
- 字段裁剪：**只送 `title + meaning + entities + time`**，不送 `content`。若 `meaning` 为空或 `confidence<0.5`，允许在 LLM 输入中附一条 ≤120 字的脱敏摘要（去除邮箱 / 手机 / URL / 长 doc 片段，由 `workMapDraftPrompt` 中的 sanitize 函数生成）。
- 总 token 预算：默认 8k，硬上限 10k。

### 4.6 前端任务

新增 `WorkMapPanel`，放在左侧面板，优先级高于调试面板：

```text
Work Map
├── 我的角色 / 职责
├── 当前项目
├── 关键相关人
├── 近期承诺
├── 我担心的风险
└── 不希望被打扰的事（→ BoundaryRule）
```

交互：

- "生成草稿"：调用 7.1 LLM 草稿接口。
- "我来补充"：用户输入 5-8 行自然语言。
- "确认写入"：调用 confirm 接口。
- "不对，修改"：用户直接改字段；草稿状态保存在浏览器（localStorage 或 sessionStorage），刷新丢失可接受。
- "重新生成"：仅在用户显式点击时全量重建，否则默认 incremental。

### 4.7 验收标准

输入：

```text
我现在主要负责 AI is ON，本周目标是把 MVP6 之后的路线想清楚。
我常协作的人是 A/B/C，重要文档在飞书里。
我不希望普通群消息打断我，P2/P3 合并成日报即可。
```

系统应：

1. LLM 草稿在 8k token 预算内完成、产物 JSON 合法。
2. 用户确认后，库中至少出现：1 条 work-scope state（角色）、1 个 Context Space、≥2 条 goal/commitment、≥1 条 preference、≥1 条 BoundaryRule。
3. 再次点 "确认写入"（不改字段）不产生新行，只更新 `updatedAt`。
4. `settings.bootstrap_completed_at` 被设置。
5. `activeContext` summary 中能看到 Work Map 高权重内容。

> 行为是否变好（"Agent 因此更聪明"）放到 MVP8 验收，不放在这里。

---

## 5. MVP8：Sliced AgentContextPacket + 轻量 changeContext

### 5.1 目标

让每次 Agent Run 都拿到一份 **按 agent 声明 slice 构造的** 上下文包，并能感知到 "什么变了"。

MVP8 验证：

> 在同样的 trigger 下，引入 sliced packet 后，三个旧 agent 的输出对 §1.2 的判断盲点（项目重要性 / 权威文档 / 完成去重）有可被 fixture 量化的改善。

### 5.2 changeContext：不建新表，挂在 trigger payload

`contextStore.upsertContextUnit` 已经在做版本号 +1，但**目前不计算字段级 diff**（`supersedes_json` 实际写 null）。新版做法：

```ts
type ChangeContext = {
  isUpdate: boolean;
  changedFields: string[];          // ['actionability', 'time.dueAt']
  before?: ContextUnitSnapshot;     // 白名单字段
};

type ContextUnitSnapshot = Pick<
  ContextUnit,
  'kind' | 'title' | 'meaning' | 'actionability' | 'time' |
  'confidence' | 'entities' | 'status' | 'version'
>;
```

- `upsertContextUnit` 在 UPDATE 路径上构造 `ChangeContext`，INSERT 时 `isUpdate=false / changedFields=['*created*']`。
- `registerUpsertHook` 签名升级为 `(unit, changeContext?) => void`，新参数可选；triggerEvaluator 接收后写入 `TriggerDraft.payload.changeContext`，最终落到 `triggers.payload_json`。
- **不**新建 `context_deltas` 表。需要跨 run 审计 / 回放 / 统计时再单独提案。
- `before` 字段严格白名单，不包含 `content`。`triggers.payload_json` 整体加 size cap（默认 4 KB，超出截断 `before.title/meaning`），避免与 §4.5 "drop raw content" 原则冲突。

### 5.3 AgentContextPacket：按 slice 构造

#### 5.3.1 数据结构

```ts
type AgentContextPacket = {
  packetAssemblerVersion: number;   // 排序 / 裁剪逻辑变化时 ++
  packetSliceVersion: number;       // slice 定义变化时 ++
  materializedSlices: Array<{ name: PacketSlice; itemCount: number }>;

  subject?: {                       // slice=subject
    id: 'me';
    roleTitle?: string;
    teamName?: string;
    responsibilities: string[];
    preferences: string[];
  };
  trigger: {
    id: string;
    type: string;
    reasoning: string;
    changeContext?: ChangeContext;
  };
  focalUnit?: ContextUnit;          // slice=focalUnit（默认）
  spaces?: Array<{...}>;            // slice=spaces
  goals?: ContextUnit[];            // slice=goals
  uncertainties?: ContextUnit[];    // slice=uncertainties
  relatedContext?: ContextUnit[];   // slice=relatedContext
  stakeholders?: Array<{...}>;      // slice=stakeholders
  latestActionResult?: ContextUnit; // slice=latestActionResult
  boundary?: {                      // slice=boundary
    allowed: BoundaryAction[];
    requiresApproval: BoundaryAction[];
    matchedRules: string[];
  };
  missingInfo?: string[];           // slice=missingInfo
  recommendedHandling?:             // 由 handlingPolicy 填充
    | 'record' | 'notify' | 'ask' | 'draft' | 'act';
};

type PacketSlice =
  | 'subject' | 'focalUnit' | 'spaces' | 'goals' | 'uncertainties'
  | 'relatedContext' | 'stakeholders' | 'latestActionResult'
  | 'boundary' | 'missingInfo';
```

#### 5.3.2 Agent 声明 slice

每个 agent 在 registry 注册：

```ts
registerAgent('track_commitment', {
  handler: trackCommitmentHandler,
  packetSliceVersion: 1,
  slices: ['focalUnit', 'latestActionResult', 'boundary', 'subject'],
});

registerAgent('prepare_meeting', {
  handler: prepareMeetingHandler,
  packetSliceVersion: 1,
  slices: ['focalUnit', 'spaces', 'goals', 'uncertainties',
           'relatedContext', 'stakeholders', 'boundary', 'subject'],
});
```

Assembler 只构造声明过的 slice，避免给纯本地 agent（如 commitment）拼一个 1500-token 大包。

#### 5.3.3 复用 activeContext，不重写排序

`agentContextAssembler.ts` 必须复用 `activeContext` 的 scorer / per-kind cap / token budget，只在其上叠加：

- subject / boundary 是 LLM 输入之外的元信息，固定塞入。
- spaces 来自 `contextSpaceService.listSpaces` + `listSpaceLinks`。
- relatedContext 仍走 `collectRelatedContext` 的 person-overlap 思路，但 cap 由 packet level 控制。

#### 5.3.4 落库摘要

`AgentRunQueue.createAgentRun` 把 packet 摘要写入 `agent_runs.input_json`：

```json
{
  "trigger": {...},
  "packetAssemblerVersion": 1,
  "packetSliceVersion": 1,
  "materializedSlices": [
    { "name": "focalUnit", "itemCount": 1 },
    { "name": "latestActionResult", "itemCount": 1 },
    { "name": "boundary", "itemCount": 0 }
  ],
  "focalUnitId": "...",
  "changeContext": { "isUpdate": true, "changedFields": ["time.dueAt"] }
}
```

完整 packet 内容不持久化，size 不可控也无必要。

### 5.4 handlingPolicy vs boundaryEvaluator

冲突点已厘清：

- `handlingPolicy`：**agent 侧推荐**。输入 packet，输出 `recommendedHandling ∈ {record, notify, ask, draft, act}` + 一句话理由。属于 packet 一部分。
- `boundaryEvaluator`：**系统终审**。在 `createCardFromProposal` / agent 真正写副作用前评估，决定 allow / soften / block，并写 audit。

任何动作必须先有 handlingPolicy 推荐，再过 boundaryEvaluator。两者解耦后，未来加 autonomy 梯度（§6.4）只动 boundary，不动 agent。

### 5.5 三个旧 Agent 的具体改造（MVP8 验收来源）

旧版列出的三个失败模式由 MVP8 修复：

1. `triggerEvaluator.checkMeetingPrepare` 当前只看关键字 + 时间窗 → 新增对 work-scope Space 的 P0/P1 标签敏感：当 meeting 关联到一个 active goal 的 Space，触发优先级上调（写在 payload，trigger 自身仍然写，但 agent 收到时能区分）。
2. `prepareMeetingAgent.collectRelatedContext` 当前只看 person overlap → 改为读 packet 的 `spaces` / `goals` / `stakeholders` slice，把 Work Map 中的权威文档作为 prompt 上下文。
3. `commitmentAgent.trackCommitmentHandler` 当前每条 due commitment 都发提醒 → 通过 packet 的 `latestActionResult` slice 判定是否已完成，已完成则跳过；通过 `subject.responsibilities` 与 `spaces` 给出 priority。

### 5.6 验收标准

场景：某 commitment 明天到期，Work Map 标记该项目本周 P0，相关 Space 有未解 risk。

系统应：

1. `triggers.payload_json` 中带有 `changeContext`（若是 update）。
2. `agent_runs.input_json` 中带有 `packetSliceVersion` 和 `materializedSlices` 摘要。
3. `track_commitment` 输出比裸提醒更具体：说明关联 goal、风险、建议下一步。
4. 若该 commitment 已存在 `kind=action_result` 链接，不重复提醒。
5. `prepare_meeting` 在带 work Space 时，输出包含 Work Map 中的权威文档与 stakeholder。

---

## 6. MVP10：Feedback Correction + 3 级 Autonomy

### 6.1 目标

把用户反馈从 "记录" 升级为 "校正世界模型和边界"，并第一次明确 Agent 自治的层级。

MVP10 验证：

> 用户在源卡片上 inline 纠错后，系统下次同类输入更准、更少打扰，并且每条纠错都可审计、可回滚。

### 6.2 Inline correction：直接长在源卡片上

旧版生成额外的 "correction proposal card" → 增加一次点击循环。新版：

- 源卡片右侧 "理解错了" 弹出 inline widget（**不再单独发一张卡**），按 §6.3 的 tier 决定是否需要二次确认。
- `feedbackInterpreter.ts` 把 user click 解释成结构化 correction。
- `correctionWriter.ts` 写入对应表 + `correction_journal`。

### 6.3 Tier 化与 UX

| Correction type | Tier | UX 与写入 |
|---|---|---|
| wrong_priority（仅当前卡 / 当前 unit） | low | inline 一键，更新 unit + audit |
| wrong_priority（要写未来生效的 BoundaryRule） | medium | 展示 "将生成的 rule scope/condition" 摘要，确认后写 BoundaryRule + audit + journal |
| wrong_actionability | high | 影响 trigger 行为，需 explicit confirm；更新 unit + audit + journal |
| wrong_meaning（纯文本） | low | inline 编辑文本，更新 unit + audit |
| wrong_meaning 涉及 deadline / kind | high | explicit confirm；更新 unit（可能影响 trigger）+ audit + journal |
| wrong_entity（alias merge） | high | inline 提议 alias merge；预览 "将影响 X 条 context，**有新数据写入后不可无损撤销**"；确认后写 entity alias + audit + journal |
| wrong_kind | high | 预览 trigger 影响；explicit confirm；更新 unit + audit + journal |

low = 直接写 + audit；medium/high = inline 但有二次确认 + correction_journal。

### 6.4 3 级 Autonomy 梯度（取代旧版 5 级）

旧版 5 级自治梯度过细。当前 action surface 只有 cards / audits / 本地状态，没有任何对外发送。新版 3 级，每条 BoundaryRule 落一个枚举：

| 级别 | 含义 | 例子 |
|---|---|---|
| `local_auto` | 纯本地、可逆、低风险，自动执行 | 合并 P3 卡片到 daily_digest |
| `local_with_audit` | 本地状态写入或规则学习，必须 audit + journal | 学习 BoundaryRule、写 ContextUnit、entity merge |
| `external_always_confirm` | 对外、共享、不可控副作用，永远确认 | 发消息、改日历、改共享文档（MVP 内**未启用任何此类动作**，但保留位置） |

BoundaryRule 新增字段：

```ts
type BoundaryRule = {
  // ...existing fields
  autonomy: 'local_auto' | 'local_with_audit' | 'external_always_confirm';
  actionType?: string;        // 可选注释
  reversible: boolean;
  impactScope: 'self' | 'shared';
};
```

### 6.5 correction_journal：覆盖所有 correction，不只是 entity

```sql
CREATE TABLE IF NOT EXISTS correction_journal (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  correction_type TEXT NOT NULL,       -- wrong_priority | wrong_entity | ...
  target_kind TEXT NOT NULL,           -- context_unit | boundary_rule | entity_alias
  target_id TEXT NOT NULL,
  forward_patch_json TEXT NOT NULL,
  inverse_patch_json TEXT,             -- null 表示不可无损撤销
  inverse_lossy INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL,
  reverted_at TEXT
);
```

- `forward_patch_json` / `inverse_patch_json`：对 ContextUnit/BoundaryRule 是字段级 JSON patch；对 entity alias 是 (old_id → new_id) 与 unit/space link 的迁移表。
- **entity merge 一旦发生 downstream write**（新 ContextUnit / SpaceLink / mergeKey 基于合并后的 entity 写入），journal 标记 `inverse_lossy=1`，UI 上展示 "撤销将丢失部分关联信息"。
- 撤销路径仅在 RulesPanel 的 audit 视图中暴露，不在源卡片暴露。

### 6.6 验收标准

1. 用户对一张卡点 "项目认错了"，inline 看到 alias merge 预览与影响面，确认后 alias 生效，未来 Space 关联使用合并 id。
2. 用户对三张同类卡点 "以后自动"，生成的 BoundaryRule 包含 `triggerType + kind + autonomy=local_auto`。
3. 任一 correction 都能从 correction_journal 找到 forward/inverse patch；其中 entity merge 的 lossy 标记符合 §6.5 规则。
4. RulesPanel 的 audit 用人话解释 "为什么自动合并 / 为什么没有自动发送"。

---

## 7. Post-MVP：Operator Consolidation（**不再叫 MVP9**）

旧版预定义 7 类 operator（compress / complete / judge / route / track / align / writeback），且自带 fixtures，与 §5.3 自己 "避免过早抽象" 的告诫冲突。新版处理：

- 不预定义 operator 列表。
- 不进入用户价值叙事，不承诺 fixtures，不出现在路线图主线。
- 在 MVP10 落地后，做一轮代码扫描：**当同一段 context-handling 逻辑被 ≥2 个 agent 共享时，才提取为 `apps/server/src/operators/<name>.ts`**。
- 极可能首先被抽出来的 3 个候选：`compressRelatedContext`（meeting + digest 共享）、`scoreUnitForActiveContext`（activeContext + packetAssembler 共享）、`writebackActionResult`（多 agent 共享）。

不写 "MVP9 章节"，避免下游误以为这是承诺。

---

## 8. 评测体系

### 8.1 Fixture 目录

```text
apps/server/test/fixtures/mvp7/
  work_map_raw_context.json
  expected_work_map.json
apps/server/test/fixtures/mvp8/
  context_change_cases.json
  expected_packets.json           // 按 sliceVersion 区分
  expected_agent_outputs.json
apps/server/test/fixtures/mvp10/
  feedback_cases.json
  expected_corrections.json
```

无 mvp9 fixture（见 §7）。

### 8.2 Eval runner（每个 MVP 必须配套）

每个 fixture 目录配套 `apps/server/test/eval/mvpX.eval.ts`：

- 结构化字段：JSON-diff / 包含匹配，输出 pass / fail。
- 语义字段（如草稿 headline）：可选 LLM judge，**judge prompt 与阈值固定在版本里**（写在文件头注释，改动需 bump `evalVersion`）。
- 运行：`npm run eval:mvp7` / `eval:mvp8` / `eval:mvp10`。输出每条用例的 verdict + 命中率聚合。
- 缺这套 runner，fixture 视为未交付。

### 8.3 指标

| 指标 | 定义 | 目标 |
|---|---|---|
| Work Map idempotency | 重跑 confirm 不产生重复 unit/space/rule | 100% |
| Work Map structural coverage | 草稿覆盖用户确认字段比例 | MVP7 ≥70% |
| Packet slice 完整率 | 实际 materialized slices 与声明一致 | MVP8 = 100% |
| Agent 行为提升（§5.5 三模式） | 用 fixture 对比新旧输出 | 有可量化改善 |
| Correction 生效率 | 用户纠错后同类错误下降 | MVP10 有明显案例 |
| Correction 可撤销率 | journal 中 inverse_lossy=0 比例 | ≥80% |
| 打扰率 | dismissed / total cards | 持续下降 |
| 回流率 | agent result / user choice 写回 context 的比例 | ≥80% |

---

## 9. 单一开发顺序（唯一权威，覆盖原 §8 / §9）

```text
MVP7.0 手动 Work Map
  - workMapTypes / workMapWriter / routes
  - WorkMapPanel 手动编辑
  - activeContext workMapBoost
  - 验收：§4.7 1–4 + idempotency

MVP7.1 LLM 草稿
  - workMapDraftPrompt + sanitize + activeContext-scored 输入裁剪
  - 前端 "生成草稿" 按钮
  - 验收：§4.7 1 + token 预算 ≤8k

MVP8.0 changeContext-in-trigger
  - upsertContextUnit 计算 changedFields + before snapshot（字段白名单）
  - pushHook 签名升级
  - triggers.payload_json 写入 changeContext + size cap
  - 验收：§5.6 1

MVP8.1 sliced AgentContextPacket
  - PacketSlice 定义 + agent registry 声明 slices
  - agentContextAssembler 复用 activeContext scorer
  - AgentRunQueue 落库 sliceVersion + materializedSlices 摘要
  - 改造 track_commitment / prepare_meeting / sync_draft（按 §5.5）
  - 验收：§5.6 2–5

MVP10.0 Inline correction + journal
  - feedbackInterpreter / correctionWriter / correction_journal 表
  - 源卡片 inline widget（low/medium/high tier）
  - 验收：§6.6 1, 3

MVP10.1 Autonomy 梯度 + Boundary 升级
  - BoundaryRule 新增 autonomy / reversible / impactScope 字段（migration）
  - RulesPanel 展示 "自动 / 必问 / 不可逆" 视图
  - 验收：§6.6 2, 4

Post-MVP Operator Consolidation
  - 见 §7。无 MVP 标签，无 fixture 承诺。
```

---

## 10. 最终系统形态

MVP10 之后，工作场景的主循环：

```text
用户通过 7.0/7.1 给出最小可校正 Work Map
→ 系统持续采集工作 context
→ 每次变化通过 changeContext 进入 trigger payload
→ AgentContextAssembler 按 agent slice 构造 packet（复用 activeContext scorer）
→ Agent + handlingPolicy 给出推荐
→ BoundaryEvaluator 按 autonomy 梯度 allow / soften / block
→ local_auto 直接执行；local_with_audit 写 journal；external_always_confirm 永远问
→ 用户 inline 纠错 → feedbackInterpreter → correctionWriter → correction_journal
→ 后续处理越来越少打扰、越来越贴合用户、错误可回滚（entity merge 在 downstream write 后承认不可无损撤销）
```

本质不是让 Agent "更聪明"，而是：

> 先给 Agent 一个**可校正、可审计、可回滚**的世界模型，再让它在这个世界里行动。

---

## 附录 A：v2 相对 v1 的取舍清单

| 旧版 | 新版 | 取舍理由 |
|---|---|---|
| 新增 `context_deltas` 表 + 全量历史 | 取消；在 upsert 时算 `changedFields`，挂 trigger payload | 当前规模（302 units）不需要新表 + migration |
| 新增 `work_profile` 单行表 | 取消；用 ContextUnit `kind=state, scope=work` | 单行表对单用户系统不产生信息增量 |
| 新增 `bootstrap_sessions` 表 | 取消；草稿放前端，确认后才写库 | 未确认草稿无须跨进程持久化 |
| MVP9 = 7 类 operator + fixtures | 取消 MVP9；改为 Post-MVP 工程重构 | 与 "避免过早抽象" 自相矛盾 |
| AgentContextPacket 全字段每次构造 | 按 agent 声明 slice 构造 + 复用 activeContext scorer | 防 packet 膨胀 + 不重写排序逻辑 |
| handlingPolicy 与 boundaryEvaluator 重叠 | 明确分工：policy=agent 推荐，boundary=系统终审 | 避免双 source of truth |
| 5 级 autonomy 梯度 | 3 级 local_auto / local_with_audit / external_always_confirm | 与当前 action surface 匹配 |
| 单独 correction proposal card | 源卡片 inline widget + tier 化 | 减少点击循环 |
| §8 / §9 双开发顺序 | 单一开发顺序（§9） | 消除歧义 |
| Work Map LLM 输入无 cap | per-kind cap + 8k token budget + 字段裁剪 + sanitize | 避免 token 爆 + PII 泄漏 |
| 仅 entity-merge 有回滚 | correction_journal 覆盖 unit / boundary / entity，lossy 标记 | 全 correction 类型可审计 |
