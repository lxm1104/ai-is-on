# MVP15B · Work Map 图语义化与 Attention 接入技术方案

## 0. TL;DR

MVP15A 把图**建起来了**——entity_edges、work_item_edges、SelfCollaboratorRanking 都有数据，前端能看到 MyCollaboratorsPanel。但 **attention engine 看不到这些**，packet 里没有协作圈、没有 graphContext，attention 只能继续靠 Phase A' 的 stakeholders 12 人列表。

MVP15B 把图**变得能用**——三件事：

1. **3 个 LLM 任务给边和项目打语义标签**（top-N 控制 LLM 成本）：
   - `judgeProjectPhase`：~27 个 canonical project 一次性出 `{phase, health}`
   - `inferDecisionAuthority`：top 50 PersonProject 边出 `decisionAuthority` (high/mid/low)
   - `classifyPersonPersonEdges`：top 50 PersonPerson 边出 `collabType` (collab/reviewer_author/cross_team/mentor)
2. **新 packet slice 把图喂给 attention**：
   - `myTopCollaborators` (global view, top 12)
   - `graphContext` (focal-scoped: decisionPath + expectedButMissing + activeBlockers)
3. **attention prompt §13** 加新铁律消费图信号；新增 `commitmentAgent` 接入示范

工时 **5-7 天**。不做：blocks LLM 推断（→ MVP15.5）、specialist agent 全套（每个独立 PR）、反馈通道（→ MVP15B.5）、ProjectProjectEdge（→ MVP15C）、WorkGraphPanel（→ MVP15C）。

---

## 1. 起点：MVP15A 落到 main 之后的现状

### 1.1 MVP15A 交付

| 模块 | 当前数据 |
|---|---|
| `entity_edges` (person_person) | 1102 条 |
| `entity_edges` (person_project) | 27 条（canonical 合并后）|
| `work_item_edges` (follows) | 87 条 |
| `org_project_taxonomy` | 51 entity → ~27 canonical（LLM 解析）|
| `SelfCollaboratorRanking` | 11 人（cooccurrence 4 + work_map 兜底 7）|
| `MyCollaboratorsPanel` | 前端 read-only 展示 |

### 1.2 attention 现在能看到的相关人信号（Phase A'）

```xml
<stakeholders>      <!-- collectStakeholders, cap=12, 来自 work_map:relationship:* -->
- 杨薛莎 [orgRole=same_business_cross_function biz=Lark Base fn=Engineering] -- note...
- 王奕迪 [orgRole=same_business_cross_function biz=Lark Base fn=Engineering] -- note...
...
</stakeholders>
```

外加铁律 §11（external 降一档、cross_dept 倾向 P2、same_business 倾向 P1、peer 不动）+ §12（IM 双向）。

### 1.3 attention 看不到的（MVP15B 要补的）

- **weight 排序**：哪些是高频协作者
- **sharedProjects**：跟我有共同项目的人
- **decisionRoleHint / decisionAuthority**：谁有决策权
- **expectedButMissing**：本该参与但没参与的人/文档
- **activeBlockers**：阻塞我当前 commit 的事
- **project phase / health**：当前项目阶段决定信号的紧迫度（如 frozen 项目降权）
- **collabType**：协作关系类型（评审/合作/跨团队）

---

## 2. 范围

### 2.1 在 MVP15B 范围内

| 模块 | 输出 |
|---|---|
| M1 schema 扩展 | entity_edges 加 4 列 + 新 `org_project_phase` 表 |
| M2 `judgeProjectPhase` LLM | ~27 project 出 phase/health |
| M3 `inferDecisionAuthority` LLM | top 50 ppj 出 decisionAuthority |
| M4 `classifyPersonPersonEdges` LLM | top 50 pp 出 collabType |
| M5 `assembleGraphContext(focalUnitId)` | decisionPath / expectedButMissing / activeBlockers slice |
| M6 packet slices | `myTopCollaborators` (global) + `graphContext` (focal) |
| M7 attention prompt §13 | 4-5 条新铁律消费图信号 |
| M8 `commitmentAgent` 接入示范 | 在 packet input 加 graphContext，prompt 利用 sharedProjects 解释追单原因 |
| M9 vitest + smoke + 文档 | 见 §6 |

### 2.2 不在范围（推后）

