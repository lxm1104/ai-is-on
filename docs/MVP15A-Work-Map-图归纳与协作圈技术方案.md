# MVP15A · Work Map 图归纳与协作圈技术方案

## 0. TL;DR

把 Work Map 从「带 orgRole 的扁平相关人列表」演化为「**人协作图 + 跨人-项目边 + Self 协作圈 read model + 工作项 follows 边**」。这一期**只在一处用 LLM——project entity 去重（永久缓存）**；其余推断全部 SQL。不动 attention/agent packet，只把 db 里已经存在的共现/links 关系**归纳成显式图**，并在前端给一个 read-only 的「我的协作圈」面板让用户验收。

五个 inducer（4 个 SQL + 1 个 LLM-cached）：

- `projectTaxonomy` ← **LLM-batch project entity 去重**（仿 dept taxonomy），永久缓存到 `org_project_taxonomy` 表
- `personPerson` ← 复用 `cooccurrenceService` 数据源，加业务（biz）/职能（fn）维度
- `personProject` ← entity-overlap 路径，project 端先走 taxonomy canonical 映射（**不走** `context_space_links`——见 §3 落差 D2）
- `workItem.follows` ← `context_links (link_type='updates')`
- `selfCollaboratorRanking` ← 基于上面 inducer 的 self-anchored read model

交付指标：

- `entity_edges` 表内有 ≥200 条 PersonPerson + ≥80 条 PersonProject 边
- `org_project_taxonomy` 缓存里 43 个 project entity 被聚合到 ~25-30 个 canonical 项目
- `/api/graph/my-collaborators` 返回 ≥15 个协作者，按 weight 排序，每个带 orgRole / biz / fn / shared projects（项目名是 canonical 名）
- 前端 `MyCollaboratorsPanel` read-only 展示 top 20 协作者
- 不影响 Phase A' 已有功能，不动 attention prompt

---

## 1. 用户的最终目标（引用原话）

> 「这个 work map 应该尽量反映出来一个图状的结构，能够从 context 中推断出来谁跟谁在协作，谁跟谁在同一个项目上，他们之间是什么关联的项目/工作和人，应该是两张图，然后之间有一些关联。包括每一个人跟我配合的关系，每一个人在决策中的位置，还可以根据飞书联系人的能力找到更多信息，比如飞书中能不能取到我的上级是谁，然后我所属的部门是什么。
>
> 然后，这样后续每次用的时候就能够达到一个 context 之后，就能够从这个 work map 中推断出来当前这个 context 属于哪个位置，它还需要哪些 context 可以补充，才能帮助 Agent 进行决策。」

拆成 6 个目标块：

| # | 目标 | 现状 |
|---|---|---|
| G1 | 图状结构（两张图 + 跨边） | **MVP15A 主线** |
| G2 | 谁跟谁在协作（人 ↔ 人） | **MVP15A 主线**（PersonPersonEdge） |
| G3 | 谁跟谁在同一个项目（人 ↔ 项目） | **MVP15A 主线**（PersonProjectEdge） |
| G4 | 每个人跟我配合的关系 | **MVP15A 主线**（SelfCollaboratorRanking） |
| G5 | 每个人在决策中的位置 | 部分 MVP15A（role hint），完整版推 MVP15B（LLM 语义） |
| G6 | 飞书：上级是谁、部门是什么 | 部门 Phase A' 已 ✓；上级等 Phase A.5（scope 审批） |
| G7 | 给一个 context 算它属于图哪里 + 缺什么 context | **推 MVP15B**（assembleGraphContext） |

---

## 2. Phase A' 已经做了什么（2026-05-26 已合并到 main）

### 2.1 数据采集

| 组件 | 行为 |
|---|---|
| [`util/larkOrg.ts`](../apps/server/src/util/larkOrg.ts) | `lookupUsers(openIds[])` / `searchUserByName(name, hasChatted)` 封装 lark-cli `+search-user` |
| [`collectors/larkOrgCollector.ts`](../apps/server/src/collectors/larkOrgCollector.ts) | 每 1h tick：(1) 同步 self；(2) `resolveMissingAliasesForWorkMapPeople` 给 Work Map 里无 ou_ alias 的 person 按名字反查补 alias；(3) 优先刷 Work Map 相关人；(4) 主同步 cap=200 per run；(5) 单 entity 24h TTL；self 失败自动 retry 2 次 |
| [`util/departmentTaxonomy.ts`](../apps/server/src/util/departmentTaxonomy.ts) | 部门名 → `{business, functionLabel, functionPath}` LLM 解析，结果永久缓存到 `org_department_taxonomy` 表 |

### 2.2 推断与装配

| 组件 | 行为 |
|---|---|
| [`context/personOrgRole.ts`](../apps/server/src/context/personOrgRole.ts) | `computeOrgRoleFromMe()` 推断 4 档：`external` / `peer_same_dept` / `same_business_cross_function` / `cross_dept` |
| [`context/agentContextAssembler.ts`](../apps/server/src/context/agentContextAssembler.ts) | `collectStakeholders` 给每个 stakeholder 加 `orgRole`；GLOBAL_SLICE_CAPS.stakeholders=12 |
| [`bootstrap/workMapService.ts`](../apps/server/src/bootstrap/workMapService.ts) | `getCurrentWorkMap.stakeholderOrgRoles` 暴露 `{role, business, functionLabel}` 给前端；generateWorkMapDraft 服务端按 self.larkLocalizedName 过滤 self |

### 2.3 attention prompt

attention 系统 prompt 加铁律 §11：`orgRole=external` 降一档，`cross_dept` 倾向 P2，`same_business_cross_function` 倾向 P1，`peer_same_dept` 无升降。

### 2.4 前端

`WorkMapPanel` StakeholdersEditor 行尾 OrgRoleChip：peer/cross/same-biz/external 四色 + 二级业务/职能标签。

### 2.5 真 db 数据画像（截至 2026-05-26）

