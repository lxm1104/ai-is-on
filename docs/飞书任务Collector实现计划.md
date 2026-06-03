# 飞书任务 Collector 实现计划

> 目标：把用户在飞书 App 里自己创建/被指派的任务采集进 context，落成 `kind='commitment'` 的
> ContextUnit，从而被 attention 引擎扫描。补上 MVP5 里挂着的 task collector TODO
> （`docs/MVP2-MVP6-Context连续性系统开发执行方案.md:902`）。

## 0. 背景与现状

- 现役 6 个 collector（`apps/server/src/collectors/scheduler.ts:53`）：calendar / im / drive /
  driveComment / meetingArtifact / larkOrg。**没有 task collector**。
- 飞书任务现在是**单向下行**：`createLarkTaskFromCard()`
  （`apps/server/src/lark/larkTaskService.ts:65`）能把卡片写成飞书任务并顺带记一条
  `kind='commitment'`（`mergeHint: lark_task:<guid>`），但**读不回**用户自己在飞书里建的任务。
- attention 引擎从 `assembleGlobalContextPacket()` 的 `commitments` 桶取数
  （`apps/server/src/context/agentContextAssembler.ts:831`），所以只要任务落成 active commitment
  并触发一次非缓存 tick，就会被扫到。

> **决策已定（用户拍板）**：
> 1. **R1 = 方案 B：独立 `tasks` slice**，不挤 commitments 桶。
> 2. **采集范围 = get-my-tasks ∪ get-related-tasks --created-by-me**（指派给我 + 我创建/关注）。
> 下文相关章节已据此更新。

## 1. 数据源：lark-cli

用两个命令并集（都是 Risk: read，只读自己的任务）：
- `lark-cli task +get-my-tasks`：指派给我的任务。
- `lark-cli task +get-related-tasks --created-by-me`：我创建/关注的任务（含没指派给自己的自建任务）。

两路按 `guid` 去重合并。`get-related-tasks` 的 `--include-complete`（默认 true）要设 false 只取未完成，
与 get-my-tasks 的 `--complete=false` 对齐。实测 get-my-tasks 输出：

```json
{
  "ok": true,
  "data": {
    "has_more": false,
    "items": [
      { "created_at": "2026-06-03T07:07:33+08:00",
        "guid": "163f1149-...",
        "summary": "ai is on ... 点一下自动处理",
        "url": "https://applink.larkoffice.com/client/todo/detail?guid=163f1149-..." },
      { "created_at": "...", "due_at": "2026-06-03T08:00:00+08:00", "guid": "...", "summary": "...", "url": "..." }
    ]
  }
}
```

字段：`guid`(稳定主键) / `summary` / `url` / `created_at` / 可选 `due_at`。

关键参数：
- `--complete`：省略=查全部；`--complete=false`=只查未完成；`--complete=true`=只查已完成。
- `--page-all`（最多 40 页）/ `--page-limit`。
- `--as user`（必须，用户身份）。
- `--due-start/--due-end/--created_at`：时间过滤。

## 2. 骨架选型：套 larkOrgCollector 模式（不走 RawSignal）

标准 `Collector.collect()` 返回 `RawSignal[]`，但 scheduler 的 tick 会对每条 signal 强制
`insertMinimalEventContextUnit`（`kind='event'`，`scheduler.ts:140`）——**不适合任务**（任务要落
commitment 不是 event）。

先例：`larkOrgCollector`（`collectors/larkOrgCollector.ts:6` 注释）——它在 `collect()` 里直接写库
（side-effect），然后**返回空 `RawSignal[]`**，告诉 scheduler「没有新事件」。

→ **task collector 照搬此模式**：在 `collect()` 内部自己调 `upsertContextUnit(kind='commitment')`，
返回 `[]`。这样不污染 events 表、不进 triage LLM、不被强制落成 event。

## 3. 落库映射（与 card 创建路径对齐，复用 mergeHint 去重）

**任务仍落成 `kind='commitment'` ContextUnit**（不引入新 kind）——这样才能复用 mergeHint 与 card
路径合并去重。「独立 tasks slice」是在 **packet 装配层**把 task-origin 的 commitment 单独拎出来
（见 §5.5），底层存储不变。

card 路径已用 `mergeHint: lark_task:<guid>`、entity `{type:'task', name:'lark_task:<guid>'}`
（`larkTaskService.ts:115-137`）。collector **用完全相同的 mergeHint 和 entity**，于是：