| 推迟项 | 推到哪 | 原因 |
|---|---|---|
| WorkItemEdge.blocks LLM 推断 | **MVP15.5**（独立 PR） | 候选 pair 复杂度高（需要扫所有 commitment×uncertainty 对），需要单独设计 prompt 和 batch 策略 |
| `prepareMeetingAgent` / `syncDraftAgent` / `recapActionItemsAgent` 接入 graphContext | **MVP15B.x**（每个独立 PR） | 每个 agent 自己 prompt 需调优，**MVP15B 只接 commitmentAgent 作示范**，模板可复制 |
| 用户反馈通道（错标 override） | **MVP15B.5**（独立 PR） | 反馈机制是独立基建，跟 LLM 任务解耦后可服务多个场景（错标/Phase A.5 manager 误判/未来）|
| ProjectProjectEdge 完整 | **MVP15C** | 项目间关系数据稀疏，先做人图 |
| WorkGraphPanel 双子图可视化 | **MVP15C** | MyCollaboratorsPanel 已经够 dogfood，重 UI 投入推后 |
| `manager_of_me` / `report_of_me` | **Phase A.5** | 等飞书 `contact:user.employee` scope 审批 |

---

## 3. 关键设计决策

| # | 决策 | 替代方案与不选原因 |
|---|---|---|
| D1 | **LLM 调用范围用 top-N 控制**：每类边只 classify top 50 by weight；其余留空，attention 按 default 处理 | 全量 classify：200+ pp × 30s = 100+ min 一次，太贵；top-50 覆盖协作圈核心，~10-15 min |
| D2 | **LLM 结果存 `entity_edges` 新列**（decision_authority / collab_type / llm_classified_at / llm_why） | JSON 一列：查询不方便（"找 decisionAuthority=high 的边"要 json_extract）；分开存简单 |
| D3 | **`org_project_phase` 单独表**（不塞 `org_project_taxonomy`）| 塞同一表：taxonomy 关注命名去重，phase 关注阶段，TTL 不同（taxonomy 永久 / phase 30 天）|
| D4 | **`assembleGraphContext` 是 read model，60s 缓存按 focalUnitId**，不入表 | 入表：每个 focalUnit 一行，量大且短命；read model 计算 ~50ms 可接受 |
| D5 | **`myTopCollaborators` slice 是 global** (top 12)；`graphContext` slice 是 focal-scoped（仅 trigger 含 focal 时填）| 都 global：focal 视角的 expectedButMissing 算不出来；都 focal：global 协作圈视野丢失 |
| D6 | **attention prompt §13 是加（不替换）**：§11(stakeholders) §12(IM 双向) 都保留 | 替换 §11：会破坏 Phase A' 的 orgRole 调权；累加更安全 |
| D7 | **错标暂时手 SQL 修**：MVP15B 不做 UI override（推 MVP15B.5）| 一起做：MVP15B 失焦、反馈 schema 后续可能多次改 |
| D8 | **`commitmentAgent` 是 MVP15B 唯一接图的 specialist agent**，其它 agent 独立 PR | 全套接入：每 agent 自己 prompt 需调优，会卡 dogfood 节奏 |
| D9 | **LLM 错时降级**：解析失败 → 不写、留空、下次重试；写入失败 → 不阻塞 inducer | 错时阻塞：链路脆 |
| D10 | **每次 LLM 任务限制 batch 大小 10-15 条**：MVP15A projectTaxonomy 的经验，30 条 60s 超时 | 30 条：超时频；10-15 条 30-60s 内能完成 |
| D11 | **`commitmentAgent` 是机械文案 agent，非 LLM**：MVP15B 接入是改它的 bodyLines 文案模板 + slices 声明加 'graphContext'，不引入新 LLM 调用 | 写错成"prompt 调优"会让人以为要碰 opencode agent file；这个 agent 没有 .md 文件 |
| D12 | **`graphInducer` 写完 entity_edges 后必须 invalidate `selfCollaboratorRanking._cache`**（pre-existing MVP15A bug）：MVP15B 顺手修 —— inducer 完成后调 `selfCollaboratorRanking.__internal.resetCache()` | 不修：M2-M4 LLM 写新 collab_type / decision_authority 后，前端 panel 60s 内看到的还是没标签的版本 |

---

## 4. 数据模型

### 4.1 `entity_edges` 加 4 列

```ts
ensureColumn('entity_edges', 'decision_authority', 'TEXT');  // 'high'|'mid'|'low'，仅 person_project
ensureColumn('entity_edges', 'collab_type',        'TEXT');  // 'collab'|'reviewer_author'|'cross_team'|'mentor'，仅 person_person
ensureColumn('entity_edges', 'llm_classified_at',  'TEXT');  // ISO timestamp; cache 失效用
ensureColumn('entity_edges', 'llm_why',            'TEXT');  // ≤200 字简释
```