```
person entity 总数：    298
├─ 有 attributes_json：  153  (51%)
└─ 有 larkDeptBusiness： 100  (34%)

project entity：         43      ← 注意：不是 context_spaces.project 的 4 个
doc entity：             120
chat entity：            41

work-scope active unit：
  event           936
  state            63
  relationship     12
  commitment        9
  uncertainty       8
  goal              4
  others           ≤7

person+project 同 unit 共现：62 (state 40 + commitment 8 + intent 5 + ...)
person-person unique pair：  1070
context_links (updates)：    87
context_spaces (project)：   4

≥3 unit 共现的 entity（noise filter 后的"核心节点"）：
  person:   68
  chat:     17
  doc:      13
  project:   8
```

---

## 3. 落差分析（与最终目标）

| 落差点 | 严重度 | MVP15A 是否处理 |
|---|---|---|
| **D1** 还没有显式的"图"数据结构 | 阻塞 | ✓ entity_edges + work_item_edges 表 |
| **D2** `context_space_links` 关联近 0（只有 4/970 unit 有 link），原 Phase B SQL 跑空 | 阻塞 | ✓ PersonProject 改走 entity-overlap |
| **D3** ProjectNode 当成 `context_spaces` 漏掉 90% 项目（4 vs 43） | 阻塞 | ✓ 改用 `context_entities (type='project')` |
| **D4** 没有"我跟某人配合"的视角，PersonPersonEdge 是 N×N 对称的 | 重要 | ✓ SelfCollaboratorRanking read model |
| **D5** 没有"决策位置"信号 | 重要 | 部分（role 标签 + orgRole 联合）；LLM 语义推 MVP15B |
| **D6** 没有"给 context 算位置 + 缺啥"能力 | 重要 | 推 MVP15B（需要图先存在） |
| **D7** 缺 leader_user_id（manager_of_me 推不出） | 中 | 推 Phase A.5（scope 审批） |
| **D8** WorkItemEdge.blocks 没数据来源 | 中 | follows 这一期做；blocks 推 MVP15B（LLM） |
| **D9** project entity 噪音（43 个里很多只在 1 个 unit 出现） | 中 | 加 minOccurrence 过滤 |
| **D10** 同名不同 alias 的 entity 在共现里算 2 个节点 | 低 | 沿用 `resolveAliased`，不额外合并 |

---

## 4. MVP15A 范围

### 4.1 必做（这一期）

1. **`entity_edges` 表**：承载 PersonPerson + PersonProject 两类边
2. **`work_item_edges` 表**：承载 follows 边（depends_on / blocks 留 MVP15B）
3. **`org_project_taxonomy` 表 + `projectTaxonomy.ts`**：LLM-batch 解析 project entity → canonical cluster，永久缓存
4. **`graphInducer.ts`**：5 个 inducer（含 projectTaxonomy）+ 5 分钟 throttle cache
5. **`SelfCollaboratorRanking` read model**：基于上面边和 taxonomy 算"我的协作圈"
6. **`/api/graph/*` 路由**：暴露给前端
7. **`MyCollaboratorsPanel`**：read-only，展示 top 20 协作者
8. **vitest**：5 个 inducer + read model + taxonomy mock 边界用例

### 4.2 不做（推 MVP15B / 15B.5 / 15C / Phase A.5）

| 推迟项 | 推到哪 | 原因 |
|---|---|---|
| LLM-based decisionRoleHint 深度版（读 evidence 内容判定 role） | MVP15B | MVP15A 用 SQL 粗判（owner/driver/reviewer/contributor）够 dogfood；LLM 版需要反馈通道一起做 |
| LLM 边语义（collabType / blocks / depends_on） | MVP15B | 不阻塞当前 dogfood；先确认 SQL 出来的边有质量 |
| `assembleGraphContext` + attention/packet 注入 | MVP15B | 图先要稳定存在；packet 注入是消费侧 |
| **用户反馈通道（错标 override / entity_edge_overrides 表）** | **MVP15B.5** | LLM 标签错时用户需要 override 机制——这是独立的基建模块，跟 MVP15B 的 LLM 功能解耦 |
| ProjectProjectEdge 完整 | MVP15C | 43 个 project entity 共现关系数据稀疏，先做人图见效快 |
| WorkGraphPanel 完整双子图可视化 | MVP15C | UI 重投入；先用 list-panel 验证图归纳质量 |
| manager_of_me / report_of_me | Phase A.5 | 等 `contact:user.employee:readonly` scope 审批 |
| `context_relations` 老表 drop | minor release | 物理表保留不动 |

### 4.3 选这个范围的理由

- **数据已经足够**：68 个频繁 person + 1070 个 pair + 100 个有 biz 的人。SQL inducer 当天能出图。
- **直接答原文最强诉求**：「每一个人跟我配合的关系」= SelfCollaboratorRanking。一上线用户能立刻 dogfood 验证。
- **不卡 attention/packet 团队继续 MVP16 工作**：边表写进去不影响现有路径。
- **图归纳的质量必须先验**：在没上 LLM 语义之前，SQL 出来的边到底准不准、有没有噪音，肉眼审一次再决定。

---

## 5. 关键设计决策

