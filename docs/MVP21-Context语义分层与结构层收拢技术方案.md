# MVP21 · Context 语义分层与结构层收拢技术方案

## 0. TL;DR

**问题**：系统按 MVP 编号迭代到现在，所有"派生 / 推断 / 用户断言"的信息散落在 39 张表里，没有统一的目录学。最尖锐的两个症状：

1. **Work Map 既写静态身份，又写动态项目状态**——`workMapWriter` 用同一份 confirm 表单同时写 `kind=state/relationship/preference`（半年级稳定）和 `kind=goal/commitment/uncertainty`（周级流动）。后三种被 attention engine 当成跟 IM/triage 抓到的同等一等信号消费（[agentContextAssembler.ts:816-854](../apps/server/src/context/agentContextAssembler.ts)），导致"用户填的 risk"和"昨晚开会冒出的 risk"在卡片里抢位置；卡片用户也分不清这条 commitment 是"已对外承诺的事实"还是"我登记给自己的提醒"。
2. **结构信息有两条不交汇的写入路径**——`bootstrap/workMapWriter` 是 *用户断言*，`spaces/suggestionWorker + llmChatAffinityRanker` 是 *系统推断*。两者最终都写 `context_spaces / entity_edges / context_space_links`，但消费方（attention prompt / agentContextAssembler / commitmentAgent）不知道这条信息的"权威等级"，所有 link 一视同仁。

**结论方向**：底层 ContextUnit 流动不动；上面应该有清晰的**语义层标签 + 来源标签 + 权威等级**三轴元数据，让消费方按需取用。

**第一刀不切数据、不切目录、不改写入路径**——只加 `classifyContextUnit / classifySpaceField` 两个纯函数 + 在 attention prompt 行尾输出 `[src=work_map_seed]` / `[src=triage]` 这类 inline 标签，让 LLM 在推理时自己用，并通过 `/api/debug/*` 暴露给前端 ContextPanel 观察一周再决定下一步。可逆性 100%。

**5 个阶段独立可上线、独立可回滚**，每阶段都对应一个 PR：

| 阶段 | 内容 | 行为变化 | Schema 改 | 风险 |
|---|---|---|---|---|
| **S1 语义标签**（首刀） | `classifyContextUnit` + packet 注入 `_layerHint` + attention prompt inline `[src=...]` 标签 + ContextPanel 显示 | 零硬过滤；只多 LLM 一句可读 hint | 无 | 极低 |
| **S2 字段重命名** | `Space.intent_json` 的 `workMapGoalTitles / workMapRiskTitles` → `seedGoalTitles / seedConcernTitles`，向后兼容读 | ranker prompt 措辞更准 | 无（字段加一对兼容键） |
| **S3 Work Map UI 拆分** | 前端拆 Identity / Current Focus 两屏；Current Focus 改为只读，从 `GET /api/context-spaces/:id` 现查 | 写入路径不动；只是 UI 重组 | 无 | 中（前端工作量） |
| **S4 写入路径分流** | Work Map confirm 时**不再**写 `kind=commitment/uncertainty (mergeHint=work_map:*)`；保留 `kind=goal` 作为长期 intent；保留 Space.intent_json 完整 | 新提交的 Work Map 不再制造 work_map seed commitment / uncertainty | 无（写入分支变化） | **高**，需在 S1 telemetry 跑满 2 周后再上 |
| **S5 目录与 inducer 注册表** | `bootstrap/` + `spaces/` 物理迁移到 `structure/{asserted, inferred, routing, derived}`；建立 inducer 注册表（仅记 name/layer/triggerKind/lastRunAt） | 编译时重构 | 无 | 低 |

**关键约束**：
- **每一步都不动现有 attention `commitments[]/goals[]/uncertainties[]` 的硬过滤逻辑**——这套数据是 attention 的主食，被代码硬过滤等于断电。所有"按来源分流"全部落在 prompt 文字里靠 LLM 决策。
- **三轴分类不是 4 个二元 flag 拼起来**——是一个 layer 标签（identity_fact / project_intent / dynamic_signal / pending_inference / derived_signal / output）+ source + asserted/voluntary 元数据。
- **不引入 Inducer Framework 的统一 TTL/落表抽象**——graphInducer 是 throttled-cache、suggestionWorker 是 feedback-cooldown、selfRoleOnUnit 是 on-read，三种生命周期保留，只共享注册表 + 观测元数据。

不做：把 `kind=goal/commitment/uncertainty` 拆成新表；新建 `identity_facts` 表；删 Work Map 的 `kind=relationship/preference` 写入分支；统一所有 inducer 的 TTL 配置。

---

## 1. 起点：观察到的问题与代码定位

### 1.1 症状一：Work Map 写入跨越两个流速带

[workMapWriter.ts:65-229](../apps/server/src/bootstrap/workMapWriter.ts) 在一次 confirm 中写入下列 ContextUnit（**全部带 `mergeHint='work_map:*'` 前缀**，MVP7 已让这个前缀字符串直接作为 `mergeKey` 存库，不做 sha1）：

| Work Map UI 字段 | 写成 | 实际流速 | 谁消费 |
|---|---|---|---|
| `profile.roleTitle` | `kind=state, mergeHint=work_map:role:self` | 半年级 | activeContext scorer +0.6 boost；attention `subject` slice |
| `profile.responsibilities` | `kind=state, mergeHint=work_map:responsibility:*` | 半年级 | 同上 |
| `stakeholders` | `kind=relationship, mergeHint=work_map:relationship:*` | 半年级 | `subject.stakeholders` |
| `preferences` | `kind=preference, mergeHint=work_map:preference:*` | 半年级 | `subject.preferences`、attention prompt `<preferences>` |
| `projects[].goals` | `kind=goal, mergeHint=work_map:goal:*:*` | 季度级 | attention `goals[]`、Space.intent_json |
| `projects[].upcomingDeadlines` | `kind=commitment, mergeHint=work_map:commitment:*:*` | **周级** | attention `commitments[]`（与 triage commitment 并列）、commitmentAgent trigger |
| `projects[].risks` | `kind=uncertainty, mergeHint=work_map:risk:*:*` | **周级** | attention `uncertainties[]`（与 triage uncertainty 并列） |

**前 4 行的语义和流速一致**——身份描述，半年才动一次。**后 3 行的流速跟 UI 维护节奏不匹配**：DDL 临期会消失、风险会演化、目标会换。但 UI 上没有"标记完成 / 标记已过时"的入口，用户要么不维护让它过期，要么手工去 ContextPanel 删——双写、漂移、attention 输入污染。

### 1.2 症状二：结构信息有两条不交汇的写入路径

`bootstrap/workMapWriter.ts` 与 `spaces/suggestionWorker.ts` 最终都向同一组表写入：

```
context_spaces            ← workMapWriter.writeProject(), suggestionWorker 不直接写（用户 confirm 后才写）
context_space_links       ← workMapWriter ensureDocEntityLinked + contextSpaceService.resolveUnitToSpaces
entity_edges              ← workMapWriter（me↔stakeholder 直接写）+ personPersonInducer / personProjectInducer（推断写）
context_entities          ← workMapWriter ensure-only + entityResolver
context_space_suggestions ← suggestionWorker 唯一写入方
```