### 4.2 新表 `org_project_phase`

```sql
CREATE TABLE IF NOT EXISTS org_project_phase (
  canonical_name TEXT PRIMARY KEY,
  phase TEXT,                              -- 'discovery'|'planning'|'execution'|'review'|'frozen'
  health TEXT,                             -- 'on_track'|'at_risk'|'overdue'|'unknown'
  health_evidence_unit_ids_json TEXT,      -- JSON 数组：导致 at_risk/overdue 判定的 unit id
  summary TEXT,                            -- LLM 一句话项目状态描述
  llm_classified_at TEXT NOT NULL,
  ttl_until TEXT NOT NULL                  -- 30 天 TTL，过期重判
);
```

helpers：

```ts
export type OrgProjectPhaseRow = { canonical_name, phase, health,
  health_evidence_unit_ids_json, summary, llm_classified_at, ttl_until };

export function getProjectPhase(canonicalName: string): OrgProjectPhaseRow | null;
export function listProjectPhasesNeedingRefresh(now: number): string[];  // 返回 ttl_until < now 的 canonical_name
export function upsertProjectPhase(row: OrgProjectPhaseRow): void;
```

### 4.3 Packet 类型扩展

```ts
// apps/server/src/context/agentContextAssembler.ts

// 全局新增
export type MyTopCollaborator = {
  name: string;
  weight: number;
  orgRole?: OrgRoleFromMe;
  business?: string;
  functionLabel?: string;
  sharedProjectCanonicalNames: string[];
  collabType?: 'collab'|'reviewer_author'|'cross_team'|'mentor';
  decisionRoleHint?: 'co_owner'|'reviewer'|'contributor'|'observer';
};

// focal-scoped 新增
export type GraphContextSlice = {
  focal: { personEntityIds: string[]; projectCanonicalNames: string[] };
  decisionPath: Array<{
    name: string;
    role: 'owner'|'driver'|'reviewer';
    decisionAuthority?: 'high'|'mid'|'low';
    orgRole?: OrgRoleFromMe;
  }>;
  expectedButMissing: {
    persons: Array<{ name: string; reason: string; weight: number }>;
    // docs 留 MVP15C
  };
  activeBlockers: Array<{
    blockerUnitId: string;
    blockerTitle: string;
    blockerOwner?: string;
    reason: string;
  }>;
  projectPhase?: { phase: string; health: string; summary?: string };
};

// GlobalContextPacket 加：
export type GlobalContextPacket = {
  ...existing,
  myTopCollaborators: MyTopCollaborator[];     // cap 12
};

// AgentContextPacket（focal agent run）加可选：
export type AgentContextPacket = {
  ...existing,
  graphContext?: GraphContextSlice;            // 仅 trigger 含 focal 时填
};

// PacketSlice union 扩展（现有 10 个 + 1 个新加）
export type PacketSlice =
  | 'subject' | 'focalUnit' | 'spaces' | 'goals' | 'uncertainties'
  | 'relatedContext' | 'stakeholders' | 'latestActionResult' | 'boundary' | 'missingInfo'
  | 'graphContext';        // ← MVP15B 新加

// SLICE_CAPS 加：
const SLICE_CAPS: Record<PacketSlice, number> = {
  ...existing,
  graphContext: 1,         // 一次 agent run 一个 graphContext slice
};

// GLOBAL_SLICE_CAPS 加：
const GLOBAL_SLICE_CAPS = {
  ...existing,
  myTopCollaborators: 12,  // 跟 stakeholders 一致
};
```

---

## 5. 实施步骤

### M1 · DB schema 扩展（0.5 天）

新增 `apps/server/src/db.ts`：
- `ensureColumn` 给 entity_edges 加 4 列（decision_authority / collab_type / llm_classified_at / llm_why）
- `db.exec` 建 `org_project_phase` 表
- 加 3 个 helpers (`getProjectPhase` / `listProjectPhasesNeedingRefresh(nowIso)` / `upsertProjectPhase`)
- 给已有 `EntityEdgeRow` 类型加 4 个新字段（`decision_authority: string | null`, `collab_type: string | null`, `llm_classified_at: string | null`, `llm_why: string | null`）
- 给已有 `upsertEntityEdge` 的 INSERT/UPDATE 语句加 4 个新列处理

新增 `apps/server/src/context/projectUnitsResolver.ts`（M2 / M5 都要用）：
- `listUnitsForProjectCanonical(canonicalName, opts: {kinds?, limit?}): ContextUnit[]`
- 通过 `org_project_taxonomy.aliases_json` 反向找所有归属此 canonical 的 project entity name
- 再到 `context_entities` 拿 entity id（含 alias 解析）
- 再到 `context_unit_entities` 找含这些 entity 的 unit，按 kind 过滤 + limit