| # | 决策 | 替代方案与不选原因 |
|---|---|---|
| D1 | **Project 节点走 `context_entities (type='project')`**，43 vs 4 | 走 spaces：漏 90% 节点；混合：schema 复杂 |
| D2 | **PersonProjectEdge 走 entity overlap**（同 unit 上 person + project entity 共现） | 走 `context_space_links`：覆盖率 4/970，几乎跑空 |
| D3 | **minOccurrence ≥3 的过滤**只对 project entity 启用，person 不过滤 | 全过滤：会丢掉新加入的协作者；不过滤 project：43 个里很多噪音 |
| D4 | **SelfCollaboratorRanking 不入表，read model 实时算** | 入表：self 改名 / 部门变动 → 全表脏；read model 60s cache 够用 |
| D5 | **WorkItemEdge.follows 从 `context_links (updates)` 推**（已有 87 行） | 等 LLM：推 MVP15B 才能跑；现在 follows 边是免费的 |
| D6 | **entity_edges 用 `edge_kind` 字段区分三类**（person_person / person_project / project_project），不拆 3 张表 | 拆表：3 个 UNIQUE INDEX 各管各的，查询 / 写入复杂 |
| D7 | **MVP15A 只在一处用 LLM —— project entity 去重**。仿 `departmentTaxonomy` 模式：新 `projectTaxonomy.ts` + `org_project_taxonomy` 表 + `aiisn-project-taxonomy` agent。输入：43 个 project entity 名 + 各自 top 5 共现的 person/doc 名。输出：`{canonicalName, aliases[]}` cluster 数组。失败降级：cluster 不可得 → 按 entity 原样建图。<br>**collabType / blocks / 深度 decisionAuthority 仍推 MVP15B；用户反馈通道单独 MVP15B.5。** | 全 SQL：43 个项目可能拆成 30+ 个噪音节点（"chatbot agent 建设"vs"Chatbot 产研协同"），weight 稀释；全 LLM：MVP15A 失焦 + 没反馈通道收不住错标 |
| D8 | **decisionRoleHint 用 SQL 粗判**：根据 unit.kind + entity role 推 `owner` (commitment.actor) / `driver` (goal.actor) / `reviewer` (decision.actor) / `contributor` (其它 actor) / `stakeholder` (about) / `observer`。粗但够 dogfood | LLM 深度版：需要读 evidence 文本 + 反馈通道，跟 MVP15B 一起做更连贯 |
| D9 | **MyCollaboratorsPanel read-only**，不开编辑 | 编辑：让用户改图边违反"图是 read model"原则；想改协作关系应该改 Work Map relationship unit |
| D10 | **MVP15B.5 反馈通道单列**：`entity_edge_overrides` 表 + UI 上的"✗这不对"按钮 + inducer 跳过 override 过的边。**跟 MVP15B 的 LLM 功能解耦**，因为 override 机制本身可服务于：(a) MVP15B 的 LLM 标签纠错；(b) 未来其它图编辑场景；(c) Phase A.5 的 manager 误判纠错 | 跟 MVP15B 一起做：耦合，LLM 模块改 schema 时反馈表跟着改，回滚成本高 |

---

## 6. 数据模型

### 6.1 `entity_edges` 表

```sql
CREATE TABLE IF NOT EXISTS entity_edges (
  id TEXT PRIMARY KEY,
  edge_kind TEXT NOT NULL,              -- 'person_person' | 'person_project' | 'project_project'(预留)
  from_id TEXT NOT NULL,                -- canonical entity id（已 resolveAliased）
  to_id TEXT NOT NULL,                  -- canonical entity id；person_person 时 from_id < to_id（无向）
  role_or_type TEXT,                    -- person_project: 'owner'|'driver'|'reviewer'|'contributor'|'stakeholder'
                                        -- person_person: NULL（MVP15A），MVP15B LLM 写 collabType
  weight REAL NOT NULL DEFAULT 0,       -- recency-decayed cooccur count
  business_relation TEXT,               -- 仅 person_person：'same_business'|'cross_business'|'external'|'unknown'
  shared_ids_json TEXT,                 -- 仅 person_person：sharedProjectEntityIds[]
  evidence_unit_ids_json TEXT NOT NULL DEFAULT '[]',  -- ≤10 条 unit id，用于 hover 解释
  detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_edges_kind ON entity_edges(edge_kind);
CREATE INDEX IF NOT EXISTS idx_entity_edges_from ON entity_edges(edge_kind, from_id);
CREATE INDEX IF NOT EXISTS idx_entity_edges_to ON entity_edges(edge_kind, to_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_edges
  ON entity_edges(edge_kind, from_id, to_id);
```

### 6.1.1 `org_project_taxonomy` 表（LLM 去重缓存）

```sql
CREATE TABLE IF NOT EXISTS org_project_taxonomy (
  -- canonical_name 是这一组项目的标准名（LLM 选出最规范的那个）
  canonical_name TEXT PRIMARY KEY,
  -- 这一组里所有 entity 名（JSON 数组），包括 canonical_name 自己
  aliases_json TEXT NOT NULL,
  -- LLM 给的一句话项目摘要，供 UI 提示
  summary TEXT,
  -- 'llm' | 'manual' | 'rule'
  parsed_by TEXT NOT NULL DEFAULT 'llm',
  parsed_at TEXT NOT NULL
);
-- 反向索引：从 entity 名 → canonical_name（aliases_json 里 LIKE 查粗筛，应用层精确匹配）
CREATE INDEX IF NOT EXISTS idx_org_project_aliases ON org_project_taxonomy(aliases_json);
```

helpers：
```ts
export type OrgProjectTaxonomyRow = {
  canonical_name: string;
  aliases_json: string;
  summary: string | null;
  parsed_by: string;
  parsed_at: string;
};

export function listProjectTaxonomy(): OrgProjectTaxonomyRow[];
/**
 * upsert 语义（增量解析关键）：如果 canonical_name 已存在，**aliases 取并集**而非覆盖。
 * 这样后续 LLM run 给同一 canonical 加了新 alias 不会把老 alias 丢掉。
 */
export function upsertProjectTaxonomy(row: OrgProjectTaxonomyRow): void;
/** 给定 entity 名，返回对应 canonical_name；缓存里没找到返回原名（不做隐式合并） */
export function resolveProjectCanonical(entityName: string): string;
```

### 6.2 `work_item_edges` 表

```sql
CREATE TABLE IF NOT EXISTS work_item_edges (
  id TEXT PRIMARY KEY,
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  type TEXT NOT NULL,                   -- MVP15A 只写 'follows'；MVP15B 加 'blocks'|'depends_on'|'derived_from'
  status TEXT NOT NULL DEFAULT 'active',-- 'active'|'resolved'|'stale'
  reason TEXT NOT NULL,                 -- ≤200 字解释
  evidence_unit_ids_json TEXT NOT NULL DEFAULT '[]',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_item_edges_from ON work_item_edges(from_unit_id);
CREATE INDEX IF NOT EXISTS idx_work_item_edges_to ON work_item_edges(to_unit_id);
CREATE INDEX IF NOT EXISTS idx_work_item_edges_status ON work_item_edges(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_item_edges
  ON work_item_edges(from_unit_id, to_unit_id, type);
```

### 6.3 内部 TS 类型

