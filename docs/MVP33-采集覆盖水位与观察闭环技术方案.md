# MVP33 — 采集覆盖水位与观察闭环技术方案

> 状态：设计完成，实施中。
> 起因：2026-06-12 排查「专利 Matter 未自动止催」事故；方案按普适缺陷而非单点事故设计。
> 作者：Claude（与 xinming 讨论产出），2026-06-12

## 0. 一句话

修两个普适缺陷：**U1 — 采集游标可以越过未覆盖的时间段**（任何停摆/洪峰后静默永久丢数据），引入「覆盖水位」契约，游标只允许推进到已完整消化的时间点；**U2 — 系统认出了进展证据但证据到不了 Matter 状态机**（triage 产出的 matter_observations 是只写死信），给它接上召回→判定→保守落地的消费通路。

## 1. 事故复盘（作为缺陷类的一个实例）

时间线（CST）：

1. 6-10 17:47 周强在单聊要求提交三个专利 → Matter `04ce4f28`（P0，executor=我）。
2. 6-11 上午 用户编辑三份交底书；drive 事件实时入库，triage 产出 5 条专利相关 observation（含 `progress/advance`）→ **全部死信**（U2）。
3. 6-11 11:56 IM 采集最后一轮成功；随后 lark-cli 整批挂死，采集失明。
4. 6-11 12:51-12:58 用户在单聊对周强说「都提交好了哈…」周强回「可以，点赞」——**决定性闭环证据，落在盲区开头**。
5. 6-12 11:59 修复后回灌：游标正确（COALESCE 保住 last_success_at），但 p2p `messages-search --page-all --page-limit 5` 最新优先、只返回 ~100 条即停（`has_more:true` 被忽略）——**比 6-11 20:06 更早的约 8 小时静默丢弃**（U1），周强对话永久丢失。
6. Matter 停留在 version=1 / open / P0，attention 层持续催办。

两个缺陷各自独立成类：U1 适用于所有采集器的所有截断点；U2 适用于所有「非语义 kind」证据源（doc 编辑、评论、应用通知、state 单元）。

## 2. 目标与非目标

### 目标

- G1（U1）：建立**覆盖水位（coverage watermark）契约**——collector 显式上报"我完整覆盖到了哪个时间点"，调度器游标永不越过水位。停摆/洪峰后的积压通过有界追赶窗口逐轮排干，**零静默丢失**。
- G2（U1）：水位滞后可观测、可告警（freshnessWatchdog 升级）；滞后超硬上限才允许跳水位，且必须升 P0 系统卡——**丢数据可以，静默丢不行**。
- G3（U2）：`matter_observations` 从只写表变为统一证据入口：带 `lifecycle_effect` 的观察经 召回（实体 + 标题双轴）→ LLM 判定 → **复用 reducer 既有保守阈值** 落地到 Matter；回写 `candidate_matter_ids_json`（补上 MVP29 预留未用的字段）。
- G4（U2）：消费幂等 + 重启可恢复（consumed 标记 + 启动补扫）。

### 非目标

- 不改 novelty 语义（`create_time > sinceIso`）与 MVP30 的 context/novelty 分离设计。
- 不给 `skipTriage=true` 的源（driveComment 评论）接 observation——它们不过 triage，天然无观察产出；列为后续（见 §10）。
- 不做关键词层面的 detectSelfAction 扩词——实例级补丁，由 U2 证据路径 + MVP32 手动「已处理」覆盖。
- 不重做 Matter Reducer 的阈值与守卫（≥0.78 改状态、0.55-0.78 只挂证据、永不自动 drop——原样复用）。
- 本期只给 **im** 做全保真水位（唯一被证实丢数据、且唯一高流量 since 窗口源）；calendar/larkTask/larkOrg/driveComment/meetingArtifact 是固定窗口快照式（不依赖 since 游标），drive 低流量——它们接入契约但水位=本轮扫描起点，行为与今天一致，保真度后续按需提升。