验证：既有 vitest 全过；smoke 创建一条 phase + 读回 + projectUnitsResolver 返回非空。

### M2 · `judgeProjectPhase` LLM + 缓存（1 天）

新 `apps/server/src/util/projectPhaseClassifier.ts` + `.opencode/agent/aiisn-project-phase.md`

```ts
export async function refreshProjectPhasesIfNeeded(opts: {
  now: number;
  llmHook?: (system, user) => Promise<string>;
}): Promise<{ refreshed: number; skipped: number; failed: number }>;
```

逻辑：
1. 拿所有 `org_project_taxonomy` canonical names (~27)
2. 过滤需要刷新的（无记录 / ttl 过期）
3. **每个 project 用新 helper `listUnitsForProjectCanonical(name)` 拉证据**：goals + active commitments (含 dueAt) + 近 14d events，cap 各 5 条避免 prompt 太长
4. **batch ≤10 个 project per LLM call**，**`LLM_TIMEOUT_MS = 180_000`**（继承 MVP15A projectTaxonomy 经验：30 条超时，15 条勉强，10 条保险）
5. LLM 输出 `[{canonicalName, phase, health, healthEvidenceUnitIds, summary}]`
6. upsert `org_project_phase`，ttl_until = now + 30 天

> **新 helper 需求**：`apps/server/src/context/projectUnitsResolver.ts` `listUnitsForProjectCanonical(canonicalName, opts: {kinds?, limit?})` — 通过 `org_project_taxonomy.aliases_json` 反向找所有归属此 canonical 的 project entity → 再 `context_unit_entities` 找含这些 entity 的 unit。一并 alias 解析。

system prompt 主纲：

```
你判断一个项目当前的阶段和健康度。
项目阶段：discovery (调研) / planning (规划) / execution (执行) / review (评审) / frozen (冻结)
项目健康：on_track / at_risk / overdue / unknown
判定规则：
- 多数 active commitment 都临期但未完成 → at_risk
- ≥1 commitment 已逾期 → overdue
- 多数 goal 刚立，无 commitment → planning
- 多个 active commitment 在跑 + 近期 events 频繁 → execution
- 14 天没新 event → 默认 unknown
输出严格 JSON 数组。
```

### M3 · `inferDecisionAuthority` LLM（1.5 天）

新 `apps/server/src/util/decisionAuthorityClassifier.ts` + `.opencode/agent/aiisn-decision-authority.md`

```ts
export async function classifyTopPpjEdges(opts: {
  now: number;
  topN?: number;   // 默认 50
  llmHook?: ...;
}): Promise<{ classified: number; skipped: number; failed: number }>;
```

逻辑：
1. 取 entity_edges where kind='person_project' AND (llm_classified_at IS NULL OR llm_classified_at < now-14d)
2. 按 weight desc 取 top N（默认 50）
3. 每条边拉证据：top 5 evidence unit 的 title + meaning（从 evidence_unit_ids_json 找）
4. **batch 10 条 per LLM call，timeout 180s**（同 M2）
5. LLM 输出 `[{edgeId, decisionAuthority, why}]`
6. 写回 entity_edges.decision_authority + llm_why + llm_classified_at（**部分失败仍写入成功部分**）

system prompt 主纲：

```
你判断某人对某项目的决策权重。
high：是 owner，能拍板大方向（架构、上线决策、招人）
mid：是 reviewer 或 driver，对子模块有决策权但不能拍大方向
low：是 contributor，执行为主，没有决策权
判定信号（从 evidence 找）：
- 出现 "由 X 决定" / "X 拍板" / "@X review" → high 或 mid
- 出现 "X 来 fix" / "X 来 implement" → low
- 没有明确信号 → mid（保守默认）
输出严格 JSON 数组。
```

### M4 · `classifyPersonPersonEdges` LLM（1.5 天）

新 `apps/server/src/util/collabTypeClassifier.ts` + `.opencode/agent/aiisn-collab-type.md`

类似 M3，输入 pp 边的 evidence + 双方 PersonAttributes 简版，输出 collabType + why。

```
collab：普通协作（一起做事）
reviewer_author：明显的"评审-作者"关系（一方反复 review 另一方的输出）
cross_team：跨团队对接（biz 不同或 dept 不同）
mentor：明显的师徒关系（一方反复指导另一方）
默认 collab；只有强信号才升级到其他三档。
```