```ts
// apps/server/src/context/graphTypes.ts （新）

export type EdgeKind = 'person_person' | 'person_project' | 'project_project';

export type PersonProjectRole =
  | 'owner' | 'driver' | 'reviewer' | 'contributor' | 'stakeholder' | 'observer';

export type BusinessRelation =
  | 'same_business' | 'cross_business' | 'external' | 'unknown';

export type PersonPersonEdge = {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  weight: number;
  businessRelation: BusinessRelation;
  sharedProjectEntityIds: string[];
  evidenceUnitIds: string[];
  lastSeenAt: string;
  detectedAt: string;
  updatedAt: string;
  // MVP15B 由 LLM 写入：
  // collabType?: 'collab'|'reviewer_author'|'cross_team';
};

export type PersonProjectEdge = {
  id: string;
  personEntityId: string;
  projectEntityId: string;
  role: PersonProjectRole;
  weight: number;
  evidenceUnitIds: string[];
  lastSeenAt: string;
  detectedAt: string;
  updatedAt: string;
};

export type WorkItemEdge = {
  id: string;
  fromUnitId: string;
  toUnitId: string;
  type: 'follows';                       // MVP15A 仅 follows；MVP15B 扩
  status: 'active' | 'resolved' | 'stale';
  reason: string;
  evidenceUnitIds: string[];
  detectedAt: string;
  resolvedAt?: string;
  updatedAt: string;
};

// SelfCollaboratorRanking —— 不入表，read model 实时算
export type SelfCollaboratorEntry = {
  personEntityId: string;
  name: string;
  weight: number;                        // 跟 self 的 cooccur weight
  orgRole?: OrgRoleFromMe;
  business?: string;
  functionLabel?: string;
  sharedProjectEntityIds: string[];      // 通过 PersonProject 交集
  sharedProjectNames: string[];
  decisionRoleHint: 'co_owner' | 'reviewer' | 'contributor' | 'observer' | null;
  evidenceUnitIds: string[];             // 跟 self 共现的 unit id ≤5
  lastSeenAt: string;
};
```

---

## 7. 实施步骤

### 7.1 DB schema + helpers

新增 `apps/server/src/db.ts`：3 张表创建 + helpers

```ts
// entity_edges
export type EntityEdgeRow = { id, edge_kind, from_id, to_id, role_or_type, weight,
                              business_relation, shared_ids_json, evidence_unit_ids_json,
                              detected_at, last_seen_at, updated_at };
export function upsertEntityEdge(row: EntityEdgeRow): void;
export function listEntityEdges(opts: { kind?: EdgeKind, fromId?, toId?, minWeight?, limit? }): EntityEdgeRow[];
export function deleteStaleEntityEdges(kind: EdgeKind, lastSeenBefore: string): number;

// work_item_edges
export type WorkItemEdgeRow = { ... };
export function upsertWorkItemEdge(row: WorkItemEdgeRow): void;
export function listWorkItemEdges(opts: { fromUnitId?, toUnitId?, status? }): WorkItemEdgeRow[];

// org_project_taxonomy（LLM 去重缓存）
export type OrgProjectTaxonomyRow = { canonical_name, aliases_json, summary, parsed_by, parsed_at };
export function listProjectTaxonomy(): OrgProjectTaxonomyRow[];
export function upsertProjectTaxonomy(row: OrgProjectTaxonomyRow): void;
export function resolveProjectCanonical(entityName: string): string;
```

### 7.1.5 `projectTaxonomy.ts` —— LLM project entity 去重

新增 `apps/server/src/util/projectTaxonomy.ts` + opencode agent `.opencode/agent/aiisn-project-taxonomy.md`（仿 `aiisn-dept-taxonomy`）：

```ts
export async function parseProjectClusters(
  entities: Array<{ name: string; cooccurNames: string[] }>,
  opts: { llmHook?: (prompt: string, system: string) => Promise<string> } = {}
): Promise<Array<{ canonicalName: string; aliases: string[]; summary?: string }>>;
```

工作流程：
1. inducer 第一次跑时，先查 `org_project_taxonomy` 表
2. 找出**没缓存过**的 project entity 名
3. 给每个未缓存 entity 收集 top 5 共现的 person/doc 名（作为消歧上下文）
4. 一次 LLM batch 调用，输入 ≤30 个未缓存 entity
5. LLM 输出 cluster 数组，写入 `org_project_taxonomy`
6. 后续 inducer 直接读缓存（`resolveProjectCanonical`）

LLM prompt 主要内容：

> 你需要把一组飞书/字节跳动里被提到的"项目名"合并去重。
> 给你 N 个 entity 名 + 各自最常共现的协作者/文档名。
> 规则：
> - 同义合并：例如 "chatbot 评测" / "Chatbot 产研协同" 可能都是一个 Chatbot 项目
> - 不强行合并：如果两个名字明显是不同项目（即使主题相近），保持独立
> - canonical_name 选最规范、最常出现的那个
> - aliases 包含所有归入此 cluster 的 entity 名（含 canonical 自身）
> - summary 一句话项目摘要（可缺省）
> - 输出严格 JSON 数组

失败降级：LLM error / parse fail → 不写缓存，inducer 把每个 entity 当独立项目处理（不阻塞）。下次 tick 重试。

### 7.2 `inducePersonPersonEdges` —— 最大数据量，先做

复用 `cooccurrenceService` 的 SQL，加 biz 派生：

```sql
WITH base AS (
  SELECT
    a.entity_id AS from_id,
    b.entity_id AS to_id,
    a.context_unit_id AS unit_id,
    cu.updated_at AS unit_updated_at
  FROM context_unit_entities a
  JOIN context_unit_entities b ON a.context_unit_id = b.context_unit_id
                              AND a.entity_id < b.entity_id
  JOIN context_entities ea ON ea.id = a.entity_id AND ea.type = 'person'
  JOIN context_entities eb ON eb.id = b.entity_id AND eb.type = 'person'
  JOIN context_units cu ON cu.id = a.context_unit_id
  WHERE cu.status='active' AND cu.scope='work'
    AND (cu.expires_at IS NULL OR cu.expires_at > ?)
    AND a.role IN ('actor','about') AND b.role IN ('actor','about')
)
SELECT from_id, to_id,
       COUNT(*) AS cooccur,
       MAX(unit_updated_at) AS last_seen_at,
       GROUP_CONCAT(unit_id) AS evidence_csv
FROM base
GROUP BY from_id, to_id;
```