但消费方看到一条 link 时**无法分辨**它是用户在 Work Map 上声明的、还是 LLM ranker 推断的、还是用户在 suggestion 列表里 confirm 出来的。表上有 `confidence` 字段但**没有 `source_authority` 维度**。

### 1.3 一个被 MVP7 半路截断的好做法

[contextStore.ts:163-175](../apps/server/src/context/contextStore.ts) 当 `mergeHint` 以 `work_map:` 开头时，**直接把 hint 作为 mergeKey 用，不再 sha1**。原因（注释原文）："活动 context scorer 要靠 `mergeKey.startsWith('work_map:')` 给 Work Map 条目加 +0.6 boost；sha1 之后无法识别。"

[activeContext.ts:98-105](../apps/server/src/context/activeContext.ts) 确实在用它：

```typescript
const isWorkMap =
  u.scope === 'work' &&
  (u.kind === 'state' || u.kind === 'goal' || u.kind === 'preference' || u.kind === 'relationship') &&
  (u.mergeKey?.startsWith('work_map:') ?? false);
if (isWorkMap) s += 0.6;
```

**两个观察**：

1. MVP7 已经在做"识别 work_map 来源"这件事——基础设施在；
2. 但识别只覆盖 4 个 kind（state/goal/preference/relationship），**`kind=commitment/uncertainty` 的 work_map 种子**根本没进 boost 条件，也没在别处被区分对待。这就是 `agentContextAssembler.ts:816-854` 收 commitments/uncertainties 时来源混淆的根因。

**这意味着本方案不是从零造概念，是把 MVP7 已经走了一半的"按来源标记"扩展到全 kind + 全消费方。**

### 1.4 数据在，没人统一接出来

把所有"想知道这条信息从哪来"的地方枚举一遍：

| 消费方 | 现在怎么判断来源 | 缺什么 |
|---|---|---|
| [activeContext.scoreContextUnit](../apps/server/src/context/activeContext.ts) | 4 个 kind + `mergeKey.startsWith('work_map:')` | 没覆盖 commitment/uncertainty；只有"work_map vs 非 work_map"二元，没 layer 概念 |
| [agentContextAssembler.assembleGlobalContextPacket](../apps/server/src/context/agentContextAssembler.ts) (L816-854) | 按 `u.kind === 'commitment'/'goal'/'uncertainty'` 三处 filter 分桶，配 `GLOBAL_SLICE_CAPS` 上限 + `scoreContextUnit` 排序；**不看来源** | 把 work_map seed 和 triage 信号混在同一个数组里 |
| [attentionPrompt.renderUnitOneLine](../apps/server/src/attention/attentionPrompt.ts) | 只输出 `{type:name}`；不暴露来源 | LLM 无从分辨"用户填的 risk"和"实时风险" |
| [commitmentAgent](../apps/server/src/agents/commitmentAgent.ts) | 看 `mergeKey` 字符串前缀做兜底 | 没有统一谓词；每个 agent 重复实现识别逻辑 |
| ContextPanel（前端） | 显示 `kind` + `meaning`；不显示 layer | 调试时看不出这条 unit 是哪条路径写的 |
| ranker prompt（[llmChatAffinityRanker](../apps/server/src/spaces/llmChatAffinityRanker.ts)） | 读 `Space.intent_json.workMapGoalTitles / workMapRiskTitles` | 字段名暗示"工作地图填的目标"是当前事实，措辞容易让 LLM 当 ground truth |
| Space detail handler（[routes/contextSpaces.ts:53-83](../apps/server/src/routes/contextSpaces.ts)） | 按 `u.kind` 分桶返回 `commitments / goals / risks / state / recentEvents`，**不区分 source** | 前端"当前进展"tab 拿到后无法在 UI 上区分"用户登记的"和"系统抓的" |

**结论**：这是个"派生层而非新数据层"的工作——所有信息都在 DB 里，但没人统一接出来。这决定了方案的复杂度上限。

---

## 2. 范围

### 2.1 在本方案范围内

| 模块 | 文件 | 输出 |
|---|---|---|
| **S1.1 分类函数** | `apps/server/src/context/layerClassifier.ts`（新建，约 90 行） | `classifyContextUnit(u): ContextLayerHint`、`classifySpaceField(field): SpaceFieldLayer` |
| **S1.2 packet 注入** | `agentContextAssembler.ts` 改 ~30 行：三处分桶 map 后挂 `_layerHint`；**抽出** `GoalInPacket / UncertaintyInPacket` 两个新类型；`GlobalContextPacket.goals / .uncertainties` 字段类型从 `ContextUnit[]` 改成新类型 | 现有 filter/sort/cap 不变 |
| **S1.3 prompt 暴露** | **先扩 `attentionPrompt.ts:renderUnitOneLine` 签名**接收 `_layerHint?` ; 行尾输出 `[src=...]` 标签 ; §3 加 1 条铁律 15 | 5 个 source 值输出（work_map_seed / triage / collector / manual / card_action / agent_run / system_feedback），unknown / inducer 不输出 |
| **S1.4 debug 接口 & 前端** | `routes/debug.ts` + `routes/context.ts` 加 `_layerHint` 透出；ContextPanel 显示 layer badge | 可观测性 |
| **S1.5 单测** | `apps/server/test/layer-classifier.test.ts`（新建） | 覆盖 mergeKey 前缀映射、kind+origin fallback、unknown 兜底 |
| **S2.1 类型字段定义** | `spaces/contextSpaceService.ts:39-51 SpaceIntentJson` 加 `seedGoalTitles? / seedConcernTitles?` 两个 optional 字段；旧字段标 deprecated 但保留 | 类型先行，后续写入/读取才能编译通过 |
| **S2.2 写入双写** | `bootstrap/workMapWriter.ts:253-269` 调 `syncSpaceIntentFromWorkMap` 时双写新旧键 | 兼容性好，6 个月后下线旧键 |
| **S2.3 读取兜底 + ranker prompt** | `spaces/contextSpaceService.ts` 读取处 fallback；`spaces/llmChatAffinityRanker.ts` prompt 措辞改"种子（可能已过时）" | ranker 措辞与 layer 语义对齐 |
| **S3.1 Space detail handler 挂 _layerHint** | `routes/contextSpaces.ts:53-83` 给现有 `commitments / goals / risks / state / recentEvents` 五组每条 ContextUnit 挂 `_layerHint`；**字段名不变** | 前端按 `_layerHint.source` 做视觉区分 |
| **S3.2 前端 Work Map UI 拆分** | `apps/web/src/components/WorkMapPanel.tsx` | 顶部 "我是谁" tab + 下半 "项目种子" tab；"当前进展" tab 内容来自 Space detail；feature flag `MVP21_WORK_MAP_SPLIT_UI=true` |
| **S4.1 写入路径分流** | `bootstrap/workMapWriter.ts` 移除 `projects[].upcomingDeadlines / risks` 的 `kind=commitment / uncertainty` 写入分支；保留 `goals` 的 `kind=goal` 写入 | 新提交 Work Map 不再产生 work_map seed 的 commitment / uncertainty |
| **S4.2 兼容已有 unit** | 一次性 migration script `apps/server/scripts/mvp21-archive-work-map-dynamic-units.ts`，可选执行 | 给历史 work_map:commitment:* / work_map:risk:* 标 `status='archived'`（不删，可恢复）；默认不跑，用户在 admin 触发 |
| **S5.1 目录重组** | `apps/server/src/bootstrap/` + `apps/server/src/spaces/` → `apps/server/src/structure/{asserted, inferred, routing, derived}` | 纯 import 路径调整 |
| **S5.2 inducer 注册表** | `apps/server/src/structure/inducerRegistry.ts`（新建，约 50 行） | 仅注册 `{name, layer, triggerKind, lastRunAt}` 元数据；不强加 TTL/落表 |