### M5 · `assembleGraphContext(focalUnitId)`（1 天）

新 `apps/server/src/context/graphContextAssembler.ts`

```ts
export function assembleGraphContext(focalUnitId: string): GraphContextSlice | null;
```

逻辑：
1. 加载 focal unit
2. 算 personEntityIds (focal.entities[type='person']) + projectCanonicalNames (resolveProjectCanonical 映射后)
3. **decisionPath**：
   - 找所有 PersonProjectEdge where projectCanonical IN focal.projects AND role IN ('owner','driver','reviewer')
   - 按 (decisionAuthority desc, role 优先序, weight desc) 排
   - 取 top 3
4. **expectedButMissing.persons**：
   - 找所有 PersonProjectEdge where projectCanonical IN focal.projects
   - 减去 focal.personEntityIds 已经在的人
   - weight ≥ 0.5 的留下，按 weight desc 取 top 5
   - reason: "{name} 是 {project} 的 {role}，但此 context 未参与"
5. **activeBlockers**：
   - 找 work_item_edges where to_unit_id=focal AND type='follows' AND status='active'
   - （MVP15B 暂时只有 follows，没真正的 blocks——按 follows 上溯返回，标 "可能阻塞"）
   - cap 3 条
6. **projectPhase**：若 focal.projectCanonicalNames 唯一 → 加载 org_project_phase
7. 60s in-memory cache by focalUnitId

### M6 · Packet slices 接入（0.5 天）

改 `apps/server/src/context/agentContextAssembler.ts`：
- **扩 PacketSlice union 加 `'graphContext'`** + `SLICE_CAPS.graphContext = 1` + `GLOBAL_SLICE_CAPS.myTopCollaborators = 12`
- 扩 `GlobalContextPacket` 加 `myTopCollaborators: MyTopCollaborator[]` 字段
- 扩 `AgentContextPacket` 加 `graphContext?: GraphContextSlice` 可选字段
- `assembleGlobalContextPacket`：在 spaces/goals/... 之后加 myTopCollaborators 装配 —— 调 `buildSelfCollaboratorRanking({limit:12, now})`，再用 `listEntityEdges({kind:'person_person', fromId/toId: 双向查 self↔X})` 把 collab_type 字段拼到每条 entry 上
- `assembleAgentContextPacket`：在 `declared.has('graphContext')` 分支下，若 `input.unit !== null` 调 `assembleGraphContext(input.unit.id)` 填 packet.graphContext；写 materializedSlices

`apps/server/src/attention/attentionPrompt.ts`：
- 新增 `renderMyTopCollaborators(items)` 函数，在 `renderStakeholders` 之后追加 blocks（注意：myTopCollaborators 是 global，要在 GlobalContextPacket-driven 的 buildAttentionUserMessage 里渲染）

`apps/server/src/agents/index.ts`：
- `registerAgent('track_commitment', ...)` 的 slices 数组追加 `'graphContext'`
- 其它 agent 不动（独立 PR 处理）

### M7 · attention prompt §13（1 天，含 prompt 调优）

改 `apps/server/src/attention/attentionPrompt.ts`：

`renderMyTopCollaborators`：

```xml
<myTopCollaborators count="12" sortedByWeight>
- 杨薛莎 weight=2.93 同部门 fn=Engineering type=collab 共项目=[Chatbot 接入 Workspace] hint=co_owner
- 徐思雨 weight=2.93 同部门 fn=Engineering type=reviewer_author hint=reviewer
...
</myTopCollaborators>
```

`renderGraphContext`（仅 focal 时）：

```xml
<graphContext>
  focal: project=Chatbot 接入 Workspace
  decisionPath:
    - 陈炫旭 (owner, authority=high) 同部门
    - 杨薛莎 (contributor, authority=mid)
  expectedButMissing:
    - 詹育帆 weight=1.42 (Chatbot 接入 Workspace 的 contributor，本次未参与)
  activeBlockers: (none)
  projectPhase: execution / at_risk -- "多数 commitment 临期未完成"
</graphContext>
```

铁律 §13（4 条小条目）：