## 3. U1：采集覆盖水位契约

### 3.1 契约定义

```ts
// collectors/types.ts
export type CollectResult = {
  signals: RawSignal[];
  /**
   * 覆盖水位（ISO）：调用方可以安全把游标推进到这里。
   * 铁律：凡 occurred_at ≤ coveredUntil 且属于本源职责范围的数据，
   * 要么已包含在本轮（或历史轮）signals 中，要么永远不会存在。
   * 本轮没有完整消化的时间段，水位不得越过。
   */
  coveredUntil: string;
};

export type Collector = {
  name: string;
  intervalMs: number;
  collect(since: Date | null): Promise<CollectResult>;
};
```

- 快照式采集器（calendar/larkTask/larkOrg/driveComment/meetingArtifact/drive）：`coveredUntil = 本轮扫描起点(now)` ——与今天行为一致。
- imCollector：见 §3.3，真实计算水位。

### 3.2 调度器与存储

- `collector_state` 增列 `covered_until TEXT`（`ensureColumn` 迁移，nullable）。
- 读游标：`since = covered_until ?? last_success_at`（旧库回退）。
- 写状态：成功轮 `covered_until = result.coveredUntil`（错误轮写 null，沿用 COALESCE 保旧值）。
- `last_success_at` 语义回归本义：**活性**（最近一次成功扫描的墙钟时间），供 freshness 停滞判断；`covered_until` 表达**覆盖进度**。两者分离，追赶中的 collector 不会被误判为停滞。
- **保险丝**：`since = max(watermark, now - collectorWatermarkMaxLagMs)`（默认 7d）。触发即 `console.error`，水位滞后告警卡（§3.5）让用户可见。
- 水位回拨 = 免费的补扫能力：管理性地把 `covered_until` 拨回 T，系统自动把 (T, now] 重新扫干净（事件 UNIQUE 去重兜底）。

### 3.3 imCollector 水位实现

#### 窗口结构

```
since(=watermark) ──── windowEnd = min(now, since + imMaxScanWindowMs)
   │   novelty 窗口：(since, coveredUntil]，产信号
   │
ctxFetchStart = min(since, windowEnd - imContextFetchHorizonMs)
   │   context 区：只作渲染/disambiguation 上下文，允许有损（不影响水位）
```

正常运行（3 分钟 tick）窗口远小于 `imMaxScanWindowMs`（默认 6h），行为与今天一致；停摆后窗口自动截到 6h，每 tick 排干一段，24h 积压 ≈ 4 个 tick 追平。

#### 各抓取路径的覆盖判定

| 路径 | API 形态 | 覆盖判定 | 失败动作 |
|---|---|---|---|
| 内部 p2p / my-group | `messages-search`，**最新锚定**（验证：has_more 时丢的是窗口最老段） | `!has_more` 或 `oldestReturned ≤ since`（novelty 窗口完整） | **收缩重试**：windowEnd 减半（floor `imMinScanWindowMs`=5min，≤6 次必终止）；floor 仍超限 → 接受 + `console.error`（病态：5min 内 >100 条，有界且大声） |
| 群聊 per-chat / 外部 p2p | `chat-messages-list --sort asc`，3 页截断（丢的是窗口最新段） | `!has_more` | **clamp**：该 chat 的 coveredUntil = 最后返回消息时间 − 60s；下轮自然续扫（asc 每轮至少推进 3 页，必收敛） |
| chat-list 翻页上限 | ByActiveTimeDesc | 命中 `imChatListMaxPages` 即可能漏冷群 | 仅 `console.warn`（漏的是按活跃排序的尾部，量化后续） |

全局 `coveredUntil = min(windowEnd, p2p 覆盖点, my-group 覆盖点, 各 chat clamp 点)`。

#### 信号发射不变量（防 agg 重复计数）