### 2.2 不在范围（推后或不做）

| 项 | 原因 |
|---|---|
| 把 `kind=goal/commitment/uncertainty` 拆成独立的 `identity_facts` / `dynamic_signals` 表 | 现有 schema 用 `mergeKey` 前缀和分类函数足够区分；拆表会破坏 `agentContextAssembler` 主流程；MVP22+ 再讨论 |
| 删 Work Map 的 `kind=relationship / preference / state` 写入 | 这部分**就是身份层**，不该删；S4 只动 commitment / uncertainty |
| 给 `context_space_links / entity_edges` 加 `source_authority` 列 | 信息可从 `reason_json`（已有列）解析得到；新增列收益不大 |
| 统一所有 inducer 的 TTL 配置 | graphInducer throttled-cache、suggestionWorker cooldown、selfRoleOnUnit on-read 三种生命周期不应被强加统一抽象 |
| Work Map UI 显示 attention 历史 / 调权曲线 | UI 范围，等 S3 上线后看用户需求 |
| 把 `attention_items.signal_ids_json` 也按 layer 切分 | 现有 LLM 已经能区分；S1 后 prompt 加 hint 即可 |
| boundary_rules 加 layer 条件 | 边界规则本身就是 identity_fact 层；不需要再分 |

---

## 3. 数据模型

### 3.1 `ContextLayer` 类型与 `classifyContextUnit` 谓词

```typescript
// apps/server/src/context/layerClassifier.ts

export type ContextLayer =
  | 'identity_fact'      // 用户身份 / 角色 / 关系 / 长期偏好。半年级稳定。
  | 'project_intent'     // 项目元信息 / 长期目标 / 权威文档。季度级稳定。
  | 'dynamic_signal'     // 当下事件 / 临期 commitment / 当前 uncertainty / action_result。周级流动。
  | 'pending_inference'  // 系统推断、待用户确权（suggestion 等）。审核状态决定生命周期。
  | 'derived_signal'     // 系统从其它 layer 算出来的派生关联（entity_edges 边、selfRoleOnUnit、cooccurrence）。可重算。
  | 'output';            // LLM 出的最终结果（attention_item / agent_run.output）。TTL 24h–7d。

export type ContextSource =
  | 'work_map_seed'    // workMapWriter 写入，mergeHint 以 'work_map:' 开头
  | 'triage'           // triage enrichment 写入 (origin.kind='event'，但 unit.kind 不是 'event')
  | 'collector'        // collector 直写的最小 event unit (origin.kind='event' AND unit.kind='event')
  | 'agent_run'        // agent handler 写入 (origin.kind='agent_run')
  | 'card_action'      // 卡片动作触发的写入 (origin.kind='card_action'，larkTaskService / actionItems 等)
  | 'manual'           // 用户在 UI 上手动创建 (origin.kind='manual' 或 'chat')
  | 'system_feedback'  // 非 work_map 的 system 路径，例：workMapMutator 写的 attention_feedback (origin.kind='system' 且 mergeHint 不以 work_map: 开头)
  | 'inducer'          // 后台 inducer 写入（如有）
  | 'unknown';         // 兜底，不应在生产环境出现

export type ContextLayerHint = {
  layer: ContextLayer;
  source: ContextSource;
  /** 用户/权威系统直接断言；false = 系统推断 */
  asserted: boolean;
  /** 用户在 UI 上能直接改写；false = 系统派生或锁定 */
  voluntary: boolean;
};
```

### 3.2 ContextUnit 分类规则

```typescript
export function classifyContextUnit(u: ContextUnit): ContextLayerHint {
  const mk = u.mergeKey ?? '';
  const origin = u.origin.kind;

  // ---- 1) work_map:* mergeKey 前缀：按身份 vs 项目意图 vs 动态种子细分 ----
  // (MVP7 起 work_map:* 前缀的 mergeHint 直接当 mergeKey 存库，见 contextStore.ts:163-175)
  if (mk.startsWith('work_map:')) {
    if (mk.startsWith('work_map:role:')           ||
        mk.startsWith('work_map:responsibility:') ||
        mk.startsWith('work_map:relationship:')   ||
        mk.startsWith('work_map:preference:')) {
      return { layer: 'identity_fact', source: 'work_map_seed', asserted: true, voluntary: true };
    }
    if (mk.startsWith('work_map:goal:')) {
      return { layer: 'project_intent', source: 'work_map_seed', asserted: true, voluntary: true };
    }
    if (mk.startsWith('work_map:commitment:') || mk.startsWith('work_map:risk:')) {
      // 流速是 dynamic，但 source='work_map_seed' + asserted=true 让消费方区分
      return { layer: 'dynamic_signal', source: 'work_map_seed', asserted: true, voluntary: true };
    }
    // 未知 work_map:* 子前缀（防 schema 漂移）：当 identity_fact 兜底，最不破坏
    return { layer: 'identity_fact', source: 'work_map_seed', asserted: true, voluntary: true };
  }

  // ---- 2) 非 work_map：按 origin.kind 路由 ----
  // origin.kind 实际取值：'event' | 'chat' | 'card_action' | 'agent_run' | 'manual' | 'system'
  switch (origin) {
    case 'event':
      // collector 直写最小 event unit (kind='event') vs triage enrichment 写的语义 unit (kind!='event')
      // 见 contextStore.insertMinimalEventContextUnit + triageQueue.ts:230
      if (u.kind === 'event') {
        return { layer: 'dynamic_signal', source: 'collector', asserted: false, voluntary: false };
      }
      return { layer: 'dynamic_signal', source: 'triage', asserted: false, voluntary: false };

    case 'agent_run':
      // caringAgent / cards/contextProjection 等写入
      return { layer: 'dynamic_signal', source: 'agent_run', asserted: false, voluntary: false };

    case 'card_action':
      // larkTaskService / actionItems 路径：用户点了卡片按钮触发写入，本质是用户断言
      return { layer: 'dynamic_signal', source: 'card_action', asserted: true, voluntary: true };

    case 'manual':
    case 'chat':
      // manualEvent 或聊天上下文中的写入。preference/relationship 视作身份层
      if (u.kind === 'preference' || u.kind === 'relationship') {
        return { layer: 'identity_fact', source: 'manual', asserted: true, voluntary: true };
      }
      return { layer: 'dynamic_signal', source: 'manual', asserted: true, voluntary: true };

    case 'system':
      // 这里能进来意味着 mergeHint 不是 'work_map:' 开头但 origin.kind='system'。
      // 已知场景：workMapMutator 写 origin.kind='system' + refId='attention_feedback' (见 workMapMutator.ts:42)
      return { layer: 'dynamic_signal', source: 'system_feedback', asserted: true, voluntary: false };

    default:
      // ContextOriginKind 未来扩枚举的兜底
      return { layer: 'dynamic_signal', source: 'unknown', asserted: false, voluntary: false };
  }
}
```

**关键设计决定**：