```
13. <myTopCollaborators> 和 <graphContext> 是图归纳信号：
    a) trigger 信号涉及 myTopCollaborators 里 weight ≥ 1.5 的人 → 默认至少 P2；
       weight ≥ 2.5 + 临期 → P0/P1。collabType='reviewer_author' 且对方在 review 我
       的产出 → 抬一档（评审 unblock 关键）。
    b) <graphContext.decisionPath> 是该项目的实际决策链。decisionAuthority='high'
       的人发起的 commitment / decision → 至少 P1；他们的明确请求 → 至少 P1。
    c) <graphContext.expectedButMissing.persons> 列出 "本该参与但没参与" 的人——
       在 suggestedAction 写 "考虑同步给 X"，但不要直接发；只是建议。
    d) <graphContext.activeBlockers> 视为 P0/P1 候选证据；必须放进 signalIds。
    e) <graphContext.projectPhase>:
       - frozen → 该 project 信号一律降一档（项目暂停状态）
       - at_risk / overdue → 信号倾向 P1/P0
       - on_track → 维持原 priority
```

### M8 · `commitmentAgent` 接入示范（0.5 天）

**重要修正**：`commitmentAgent` 是**纯本地机械文案 agent，不调 LLM**（见 `commitmentAgent.ts` 注释「仍然不调 LLM，纯本地」）。它生成 action_proposal + card text。MVP15B 接入方式：

1. `apps/server/src/agents/index.ts` 中 `registerAgent('track_commitment')` 的 `slices` 加 `'graphContext'`
2. `apps/server/src/agents/commitmentAgent.ts` 读 `packet.graphContext`，在生成 card 文案的 bodyLines 中加：
   - 若 `graphContext.decisionPath` 含 decisionAuthority='high' 的 owner（且不是用户自己）→ 文案多一行「该项目 owner: {name}（建议同步给 TA）」
   - 若 `graphContext.expectedButMissing.persons` 不空 → suggestedAction 文本增量「可考虑抄: {top1 name}」
   - 若 `graphContext.projectPhase.health` == 'overdue' → priority 自动升一档（在现有 critical-space 逻辑基础上叠加）

**不动其它 agent**——prepareMeetingAgent / syncDraftAgent / recapActionItemsAgent 走独立 PR (MVP15B.x)。模板：上面 3 个分支照搬。

### M9 · vitest + smoke + 文档（1 天）

vitest:
- `mvp15b-project-phase.test.ts`: LLM hook 注入，4 个场景（execution/at_risk/overdue/frozen）
- `mvp15b-decision-authority.test.ts`: 边界 + cache 命中
- `mvp15b-collab-type.test.ts`: 同上
- `mvp15b-graph-context.test.ts`: assembleGraphContext 边界（无 focal / focal 无 project / 多 project / 缺协作圈数据）
- `mvp15b-attention-packet.test.ts`: packet 含 myTopCollaborators + graphContext 时 prompt 文本正确

真 db smoke:
- 27 个 project 都有 phase + health（人眼审 5 个）
- top 50 ppj 都有 decisionAuthority（人眼审 10 个）
- top 50 pp 都有 collabType（人眼审 10 个）
- 触发一次 attention tick，packet 含 myTopCollaborators 12 人，prompt 含 §13

dogfood:
- 协作圈 top 5 人的相关信号 attention priority 比之前高（同条件下从 P2 抬到 P1）
- 关键 missing 人在 attention items 的 suggestedAction 里被建议
- 项目 phase=frozen 的项目信号被显著降权

---

## 6. 验证

### 6.1 单元用例矩阵（实测）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `mvp15b-project-phase.test.ts` | 9 | T1 空 / T2 happy / T3 cache 命中 / T4 TTL 过期 / T5 force / T6 LLM 抛错 / T7 漏返 / T8 非法值 filter / T9 JSON parse 失败 |
| `mvp15b-decision-authority.test.ts` | 8 | T1 空 / T2 happy / T3-T4 cache+TTL / T5 topN / T6 LLM 抛错 / T7 非法值 / **T8 关键：inducer 重跑不擦 LLM 字段** |
| `mvp15b-collab-type.test.ts` | 4 | T1 4 档 collabType 全档位 / T2 非法值 filter / T3 LLM 抛错 / T4 topN + cache 配合 |
| `mvp15b-graph-context.test.ts` | 9 | T1 null focal / T2 无 project / T3 DA*role 排序 / T4 self 排除 / T5 focal 排除 / T6 follows 上溯 / T7 单/多 project phase / T8 60s cache / T9 cache 过期 |
| `mvp15b-attention-packet.test.ts` | 7 | T1 myTopCollaborators 字段 / T2 render block / T3 §13 in system prompt / T4 graphContext 装配 / T5 不 declare 时 undefined / T6 unit=null 时 undefined / T7 materializedSlices 含 entry |
| **合计** | **37** | 全部通过 |

跟 MVP15A 合并跑 regression: **85/85 全过**。

### 6.2 真 db smoke 期望