JS 层后处理：
1. 跑 `resolveAliased(fromId)` / `resolveAliased(toId)` → canonical；同 canonical id pair 合并；合并后保证 fromId < toId（UNIQUE 索引约束）
2. weight = Σ exp(-ageHours/720)（30d 半衰，按 ms-precision）
3. weight ≥ 0.3 才入边
4. 双方 PersonAttributes.larkDeptBusiness 都存在 → biz 比较得 businessRelation；任一缺则 'unknown'
5. **`sharedProjectEntityIds` = 查 entity_edges where kind='person_project' AND person_id IN (fromId, toId)**，取 project 交集（这一步要求 ppj inducer 已经先跑完，§7.2.1 顺序保证）
6. evidence_unit_ids cap 10 条（取最新 10 条 unit）
7. upsert 进 entity_edges（UNIQUE 索引上 ON CONFLICT 更新 weight/last_seen_at/evidence）

预期：~1070 pair → resolveAliased dedup → ~800 → weight ≥ 0.3 filter → ~200-400 边

### 7.2.1 inducer 调用顺序与依赖

```ts
export async function runGraphInducer(opts: { force?, now?, includeLlm? } = {}) {
  // 顺序至关重要：taxonomy → ppj → pp（pp 用 ppj 算 sharedProjects） → wif → cleanup
  if (opts.includeLlm !== false) {
    await refreshProjectTaxonomyIfNeeded(opts);   // ← LLM 仅这一处；可禁用便于测试
  }
  const ppj = inducePersonProjectEdges(opts.now);  // 内部用 resolveProjectCanonical
  const pp  = inducePersonPersonEdges(opts.now);   // **依赖 ppj 算 sharedProjectEntityIds**
  const wif = induceWorkItemFollowsEdges();
  const purged = purgeStaleEdges(opts.now);        // 见 §7.5
  // ...
}
```

**依赖关系（执行顺序硬要求）**：
1. `projectTaxonomy` — 没它 `resolveProjectCanonical()` 退化为原 entity 名（不阻塞，只是质量降）
2. `personProject` — 用 canonical 名 group_by；输出 PersonProjectEdge 写入 entity_edges
3. `personPerson` — **遍历 PersonProjectEdge 算 sharedProjectEntityIds**；不能跟 ppj 并行
4. `workItem.follows` — 完全独立，最后跑
5. `purgeStaleEdges` — 见 §7.5

**LLM 调用的 HTTP 同步性问题**：第一次跑 `/api/graph/*` 路由会同步等 LLM（~30s）。**缓解策略**：server boot 后异步 kick off 一次 `runGraphInducer({force:true})` 预热缓存；后续 HTTP 请求都命中缓存。code 在 `index.ts` 加 `setTimeout(() => void runGraphInducer({force:true}), 10_000)`。

`refreshProjectTaxonomyIfNeeded` 行为：
- 第一次跑（缓存全空）→ LLM 调用一次，~30 个 entity
- 后续 tick → 跳过（缓存命中）
- 新 entity 出现且距 last LLM run ≥7 天 → 增量 LLM 调用，仅给未缓存 entity

### 7.3 `inducePersonProjectEdges`

```sql
WITH base AS (
  SELECT
    a.entity_id AS person_id,
    b.entity_id AS project_id,
    a.role AS unit_role,
    cu.kind AS unit_kind,
    a.context_unit_id AS unit_id,
    cu.updated_at AS unit_updated_at
  FROM context_unit_entities a
  JOIN context_unit_entities b ON a.context_unit_id = b.context_unit_id
  JOIN context_entities ea ON ea.id = a.entity_id AND ea.type = 'person'
  JOIN context_entities eb ON eb.id = b.entity_id AND eb.type = 'project'
  JOIN context_units cu ON cu.id = a.context_unit_id
  WHERE cu.status='active' AND cu.scope='work'
    AND (cu.expires_at IS NULL OR cu.expires_at > ?)
)
SELECT person_id, project_id,
       COUNT(*) AS cooccur,
       MAX(unit_updated_at) AS last_seen_at,
       -- json_group_array DISTINCT 在部分 sqlite 版本不可靠，应用层去重
       json_group_array(unit_id) AS evidence_json,
       json_group_array(unit_kind || ':' || unit_role) AS kind_role_pairs
FROM base
GROUP BY person_id, project_id
HAVING cooccur >= 2;  -- 单次共现噪音偏大；person-project 至少 2 次共现才入边
```

> **note**：HAVING cooccur ≥ 2 是 §9 自审里 "person-project 噪音过滤" 的实现位。weight ≥ 0.2 SQL 过滤紧跟其后（应用层算 weight 时再筛）。

JS 层处理：
1. SQL 拿到 (person_id, raw_project_entity_id, evidence...) 行
2. **project_id 通过 `resolveProjectCanonical(entity.name)` 映射为 canonical**——这是 LLM dedup 接入图归纳的关键点
3. 按 (person_id, canonical_project_name) 合并：weight 累加、evidence 合并
4. role 推断（优先序破并列）：

```ts
function inferRole(kindRolePairs: string[]): PersonProjectRole {
  // 先按 (kind, role) 计频次
  const freq = countFreq(kindRolePairs);
  // 门槛：单次出现的 "owner-候选" 不够强，要 ≥ 2 才升级
  // (避免：1 次偶发 commitment.actor 把"主要 stakeholder"反而盖掉)
  if ((freq['commitment:actor'] ?? 0) >= 2) return 'owner';
  if ((freq['goal:actor']       ?? 0) >= 2) return 'driver';
  if ((freq['decision:actor']   ?? 0) >= 1) return 'reviewer';  // decision 频次低、单次有效
  // 单次 commitment/goal actor 退到 contributor
  if ((freq['commitment:actor'] ?? 0) === 1 || (freq['goal:actor'] ?? 0) === 1) return 'contributor';
  // about role 主导 → stakeholder
  const aboutCount = Object.entries(freq).filter(([k]) => k.endsWith(':about')).reduce((a, [, v]) => a + v, 0);
  const actorCount = Object.entries(freq).filter(([k]) => k.endsWith(':actor')).reduce((a, [, v]) => a + v, 0);
  if (aboutCount > actorCount * 2) return 'stakeholder';
  if (actorCount > 0) return 'contributor';
  return 'observer';
}
```