- `upsertContextUnit` 按 mergeKey 命中既有 unit → **UPDATE 而非新建**
  （`contextStore.ts:178,183`）。
- 因此「AI is ON 自己创建的任务」与「collector 采回的同一任务」**自动合并成一条**，不会重复。

每条未完成任务 → `upsertContextUnit`：

```ts
upsertContextUnit({
  kind: 'commitment',
  title: summary,
  content: `飞书任务：${summary}${url ? `\n链接：${url}` : ''}`,
  entities: [{ type: 'task', name: `lark_task:${guid}`, aliases: url ? [url] : undefined, role: 'target', confidence: 1.0 }],
  scope: 'work',
  origin: { kind: 'system', refId: `lark_task:${guid}` },   // 已验证：ContextOriginKind 无 'collector'，合法值仅 event|chat|card_action|agent_run|manual|system
  time: due_at ? { dueAt: normalizeIso(due_at) } : undefined,
  actionability: 'act',
  confidence: 0.9,
  mergeHint: `lark_task:${guid}`,
});
```

`upsertContextUnit` 末尾 `invokeHook()`（`contextStore.ts:266`）会触发 attention 的 upsert hook
→ debounce 60s 后跑 tick。无需手动调度。

## 4. 生命周期：完成与消失的回收

只「进」不「出」会让已完成任务永远挂在 commitments 里。

**已验证的关键事实**：`+get-my-tasks` 的未完成项与已完成项**结构完全相同**（都只有
`guid/summary/url/created_at[/due_at]`），**没有任何 `completed`/`completed_at` 字段**——只能靠
「是 `--complete=false` 还是 `--complete=true` 查出来的」来区分。所以「拉完成项逐条标 done」这条路
不可靠（拿不到完成时间、还得全量比对）。

→ **改用集合差（set-difference）做主对账**：

1. 每轮 `--complete=false --page-all` 拉**未完成全集** `liveGuids`。
2. 每个 guid → upsert active commitment（§3）。
3. 查本地所有 `mergeHint` 前缀为 `lark_task:` 且 status=active 的 commitment：
   **凡 guid 不在 `liveGuids` 里的 → 标掉**（已完成或已删除，二者对 attention 等价）。
4. 标掉的写法（**已验证：contextStore 未导出 status-setter**）：
   `getActiveContextUnitByMergeKey(mergeKey)`（db.ts:1318）取 row →
   `updateContextUnit({ ...row, status:'superseded', updated_at })`（db.ts:1264）。
   注意 `updateContextUnit` 是 raw db 函数、**不触发 upsert hook**——对「标记下线」无影响
   （我们不需要因下线再跑 attention）。如需触发可另调 hook，MVP 不必。
5. 需要一个「列出所有 task-origin active commitment」的查询。

⚠️ **mergeKey 陷阱（已核实）**：`mergeHint` 只有 `work_map:` 前缀才原样当 mergeKey，其余走
`computeMergeKey` 的 sha1（`contextStore.ts:168`；`getActiveContextUnitByMergeKey` 只支持**精确
匹配**、无 LIKE）。所以 `lark_task:<guid>` 会被 sha1 成不可读 key，**不能前缀反查**。

❌ **entity 反查函数确认不存在，必须新增（最大代码缺口）**：
- `listEntitiesForUnit(unitId)`（db.ts:1503）只有 unit→entities **正向**；
- `listActiveContextUnits`（contextStore.ts:426）只能按 kind/originKind/actionability/status 过滤，
  **无 entity 过滤**；
- 全仓无 `listUnitsForEntity` / `listContextUnitsForEntity` 之类。
- → **必须在 db.ts 新增**（`context_unit_entities` 已有 `idx_cue_entity` 索引，db.ts:156）：
  ```ts
  export function listActiveContextUnitsForEntity(entityId: string): ContextUnitRow[] {
    return db.prepare(
      `SELECT cu.* FROM context_units cu
       JOIN context_unit_entities cue ON cu.id = cue.context_unit_id
       WHERE cue.entity_id = ? AND cu.status = 'active'
       ORDER BY cu.updated_at DESC`
    ).all(entityId) as ContextUnitRow[];
  }
  ```
  caller 在 JS 层 filter `kind==='commitment'`、从 entity name 取 guid 比对。
- 注意：对账时 entityId 要先 `resolveOrCreateEntity('task','lark_task:<guid>').id` 再 `resolveAliased`，
  与 upsert 写入时一致，否则查不到。

## 5. 调度与配置（照 config.ts 既有模式）