```
projectPhase: 27 个 canonical 都有记录, ttl_until = now + 30d
ppj.decisionAuthority: top 50 边有标，~32 条 'mid', ~10 条 'high', ~8 条 'low'（粗估）
pp.collabType: top 50 边有标，多数 'collab'，少量 'reviewer_author' 'cross_team'
attention prompt token: 增 ~500-600 token（myTopCollaborators 12 行 ~400 含 7 字段，graphContext 平均 ~150）；仍在 8k context 内
attention LLM 输出 items: top items 的 why 字段引用 graphContext 内的 name / project
```

### 6.3 dogfood A/B

挑 3-5 个真实 attention items 跟之前比较：
- priority 是否更准（高频协作者 + decision_authority=high → 提升）
- suggestedAction 是否提及 expectedButMissing 里的人
- frozen 项目相关信号是否被压（看 attention 是否过滤掉）

---

## 7. 自审 / 已知薄弱点

1. **LLM 调用累计成本**：M2 (~27 调用 ÷ 10 batch = 3 calls) + M3 (50÷10 = 5 calls) + M4 (5 calls) = ~13 LLM calls；每次 30-60s = 7-13 min 完整跑一次。**缓解**：cache + TTL，平时只跑增量；用户能接受。

2. **协作圈 11 人 vs myTopCollaborators slice 12 cap 重叠 stakeholders slice**：Phase A' stakeholders slice 也是 ≤12，跟 myTopCollaborators 可能高度重合。**缓解**：MVP15B 把 stakeholders slice 保留作 focal 兜底；myTopCollaborators 是 global。两者用途不同（focal vs global）。后续如发现冗余可清理。

3. **LLM 错标无反馈通道**：MVP15B 不做（推 MVP15B.5）。错标在 dogfood 期间只能手 SQL 修：
   ```sql
   UPDATE entity_edges SET decision_authority='high' WHERE id='<edge_id>';
   UPDATE org_project_phase SET phase='execution' WHERE canonical_name='X';
   ```

4. **decisionPath 用 SQL hint + LLM authority 联合**：当前 SQL 给出 role (owner/driver/reviewer)，LLM 给出 authority (high/mid/low)。如果两者矛盾（如 SQL 算出 "owner" 但 LLM 给 "low"），按 LLM 优先。**风险**：LLM 把 owner 错判 low 会导致 decisionPath 排序错。**缓解**：M9 dogfood 时盯一下。

5. **activeBlockers 暂时只能 follows 上溯**：blocks 边推到 MVP15.5，attention 看到的 blocker 信号在 MVP15B 期间偏弱。**缓解**：先用 follows + status='active' 的 unit 标 "可能阻塞"；MVP15.5 上线后无缝替换。

6. **packet token 预算**：current attention packet ~6000-8000 token 输入。加 myTopCollaborators (~400) + graphContext (~150) = 多 ~550 token，仍在 8k context 内。**风险**：未来 attention engine 模型换成更小 context 时可能撑爆。**缓解**：M6 加 cap（GLOBAL_SLICE_CAPS.myTopCollaborators=12 / SLICE_CAPS.graphContext=1，graphContext 内部再分子 cap：expectedButMissing.persons=5 / decisionPath=3 / activeBlockers=3）。

7. **`commitmentAgent` 单点示范不够**：用户用得最多的 agent 是 prepareMeetingAgent / syncDraftAgent。**缓解**：MVP15B 之后立即起独立 PR 接 prepareMeetingAgent + syncDraftAgent（不阻塞 MVP15B 提交）。

8. **org_project_phase TTL 30 天可能太短或太长**：项目状态变化频率不定。**缓解**：dogfood 后调；先 30 天。

---

## 8. 不在 MVP15B 范围

| 推迟项 | 推到哪 | 触发条件 |
|---|---|---|
| WorkItemEdge.blocks LLM | **MVP15.5** | activeBlockers slice 在 dogfood 中确认有用，再投入 |
| prepareMeetingAgent / syncDraftAgent / recapActionItemsAgent 接入 graphContext | **MVP15B.x** 系列 | 模板已有（commitmentAgent），可一个一个独立 PR |
| 反馈通道（错标 override / org_project_phase override） | **MVP15B.5** | MVP15B 完工 + 1 周 dogfood 收集错标样本后 |
| ProjectProjectEdge 完整 | **MVP15C** | 协作圈 + decisionPath 跑顺 |
| WorkGraphPanel 双子图可视化 | **MVP15C** | UI 重投入 |
| manager_of_me / report_of_me | **Phase A.5** | scope 审批通过 |

---

## 9. 之后的路线图