1. **`work_map:commitment:* / work_map:risk:*` 的 layer 仍然是 `dynamic_signal` 而非 `identity_fact`**——因为它们的语义就是动态的，跟 triage 出来的 commitment 同等。**唯一不同是 `source='work_map_seed' + asserted=true`**——这让消费方可以决定"是看作用户主动的当前事实，还是看作过期种子"。
2. **没有 `'unknown'` layer**——`null` 不允许返回，永远给一个最佳猜测的 layer，把决定权留给消费方。
3. **`source` 是写入路径，`asserted` 是是否用户/权威断言**——两者正交。例如 `personAttributes` 是飞书系统断言的（asserted=true）但 source='inducer'。

### 3.3 Space.intent_json 字段映射

```typescript
export type SpaceFieldLayer =
  | { layer: 'project_intent'; voluntary: true }     // summary / aliases / authoritativeDocNames / seedGoalTitles
  | { layer: 'project_intent'; voluntary: false }    // keywords (extractKeywords 自动算)
  | { layer: 'derived_signal'; voluntary: false };   // 未来 inducer 写入字段

export function classifySpaceField(field: string): SpaceFieldLayer {
  switch (field) {
    case 'summary':
    case 'aliases':
    case 'authoritativeDocNames':
    case 'seedGoalTitles':
    case 'seedConcernTitles':
      return { layer: 'project_intent', voluntary: true };
    case 'keywords':
      return { layer: 'project_intent', voluntary: false };
    default:
      return { layer: 'derived_signal', voluntary: false };
  }
}
```

### 3.4 类型扩展（packet 字段）

[agentContextAssembler.ts:745](../apps/server/src/context/agentContextAssembler.ts) 现有：

```typescript
export type CommitmentInPacket = ContextUnit & { selfRoleOnUnit: SelfRoleOnUnit | null };
// goals / uncertainties 目前没有独立类型，在 GlobalContextPacket 中直接是 ContextUnit[]
// (agentContextAssembler.ts:749-770 GlobalContextPacket 定义)
```

S1 改成（**类型抽取也是 S1 的一部分工作**）：

```typescript
export type CommitmentInPacket = ContextUnit & {
  selfRoleOnUnit: SelfRoleOnUnit | null;
  _layerHint: ContextLayerHint;  // 新增；以 _ 前缀表示派生字段，不持久化
};

// 新建（之前是裸 ContextUnit[]）
export type GoalInPacket = ContextUnit & { _layerHint: ContextLayerHint };
export type UncertaintyInPacket = ContextUnit & { _layerHint: ContextLayerHint };

// GlobalContextPacket.goals / .uncertainties 字段类型同步从 ContextUnit[] 改为
// GoalInPacket[] / UncertaintyInPacket[]
```

`_layerHint` 不进 DB，只在 packet 装配时即时算（O(n) where n = packet 内 unit 数 ≈ 50-100）。

---

## 4. 阶段 1：语义标签（首刀，零行为变化）

### 4.1 装配层注入

[agentContextAssembler.ts:816-854](../apps/server/src/context/agentContextAssembler.ts) 三处分桶 map 之后，每条挂 `_layerHint`：

```typescript
// ===== commitments：现有 selfRoleOnUnit 之外，再挂 _layerHint =====
const commitmentsRaw = allActive
  .filter((u) => u.kind === 'commitment')
  .map((u) => ({ u, s: scoreContextUnit(u, now) }))
  .sort((a, b) => b.s - a.s)
  .slice(0, GLOBAL_SLICE_CAPS.commitments)
  .map((x) => x.u);

const selfRoles = computeSelfRolesOnUnits(
  commitmentsRaw.map((u) => u.id),
  selfCanonicalForRoles
);
const commitments: CommitmentInPacket[] = commitmentsRaw.map((u) => ({
  ...u,
  selfRoleOnUnit: selfRoles.get(u.id) ?? null,
  _layerHint: classifyContextUnit(u),       // ★ S1 新增
}));

// ===== goals：原本是 ContextUnit[]，S1 后是 GoalInPacket[] =====
const goals: GoalInPacket[] = allActive
  .filter((u) => u.kind === 'goal')
  .map((u) => ({ u, s: scoreContextUnit(u, now) }))
  .sort((a, b) => b.s - a.s)
  .slice(0, GLOBAL_SLICE_CAPS.goals)
  .map((x) => ({ ...x.u, _layerHint: classifyContextUnit(x.u) }));

// ===== uncertainties：同 goals =====
const uncertainties: UncertaintyInPacket[] = allActive
  .filter((u) => u.kind === 'uncertainty')
  .map((u) => ({ u, s: scoreContextUnit(u, now) }))
  .sort((a, b) => b.s - a.s)
  .slice(0, GLOBAL_SLICE_CAPS.uncertainties)
  .map((x) => ({ ...x.u, _layerHint: classifyContextUnit(x.u) }));
```

**严格不动**：`filter / sort / slice / GLOBAL_SLICE_CAPS`（agentContextAssembler.ts:772-788 模块顶部常量）一律不改。`recentEvents / topActive / stakeholders` 等其他 slice **暂不**挂 `_layerHint`——先看 commitments/goals/uncertainties 的效果，再决定要不要全量铺开。`assembleAgentContextPacket`（agent-级别的 slice 装配）走另外一条路径，本阶段也不动。

### 4.2 attention prompt 暴露

[attentionPrompt.ts:312-337 renderUnitOneLine](../apps/server/src/attention/attentionPrompt.ts) 现在的签名只接收 `ContextUnit & { selfRoleOnUnit?: ... }`，**不含 source 信息**。S1 必须**先扩签名**：

```typescript
// 旧
function renderUnitOneLine(u: ContextUnit & { selfRoleOnUnit?: SelfRoleOnUnit | null }): string

// S1 新
function renderUnitOneLine(
  u: ContextUnit & {
    selfRoleOnUnit?: SelfRoleOnUnit | null;
    _layerHint?: ContextLayerHint;   // 新增，optional 是为兼容其它 slice（暂未挂 hint 的）调用
  }
): string
```

签名扩好后，行尾追加 inline 标签：

```
- [c-cad8d3c4] Base UX Image 文案 2 条 [type=commitment] [role=requester] [src=work_map_seed]
                                                          ^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^
                                                          MVP20 已有       MVP21 新增
```

**渲染规则**（与 MVP20 `[role=...]` 一致）：

- `[src=work_map_seed]` ：`_layerHint.source === 'work_map_seed'`
- `[src=triage]` ：`'triage'`
- `[src=collector]` ：`'collector'`
- `[src=manual]` ：`'manual'`
- `[src=card_action]` ：`'card_action'`
- `[src=agent_run]` ：`'agent_run'`
- `[src=system_feedback]` ：`'system_feedback'`
- `_layerHint` 缺失 / `source === 'unknown'` / `source === 'inducer'`：**不输出** `[src=...]` 标签

**§3 加铁律 15（提前定稿，本阶段就上）**：