> 优先级：`owner` > `driver` > `reviewer` > `contributor` > `stakeholder` > `observer`。决定一对 (person, project) 最终 role 时取这个序里最高的命中项。

预期：62 共现 unit × 2-3 人 = ~150 raw edges → resolveProjectCanonical 合并后 ~100 canonical edges。

### 7.4 `induceWorkItemFollowsEdges`

```sql
SELECT id, from_context_id, to_context_id, confidence, created_at
FROM context_links
WHERE link_type = 'updates';
```

每条 `updates` link 写成 `WorkItemEdge { type:'follows', from=to_context_id, to=from_context_id, reason: 'context_links.updates link' }`。注意方向：`updates` 语义是 "B updates A" → A 在前、B 跟随 → A follows B.

校验任一 unit 失活时把 edge 转 resolved。**过滤 self-loop**：`from_context_id == to_context_id` 直接跳过。

### 7.4.5 `purgeStaleEdges` —— 删掉久未更新的边

inducer 每次都 upsert 命中的边的 `last_seen_at`。所以"没出现"的边（人离职 / 项目关停）会留在表里 last_seen_at 不变。

```ts
export function purgeStaleEdges(now: number): { purged: number } {
  // 90 天没碰过 → 删掉
  const cutoff = new Date(now - 90 * 86400_000).toISOString();
  const r1 = db.prepare(`DELETE FROM entity_edges WHERE last_seen_at < ?`).run(cutoff);
  // work_item_edges: 同 unit 失活/删了 → 边变 stale，30 天后清理
  const r2 = db.prepare(`UPDATE work_item_edges SET status='stale' WHERE updated_at < ?`).run(cutoff);
  return { purged: r1.changes + r2.changes };
}
```

不删 self-anchored 边（fromId 或 toId === self 的）—— 保留历史协作记忆。

### 7.5 `induceSelfCollaboratorRanking` —— read model，不入表

```ts
export function buildSelfCollaboratorRanking(opts: { limit?: number } = {}): SelfCollaboratorEntry[] {
  const selfId = getSetting('self_person_entity_id');
  if (!selfId) return [];

  // 1) 所有 self ↔ X 的 PersonPersonEdge
  const edges = listEntityEdges({
    kind: 'person_person',
    fromId: selfId,  // 注意 person_person 用 from_id < to_id 排序，所以需要双向查
  }).concat(listEntityEdges({ kind: 'person_person', toId: selfId }));

  // 2) 对每个 X，查 PersonProjectEdge → 找出 X 跟 self 共同参与的 project
  // 3) 算 decisionRoleHint：看 X 在 self 也参与的 unit 里 role 是什么
  // 4) 装 SelfCollaboratorEntry，按 weight 排序，取 top N

  return entries.slice(0, opts.limit ?? 20);
}
```

### 7.6 `graphInducer.ts` 集成

```ts
// apps/server/src/context/graphInducer.ts

let lastRunAt = 0;
const THROTTLE_MS = 5 * 60_000;

export async function runGraphInducer(opts: { force?: boolean, now?: number } = {}): Promise<{
  personPersonEdges: number;
  personProjectEdges: number;
  workItemFollowsEdges: number;
  durationMs: number;
}> {
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastRunAt < THROTTLE_MS) {
    return { personPersonEdges: 0, personProjectEdges: 0, workItemFollowsEdges: 0, durationMs: 0 };
  }
  const t0 = now;
  const pp = inducePersonPersonEdges(now);
  const ppj = inducePersonProjectEdges(now);
  const wif = induceWorkItemFollowsEdges();
  lastRunAt = now;
  return { personPersonEdges: pp, personProjectEdges: ppj, workItemFollowsEdges: wif, durationMs: Date.now() - t0 };
}
```

不挂到 collector scheduler；改成**懒计算**：`/api/graph/*` 路由请求时先 throttled-run inducer。后续如果 attention engine 需要，可在 attention tick 之前 await `runGraphInducer()`（MVP15B 接入）。

### 7.7 API + 前端

`apps/server/src/routes/graph.ts`（新）：

```ts
graphRouter.get('/graph/my-collaborators', async (req, res) => {
  await runGraphInducer({});
  const limit = clampInt(req.query.limit, 20, 50);
  const entries = buildSelfCollaboratorRanking({ limit });
  res.json({ entries, inducerLastRunAt: getLastRunAt() });
});

graphRouter.get('/graph/person-graph', async (req, res) => {
  await runGraphInducer({});
  const edges = listEntityEdges({ kind: 'person_person', minWeight: 0.3, limit: 500 });
  // 加 node 信息：name / orgRole / biz / fn
  const nodes = enrichNodes(edges);
  res.json({ nodes, edges });
});

graphRouter.get('/graph/project-graph', ...);  // 留 stub，MVP15C 完整做
graphRouter.get('/graph/neighborhood?unitId=...', ...);  // 留 stub，MVP15B 用
```

`apps/web/src/components/MyCollaboratorsPanel.tsx`（新）：

WorkMapPanel 旁边一个新折叠面板「我的协作圈」。展示前 20 名：
- 名字 + chip（peer/cross/biz/external —— 复用 OrgRoleChip）
- weight 进度条
- shared projects 列表（点击高亮）
- decisionRoleHint 标签（co_owner/reviewer/contributor/observer）
- hover evidence unit titles

---

## 8. 验证

### 8.1 vitest

新增 `apps/server/test/mvp15a-graph-inducer.test.ts`：