`apps/server/src/config.ts` 加：

```ts
taskCollectorEnabled: envBool('TASK_COLLECTOR_ENABLED', true),
taskIntervalMs: envInt('TASK_COLLECTOR_INTERVAL_MS', 300_000),   // 5min，与 calendar 持平
taskCompletedLookbackMs: envInt('TASK_COMPLETED_LOOKBACK_MS', 7 * 24 * 3600_000),
taskMaxPerTick: envInt('TASK_MAX_PER_TICK', 200),
```

`scheduler.ts:67` 之后注册：

```ts
if (config.taskCollectorEnabled) {
  scheduled.push({ collector: larkTaskCollector, running: false });
}
```

`collect(since)` 的 `since` 来自 `getCollectorState('larkTask').last_success_at`，可用于
`--created_at` 增量；但任务的 summary/due 会变，**不能纯增量**——未完成集合每轮全量 page-all 兜底，
`upsertContextUnit` 幂等保证不重复。

### 5.5 独立 tasks slice（决策 B 的落点）

`GlobalContextPacket` 加字段 `tasks: TaskInPacket[]`，在 `assembleGlobalContextPacket`
（`agentContextAssembler.ts:814`）里：

- **从 commitments 桶里剔除 task-origin commitment**（`origin.kind==='system'` 且挂 `lark_task:`
  entity），避免它们既占 commitments cap 又进 tasks slice。
- 单独按 dueAt / createdAt 排，cap 自定（建议 `GLOBAL_SLICE_CAPS.tasks = 15`）。
- **同步要改的点（agent 复核后从 6 个补到 11 个）**：
  1. `TaskInPacket` 类型定义（agentContextAssembler.ts:750 一带，与 `CommitmentInPacket`/`GoalInPacket`
     并列）；建议 `ContextUnit & { _layerHint?: ContextLayerHint }`，**先不挂 selfRoleOnUnit**（任务不
     需要「我的角色」判断，省一次 `computeSelfRolesOnUnits`）。
  2. `GlobalContextPacket` 类型加 `tasks: TaskInPacket[]`（:763-784，inputHash 字段前）。
  3. **commitments 桶剔除**：commitmentsRaw 的 filter 链（:831）加
     `.filter(u => !u.entities.some(e => e.type==='task' && e.name.startsWith('lark_task:')))`。
     ✅ 已确认不影响 selfRoleOnUnit / _layerHint 派生（它们在 filter 之后 map）。
  4. **新增 tasks 装配块**：在 recentEvents 之前（:873 附近）按 dueAt/score 排序、slice 到 cap。
  5. `GLOBAL_SLICE_CAPS` 加 `tasks: 15`（:786-802；agent 建议 8，我倾向 15，因为任务量大且已不挤
     commitments）。
  6. **返回值挂 `tasks,`**（:1043-1062 的 return 对象——agent 特别提醒这个最容易漏，漏了装配白做）。
  7. `estimateGlobalPacketTokens`：入参加 `tasks`，并入 `unitChars` 循环（:1129-1164，含调用处 :978）。
  8. `hashSeed` 加 `tasks: unitFingerprints(tasks)`（:1016 一带）——否则任务变化不触发非缓存 tick。
  9. `attentionPrompt.ts` `buildAttentionUserMessage`：uncertainties 与 recentEvents 之间插一段
     `renderUnitsBlock('tasks', packet.tasks, '飞书任务…', minter)`。✅ `RefMinter` 自动给 task id
     编 `S#`、`renderUnitOneLine` 自动挂 `[src=…]`，**无需改 ref 体系**；prompt 文案里说明「飞书原生
     任务，区别于从对话抽出的 commitment」。
  10. `AttentionInputSummary` 加 `tasksCount`（attentionTypes.ts），并在 attentionEngine.ts:100-114
      的 inputSummary 装配处加 `tasksCount: packet.tasks.length`。
  11. **bootstrap-skip 判据**（attentionEngine.ts:117-136）：现在是
      `topActive==0 && commitments==0 && recentEvents==0` 就 skip。**必须加 `&& packet.tasks.length===0`**，
      否则「只有飞书任务、没别的信号」时会被误判为无数据而 skip，任务永远不进 attention。
- 识别「task slice 成员」的判据：**挂 `{type:'task', name 前缀 lark_task:}` 的 entity**（不看 origin）。
  这样 collector 建的（origin='system'）和 card 路径建的（origin='card_action'）commitment 都会被
  归入 tasks slice——它们本质都是飞书任务。commitments 桶用同一判据做反向剔除，保证不重不漏。