**每轮事件只产自 `(since, coveredUntil]`，跨轮窗口两两不相交。**

- 计算出全局 coveredUntil 后，所有消息先过滤 `create_time ≤ coveredUntil` 再进入 novelty 切片与信号构建。超出水位的消息本轮丢弃、下轮以 novel 身份重来（单消息事件有 UNIQUE 去重；聚合信号 sourceId/`contentHash` 含 sinceIso，窗口不相交 ⇒ 不会重复计数同一批消息）。
- **分钟边界约定**：lark 消息时间是分钟粒度、novelty 是严格 `>`。水位必须落在"该分钟已完整覆盖"的点上——clamp 一律取 `T − 60s`（T=最后返回消息的分钟），宁可下轮重扫一分钟（去重兜底），不可丢同分钟被分页切掉的消息。
- **信号上限改语义**：`imMaxSignalsPerScan` 命中时不再按优先级**永久丢弃**，改为按 occurredAt 升序保留前 N 条、`coveredUntil` clamp 到首条被丢信号时间 − 60s——积压变成多轮排水而非数据丢失。边界：超上限的信号全在同一分钟 → 全保留（允许小幅超限，warn）。

### 3.4 共享收缩助手（可单测）

```ts
// 注入 fetch 函数，纯逻辑可测
export async function coverNewestAnchoredWindow(opts: {
  sinceMs: number; endMs: number; minWindowMs: number; maxShrinks: number;
  fetch: (startMs: number, endMs: number) => Promise<{ msgs: ImMessage[]; hasMore: boolean }>;
}): Promise<{ msgs: ImMessage[]; coveredUntilMs: number; truncated: boolean }>
```

验收测试以事故形态写成通例：模拟 24h 停摆 + 注入超过分页上限的最新锚定消息流 → 断言若干轮后**零丢失**。

### 3.5 可观测与告警

- `getCollectorSnapshot()` / `/api/collectors` 透出 `coveredUntil` 与滞后毫秒数。
- freshnessWatchdog 增加第二类检查：任一 collector `now − covered_until > collectorWatermarkLagAlarmMs`（默认 2h）且扫描本身在成功 → 升 P1 系统卡「采集落后于实时」（独立 input_hash，恢复自动撤）；与既有"全员停滞 30min → P0"互补：那边管**活性**，这边管**覆盖进度**。

## 4. U2：matter_observations 消费通路

### 4.1 数据流

```
triage LLM → matterObservations（已有）
  └→ recordMatterObservation 落库（已有，返回值补 id）
       └→ [新增] consumeMatterObservation（fire-and-forget，不阻塞 triage 批次）
            ① 门槛：lifecycle_effect ∈ {advance, block, resolve…}（排除 create）
               且 confidence ≥ matterObsMinConfidence(0.6)
            ② 让路：该 event 本轮已产出 HANDLED_KINDS 语义单元
               （commitment/intent/action_result/decision/uncertainty）
               → reducer hook 已负责，标 consumed='delegated_to_reducer' 跳过
            ③ 选 unit：观察关联的 context_unit_ids 中优先语义单元，否则 raw event 单元
            ④ 召回：scoreAndRank(unit)（实体轴）∪ titleSimilarity(obs.title, matter.title)≥0.25
               的 active matter（标题轴，补实体稀疏的应用通知类证据），合并取 top 8
            ⑤ 判定：复用 llmJudge；喂给它的 unit content 前置
               `观察：<obs.title>\n证据：<obs.evidence>`（sketch 400 字截断内可见）
            ⑥ 落地：复用 reducer 的 applyDecision（同阈值、同守卫，永不 create/drop）
            ⑦ 回写：candidate_matter_ids_json + consumed_at + consume_result
```

### 4.2 关键决策