```
15. （MVP21）<commitments> / <goals> / <uncertainties> 行尾可能带 [src=...] 标签：
    a) src=work_map_seed —— 用户在 Bootstrap / Work Map 上主动登记的种子信息。
       视为"用户曾经认为重要的关注点"，**不**视为"当前一定还成立的事实"。
       若同 entities / 同标题在 <recentEvents> 或其它 src=triage 信号里有近期更新，
       priority 以 triage 那条为准；若只有 src=work_map_seed、没有近期事件支撑，
       priority 上限 P2，title/why 措辞用"你之前登记的 X 是否还重要"类提问句，
       不要写"X 该交了"。
    b) src=triage —— 系统从近期事件中抽出来的语义 unit。原有 priority 判断不变。
    c) src=collector —— 原始事件直写，未经富化；通常出现在 <recentEvents>，
       不应单独产出 attention item（按现有规则）。
    d) src=manual / src=agent_run —— 用户或 agent 显式写入，按内容本身判断。
    e) 缺 [src=...] 标签 = 装配未注入或未知来源，按内容判断，不作来源加权。
```

### 4.3 ContextPanel 显示

`/api/context/units` / `/api/context/units/:id` 返回每条 unit 时附带 `_layerHint`（pure JSON 序列化分类函数的输出）。前端 ContextPanel 给每行加一个 layer chip：

```
[identity_fact] [work_map_seed] · "我负责 Chatbot 产研协同"
[dynamic_signal] [work_map_seed] · "Base UX 文案 2 条 (DDL 05/28)"
[dynamic_signal] [triage]        · "Base UX 文案 2 条 (DDL 05/28)" ← 同主题，看双写情况
```

用户能立刻看到 work_map seed 与 triage 信号之间的双写实例数量，给 S4 决策提供 ground truth。

### 4.4 单测（PR1 必备）

`makeUnit` 是测试 helper，构造 `ContextUnit`（注意：`origin` 是嵌套对象 `{ kind: ContextOriginKind; refId: string }`，不是顶层 `originKind` 字段，见 [ContextUnit.ts:72-96](../apps/server/src/context/ContextUnit.ts)）：

```typescript
// apps/server/test/layer-classifier.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextUnit, ContextOriginKind, ContextUnitKind } from '../src/context/ContextUnit.js';
import { classifyContextUnit } from '../src/context/layerClassifier.js';

function makeUnit(p: {
  kind: ContextUnitKind;
  mergeKey?: string;
  origin: { kind: ContextOriginKind; refId: string };
}): ContextUnit {
  const now = new Date().toISOString();
  return {
    id: 'u-test', subjectId: 'me', scope: 'work',
    origin: p.origin, kind: p.kind, title: 't', content: 'c',
    entities: [], actionability: 'record', confidence: 0.7,
    mergeKey: p.mergeKey, version: 1, status: 'active',
    createdAt: now, updatedAt: now,
  };
}

test('work_map:role:self → identity_fact + work_map_seed', () => {
  const u = makeUnit({
    kind: 'state',
    mergeKey: 'work_map:role:self',
    origin: { kind: 'system', refId: 'work_map' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.layer, 'identity_fact');
  assert.equal(h.source, 'work_map_seed');
  assert.equal(h.asserted, true);
  assert.equal(h.voluntary, true);
});

test('work_map:goal:* → project_intent', () => {
  const u = makeUnit({
    kind: 'goal',
    mergeKey: 'work_map:goal:chatbot:q3-ramp',
    origin: { kind: 'system', refId: 'work_map' },
  });
  assert.equal(classifyContextUnit(u).layer, 'project_intent');
});

test('work_map:commitment:* → dynamic_signal + source=work_map_seed', () => {
  const u = makeUnit({
    kind: 'commitment',
    mergeKey: 'work_map:commitment:base-ux:image-2',
    origin: { kind: 'system', refId: 'work_map' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.layer, 'dynamic_signal');
  assert.equal(h.source, 'work_map_seed');
});

test('triage 写的 commitment (sha1 mergeKey, origin.kind=event) → source=triage', () => {
  const u = makeUnit({
    kind: 'commitment',
    mergeKey: 'a1b2c3d4',
    origin: { kind: 'event', refId: 'ev-123' },
  });
  assert.equal(classifyContextUnit(u).source, 'triage');
});

test('collector 直写最小 event unit → source=collector', () => {
  const u = makeUnit({
    kind: 'event',
    mergeKey: 'event:abc-123',
    origin: { kind: 'event', refId: 'ev-123' },
  });
  assert.equal(classifyContextUnit(u).source, 'collector');
});

test('agent_run 写的 unit → source=agent_run', () => {
  const u = makeUnit({
    kind: 'action_result',
    origin: { kind: 'agent_run', refId: 'run-9' },
  });
  assert.equal(classifyContextUnit(u).source, 'agent_run');
});

test('card_action 写的 unit → source=card_action', () => {
  const u = makeUnit({
    kind: 'commitment',
    origin: { kind: 'card_action', refId: 'card-7' },
  });
  assert.equal(classifyContextUnit(u).source, 'card_action');
});

test('manual 路径写的 preference → identity_fact', () => {
  const u = makeUnit({
    kind: 'preference',
    origin: { kind: 'manual', refId: 'ui' },
  });
  assert.equal(classifyContextUnit(u).layer, 'identity_fact');
});

test('非 work_map 的 origin.kind=system → source=system_feedback', () => {
  // 例：workMapMutator 写 attention_feedback (workMapMutator.ts:42)
  const u = makeUnit({
    kind: 'state',
    origin: { kind: 'system', refId: 'attention_feedback' },
  });
  assert.equal(classifyContextUnit(u).source, 'system_feedback');
});

test('未知 work_map:* 子前缀 → identity_fact 兜底', () => {
  const u = makeUnit({
    kind: 'state',
    mergeKey: 'work_map:newkind:foo',
    origin: { kind: 'system', refId: 'work_map' },
  });
  assert.equal(classifyContextUnit(u).layer, 'identity_fact');
});
```

### 4.5 S1 验收

- [ ] `classifyContextUnit` 单测全绿，分支覆盖 ≥ 90%
- [ ] 跑一次 attention tick，`agentContextAssembler` 输出的 packet 中 commitments/goals/uncertainties 每条都有 `_layerHint`
- [ ] attention prompt 实际输出包含 `[src=...]` 标签（grep 一轮 `attention_engine_runs.output_text`）
- [ ] ContextPanel 显示 layer / source chip
- [ ] **不动现有 attention `commitments[]/goals[]/uncertainties[]` 的过滤、排序、上限**
- [ ] **零 schema 改动**

### 4.6 S1 上线后的观察期（建议 2 周）

在 `attention_engine_runs.output_text` 上跑统计：

- LLM 在 `why` 字段中实际引用 `src=work_map_seed` 的频率
- 同 entities + 同标题在 work_map_seed 与 triage 两个来源都出现的"双写" unit 数量
- Work Map seed commitment / uncertainty 距离最近一次 confirm 的中位天龄

这三组数据决定 S4 是否值得做、什么时候做。

---

## 5. 阶段 2：Space.intent_json 字段重命名

### 5.1 类型字段定义（先做）

[contextSpaceService.ts:39-51 `SpaceIntentJson`](../apps/server/src/spaces/contextSpaceService.ts) 当前只有 `workMapGoalTitles?: string[]; workMapRiskTitles?: string[]`。S2 先在类型上新增（旧字段保留作为 deprecated）：