## 6. 待确认项（两轮 review 后全部核验完毕，无遗留 ⏳）

1. ✅ **`origin.kind`**：已验证，`ContextOriginKind = event|chat|card_action|agent_run|manual|system`，
   **无 `'collector'`**。用 `'system'`。
2. ✅ **status 写法**：已验证，`contextStore` **未导出** status-setter。走
   `getActiveContextUnitByMergeKey`（db.ts:1318）+ `updateContextUnit`（db.ts:1264，raw、不触 hook）。
   详见 §4.4。
3. ✅ **完成字段**：已验证，已完成项**无任何完成标记字段**，结构同未完成项。→ §4 改用集合差对账。
4. ✅ **覆盖面已实测**：`get-related-tasks --created-by-me` 跑通，`--created-by-me` 是按 creator 的
   客户端过滤、与 assignee 无关，**能覆盖「自己创建但没指派给自己」的任务**。决策的 get-my-tasks ∪
   get-related-tasks 并集成立。

6. ⚠️ **两路输出字段/时间格式不一致（新发现，必须归一）**：
   - `get-my-tasks` 的 `created_at` 是 ISO8601 带时区：`2026-06-03T11:24:26+08:00`；
   - `get-related-tasks` 的 `created_at` 是**空格分隔、无时区**：`2026-05-29 06:03:02`。
   - collector 写 ContextUnit 前必须统一成 ISO（参考 larkTaskService 的 `normalizeDueAt`：`Date.parse`
     兜底，但要注意无时区串会被当本地时区解析，可能差 8h——建议显式按 +08:00 处理）。
   - 另：`get-related-tasks` 多带 `status`（如 `"todo"`）、`members`、`description`、`tasklists` 等
     字段，`get-my-tasks` 没有。`status` 可作为完成判断的**补充**信号，但主对账仍用集合差（§4），
     不依赖它（get-my-tasks 侧拿不到）。两路合并时以 `guid` 去重。
7. ✅ **打分/cap**：已验证 `scoreContextUnit`（activeContext.ts）actionability 权重 0.8、`'act'` 为
   最高档，且 dueAt 给 urgency 加成。→ **task commitment（actionability='act'）会排在 commitments
   桶高位**，cap=10 下挤占风险坐实——已由决策 B（独立 slice + commitments 反向剔除）解决，见 §5.5。
8. ✅ **entity→units 反查**：已验证**不存在**，必须新增 `listActiveContextUnitsForEntity`（§4.5）。
9. ✅ **computeMergeKey 一致性**：已验证（sort + canonical + resolveAliased），card 路径与 collector
   路径同 (kind, task entity, mergeHint) → 同 mergeKey → 自动合并去重。

## 7. 风险

- **R1 cap 挤占（已确认，最大设计风险）**：`scoreContextUnit` 给 actionability='act'（0.8 权重）+
  dueAt 高分，task commitment 几乎必然排在 commitments 桶前列。用户实测有**几十条**任务，cap=10
  会被任务**整桶占满**，把日历/会议/triage 派生的 commitment 全顶掉，attention 视野被任务淹没。
  这是「接 task collector」与「现有 commitment 信号」的正面冲突。**✅ 已采方案 B：独立 `tasks`
  slice**（见 §5.5）——commitments 桶反向剔除 task entity，任务进自己的 slice，互不挤占。
- **R2 噪声任务**：实测任务里有「来自话题群：…」「[图片]」这类低信息条目，直接成 commitment 会脏。
  缓解：collector 侧做最小过滤（空 summary / 纯图片占位）。
- **R3 完成对账时间窗**：只拉近 7d 完成项，超窗完成的老任务对账不到，commitment 残留。
  缓解：未完成集合每轮全量；某 guid 不在「未完成全量」里且本地仍 active → 视为已完成/删除，标掉。
  （这条比「拉完成项」更稳，建议作为主对账逻辑，§4.2 降级为补充。）
- **R4 鉴权/代理**：lark-cli 走代理且依赖 user 授权，permission_denied 时整轮停（照 larkOrg）。

## 8. 实现步骤（建议顺序）

> §6 已全部核验、R1/覆盖面决策已定，可直接按下序实现。

1. **db 层**：新增 `listActiveContextUnitsForEntity(entityId)`（§4.5）。
2. **config.ts**：加 4 个开关（`taskCollectorEnabled` / `taskIntervalMs` / `taskMaxPerTick` /
   `taskCompletedLookbackMs`，照 envBool/envInt）。