- T1 PersonPerson：构造 5 人 6 unit 共现，断言 edges 数 / weight / business_relation
- T2 PersonProject：commitment(actor) → owner；goal(actor) → driver；其它 → contributor；多 hint 时按优先级破并列
- T3 PersonProject canonical 合并：3 个 entity 名（"chatbot agent 建设"/"Chatbot 产研协同"/"chatbot 评测"）被 taxonomy 合并到 1 个 canonical → PersonProjectEdge 只出现 1 条 per person
- T4 WorkItem follows：updates link → follows 边方向正确；任一 unit 失活 → 边转 resolved
- T5 SelfCollaboratorRanking：top-N 按 weight 排序；sharedProjects 通过 PersonProject 交集计算（且按 canonical 名）
- T6 alias dedup：同人不同 alias → 1 个 canonical 节点
- T7 throttle：5min 内重复调 `runGraphInducer({})` → 第二次直接返回 cache
- T8 force：`runGraphInducer({force:true})` 跳过 throttle
- T8.5 空 self：settings 里没有 `self_person_entity_id` → `buildSelfCollaboratorRanking()` 返回 `[]`，不抛
- T8.6 空图：fresh db，0 person entity → inducer 各跑一次返回 0 edges，不抛；后续 `/api/graph/my-collaborators` 返回 `{entries:[]}`
- T8.7 purge 不动 self-anchored 边：构造 1 条 self↔X 边 last_seen_at=100 天前 + 1 条 X↔Y 边 last_seen_at=100 天前 → 调 purgeStaleEdges → 第一条保留、第二条删除

新增 `apps/server/test/mvp15a-project-taxonomy.test.ts`：

- T9 LLM hook 注入：mock llmHook 返回固定 cluster，断言写入 org_project_taxonomy 表
- T10 缓存命中跳过 LLM：第二次跑 inducer，hook 不被调用
- T11 增量解析：缓存中有 30 个 entity，新增 2 个未缓存的 → 只对新 2 个调 LLM
- T12 LLM 失败降级：hook 抛错 → 不写缓存 + inducer 仍能跑（用原 entity 名）

新增 `apps/server/test/mvp15a-graph-routes.test.ts`：

- API smoke：each `/graph/*` route response shape

### 8.2 真 db smoke

```bash
# 跑 inducer 一次
curl -X POST http://127.0.0.1:5173/api/graph/_inducer/run-once
# 期望：~200-400 person_person, ~100-150 person_project, ~85 work_item follows

# 拿我的协作圈
curl http://127.0.0.1:5173/api/graph/my-collaborators?limit=20 | jq '.entries[:5]'
# 期望：≥15 个协作者，按 weight 降序，每个带 orgRole 或缺失（不冒充）
```

### 8.3 dogfood 手测

打开 WorkMapPanel → 展开「我的协作圈」面板：
- 看到 ≥15 个协作者
- 每行带 chip + weight 进度条 + sharedProjects 列表
- 排序明显有 sense（跟你直觉里"我跟谁配合最多"对得上）
- 点击协作者 → 高亮共同 project（保留扩展点，可不实现）

---

## 9. 自审 / 已知薄弱点

1. **project entity 噪音 + LLM 去重的可靠性**：43 个 entity 名里大概 25-30 个 canonical 项目。LLM 去重质量决定 PersonProjectEdge 排序。第一次 smoke 时**必须人眼审 cluster 结果**——如果 LLM 把不同项目错误合并（高严重度）或漏合并（低严重度），都要通过 MVP15B.5 反馈通道补救。**缓解**：除 LLM 输出外，inducer 再加一道 `cooccur ≥ 2` 过滤，把"只出现 1 次的孤立 project entity"自动排除（这条 SQL filter 跟 LLM 互补）。

2. **resolveAliased 不够覆盖同名同人**：Phase A' 的 `resolveMissingAliasesForWorkMapPeople` 已经按名字反查补 alias，但**纯文本提名**（context 里"小明"vs entity "王某某"）还是 2 个节点。MVP15A 不再额外合并；可能误报 2 个低 weight 边。**缓解**：用 weight ≥ 0.3 阈值天然过滤这种低质量边。

3. **inducer 在 `/api/graph/*` 路由懒触发，第一次有 LLM 延迟**：第一次访问会跑 projectTaxonomy LLM (~30s)。**缓解**：server boot 后 10s 异步跑一次 `runGraphInducer({force:true})` 预热（见 §7.2.1）。后续 HTTP 命中缓存。

4. **没接 attention/packet**：MVP15A 不让图直接影响 attention 决策。**显式选择**——先验证图归纳质量再决定接入方式。MVP15B 才做 packet 注入。

4.5. **LLM project dedup 错标用户暂时没法 override**：MVP15A 不做反馈通道（推到 MVP15B.5）。这一周 dogfood 期间如果 LLM 合并明显错了（比如把不同项目当成同一个），临时**手工** `UPDATE org_project_taxonomy SET aliases_json=... WHERE canonical_name=...` 修一下。MVP15B.5 会把这条变成 UI 上的「✗这不对」按钮。

5. **WorkItemEdge.follows 方向可能反**：`context_links.updates` 语义是 "B updates A"。我设计成 "A follows B"（A 跟随 B 的更新）。如果调用方理解成 "B 是 A 的下游"，方向就反了。**缓解**：在 reason 字段写清"来源 context_links.updates: B updates A"，让消费者自己定语义。

6. **没考虑 self 的 alias chain**：self entity 可能有多个 ou_alias 历史（账号合并等），`resolveAliased` 必须先解 self 再查。**缓解**：buildSelfCollaboratorRanking 一开始就 `const canonicalSelfId = resolveAliased(getSetting('self_person_entity_id'))`。

7. **edge_kind 把三类边塞一张表**：查询时索引能覆盖，但 schema 复杂度更高。**理由**：3 张表 dedup / migration 成本是 1 张表的 3 倍，写入路径也多。先 1 张表，性能塌了再拆。

8. **inducer 的 pp 依赖 ppj** —— 顺序错了 sharedProjects 全空。**强约束**：§7.2.1 明确顺序，测试 T1 必须先跑 ppj inducer 再调 pp inducer 的 hook，否则 sharedProjectEntityIds 全为空数组。代码层用 throw 显式提示。

9. **purgeStaleEdges 的 90 天阈值是猜的**：用户的协作周期可能更长。**缓解**：第一周 dogfood 时只打日志不真删（dryRun flag）；用户确认无误后再开启实删除。

---

## 10. 不在 MVP15A 范围（推后）