```typescript
export type SpaceIntentJson = {
  schemaVersion: 1;
  summary?: string;
  aliases?: string[];
  keywords?: string[];
  authoritativeDocNames?: string[];

  // ★ S2 新增
  seedGoalTitles?: string[];
  seedConcernTitles?: string[];

  // @deprecated S2 起改用 seedGoalTitles / seedConcernTitles；写时双写，读时新键优先
  workMapGoalTitles?: string[];
  workMapRiskTitles?: string[];

  // 其余字段保持
  updatedBy?: 'user' | 'work_map_writer' | 'system';
  updatedAt?: string;
};
```

### 5.2 写入分支双写

[workMapWriter.ts:253-269](../apps/server/src/bootstrap/workMapWriter.ts) 调 `syncSpaceIntentFromWorkMap` 时同时写两套键：

```typescript
syncSpaceIntentFromWorkMap(
  space.id,
  {
    summary,
    aliases: [p.name],
    keywords,
    // 新键
    seedGoalTitles: p.goals.filter((g) => g.trim()),
    seedConcernTitles: p.risks.filter((g) => g.trim()),
    // 旧键 ─ 兼容到 6 个月后下线
    workMapGoalTitles: p.goals.filter((g) => g.trim()),
    workMapRiskTitles: p.risks.filter((g) => g.trim()),
    authoritativeDocNames: p.authoritativeDocs.filter((u) => u.trim()),
  },
  { source: 'work_map_writer', projectName: name, origin: 'work_map', updatedAt: nowIso },
);
```

### 5.3 读取兜底

[contextSpaceService.ts](../apps/server/src/spaces/contextSpaceService.ts) 周边读 `intent_json` 的地方一律改成 "优先读新键，找不到 fallback 老键"：

```typescript
const goalTitles = intent.seedGoalTitles ?? intent.workMapGoalTitles ?? [];
const concernTitles = intent.seedConcernTitles ?? intent.workMapRiskTitles ?? [];
```

`encodeSpaceIntent / decodeSpaceIntent` 不动——它们只做 JSON 序列化，对新增 optional 字段天然兼容。

### 5.4 ranker prompt 措辞

[llmChatAffinityRanker.ts](../apps/server/src/spaces/llmChatAffinityRanker.ts) 把"项目目标 / 关注点"段措辞改：

```
旧：该项目的目标：{workMapGoalTitles}；风险：{workMapRiskTitles}
新：用户在 Work Map 登记的项目种子目标（可能已过时）：{seedGoalTitles}；
    登记的关注点：{seedConcernTitles}。请结合近期实际 unit 判断是否仍成立。
```

### 5.5 S2 验收

- [ ] 已有 `Space.intent_json` 行被读时新旧键都能解析
- [ ] 新 Work Map confirm 同时写两套键
- [ ] ranker run 输入摘要里不再出现 `workMapGoalTitles` 的占位
- [ ] 至少一个 ranker run 跑通，结果 ≈ S2 前

---

## 6. 阶段 3：Work Map UI 拆分（Identity / Project Intent / Current Focus）

### 6.1 三屏结构

```
WorkMapPanel
├── tab "我是谁"        ← 写 identity_fact 层（roleTitle / responsibilities / stakeholders / preferences / boundaries）
├── tab "项目种子"      ← 写 project_intent 层（projects[].name / description / goals / authoritativeDocs）
└── tab "当前进展"      ← 只读，从 GET /api/context-spaces/:id 现查 commitments / risks / goals 三组数组（按 _layerHint.source 视觉区分）
```

### 6.2 Space detail 接口扩展

[routes/contextSpaces.ts:53-83](../apps/server/src/routes/contextSpaces.ts) 已有 detail handler，**目前返回结构**（按 unit.kind 分桶）：

```typescript
GET /api/context-spaces/:id
→ {
    space, entityLinks,
    commitments: ContextUnit[],   // kind='commitment'
    goals: ContextUnit[],         // kind='goal' + kind='intent'
    decisions: DecisionRow[],
    risks: ContextUnit[],         // kind='uncertainty' + kind='constraint'
    state: ContextUnit[],
    recentEvents: ContextUnit[],
    allUnitCount: number,
  }
```

S3 **不新造字段名**——保留现有 `commitments / goals / risks`，**只给每条 ContextUnit 挂上 `_layerHint` 字段**（同 S1 packet 装配模式）。修改 handler ≈ 5 行：

```typescript
const attachHint = <T extends ContextUnit>(u: T) => ({ ...u, _layerHint: classifyContextUnit(u) });

res.json({
  space: detail.space,
  entityLinks,
  commitments: (byKind.get('commitment') ?? []).map(attachHint),
  goals: [...(byKind.get('goal') ?? []), ...(byKind.get('intent') ?? [])].map(attachHint),
  decisions: listDecisionsBySpace(detail.space.id),
  risks: [...(byKind.get('uncertainty') ?? []), ...(byKind.get('constraint') ?? [])].map(attachHint),
  state: (byKind.get('state') ?? []).map(attachHint),
  recentEvents: (byKind.get('event') ?? []).slice(0, 10).map(attachHint),
  allUnitCount: units.length,
});
```

前端"当前进展"tab 拿到这三组数组后，根据每条 `_layerHint.source` 在视觉上区分"用户登记 (work_map_seed)"vs"系统抓的 (triage)"——例如左侧加 icon、灰色 vs 主色调。

### 6.3 Feature flag

```
MVP21_WORK_MAP_SPLIT_UI=true   # 启用三屏 UI
默认 false                       # 老 UI 保留作为兜底
```

### 6.4 写入路径保持不动

S3 阶段**前端 UI 改了，但 POST 体仍然是老的 `WorkMapDraft`**——`projects[].upcomingDeadlines / risks` 字段如果用户在"项目种子"tab 留空就传空数组（等价于不写）。S4 才真正删 writer 的分支。

### 6.5 S3 验收

- [ ] flag on 时三 tab 渲染正确
- [ ] flag off 时保留老 UI
- [ ] "当前进展" tab 显示 source=triage 与 source=work_map_seed 的 unit 时有视觉区分
- [ ] 写入路径未变，老 e2e 全绿

---

## 7. 阶段 4：写入路径分流（实质行为变化）

### 7.1 前置条件（hard gate）

S4 不能在 S1 之前上。S4 上线前必须：

1. S1 telemetry 跑满 **≥ 14 天**
2. 统计显示"work_map_seed 的 commitment / uncertainty 在 attention 输出中被 LLM 引用为 P0/P1 的频率 < 20%"——即 LLM 已经基本不靠它们做高优判断
3. S3 已上线、`MVP21_WORK_MAP_SPLIT_UI` 默认开启

如果 (2) 不成立，说明 work_map_seed 是 attention 主食的一部分，S4 改写会让 attention 失血，必须先补别的数据源（例如让 caringAgent 主动生成 "你登记的 X 是否还重要" 提问）。

### 7.2 改动

[workMapWriter.ts](../apps/server/src/bootstrap/workMapWriter.ts) 删除两段：

```typescript
// ← 删除
for (const c of p.upcomingDeadlines) {
  upsertContextUnit({
    kind: 'commitment',
    ...,
    mergeHint: `work_map:commitment:${slug(name)}:${slug(c.title)}`,
  });
}

// ← 删除
for (const r of p.risks) {
  upsertContextUnit({
    kind: 'uncertainty',
    ...,
    mergeHint: `work_map:risk:${slug(name)}:${slug(r)}`,
  });
}
```

**保留**：