```
MVP15A   人图 + 跨人项目边 + Self 协作圈 + WorkItem.follows + LLM project dedup（已完成）
   │
MVP15B   → 图语义化（3 个 LLM 任务）+ assembleGraphContext + attention/packet 接入 + commitmentAgent 示范（本期）
   │
   ├── MVP15B.x  → prepareMeetingAgent / syncDraftAgent / recapActionItemsAgent 各自接入 graphContext（独立 PR）
   ├── MVP15B.5  → 反馈通道（entity_edge_overrides + org_project_phase_overrides + UI ✗ 按钮）
   ├── MVP15.5   → WorkItemEdge.blocks LLM 推断（候选 pair 扫描 + LLM 判定 + activeBlockers 真实化）
   ├── MVP15C    → ProjectProjectEdge + WorkGraphPanel 双子图可视化
   └── Phase A.5 → manager / report 信号补全（独立 PR，等审批）
```

---

## 10. 落地里程碑 + 工时

| 里程碑 | 内容 | 工时 | 完成判据 |
|---|---|---|---|
| M1 | DB schema 扩展（4 列 + 新表） | 0.5 天 | tsc clean + 既有 vitest 全过 |
| M2 | `judgeProjectPhase` LLM + 缓存 + agent file | 1 天 | 27 个 project 都有 phase 记录，人眼审 5 个合理 |
| M3 | `inferDecisionAuthority` LLM + top-N + cache | 1.5 天 | top 50 ppj 边有 decisionAuthority，人眼审 10 个合理 |
| M4 | `classifyPersonPersonEdges` LLM | 1.5 天 | top 50 pp 边有 collabType，人眼审 10 个合理 |
| M5 | `assembleGraphContext(focalUnitId)` | 1 天 | 给定 focal，返回非空 decisionPath/expectedButMissing |
| M6 | Packet slices 接入（global myTopCollaborators + focal graphContext）| 0.5 天 | attention packet input 含两个新 slice |
| M7 | attention prompt §13 + dogfood prompt 调优 | 1 天 | attention items 的 why 引用 graphContext 内的 name |
| M8 | `commitmentAgent` 接入示范 | 0.5 天 | commitmentAgent prompt input 含 graphContext，提醒文案利用 sharedProjects |
| M9 | vitest + 真 db smoke + 文档 amend | 1 天 | 5 个新 test file，~25 用例全过；MVP15B doc §6 数字更新 |

**合计 8.5 天（最快 5-7 天，含 prompt 调优 buffer 到 8.5）**。

---

## 附录 A · 与最终目标 G1-G7 的对应

| 用户最终目标 | MVP15A 已达 | MVP15B 增量 | 合计完成度 |
|---|---|---|---|
| G1 两张图 + 跨边 | 人图 + 跨边 70% | 给图打语义标签让"边的含义"明确 +10% | 80% |
| G2 谁跟谁在协作 | 100% | collabType 让协作含义更准 | 100%（质量提升）|
| G3 谁跟谁同项目 | 100% | decisionAuthority 让位置含义更准 | 100%（质量提升）|
| G4 每个人跟我配合 | 100% | myTopCollaborators 接 attention | 100%（接入下游）|
| G5 每个人在决策中的位置 | SQL hint 60% | LLM decisionAuthority + decisionPath | 90% |
| G6 飞书：部门/上级 | 部门 60% | 不动（等 Phase A.5）| 60% |
| G7 给 context 算位置 + 缺啥 | 0% | assembleGraphContext + expectedButMissing | 80%（packet 接入；MVP15C 完整可视化）|

**MVP15B 完成后总进度：~88%**。离 100% 差 Phase A.5（manager）+ MVP15C（项目图可视化）+ MVP15.5（blocks 真值）+ MVP15B.5（反馈）。

---

## 附录 B · 数据流图

```
LLM 解析层（M2 M3 M4）
  judgeProjectPhase             → org_project_phase
  inferDecisionAuthority        → entity_edges.decision_authority
  classifyPersonPersonEdges     → entity_edges.collab_type
       ↓
read model 组装（M5）
  assembleGraphContext(focalId) → {decisionPath, expectedButMissing, activeBlockers, projectPhase}
       ↓
packet 装配（M6）
  attentionEngine packet        ← myTopCollaborators (global, top 12)
  agent packet (含 focal)        ← graphContext (focal)
       ↓
prompt 消费（M7 M8）
  attention prompt §13          → priority 调权 + suggestedAction 含 missing 人
  commitmentAgent prompt        → 追单文案引用 sharedProjects / decisionPath
```