| 推迟项 | 推到哪 | 触发条件 |
|---|---|---|
| LLM 边语义（collabType / decisionAuthority） | MVP15B | SQL 出来的边 dogfood 1 周后确认基线 |
| `assembleGraphContext(focalUnitId)` | MVP15B | 边存在且稳定 |
| attention prompt §13（图差集） | MVP15B | graphContext slice 可用 |
| WorkItemEdge.blocks / depends_on | MVP15B | LLM 模块就绪 |
| ProjectProjectEdge 完整 | MVP15C | person-project 边稳定，并且需要看到 project ↔ project 的实际场景需求 |
| WorkGraphPanel 完整双子图 SVG/canvas | MVP15C | MyCollaboratorsPanel dogfood 通过 |
| manager_of_me / report_of_me | Phase A.5 | `contact:user.employee:readonly` scope 审批通过 |
| `context_relations` 物理 drop | minor release | MVP15A 不删，物理表保留 |

---

## 11. 之后的路线图

```
MVP15A  人图 + 跨人项目边 + Self 协作圈 + WorkItem.follows
        + LLM project dedup（本期，唯一 LLM 用法）
  │
  ├── MVP15B   → LLM 语义边 + assembleGraphContext + attention/packet 接入
  │              - classifyPersonPersonEdges (collabType)
  │              - judgeProjectPhase
  │              - inferDecisionAuthority（读 evidence 内容判 high/mid/low）
  │              - workItemInducer.blocks (LLM)
  │              - assembleGraphContext(focalUnitId) packet slice
  │              - attention prompt §13 "decisionPath / expectedButMissing"
  │
  ├── MVP15B.5 → 用户反馈通道（与 MVP15B LLM 解耦）
  │              - entity_edge_overrides 表
  │              - org_project_taxonomy 也可被 override
  │              - UI "✗这不对" 按钮（chip / collab / project cluster）
  │              - inducer 跳过 override 过的边
  │              - 可服务 MVP15B LLM 错标 + Phase A.5 manager 误判 + 未来场景
  │
  ├── MVP15C   → ProjectProjectEdge + WorkGraphPanel 完整双子图
  │              - shares_owner / shares_doc / depends_on 项目间
  │              - 双子图 SVG（react-flow 或 d3）
  │              - 点节点 → 跳到 unit / space 详情
  │
  └── Phase A.5 → manager / report 信号补全（独立 PR，等审批）
                  - getUserEmployeeInfo via /contact/v3/users/:id
                  - leader_chain 推断
                  - attention prompt §11(g) "manager_of_me → P0/P1"
                  - personOrgRole 加 'manager_of_me' / 'report_of_me'
```

---

## 12. 落地里程碑

| 里程碑 | 内容 | 完成判据 |
|---|---|---|
| M1 | DB schema + helpers（3 张表） | `entity_edges` / `work_item_edges` / `org_project_taxonomy` 表存在，能 upsert/list；既有 vitest 全过 |
| M2 | `projectTaxonomy.ts` + opencode agent + LLM 缓存 | 真 db smoke：43 个 entity 被聚合到 ~25-30 个 canonical；命中缓存第二次跑不调 LLM |
| M3 | `personProject` inducer（含 canonical 映射） | 真 db smoke：≥80 canonical ppj 边；HAVING cooccur≥2 过滤生效 |
| M4 | `personPerson` inducer（依赖 ppj 算 sharedProjects） | 真 db smoke：≥200 pp 边；至少 50% 有非空 sharedProjectEntityIds |
| M5 | `workItem follows` inducer + `purgeStaleEdges` | 真 db smoke：≥80 follows 边方向正确；purge 不动 self-anchored 边 |
| M6 | SelfCollaboratorRanking | API 返回 ≥15 协作者按 weight 排序；空 self 不抛 |
| M7 | `MyCollaboratorsPanel` + server boot 预热 | 前端 dogfood：用户视觉确认排序 + canonical 项目名合理；服务起来后 ~10s 缓存预热 |
| M8 | vitest 全过 | 见 §8.1 用例矩阵（15 条用例：T1-T8 + T8.5/8.6/8.7 + T9-T12 + routes smoke） |

预估实施时间：**4-6 天**（不算 dogfood 反馈循环）。比原 3-5 天多 1 天，全部用在 projectTaxonomy（LLM batch + 缓存 + agent file + 测试 hook）。

里程碑顺序：M1 → M2 → M3 → M4（M4 依赖 M3） → M5 → M6 → M7 → M8。M2 之后可中间 dogfood 检查 cluster 质量；M7 之后做完整 dogfood。

---

## 附录 A · 与最终目标 G1-G7 的对应矩阵

| 用户最终目标 | MVP15A 交付 | 完成度 |
|---|---|---|
| G1 两张图 + 跨边 | 人图（entity_edges person_person）+ 跨边（person_project, canonical 项目名）；项目图节点定义好但项目间边推 MVP15C | 70% |
| G2 谁跟谁在协作 | PersonPersonEdge ✓ | 100% |
| G3 谁跟谁在同项目上 | PersonProjectEdge ✓ + **LLM project dedup**（43 → ~28 canonical） | 100% |
| G4 每个人跟我配合 | SelfCollaboratorRanking ✓（sharedProjects 用 canonical 名） | 100% |
| G5 每个人在决策中的位置 | decisionRoleHint（co_owner/reviewer/contributor/observer，基于 unit role + orgRole；SQL only） | 60%（LLM 深度语义版推 MVP15B） |
| G6 飞书：上级 / 部门 | 部门 ✓（Phase A'）；上级推 Phase A.5 | 60% |
| G7 给 context 算位置 + 缺啥 | 推 MVP15B（assembleGraphContext） | 0% |

**MVP15A 完成后总进度：~72% → 离最终目标差 MVP15B 的 G5/G7。**

LLM 在 MVP15A 的唯一用法：project entity dedup（缓存型，一次性投入）。这提升了 G3 的图质量（避免 weight 稀释到错位项目）和 G4 的可读性（sharedProjects 用 canonical 名而不是噪音名）。LLM 在边语义、决策深度、反馈通道上的所有用法都明确推到 MVP15B / MVP15B.5。