- `kind=state`（role / responsibility）
- `kind=relationship`（stakeholders）
- `kind=preference`
- `kind=goal`（projects[].goals）—— **长期 intent，保留**
- `Space.intent_json` 的写入（含 `seedConcernTitles`）—— **保留为种子文案，给 ranker 用，但不再制造 ContextUnit**

### 7.3 老数据归档

```bash
# 默认不跑；admin 手工触发
$ tsx apps/server/scripts/mvp21-archive-work-map-dynamic-units.ts --dry-run
$ tsx apps/server/scripts/mvp21-archive-work-map-dynamic-units.ts --confirm
```

脚本逻辑：

```typescript
UPDATE context_units
   SET status = 'archived', updated_at = ?
 WHERE merge_key LIKE 'work_map:commitment:%' OR merge_key LIKE 'work_map:risk:%'
   AND status = 'active';
```

不删行（留作回溯审计）。

### 7.4 回滚

S4 是 **唯一会产生 attention 输入分布变化** 的阶段，回滚需要：

1. revert PR
2. 跑反向 script：把 `status='archived'` 且 `merge_key LIKE 'work_map:%'` 的 unit 翻回 `'active'`

### 7.5 S4 验收

- [ ] 新提交 Work Map 不再产生 `kind=commitment / uncertainty (mergeHint=work_map:*)` unit
- [ ] `kind=goal (mergeHint=work_map:goal:*)` 仍然被写入
- [ ] `Space.intent_json.seedConcernTitles` 仍然被写入
- [ ] attention `commitments[]` / `uncertainties[]` 数组大小在 7 天滑动均值下变化 ≤ 30%（说明 triage 这条主路径足以填充）
- [ ] 没有用户在"我登记的事消失了"上做出反馈

---

## 8. 阶段 5：目录与 inducer 注册表

### 8.1 目录重组（机械重构）

```
apps/server/src/bootstrap/  → apps/server/src/structure/asserted/
apps/server/src/spaces/     → 拆三处：
  spaces/contextSpaceService.ts        → structure/asserted/spaceService.ts
  spaces/suggestionWorker.ts           → structure/inferred/suggestionWorker.ts
  spaces/llmChatAffinityRanker.ts      → structure/inferred/affinityRanker.ts
  spaces/keywordExtractor.ts           → structure/inferred/keywordExtractor.ts
  spaces/divergenceDetector.ts         → structure/derived/divergenceDetector.ts
  spaces/suggestionCalibration.ts      → structure/inferred/calibration.ts
  spaces/chatAffinityQueries.ts        → structure/inferred/queries.ts
  spaces/chatAffinityEvidence.ts       → structure/inferred/evidence.ts
```

`context/` 下涉及结构推断的也归位：

```
context/graphInducer.ts                → structure/derived/graphInducer.ts
context/personPersonInducer.ts         → structure/derived/personPersonInducer.ts
context/personProjectInducer.ts        → structure/derived/personProjectInducer.ts
context/workItemInducer.ts             → structure/derived/workItemInducer.ts
context/projectUnitsResolver.ts        → structure/routing/projectUnitsResolver.ts
context/cooccurrenceService.ts         → structure/derived/cooccurrenceService.ts
context/selfCollaboratorRanking.ts     → structure/derived/selfCollaboratorRanking.ts
```

`context/` 仅保留：`ContextUnit.ts / contextStore.ts / activeContext.ts / agentContextAssembler.ts / changeContext.ts / entityResolver.ts / layerClassifier.ts / personAttributes.ts / personOrgRole.ts / semanticTags.ts / selfRoleOnUnit.ts / graphContextAssembler.ts`——这些是 ContextUnit 主流操作 + 派生函数（即 layer = identity_fact / dynamic_signal / output 主域）。

### 8.2 inducer 注册表

```typescript
// apps/server/src/structure/inducerRegistry.ts (约 50 行)
export type InducerLayer = 'derived_signal' | 'pending_inference';
export type InducerTrigger = 'on_unit_upsert' | 'tick' | 'manual';

export type InducerInfo = {
  name: string;
  layer: InducerLayer;
  trigger: InducerTrigger;
  lastRunAt?: string;
  lastDurationMs?: number;
  lastError?: string;
};

const registry = new Map<string, InducerInfo>();

export function registerInducer(name: string, layer: InducerLayer, trigger: InducerTrigger): void {
  registry.set(name, { name, layer, trigger });
}

export function reportInducerRun(name: string, durationMs: number, error?: string): void {
  const info = registry.get(name);
  if (!info) return;
  info.lastRunAt = new Date().toISOString();
  info.lastDurationMs = durationMs;
  info.lastError = error;
}

export function listInducers(): InducerInfo[] { return Array.from(registry.values()); }
```

**注意**：注册表**不强制管理调度**——每个 inducer 仍然自己定 throttle、cache、cooldown 策略。注册表只做**事后观测**（"我什么时候跑过"），暴露给 `/api/debug/inducers` 给前端 RulesPanel 旁边新加的 "Structure Health" 小面板用。

### 8.3 inducer 们的注册（仅 import-time 副作用）

```typescript
// structure/derived/graphInducer.ts 顶部
registerInducer('graph_inducer', 'derived_signal', 'tick');

// structure/inferred/suggestionWorker.ts 顶部
registerInducer('space_suggestion_worker', 'pending_inference', 'tick');

// structure/derived/cooccurrenceService.ts 顶部
registerInducer('cooccurrence', 'derived_signal', 'on_unit_upsert');
```

### 8.4 S5 验收

- [ ] 全量编译通过，无 import 路径残留
- [ ] 全部 smoke 测试通过
- [ ] `GET /api/debug/inducers` 列出所有注册的 inducer
- [ ] 旧 import 路径在编辑器中被 IDE 标红（即没有 fallback）

---

## 9. 验证与可观测

### 9.1 telemetry 落到哪

| 指标 | 落处 | 用途 |
|---|---|---|
| `attention_items.raw_json` 里 LLM 引用 `[src=...]` 标签的频率 | 现有 attention_items 表 | S4 hard-gate 判定 |
| Work Map seed unit 与 triage unit 在 attention 输出中的重叠率 | 新 view `mvp21_seed_overlap`（仅 dev） | S4 hard-gate 判定 |
| inducer 注册表运行频次与耗时 | in-memory 注册表 + `/api/debug/inducers` | S5 之后持续观察 |

### 9.2 单测覆盖

| 测试文件 | 覆盖 |
|---|---|
| `layer-classifier.test.ts` | classifyContextUnit 全分支 |
| `space-field-layer.test.ts` | classifySpaceField + intent_json 新旧键兼容读取 |
| `assembler-layer-hint.test.ts` | agentContextAssembler 注入 _layerHint 不破坏现有 packet 结构 |
| `attention-src-tag.test.ts` | renderUnitOneLine 输出 `[src=...]` 标签 |
| `work-map-writer-s4.test.ts` | S4 后不再写 commitment/uncertainty；仍写 goal/state/relationship/preference |
| `migration-archive-work-map.test.ts` | archive script 幂等、dry-run、--confirm 分支 |

### 9.3 集成 smoke

- `mvp21-s1-smoke.ts`：端到端跑一次 attention tick，断言 packet 中有 _layerHint、prompt 中有 [src=] 标签
- `mvp21-s4-smoke.ts`：提交一份 Work Map，断言 work_map:commitment:* 不再被写入