- **不扩 reducer 的 kind 闸门**：按 kind 逐个放行是补丁路线；observation 是 triage 对"这条 event 影响某事项"的显式判断，作为统一入口语义最准。
- **让路规则（②）防双判**：同一 event 若产出了 commitment 等语义单元，reducer hook 与 observation 消费会对同一证据各跑一次 LLM 判定，可能写出冲突 transition。以 HANDLED_KINDS 单元存在与否做静态分流：有 → reducer 负责；无（本事故里 doc 编辑/`state` 单元正属此类）→ 消费通路负责。
- **消费不创建 Matter**：`possible_new_matter`/`create` 观察跳过（创建语义由 commitment 单元路径负责，那条路有 actionability/实体门槛，防观察类噪声开新 Matter）。
- **fire-and-forget + 启动补扫**：消费含一次 LLM 调用（走 opencode 单并发闸门排队），不能阻塞 triage 批次收尾；进程重启丢 in-flight → 启动时补扫 `consumed_at IS NULL AND lifecycle_effect IS NOT NULL AND created_at > now-48h`。
- **本事故的反事实验证**：6-11 的 `progress/advance` 观察（用户编辑《Base Chatbot专利挖掘》）——unit actor=我(person) 与 matter executor=我 实体重叠 0.35 ≥ 召回线 0.2 ✓；应用通知类（"共享智能体记忆专利待审批"）实体稀疏，靠标题轴补召回 ✓。

### 4.3 存储与类型

- `matter_observations` 增列：`consumed_at TEXT`、`consume_result TEXT`（`ensureColumn`）。
- `recordMatterObservation` 返回生成的 row id（唯一调用方 triageQueue 同步改）。
- `matterReducer` 导出 `reduceUnitWithCandidates(unit, candidates, opts)`（包装 judge + applyDecision，供消费通路复用；`reduceMatterForContextUnit` 不动）。
- 新文件 `matter/matterObservationConsumer.ts`：`consumeMatterObservation(row, opts?)`、`recoverUnconsumedObservations()`；judge 可注入（测试 stub，与 reducer 同模式）。

## 5. 配置

| 配置 | env | 默认 | 说明 |
|---|---|---|---|
| `imMaxScanWindowMs` | `IM_MAX_SCAN_WINDOW_MS` | 6h | 追赶窗口上限（单轮最多消化的时间跨度） |
| `imMinScanWindowMs` | `IM_MIN_SCAN_WINDOW_MS` | 5min | 收缩 floor，到底仍超限则有界接受+大声报错 |
| `collectorWatermarkLagAlarmMs` | `COLLECTOR_WATERMARK_LAG_ALARM_MS` | 2h | 水位滞后告警线（P1 系统卡） |
| `collectorWatermarkMaxLagMs` | `COLLECTOR_WATERMARK_MAX_LAG_MS` | 7d | 保险丝：滞后超此值跳水位（大声） |
| `matterObsConsumeEnabled` | `MATTER_OBS_CONSUME_ENABLED` | `true` | U2 总开关 |
| `matterObsMinConfidence` | `MATTER_OBS_MIN_CONFIDENCE` | 0.6 | 观察消费置信门槛 |

## 6. 边界情况与风险