3. **assembler/prompt**：照 §5.5 的 11 点加 `tasks` slice（含 commitments 反向剔除、返回值挂 tasks、
   bootstrap-skip 判据、inputHash、token 估算、prompt 渲染、inputSummary.tasksCount）。
4. **新建 `collectors/larkTaskCollector.ts`**：get-my-tasks ∪ get-related-tasks 并集（guid 去重、
   时间归一）→ upsert commitment（kind='commitment', origin='system', mergeHint=`lark_task:<guid>`,
   actionability='act'）→ 集合差对账：本地 task commitment 的 guid 不在未完成全集里 → `updateContextUnit`
   标 superseded。照 larkOrg 模式：collect() side-effect、返回 `[]`、permission_denied 整轮停。
5. **scheduler.ts**：`if (config.taskCollectorEnabled) scheduled.push(...)`。
6. **单测**：mock `runLarkCliJson`，断言 ①upsert 入参 ②两路 guid 去重 + 时间归一 ③mergeHint 与 card
   路径合并去重 ④集合差对账标 superseded ⑤assembler 把 task 从 commitments 剔除、进 tasks slice。
7. **端到端**：本地起服务 → 飞书建任务 → 等一轮 → 看 packet.tasks / attention 出现；标完成 → 看下线。
8. **文档**：更新 MVP5 TODO 勾选 + 本计划归档。

## 10. 自审结论与待你拍板的决策点

**自审发现并已在本文修正的问题：**
- ❌→✅ 初稿 `origin.kind:'collector'` 非法（类型里没有），改 `'system'`。
- ❌→✅ 初稿「拉 `--complete=true` 逐条标 done」不可行——已完成项无完成字段，改**集合差对账**。
- ⚠️ 初稿漏了 **mergeKey sha1 陷阱**：`lark_task:<guid>` 不是明文 mergeKey，对账必须走 entity 反查
  （db 层可能要新增反查，已列入 §8.3）。
- ⚠️ 升级 R1 为「最大设计风险 + 必须先决策」（打分已证实 task 会占满 cap）。

**2 个决策已拍板：**
1. ✅ **R1 = 方案 B：独立 tasks slice**（语义干净）。落点见 §5.5，task 仍存为 commitment、装配层拎出。
2. ✅ **覆盖面 = get-my-tasks ∪ get-related-tasks --created-by-me**。见 §1。

### 第二轮 review（对最新代码，3 个并行 agent 复核）新增/修正

- ✅ **覆盖面销项**：实测 `get-related-tasks --created-by-me` 按 creator 过滤，覆盖自建未指派任务，
  并集方案成立（§6.4）。
- ❌→✅ **entity 反查确认缺失**：第一轮只说「可能要新增」，复核确认全仓无 unit-by-entity 反查，
  **必须新增** `listActiveContextUnitsForEntity`（§4.5、§8.1）。这是对账能否实现的硬前提。
- ➕ **§5.5 集成点 6→11**：复核补出 4 个易漏点——`TaskInPacket` 类型、**返回值挂 `tasks,`**、
  **bootstrap-skip 判据加 `tasks.length===0`**（否则纯任务时被 skip）、`inputSummary.tasksCount`。
- ➕ **新发现时间格式陷阱**：两路 `created_at` 格式不同（带/不带时区），无时区串会差 8h，必须归一
  （§6.6）。
- ✅ **computeMergeKey / larkOrg 模式 / upsert→invokeHook 链 / config 写法**：全部复核成立，无修正。

**结论**：两轮 review 后，文档无残留错误与待决策项；唯一阻塞「能否实现」的是 §8.1 那个新增 db 反查
函数，属已知补全项。计划可执行，等你说「开做」即按 §8 顺序实现。

## 9. 验收标准

- 飞书新建任务，≤1 个 collector 周期后出现在 `assembleGlobalContextPacket().tasks`（**独立 slice，
  非 commitments 桶**）。
- 同一任务被 AI is ON 创建 + collector 采回，只有 1 条 ContextUnit（mergeHint 合并生效）。
- 任务在飞书标完成/删除 → ≤1 周期后对应 commitment 被集合差对账标 superseded、不再 active。
- 只有飞书任务、无其它信号时，attention **不被 bootstrap-skip**（§5.5 第 11 点）。
- collector 失败不影响其他 collector（mutex + 独立 state）。