---

## 10. 风险与回滚

| 风险 | 触发条件 | 缓解 | 回滚 |
|---|---|---|---|
| **classifier 漏分支** | mergeKey 出现新前缀（例：`work_map:newkind:*`） | classifier 默认兜底走 identity_fact + work_map_seed；不会 throw | 改 classifier 加分支即可 |
| **prompt LLM 误读 [src=] 标签** | 铁律 15 措辞被模型理解偏差 | S1 观察期看输出文案；如果出现错误归因，调铁律措辞 | revert 单 PR |
| **S4 后 attention.commitments[] 突然为空** | hard-gate 没把好关；用户依赖 work_map seed | hard-gate (14 天 + < 20% 引用率) | 跑反向 archive script + revert S4 PR |
| **S5 目录迁移漏改 import** | 文件多、批量 sed 易错 | 用 TS 编译器报错驱动 + grep 'from "../bootstrap"' | git revert |
| **新旧 intent_json 键名混乱** | S2 期间双写，读取兜底逻辑错 | S2 单测覆盖 4 种组合（仅新 / 仅旧 / 同时存在 / 都没有） | revert S2 |

---

## 11. 阶段间依赖关系

```
S1 (语义标签)                  ←── 独立，任何时候上
   │
   ▼ 跑满 ≥14d telemetry
S2 (字段重命名)                ←── 独立，可与 S3 并行
   │
S3 (UI 拆分)                   ←── 依赖 S2 接口字段
   │
   ▼ telemetry 通过 hard-gate
S4 (写入分流)                  ←── 必须在 S1 telemetry 足够 + S3 上线后
   │
   ▼
S5 (目录与注册表)              ←── 任何时候上，建议放最后避免 review diff 过大
```

---

## 12. 文件改动清单（按阶段）

### S1（新增 ~180 行；改 ~70 行）

| 文件 | 改动 |
|---|---|
| `apps/server/src/context/layerClassifier.ts` | 新建（约 90 行） |
| `apps/server/src/context/agentContextAssembler.ts` | 抽出 `GoalInPacket / UncertaintyInPacket` 类型；`GlobalContextPacket.goals / .uncertainties` 字段类型同步改；三处分桶 map 后挂 `_layerHint`（commitments / goals / uncertainties） |
| `apps/server/src/attention/attentionPrompt.ts` | **`renderUnitOneLine` 签名加 `_layerHint?` 参数**；行尾输出 `[src=...]` 标签；§3 加铁律 15；调用 `renderUnitOneLine` 的所有处（commitments / goals / uncertainties 三段渲染）把 `_layerHint` 传进去 |
| `apps/server/src/routes/context.ts` | `/api/context/units(/.../:id)` 响应里每条 unit 补 `_layerHint` 派生字段 |
| `apps/server/src/routes/debug.ts` | （可选）`/api/debug/layer-stats` 给 telemetry 用 |
| `apps/web/src/components/ContextPanel.tsx` | 显示 layer + source chip |
| `apps/web/src/types.ts` | 加 `ContextLayer / ContextSource / ContextLayerHint` 类型 |
| `apps/server/test/layer-classifier.test.ts` | 新建 |
| `apps/server/test/assembler-layer-hint.test.ts` | 新建（断言 packet 中 commitments/goals/uncertainties 每条都有 `_layerHint`） |
| `apps/server/test/attention-src-tag.test.ts` | 新建（断言 prompt 字符串包含 `[src=work_map_seed]` 等） |
| `.opencode/agent/aiisn-attention.md` | 更新 attention agent 描述（如有） |

### S2（改 ~40 行）

| 文件 | 改动 |
|---|---|
| `apps/server/src/spaces/contextSpaceService.ts` | **`SpaceIntentJson` 类型加 `seedGoalTitles? / seedConcernTitles?`**；读取处 fallback "新 ?? 旧 ?? []" |
| `apps/server/src/bootstrap/workMapWriter.ts` | `syncSpaceIntentFromWorkMap` 调用处双写新旧键 |
| `apps/server/src/spaces/llmChatAffinityRanker.ts` | prompt 措辞改 |
| `apps/server/test/space-field-layer.test.ts` | 新建（4 种组合：仅新 / 仅旧 / 都有 / 都无） |

### S3（前端为主）

| 文件 | 改动 |
|---|---|
| `apps/server/src/routes/contextSpaces.ts` | detail handler 给现有 `commitments / goals / risks / state / recentEvents` 五组每条 ContextUnit 挂 `_layerHint`；**字段名不变** |
| `apps/web/src/components/WorkMapPanel.tsx` | 三 tab 结构（"我是谁" / "项目种子" / "当前进展"） |
| `apps/web/src/components/SpacesPanel.tsx` | 补 "当前进展" 子区，按 `_layerHint.source` 区分视觉 |
| `apps/server/.env.example` | 加 `MVP21_WORK_MAP_SPLIT_UI` |

### S4（删 ~40 行 + 新增脚本）

| 文件 | 改动 |
|---|---|
| `apps/server/src/bootstrap/workMapWriter.ts` | 删 `kind=commitment / uncertainty` 写入分支 |
| `apps/server/scripts/mvp21-archive-work-map-dynamic-units.ts` | 新建 |
| `apps/server/test/work-map-writer-s4.test.ts` | 新建 |
| `apps/server/test/migration-archive-work-map.test.ts` | 新建 |

### S5（机械重构）

- 全部 `bootstrap/` 与大部分 `spaces/` 文件移到 `structure/{asserted,inferred,routing,derived}/`
- 新建 `structure/inducerRegistry.ts`
- 6 个 inducer 文件顶部加 `registerInducer(...)` 调用
- `routes/debug.ts` 加 `/api/debug/inducers`
- 全仓 import 路径修复

---

## 13. 关键决定的"为什么"（备查）

| 决定 | 为什么这么定 |
|---|---|
| classifier 是纯函数、不落表 | 不引入新 schema；逻辑可重算；任何时候改分类规则不需迁移数据 |
| layer 与 source 拆成两个轴而非 enum 笛卡尔积 | 拼起来 16 格只用 6 个，enum 难维护；分轴让消费方按需取 |
| `work_map:commitment:*` 归 `dynamic_signal`（不是 `identity_fact`） | 内容流速是 dynamic；只是写入方权威；用 source 区分而非 layer 区分 |
| 不在 DB 加 layer 列 | mergeKey 前缀 + origin 已足够推导；加列会让"重新分类"变成大迁移 |
| 第一刀只动 commitments/goals/uncertainties 的 `_layerHint` | 这三个是 attention prompt 主要消费的；其它 slice 加 hint 收益小 |
| Inducer 注册表不管调度 | 三种生命周期（throttle / cooldown / on-read）差异太大，统一会损失现有优化；只共享观测够用 |
| S4 设 hard-gate 而非时间表 | telemetry 数据决定；若用户实际没用 seed unit，可以提前；若依赖很重，可以推迟 |
| Space.intent_json 新旧键并存 6 个月 | 兼容老库；6 个月足够让所有 active Space 至少经过一次 Work Map confirm 重写 |
| 不删 work_map:relationship / preference / state 的写入 | 这些就是 identity_fact 本体，**不是要解决的问题**；S4 只动 commitment / uncertainty 两个 kind |