| # | 场景 | 处置 |
|---|---|---|
| 1 | 收缩到 floor 仍 has_more（5min 内 >100 条 p2p） | 有界接受 + `console.error`；丢失上限 = floor 窗口的截断量，且必然留下日志 |
| 2 | 某群常态化超 3 页/轮（clamp 不前进？） | asc 每轮至少推进 3 页消息的时间跨度，fetch 速率 > 消息速率即收敛；不收敛会触发水位滞后告警（人可见） |
| 3 | 同分钟边界消息被分页切断 | 所有 clamp 取 T−60s，下轮重扫该分钟，UNIQUE 去重 |
| 4 | clamp 后已 fetch 的更新消息作废重抓 | 故意为之：保证跨轮窗口不相交（agg 不重复计数）；单消息去重兜底 |
| 5 | 追赶轮信号 occurredAt 很旧 → attention 误判新鲜度 | 既有行为（回灌同样如此）：triage/attention 按 occurred_at 判断时效，旧信号自然降权 |
| 6 | 水位长期滞后（采集速率 < 消息速率） | 2h 告警卡 + 7d 保险丝跳水位（大声丢弃，绝不静默） |
| 7 | observation 消费与 reducer hook 双判同一 event | 让路规则 §4.2-②（HANDLED_KINDS 单元存在 → delegated） |
| 8 | 消费 LLM 调用失败 / 进程重启丢 in-flight | consumed_at 仍 NULL → 启动补扫重试；解析失败标 consumed='judge_failed' 不无限重试 |
| 9 | 观察标题轴召回误拉无关 matter | 只是进候选（top 8），最终有 LLM 判定 + 0.78/0.55 阈值双闸 |
| 10 | 观察消费写状态与用户手动操作竞态 | applyDecision 既有 guardEffect（resolved 不重复 resolve、dropped 永不动）已覆盖 |
| 11 | legacy collector 返回数组（热重载窗口期） | 调度器对非 CollectResult 形状防御兜底为 `coveredUntil = scanStart` |

## 7. 测试计划（node:test，apps/server/test/）

**mvp33-watermark-contract.test.ts**
1. 调度器写 `covered_until`=collector 返回值；读游标优先 covered_until，旧库回退 last_success_at。
2. 保险丝：covered_until 滞后 >7d → since 被钳到 now−7d。
3. freshnessWatchdog：水位滞后 >2h 且扫描成功 → 滞后卡；恢复撤卡；与停滞卡互不干扰。

**mvp33-im-window-cover.test.ts**（fetch 注入）
4. 验收通例：24h 积压、200 条最新锚定消息、page cap 100 → 多轮调用后零丢失、窗口两两不相交。
5. 收缩：has_more 且 oldestReturned > since → windowEnd 减半直至覆盖；floor 仍超限 → truncated=true。
6. asc clamp：per-chat has_more → coveredUntil = 末条 −60s。
7. 信号上限 clamp：>cap 时按时间保留 + 水位回退；同分钟全保留。

**mvp33-observation-consumer.test.ts**（judge stub 注入）
8. progress/advance 观察 + 实体重叠 matter → attach/advance、candidate 回写、consumed 标记。
9. 标题轴召回：无实体重叠、标题相似 → 进候选。
10. 门槛：低置信 / create 类 / HANDLED_KINDS 让路 → 各自 consumed 标记、零 LLM 调用。
11. 幂等：重复消费同 observation → 第二次直接跳过。
12. 启动补扫：未消费观察被补；已消费/超窗不补。

## 8. 落地顺序

- **M1（U1）**：types 契约 → db 列 → scheduler → imCollector 水位 → 其余 collector 适配 → watchdog。独立可交付，交付即关闭"静默丢数据"类。
- **M2（U2）**：matterStore 返回 id → reducer 导出 → consumer 新文件 → triageQueue 挂钩 → 启动补扫。独立可交付。
- 事故实例不单修：M1 落地后把 im 水位拨回 2026-06-11T03:55Z 即可自愈补扫（或用户在卡片上手动 resolve）。

## 9. 与 MVP32 的关系

同一架构的两半：U2 是**自动闭环**（有数字痕迹时系统自己止催/推进），MVP32 是**手动闭环**（无痕迹时用户一键断言 + 异步核实）。U2 给 matter 自动挂的证据链接正是 MVP32 核实 agent 的输入（其自审 R1 依赖 matter_context_links）——U2 落地后核实准确率直接受益。

## 10. 后续（不在本期）

- driveComment（skipTriage）证据接入观察通路。
- drive/meetingArtifact 的分页保真水位。
- chat-list 翻页上限漏冷群的量化与处置。
- 群聊 burst 的 agg 在水位 clamp 边界的重复渲染优化（当前接受 ≤1min 重扫）。
