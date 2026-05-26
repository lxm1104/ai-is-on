# MVP15 Work Map 图结构与组织模型技术方案

## 0. TL;DR

把 Work Map 从「LLM 一次性出的扁平字段集合」演化为「**两张图 + 跨图边 + 工作项依赖图**」的读模型。节点放稳定身份，边放协作强度（连续量、自然衰减），工作项之间放阻塞 / 依赖（带状态、跟工作项一起过期）。新增 `larkOrgCollector` 把飞书通讯录里的部门 / 上下级补到人节点，让 attention engine 不再靠 LLM 猜「谁是我老板」。最终目标：给 agent 任意一条 context 时，系统能从图里说出「这事属于哪里、谁能拍板、还缺哪些 context、谁可能漏抄」，并把这段「图差集」喂回 prompt。

四个 phase 单独可落，单独有用：

- **Phase A**：`larkOrgCollector` + 人 entity 扩 `attributes_json` + attention prompt 加 `orgRole`（1-2 天，单 PR）
- **Phase B**：`entity_edges` 表 + `graphInducer` 跑 SQL 出骨架边 + WorkMapPanel 加关系图（2-3 天）
- **Phase C**：日 batch LLM 给边和项目打 `type / phase / health`（3-5 天）
- **Phase D**：`assembleGraphContext()` + packet 加 `<graphContext>` slice，attention prompt 加图差集铁律（2-3 天）

每个 phase 都不依赖下一个，可以暂停或局部回滚。

---

## 1. 背景

### 1.1 现状

Work Map 当前是一个扁平的 schema（见 [docs/MVP7-MVP10-Agent处理Context与冷启动执行方案.md](MVP7-MVP10-Agent处理Context与冷启动执行方案.md)）：

- 节点的载体是 `context_unit (kind=relationship)` 和 `context_space (type=project)`；
- 「人 → 人」边只有 [cooccurrenceService.ts:46](../apps/server/src/context/cooccurrenceService.ts:46) 的共现频次，**没有语义类型也没有方向**；
- 「人 → 项目」边是隐式的 —— 通过同一个 unit 上同时挂 person entity 和 project entity 推断，每次现算；
- 「项目 → 项目」边**完全没有**；
- 飞书通讯录里的部门 / 上下级 / 职位**没接入**——nameResolver 只反查名字，没拿过 `leader_user_id`、`department_ids`、`job_title`。

`context_relations` 表早在 MVP14 Phase 1c 被废弃（[db.ts:1199](../apps/server/src/db.ts:1199)）：物理 schema 仍在，但没有 caller。

### 1.2 痛点

1. **「谁是我老板」靠 LLM 猜**。attention prompt 里写了「关键人物（stakeholder）的明确请求 → P0」（[attentionPrompt.ts:24](../apps/server/src/attention/attentionPrompt.ts:24)），但 LLM 看到的只是 `stakeholders[].name`，分不出 manager / peer / external。
2. **「这件事还缺哪些 context」靠每个 agent 自己想**。`prepareMeetingAgent` 想知道「谁该来这个会」、`commitmentAgent` 想知道「谁可能被阻塞」——目前都要自己拼 SQL，缺一个共用的「图邻域」视角。
3. **协作强度判断不分场景**。两人在 3 条群消息共现 vs. 在 5 条 1:1 邮件 + 4 条决策文档共现，目前权重一样。
4. **阻塞关系无处落**。"小明的 commitment 阻塞了我的 goal" 这种依赖关系没地方记，agent 看不见。
5. **没有 UI 让用户看 / 修这张图**。WorkMapPanel 是一个扁平表单，无法表达「张三是李四的下属，二人都在 Atlas 项目」。

### 1.3 思考方向（用户提出，2026-05-26 对话）

> 「这个 work map 应该尽量反映出来一个图状的结构，能够从 context 中推断出来谁跟谁在协作，谁跟谁在同一个项目上……应该是两张图（人 + 工作），之间有一些关联。包括每一个人跟我配合的关系，每一个人在决策中的位置。可以根据飞书联系人取更多信息，比如我的上级是谁、我所属的部门是什么。后续每次用的时候就能从图里推断出当前 context 属于哪个位置、还需要哪些 context 补充。」

后续讨论里达成了一个关键纠偏：**`blocks_me / blocked_by_me` 不是人的长期属性**，它属于工作项之间的边。本文已按这条纠偏建模。

---

## 2. 关键设计决策（共识纪要）

| # | 决策 | 替代方案与不选原因 |
|---|---|---|
| D1 | **三类节点 + 三类边**：PersonNode / ProjectNode / WorkItemNode（复用 ContextUnit）；PersonProjectEdge / PersonPersonEdge / ProjectProjectEdge / WorkItemEdge | 单一异构图：查询便利但 schema 复杂、迁移成本高，本期不做 |
| D2 | **节点放稳定身份，边放协作强度，工作项边跟工作项过期** | 把 `frequent_collab` 塞节点：会撒谎（用户跳槽 / 项目换人时不更新）。`blocks_me` 塞节点：多事并存时塌成单一标签 |
| D3 | **协作强度用 `weight (float)` 不用枚举**。需要展示 frequent/sporadic/one_off 时在查询层派生 | 枚举是离散决策，丢信息；想加 P95 / 衰减半衰期时再扩字段就被锁死 |
| D4 | **飞书 OpenAPI 范围**：仅取 self / 上级链 / 同部门成员 / Work Map 已出现过的 person。**不全量同步通讯录** | 全量同步 = 内网通讯录拷贝，PII 风险大，无明显回报 |
| D5 | **org_role 只信飞书原始字段，不让 LLM 推**。无飞书数据时留空，不猜 | 误判 manager → 抬错 P0 → 用户最容易 churn |
| D6 | **LLM 只填边和节点的语义（type/phase/health），不增删拓扑**。拓扑由 SQL inducer 决定 | 让 LLM 编节点 → 凭空发明同事；让 LLM 删边 → 与 evidence 撕裂 |
| D7 | **图是 read model，用户编辑入口仍是 WorkMapPanel + feedback**。图本身不开 CRUD | 用户能拖图改边 → "edge 怎么回写 Work Map 表单" 不可解 |
| D8 | **`context_relations` 表不复用**。它的 schema 没有 evidence / weight / lastSeenAt，新增字段成本和重命名差不多。新建 `entity_edges` + `work_item_edges` 两张表，物理 drop `context_relations` | 留旧表会有 caller 误用 |

---

## 3. 数据模型

### 3.1 PersonNode（不新建表，扩 `context_entities`）

不新建表，给 `context_entities` 增 `attributes_json TEXT` 列，在 `type='person'` 时按下面 schema 填：

```ts
type PersonAttributes = {
  // ====== 来自 lark-cli `contact +search-user`（现有 scope 即可，无需审批） ======
  // 单 entity TTL 24h，由 larkOrgCollector 刷新
  larkOpenId?: string;
  larkLocalizedName?: string;        // 飞书侧名字（i18n 后的）
  larkEmail?: string;
  larkEnterpriseEmail?: string;
  larkDepartmentName?: string;       // 字符串部门名（不是 id；不审批拿不到 id）
  // ====== 来自 util/departmentTaxonomy（LLM 解析 larkDepartmentName 后写入；永久缓存）======
  larkDeptBusiness?: string;         // 业务 / 产品线 / BU，例：'Lark Base'、'TikTok'、'懂车帝'
  larkDeptFunctionLabel?: string;    // functionPath[0]，便于 chip 直接展示
  larkDeptFunctionPath?: string[];   // 完整职能层级，例：['Engineering','Infra','Performance']
  larkIsCrossTenant?: boolean;       // 是否是外部租户用户 → external 判定依据
  larkIsActivated?: boolean;
  larkHasChatted?: boolean;          // 我跟 TA 私聊过；可作 Phase B 协作权重 prior
  larkP2pChatId?: string;            // 可作 syncDraft agent 发私信用
  larkSyncedAt?: string;             // ISO 时间戳

  // ====== Phase A.5（等 contact:user.employee 审批下来后追加，见 §4.bis） ======
  // larkLeaderOpenId?: string;     // 直属上级 open_id
  // larkDeptId?: string;           // 部门 id
  // larkDeptPathIds?: string[];    // 部门链 id 用于 LCA
  // larkTitle?: string;            // 职位

  // ====== 系统从飞书数据推出的半年级稳定角色 ======
  // 仅在飞书数据齐全且能算出来时填；否则留空（不是 'external'）
  orgRoleFromMe?: 'peer_same_dept'              // 同部门（字符串部门名完全相等）
                 | 'same_business_cross_function' // 部门串不等但 larkDeptBusiness 相等
                 | 'cross_dept'                  // 跨业务（business 不同 / 任一缺）
                 | 'external';                   // is_cross_tenant=true 或飞书查不到
  // Phase A.5 引入：'manager_of_me' | 'report_of_me'
};
```

> 不在 PersonAttributes 里放 `working_relation` 这种派生量；强度由 `PersonPersonEdge.weight` 表达，需要展示成 "frequent/sporadic" 时在 read model 派生。
>
> **为什么 Phase A 没有 `manager_of_me`**：拿 `leader_user_id` / `department_ids` 需要 `contact:user.employee:readonly` scope（管理员审批）。`+search-user` 在现有 scope 下能返回的字段已经写在上面，包括 `is_cross_tenant`（外部判定）和 `department`（字符串部门名）。详细取舍见 §4 与 §4.bis。

### 3.2 ProjectNode（不新建表，扩 `context_spaces`）

`context_spaces.work_map_ref_json` 已经存在（[contextSpaceService.ts:41](../apps/server/src/spaces/contextSpaceService.ts:41)），追加两个 nullable 字段（向后兼容）：

```ts
type WorkMapRefExtensions = {
  // ====== Phase C 由 LLM 写入 ======
  phase?: 'discovery' | 'planning' | 'execution' | 'review' | 'frozen';
  health?: 'on_track' | 'at_risk' | 'overdue' | 'unknown';
  // health 的事实依据（最迟到期未完成的 commitment id 列表）
  healthEvidenceUnitIds?: string[];
  llmJudgedAt?: string;
};
```

### 3.3 PersonProjectEdge（新表）

```ts
type PersonProjectEdge = {
  id: string;
  personEntityId: string;          // canonical（已 resolveAliased）
  projectSpaceId: string;
  role: 'owner' | 'driver' | 'reviewer' | 'contributor' | 'stakeholder' | 'observer';
  weight: number;                  // 共现 × recency-halflife(30d)
  lastSeenAt: string;
  evidenceUnitIds: string[];       // JSON 数组；上限 10 条
  detectedAt: string;
  updatedAt: string;
};
```

role 推断规则（Phase B SQL，纯确定性）：

- 该 person 在 project 关联 unit 上有 `role='actor'` 且 unit `kind='commitment'` → `owner`
- 同上但 unit `kind='goal'` → `driver`
- 该 person 在 project 关联 unit 上有 `role='actor'` 且 unit `kind='decision'` → `reviewer`
- 该 person 只以 `role='about'` 出现 → `stakeholder`
- 其它 → `contributor`

冲突时取频次最高的 role；并列时按 owner > driver > reviewer > contributor > stakeholder > observer 优先序。

### 3.4 PersonPersonEdge（新表）

```ts
type PersonPersonEdge = {
  id: string;
  // 注意：from < to（canonical id 字典序），无向；方向性靠 orgRelation 表达
  fromEntityId: string;
  toEntityId: string;
  weight: number;                  // count × recency-halflife(30d)
  sharedProjectSpaceIds: string[]; // 共同 project（JSON）
  lastSeenAt: string;
  // 由飞书 org 数据明确告诉系统的，不让 LLM 推。可空
  orgRelation?: 'manager_to_report' | 'report_to_manager' | 'same_dept_peer';
  // Phase C LLM 给的语义；可空
  collabType?: 'collab' | 'reviewer_author' | 'cross_team';
  collabTypeWhy?: string;          // ≤120 字证据
  evidenceUnitIds: string[];
  detectedAt: string;
  updatedAt: string;
};
```

### 3.5 ProjectProjectEdge（新表）

```ts
type ProjectProjectEdge = {
  id: string;
  fromSpaceId: string;
  toSpaceId: string;
  type: 'shares_owner' | 'shares_doc' | 'derived_from' | 'parent_of';
  // 'shares_owner' / 'shares_doc' 时填
  sharedPersonEntityIds?: string[];
  sharedDocEntityIds?: string[];
  weight: number;
  evidenceUnitIds: string[];
  detectedAt: string;
  updatedAt: string;
};
```

> 注意：阻塞关系**不在 ProjectProjectEdge**。两个 project 间没有「整体阻塞」这种事，阻塞永远发生在具体工作项。

### 3.6 WorkItemEdge（新表，**这是阻塞关系的家**）

```ts
type WorkItemEdge = {
  id: string;
  fromUnitId: string;              // ContextUnit.id，kind ∈ commitment/goal/uncertainty
  toUnitId: string;
  type: 'blocks' | 'depends_on' | 'follows' | 'derived_from';
  status: 'active' | 'resolved' | 'stale';
  reason: string;                  // ≤200 字
  evidenceUnitIds: string[];
  detectedAt: string;
  resolvedAt?: string;
  updatedAt: string;
};
```

**自动失效规则**（Phase B inducer 每次跑都校验）：

- fromUnit 或 toUnit 任一 `status != 'active'` → 边转 `resolved`
- fromUnit / toUnit 任一被 supersede → 边重新指向新 unit（用 `context_links.link_type='updates'` 跟随）
- 边连续 60 天没有 evidence 更新 → 转 `stale`

### 3.7 物理表 schema

```sql
-- 已有 context_entities 增列（在 db.ts ensureColumn 机制下）
ensureColumn('context_entities', 'attributes_json', 'TEXT');

-- MVP15 §4 (revision): 部门名 → {business, functionPath} 永久解析缓存。
-- 表名不带 lark，避免锁定到具体 SaaS（将来 Slack / Microsoft Graph 等也能复用）。
CREATE TABLE IF NOT EXISTS org_department_taxonomy (
  dept_name TEXT PRIMARY KEY,
  business TEXT,                            -- "Lark Base" / "TikTok" / "懂车帝"
  function_label TEXT,                      -- function_path[0]，chip 用
  function_path_json TEXT,                  -- JSON 数组，["Engineering","Infra","Performance"]
  parsed_by TEXT NOT NULL DEFAULT 'llm',    -- 'llm' | 'manual' | 'rule'，预留多源覆盖
  parsed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_edges (
  id TEXT PRIMARY KEY,
  edge_kind TEXT NOT NULL,        -- 'person_project' | 'person_person' | 'project_project'
  from_id TEXT NOT NULL,           -- entity id 或 space id，由 edge_kind 决定
  to_id TEXT NOT NULL,
  role_or_type TEXT,               -- PersonProject.role / ProjectProject.type / PersonPerson.collabType
  weight REAL NOT NULL DEFAULT 0,
  org_relation TEXT,               -- 仅 person_person 用
  shared_ids_json TEXT,            -- 仅 person_person.sharedProjectSpaceIds / project_project.sharedPersonEntityIds 等
  evidence_unit_ids_json TEXT NOT NULL DEFAULT '[]',
  detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_edges_kind ON entity_edges(edge_kind);
CREATE INDEX IF NOT EXISTS idx_entity_edges_from ON entity_edges(edge_kind, from_id);
CREATE INDEX IF NOT EXISTS idx_entity_edges_to ON entity_edges(edge_kind, to_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_edges
  ON entity_edges(edge_kind, from_id, to_id, role_or_type);

CREATE TABLE IF NOT EXISTS work_item_edges (
  id TEXT PRIMARY KEY,
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- 'blocks' | 'depends_on' | 'follows' | 'derived_from'
  status TEXT NOT NULL DEFAULT 'active',
  reason TEXT NOT NULL,
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

-- context_relations 暂不 drop（保留物理 schema 作为接口面，避免误删；下个 minor release 再清）
-- DROP TABLE IF EXISTS context_relations;
```

> **§8.1 自审条目 1 已修**：`context_relations` 表 Phase B 不删除，保留 schema 加注释；下个 minor 再 drop。删表 PR 前先全仓 grep 确认 0 caller。

---

## 4. Phase A' — 人节点身份补全（走 `+search-user`，不依赖管理员审批）

**目标**：让 attention engine 能区分 `external` / `cross_dept` / `peer_same_dept` 三类相关人，给 attention prompt 注入足够的 org 上下文。**不引入图表**。

> **为什么不是原 Phase A**：拿 `leader_user_id` / `department_ids` 需要 `contact:user.employee:readonly` scope，需要管理员审批（可能要几天到几周）。`+search-user` 在现有 scope 下能拿到 `is_cross_tenant` 与 `department`（字符串部门名），覆盖约 50% 的预期价值且现在就能落。`manager_of_me` / `report_of_me` 推迟到 §4.bis Phase A.5。

### 4.1 改动清单（精确到文件 / 函数）

| 文件 | 改动 |
|---|---|
| `apps/server/src/db.ts` | `ensureColumn('context_entities', 'attributes_json', 'TEXT')`；read path（`getContextEntityById` / `listContextEntities`）反序列化 attributes_json |
| `apps/server/src/util/larkOrg.ts` *(新)* | 导出 `lookupUsers(openIds: string[]): Promise<LarkUserInfo[]>`，封装 `lark-cli contact +search-user --user-ids=...`；每批 ≤100；返回 `{openId, localizedName, email, enterpriseEmail, department, isCrossTenant, isActivated, hasChatted, p2pChatId}`；错误分类 `permission_denied` / `transient` / `parse_error` |
| `apps/server/src/collectors/larkOrgCollector.ts` *(新)* | 每次 tick：(a) 自己先：用 `--user-ids me` 拿 self；(b) 列出 `context_entities` 中 type='person' 且 `attributes_json IS NULL OR larkSyncedAt < now-24h` 的 entity，按需取 open_id；(c) 单次最多刷 20 个过期 entity，避免 hammer；(d) 失败 entity 跳过、不更新 `larkSyncedAt` 让下次 retry；**不**新建 entity（避免内网通讯录拷贝） |
| `apps/server/src/collectors/index.ts` 或等价注册点 | 注册 `larkOrgCollector` |
| `apps/server/src/context/personOrgRole.ts` *(新)* | `computeOrgRoleFromMe(self, target): 'peer_same_dept' \| 'cross_dept' \| 'external' \| undefined`。规则纯字符串比较（详 4.2.5） |
| `apps/server/src/context/agentContextAssembler.ts` `collectStakeholders()` | 给返回项加 `orgRole`（[agentContextAssembler.ts:454](../apps/server/src/context/agentContextAssembler.ts:454)） |
| `apps/server/src/attention/attentionPrompt.ts` `renderStakeholders` 与 prompt | stakeholder 行尾加 `[orgRole=external]` 等标签；prompt 加铁律 §11：「`<stakeholders>` 中 orgRole='external' 默认降一档；orgRole='cross_dept' 的明确请求倾向 P2 而非 P1（同部门同事的相同请求才到 P1）」 |
| `apps/web/src/components/WorkMapPanel.tsx` | StakeholdersEditor 行尾渲染 orgRole chip（read-only）：peer_same_dept=蓝、cross_dept=橙、external=灰 |
| `apps/server/test/mvp15-lark-org-collector.test.ts` *(新)* | 见 4.3 |
| `apps/server/test/mvp15-org-role.test.ts` *(新)* | 见 4.3 |

### 4.2 实施顺序

1. 加 `attributes_json` 列 + read path 反序列化。
2. 写 `larkOrg.ts` 的 `lookupUsers`，先 vitest 用 mock 跑 happy path；
3. 写 `personOrgRole.ts`，纯函数好测；
4. 写 `larkOrgCollector`：先 dry-run 把要写入的 attributes 打到 stdout 不入库，人眼检查；
5. 接入实际写库，单 entity TTL 24h；
6. 扩 `collectStakeholders` 出口加 `orgRole`；
7. 改 attention prompt：`renderStakeholders` 行尾加标签 + prompt 加铁律 §11；
8. 前端 chip。

#### 4.2.5 `computeOrgRoleFromMe` 精确规则

```ts
function computeOrgRoleFromMe(
  self: PersonAttributes | null,
  target: PersonAttributes
): OrgRoleFromMe | undefined {
  if (target.larkIsCrossTenant === true) return 'external';
  // self 尚未拉到飞书数据 → 不要返回 'external'，应该返回 undefined（"暂未连接"）
  if (self == null || !self.larkSyncedAt) return undefined;
  // target 没有部门信息 → 也返回 undefined（不冒充判断）
  if (!target.larkDepartmentName) return undefined;
  if (!self.larkDepartmentName) return undefined;
  // 字符串比较：trim + case-sensitive（飞书部门名 case-sensitive）
  if (target.larkDepartmentName.trim() === self.larkDepartmentName.trim()) {
    return 'peer_same_dept';
  }
  return 'cross_dept';
}
```

### 4.3 验证（vitest）

**`mvp15-lark-org-collector.test.ts`**：

- T1：mock `lookupUsers(['self_open_id'])` 返回 `{ department: 'Lark Base', isCrossTenant: false, ... }`；运行 collector；断言 self person entity attributes_json 含 `larkLocalizedName` + `larkSyncedAt`。
- T2：mock `lookupUsers` 返回 5 个用户，3 个对应已存在 entity、2 个不存在；断言只更新 3 个已存在 entity，**不新建** entity。
- T3：mock `lookupUsers` 抛 `permission_denied`；断言 collector 不崩、syncedAt 不刷新、下次 retry。
- T4：单 entity 在 `larkSyncedAt = now - 23h59m` 时再跑 collector；断言被 24h TTL 跳过（不调 lookupUsers）。
- T5：构造 25 个全过期 person entity；断言一次 run 只刷新 ≤20 个（其余等下次 tick）。

**`mvp15-org-role.test.ts`**：

- T6：target.isCrossTenant=true → 'external'。
- T7：self & target 同部门字符串 → 'peer_same_dept'。
- T8：不同部门字符串 → 'cross_dept'。
- T9：target.department 缺失 → undefined。
- T10：self=null（未拉到飞书）→ undefined（**不是 'external'**，避免冒充判断）。

### 4.4 手测（dogfood）

1. 起本地服务，跑一次 `runCollectorsOnce('larkOrg')`。
2. 用 sqlite client 看 `context_entities` 里 self 这条的 `attributes_json`，确认 `larkDepartmentName` 有值、`larkIsCrossTenant=false`。
3. 打开 WorkMapPanel，看 stakeholder 行有 chip 显示（peer/cross_dept/external 三种之一）。
4. 构造一条 cross_dept 同事发起的事件 → 触发 attention tick → 确认 prompt input 里 `<stakeholders>` 行带 `[orgRole=cross_dept]`，且输出 attention items 不把这条抬到 P1。

### 4.5 回滚

- 单 PR revert 即可；`attributes_json` 列保留（向后兼容，新代码不依赖它）。
- 如已写入 attributes，运行 `UPDATE context_entities SET attributes_json = NULL WHERE type='person';` 即可清除。

---

## 4.bis Phase A.5 — 等审批后补 leader 信号（future work）

当 `contact:user.employee:readonly` scope 审批通过、`/contact/v3/users/:user_id` 可调时，单独 PR 补齐：

### 4.bis.1 改动清单

| 文件 | 改动 |
|---|---|
| `apps/server/src/util/larkOrg.ts` | 新增 `getUserEmployeeInfo(openId)`：调 `lark-cli api GET /open-apis/contact/v3/users/:open_id`，返回 `leader_user_id` / `department_ids` / `job_title` |
| `apps/server/src/collectors/larkOrgCollector.ts` | 拿到 self / 已存在 person 的 `employeeInfo` 后，给 attributes 追加 `larkLeaderOpenId` / `larkDeptId` / `larkDeptPathIds` / `larkTitle` |
| `apps/server/src/context/personOrgRole.ts` | 扩 schema 引入 'manager_of_me' / 'report_of_me'。优先级：is_cross_tenant > leader_chain 关系 > 部门字符串比较 |
| `apps/server/src/attention/attentionPrompt.ts` | 铁律 §11 追加：「orgRole='manager_of_me' 的明确请求 → 至少 P1，明确临期 / 阻塞时 P0；orgRole='report_of_me' 的请求按用户偏好处理（可能是下属求助）」 |

### 4.bis.2 leader_chain 推导（≤3 层）

`computeOrgRoleFromMe` 升级：
```ts
if (target.larkIsCrossTenant) return 'external';
// leader_chain：self.larkLeaderOpenId → 上级 entity → 上级的上级 ... ≤3 层
const myUpline = getLeaderChain(self, maxDepth: 3);
if (myUpline.includes(target.larkOpenId)) return 'manager_of_me';
// 下属：target.larkLeaderOpenId === self.larkOpenId（直接下属；二级下属暂不识别）
if (target.larkLeaderOpenId === self.larkOpenId) return 'report_of_me';
// 退到字符串部门比较
...
```

### 4.bis.3 测试新增

- T11：target 在 self leader_chain 第 1 层 → 'manager_of_me'。
- T12：target 在 self leader_chain 第 3 层（间接上级）→ 'manager_of_me'。
- T13：target 在 self leader_chain 第 4 层 → 'cross_dept' 或 'peer_same_dept'（按部门字符串）。
- T14：target.larkLeaderOpenId === self.larkOpenId → 'report_of_me'。

---

## 5. Phase B — 显式边表 + graphInducer

### 5.1 改动清单

| 文件 | 改动 |
|---|---|
| `apps/server/src/db.ts` | 应用 §3.7 SQL：新建 `entity_edges`、`work_item_edges`，drop `context_relations` |
| `apps/server/src/context/graphInducer.ts` *(新)* | 三块 SQL：`induceePersonProjectEdges()` / `inducePersonPersonEdges()` / `induceProjectProjectEdges()`；每次 attention tick 之前 5 分钟 throttle |
| `apps/server/src/context/workItemEdgeStore.ts` *(新)* | 提供 `upsertWorkItemEdge`、`resolveStaleEdges`、`listEdgesFor(unitId)` |
| `apps/server/src/context/workItemInducer.ts` *(新)* | 基于 `context_links (link_type='follows'/'updates')` + 时间窗口推 `depends_on` 边；blocks 边在 Phase C 由 LLM 补 |
| `apps/server/src/routes/graph.ts` *(新)* | `GET /api/graph/person-graph`、`GET /api/graph/project-graph`、`GET /api/graph/neighborhood?unitId=...` |
| `apps/web/src/components/WorkGraphPanel.tsx` *(新)* | 折叠面板，渲染两子图。最小可行实现：用 `react-flow` 或简易 SVG，先不做 force layout |
| `apps/server/test/mvp15-graph-inducer.test.ts` *(新)* | 覆盖 weight 衰减、role 推断、edge dedup |

### 5.2 inducer SQL 关键片段

`PersonProjectEdge`：

```sql
WITH base AS (
  SELECT
    cue.entity_id   AS person_id,
    csl.space_id    AS project_id,
    cu.kind         AS unit_kind,
    cue.role        AS unit_role,
    cu.updated_at   AS unit_updated_at
  FROM context_unit_entities cue
  JOIN context_units cu          ON cu.id = cue.context_unit_id
  JOIN context_space_links csl   ON csl.target_id = cu.id AND csl.target_type = 'context_unit'
  JOIN context_entities e        ON e.id = cue.entity_id
  JOIN context_spaces sp         ON sp.id = csl.space_id
  WHERE cu.status = 'active'
    AND e.type = 'person'
    AND sp.type = 'project'
    AND (cu.expires_at IS NULL OR cu.expires_at > ?)
)
SELECT person_id, project_id,
       SUM( EXP(- (julianday(?) - julianday(unit_updated_at)) / 30.0) ) AS weight,
       MAX(unit_updated_at) AS last_seen_at
FROM base
GROUP BY person_id, project_id
HAVING weight >= 0.3;
```

role 用第二个 query 取每对 (person, project) 频次最高的 role 标签（按 §3.3 优先序破并列）。

`PersonPersonEdge`：复用现有 [cooccurrenceService.ts:46](../apps/server/src/context/cooccurrenceService.ts:46) 的 self-join，**只改 ORDER / aggregation**：加 weight 衰减、加 sharedProjectSpaceIds INTERSECT。`orgRelation` 通过 `personAttributes` 反查：from.larkLeaderOpenId === to.larkOpenId → `report_to_manager`，反过来 → `manager_to_report`，同 dept 且都不是 leader → `same_dept_peer`。

`ProjectProjectEdge`：

```sql
-- shares_owner
SELECT ppe1.project_id AS from_id, ppe2.project_id AS to_id,
       GROUP_CONCAT(ppe1.person_id) AS shared
FROM person_project_edges_view ppe1
JOIN person_project_edges_view ppe2
  ON ppe1.person_id = ppe2.person_id
 AND ppe1.project_id < ppe2.project_id
WHERE ppe1.role IN ('owner','driver')
  AND ppe2.role IN ('owner','driver')
GROUP BY from_id, to_id;
```

### 5.3 UI 最小切片

WorkMapPanel 旁开一个 `WorkGraphPanel`：

- 两个 tab：「人」 / 「项目」
- 「人」：节点用色块（自己=蓝、manager=紫、报告=绿、外部=灰），边粗细 = weight，hover 看 evidence
- 「项目」：节点是 space 名 + commitments due 提示，边 hover 看「为什么相关」
- 不开节点 / 边的编辑入口，read-only

### 5.4 回滚

- drop 新表 + 删 graphInducer 注册即可。`context_relations` 在 Phase B 不删，保留物理 schema，下个 minor release 单独 PR 处理。

---

## 6. Phase C — LLM 边语义 + 项目阶段

每日 batch（凌晨）跑一次。两个独立 LLM 调用：

### 6.1 `classifyPersonPersonEdges`

- 输入：单条 PersonPersonEdge + 它的 ≤15 条 evidence unit titles + 双方 PersonAttributes 简版（含 orgRelation）
- system prompt 主纲（细化见实现）：

  > 你要给一条人-人协作边打语义标签。只能从给定证据里找词。如果证据里没有明显的「评审」「合作」「跨团队」字眼，就保留默认 `collab`，并解释为什么。

- 输出 `{ collabType, collabTypeWhy }`；写回 `entity_edges`
- 不允许 LLM 增删边、不允许改 weight、不允许改 orgRelation

### 6.2 `judgeProjectPhase`

- 输入：一个 ProjectNode 的 goals titles + 近 14d commitments（含 dueAt）+ recentEvents titles
- 输出 `{ phase, health, healthEvidenceUnitIds[] }`
- 写回 `context_spaces.work_map_ref_json` 的 extension 字段

### 6.3 反馈通道

- UI 渲染边的 `collabType` 旁边有个「✗」按钮。点击：
  - 写一条 `entity_edge_feedback` 行（reason='wrong_label'）
  - 边的 `collabType` 清空 + `collabTypeOverriddenAt` 时间戳
  - 下次 batch 时跳过这条 24h
- 跟 [attentionFeedback.ts](../apps/server/src/attention/attentionFeedback.ts) 同套基础设施，复用 `workMapMutator.restoreEntityConfidence`（[workMapMutator.ts:76](../apps/server/src/bootstrap/workMapMutator.ts:76)）的反向模式。

---

## 7. Phase D — assembleGraphContext + packet slice

### 7.1 新函数

`apps/server/src/context/agentContextAssembler.ts` 新增 `assembleGraphContext(focalUnitId: string): GraphContextSlice`。返回：

```ts
type GraphContextSlice = {
  focal: { personEntityIds: string[]; projectSpaceIds: string[] };
  decisionPath: Array<{ entityId: string; name: string; role: string; orgRole?: string }>;
  expectedButMissing: Array<
    | { kind: 'doc';    id: string; name: string; reason: string }
    | { kind: 'person'; id: string; name: string; reason: string }
  >;
  activeBlockers: Array<{
    blockerUnitId: string; blockerTitle: string; blockerOwner?: string; reason: string;
  }>;
  upstream: ContextUnit[];   // 经 work_item_edges depends_on 上溯 ≤2 跳
  downstream: ContextUnit[]; // 同上下溯
};
```

### 7.2 接入 packet

`assembleAgentContextPacket` 增 slice `'graphContext'`。每个 agent 在 `agents/agentRegistry.ts` 声明是否需要：

- `commitmentAgent`：需要 `activeBlockers`、`decisionPath`
- `prepareMeetingAgent`：需要 `expectedButMissing.person`
- `syncDraftAgent`：需要 `expectedButMissing.person` + `decisionPath`
- attention engine 的 `GlobalContextPacket` 也补一个**全局图差集**：所有 active commitment 上的 `activeBlockers` 汇总

### 7.3 attention prompt 改动

在 [attentionPrompt.ts:30](../apps/server/src/attention/attentionPrompt.ts:30) 现有铁律里加：

> 12. `<graphContext>` 给你的是图上的邻域。`expectedButMissing` 里的 doc / person 如果对当前判断有用，可以在 `suggestedAction` 里建议「补充 X」或「抄 Y」。`decisionPath` 里的人不可凭空发明，但可以用来解释 priority（与用户 manager 相关 → 抬一档）。`activeBlockers` 视为 P0/P1 候选证据，必须放进 `signalIds`。

### 7.4 验证

- 单元测试：构造 focal commitment，挂上 blocker；断言 `activeBlockers` 返回该 blocker；blocker.status 改 'done' → 再算返回空。
- 集成测试：跑一次 attention，对比 packet 加入 graphContext slice 前后 `<graphContext>` 是否出现、prompt token 估计差额 ≤300。
- eval：用历史 attention items 回放，统计 P0 召回是否提升、误报是否未恶化。

---

## 8. 自审

写完之后停下来通读了一遍。下面列出我自己看到的问题、不确定的地方和替代方案，便于讨论：

### 8.1 已知薄弱点

1. ~~**§3.7 一次性 `DROP TABLE context_relations` 是有风险动作**~~。**已修**：§3.7 / §5.4 已改为 Phase B 不 drop，保留物理 schema，下个 minor release 单独 PR 处理。

2. **PersonProjectEdge SQL 在 §5.2 用到了 `context_space_links` 把 unit 关到 space**——这个 join 路径假设「unit 已经被 link 到 space」。Phase B 之前要先校验：当前线上数据中，多少 work-scope commitment/goal 已经有 space_link？如果覆盖率 < 70%，边的召回会塌。需要在 Phase B 起手做一个 `SELECT COUNT(*) FROM ...` 体检脚本。

3. ~~**`larkOrgCollector` 限频写得不够具体**~~。**已修**：§4.1 / §4.2 明确：单 entity 24h TTL（按 `larkSyncedAt` 算），单次 run 只刷过期的 ≤20 个，避免 hammer。

4. ~~**`computeOrgRoleFromMe` 在 self 还没拉到飞书数据时怎么办？**~~ **已修**：§4.2.5 已写明 self=null 或 larkSyncedAt 缺失时返回 `undefined`（不是 `external`）；T10 用例覆盖。

5. **Phase B SQL 里的 `julianday()` 是 sqlite 特有函数**。better-sqlite3 应该支持，但如果未来换 db 引擎会出问题。**建议把衰减算法从 SQL 提到应用层 JS**：SQL 只 SELECT 出 (person_id, project_id, unit_updated_at)，weight 在 inducer.ts 里 reduce。这样 SQL 也更短。

6. **Phase C LLM 反馈的「✗」按钮没写清楚 UX**：如果用户点了「这不对」，下一次 batch 跳过 24h，那 24h 后又会被打成同样的错标签。**应该写 entity_edge_overrides 表，永久压住这条边的 collabType**，跟现有 attention `not_relevant` 同样的语义。

7. **§7 `expectedButMissing` 的「应该出现但没出现」判定**写得太抽象。具体算法是什么？我心里的草稿：
   - 候选 person：在 focal-project 的 PersonProjectEdge 上 weight ≥ 0.5 但不在 focal-unit.entities 里
   - 候选 doc：focal-project 关联的 doc entity 但不在 focal-unit.entities 里
   - reason 文本必须含证据 unit count，例：「近 30d 与 X 在 5 条 unit 共现，本次未参与」
   
   这段应该补到 §7.1 里作为正式算法。

8. **没写 token 预算**。Phase D 加 `<graphContext>` slice 会膨胀 attention prompt input。`expectedButMissing` 单个 entity 一行算 ~30 tokens，10 个就是 300，跟全 packet 1500-token 限制相比已经是 20%。**应该在 §7.4 加 cap：`expectedButMissing.length ≤ 5`，`activeBlockers ≤ 3`**。

### 8.2 我故意不写到正文里的取舍

- **没有引入图数据库**。SQLite 自连接 + 应用层组装能完整覆盖本期需求；引入 neo4j / dgraph 是十倍工作量，没成比例回报。
- **没有 inducer 的实时增量**。每次 attention tick 之前 5min throttle 跑一次全表 inducer。当 unit 量 < 10k 时是 < 200ms 的事。等到性能塌再改增量。
- **没把 boundary_rules 接入图**。boundary rule 是用户层的过滤器，不应该参与拓扑推断；attention prompt 单独消费。

### 8.3 不确定的事实（Phase A' 启动前已验证 2026-05-26）

| 待验证 | 结论 |
|---|---|
| 飞书 contact.v3 user 接口返回 `leader_user_id` 字段 | **当前 scope 拿不到**（需 `contact:user.employee:readonly` 审批）。Phase A.5 处理 |
| `lark-cli` 现有封装 | `contact +get-user` 只返回 basic profile（无 leader/dept）；`contact +search-user` 返回 `is_cross_tenant` + `department`（字符串）+ `email` + `has_chatted` + `p2p_chat_id`，**这是 Phase A' 数据源** |
| `contact/v3/users/basic_batch` | 只返回 `name` + `i18n_name`，比 `+search-user` 还少；不采用 |
| `/contact/v3/users/:user_id`（重接口） | 401 permission denied → 等审批 |
| 当前 person entity 里 `larkOpenId` 的别名是否已被 `nameResolver` 覆盖 | 需要在 Phase A' 实施时检查 `entity_aliases` / `nameResolver.ts`，看是否已把 open_id 落地；若没有，larkOrgCollector 入库时一并写 alias |

### 8.4 命名 / 文档冲突自查

- 我在 §3.1 用了 `orgRoleFromMe`，§4.1 stakeholder slice 里写的是 `orgRole`。语义上前者描述「TA 相对于我」是什么角色，后者是给 LLM 看的短名。**应该统一：内部存 `orgRoleFromMe`，render 给 LLM 时简称 `orgRole`**——已经是这个意图，但要在 §4.1 / §4.3 prompt 改动里写清楚。
- §3.3 / §3.4 用 `weight`，§5.2 SQL 也是 weight，一致。
- Phase B 的 inducer 写成 "5min throttle"，Phase C 写成 "每日 batch"，没冲突，应该明确写在 §5.1：inducer 是高频的（5min cache），Phase C LLM 是低频的（每日）。

### 8.5 如果只能做一件事

如果时间预算被砍到一周，**只做 Phase A'**。理由：
- 它独立可用：把"外部人请求自动降级"+"跨部门请求倾向 P2"直接落到用户体验（manager 加权等审批，放 A.5）。
- 它是后面所有 phase 的前置（org_role / department_name 数据必须先有）。
- 它是唯一一个「外部 API 调用 + 数据落库 + prompt 改动」的小闭环，能跑完整链路 dogfood。
- Phase B/C/D 在 Phase A 没数据时跑不出有意义的图。

### 8.6.2 Phase A' 配额 + alias 反查扩展（2026-05-26 二轮 dogfood）

dogfood 反馈："collector 一次只刷 20 个太少；Work Map 有 3 个相关人（杨薛莎/王奕迪/鲁升纲）没 ou_ alias 永远刷不到"。

实施：
- `MAX_PER_RUN` 从 **20 → 200**。lookupUsers 内部 80/chunk → 单 run 最多 3 次 lark-cli 调用，每次 ~1s。这是本地 CLI + 飞书内网调用，没必要保守。
- `runLarkOrgSync` 加 `opts.maxPerRun?` 参数让测试可压低（T5 还测 20-cap 行为；T5.bis 验证默认 200 行为）。
- 新加 `searchUserByName(name, {hasChatted:true})` ([larkOrg.ts](../apps/server/src/util/larkOrg.ts))：用 `+search-user --query --has-chatted` 反查 open_id。`has-chatted` 大幅降低同名碰撞（大企业里"王某某"重名多）。
- 新加 `resolveMissingAliasesForWorkMapPeople()` ([larkOrgCollector.ts](../apps/server/src/collectors/larkOrgCollector.ts))：collector 主同步前先跑这一步。给 Work Map relationship 里有 entity 但 aliases_json 缺 ou_ 的人按名字反查 + 写 alias。
- 去歧义：(1) 0 个候选 → skip + warn；(2) 1 个 → 用；(3) 多个 → 找 localized_name 完全相等的子集，恰好 1 个 → 用，否则 skip。**不冒充猜测**。

dogfood 验证（真 db）：
- 3 个之前没 alias 的人（杨薛莎 / 王奕迪 / 鲁升纲）全部 has_chatted=true 单匹配命中，alias 补全
- 一轮 collector run：refreshed=19, skippedFresh=97, failed=74（dead ou_）
- `stakeholderOrgRoles` 从 22 → 74 人；11/11 Work Map relationship 全部有 chip
- 杨薛莎 fn=null 是 LLM 正确判断（部门名 "Lark Base" 没有 function 后缀）

### 8.6.1 Phase A' 部门解析扩展（2026-05-26 收到 dogfood 反馈后追加）

用户反馈：strict equality 导致同业务（同 Lark Base 但不同部门）的人都被打成 `cross_dept`，不够细。要求**从部门名解析出 business + functionPath**，并新加一档 `same_business_cross_function`。

实施：
- 新表 `org_department_taxonomy`（表名去 lark 化）：dept_name → business / function_label / function_path_json，**永久缓存**。
- 新 LLM agent `aiisn-dept-taxonomy`（[util/departmentTaxonomyPrompt.ts](../apps/server/src/util/departmentTaxonomyPrompt.ts)）：handles 业务前缀 (`TikTok-XX`)、职能前缀 (`Lark Design-Base`)、混合格式 (`Lark Base Engineering-Infra-Performance`) 三类。
- [util/departmentTaxonomy.ts](../apps/server/src/util/departmentTaxonomy.ts) 批量解析、单 unique 串只跑一次 LLM。
- [larkOrgCollector.ts](../apps/server/src/collectors/larkOrgCollector.ts) 接入：拿完 self/批量 LarkUserInfo 后，汇总 unique department，调 parseDepartments，把结果写进每个人的 attrs；force-refresh 旧 entity（has dept but no business）。
- [personOrgRole.ts](../apps/server/src/context/personOrgRole.ts) 新增 `same_business_cross_function`：部门串不等但 `larkDeptBusiness` 相等。优先级：external > peer_same_dept > **same_business_cross_function** > cross_dept > undefined。
- attention prompt 行尾标签从 `[orgRole=...]` 扩成 `[orgRole=... biz=... fn=...]`；铁律 §11 加 `same_business_cross_function` 行为：倾向 P1 但要看实际相关性。
- 前端 chip 文字变 `"同业务 · Lark Base / Engineering"` 二级显示，新增蓝绿色 `wm-chip--same-biz`。

dogfood 验证（2026-05-26 真 db）：
- 9 个 unique 部门字符串，LLM 一次解析全部正确（含中英文 + 多义嵌套，最难的 `Lark Design-Base → business=Lark Base, function=Design` 也对）
- 12s 单次 LLM 调用；二次调用 0s（全缓存命中）
- 14 个 Lark Base 系 entity 正确归为 `same_business_cross_function`；懂车帝 / Global E-Commerce 正确归为 `cross_dept`

### 8.6 Phase A → Phase A' 范围变更记录（2026-05-26）

| 信号 | 原 Phase A 计划 | Phase A' 实际 | 备注 |
|---|---|---|---|
| `external` | ✓ `larkDeptId == null` 推 | ✓ `is_cross_tenant` 直接得 | A' 实现更精确 |
| `peer_same_dept` | ✓ id LCA | ✓ 字符串 `department` 相等 | 精度降低但够用 |
| `cross_dept` | ✓ id LCA 不同 | ✓ 字符串不等 | 同上 |
| `manager_of_me` | ✓ leader_user_id 上溯 | ✗ 推迟到 Phase A.5（等 `contact:user.employee` 审批） | **主要损失** |
| `report_of_me` | ✓ | ✗ 推迟到 Phase A.5 | 主要损失 |
| `job_title` | ✓ | ✗ 推迟到 Phase A.5 | 暂未使用 |

---

## 9. 验收

### 9.1 Phase A

- 所有 vitest 全绿（含新增 §4.3 的 10 条用例）
- 手测：作者本地接通飞书后，能在 sqlite 里看到 self 的 `attributes_json` 含 `larkLeaderOpenId`
- attention 链路：构造一条「leader 发起的 IM」事件 → triage 产生 unit → attention tick → 看到至少 P1 卡片，`why` 字段引用 `orgRole=manager_of_me`

### 9.2 Phase B

- inducer 跑一次后，`entity_edges` 不为空，且对样本数据手算的 PersonProjectEdge 与跑出来的一致（差异 < 5%）
- WorkGraphPanel 能渲染至少 5 个节点、3 条边
- 边的 evidence hover 能展示对应 unit title

### 9.3 Phase C

- 抽 20 条 PersonPersonEdge 的 `collabType` 标签，人工评审准确率 ≥ 70%
- 项目 phase 标签在 dogfood 用户的 3 个项目上「明显合理」（人评）

### 9.4 Phase D

- attention eval 集（如有）跑一次：P0 召回不下降、误报不上升
- 给定一条 commitment focal，`assembleGraphContext` 返回的 activeBlockers / expectedButMissing 在人评下"至少 1 条有用"

---

## 10. 风险与待定

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 飞书 OpenAPI 接口字段名与本文假设不符 | 高（卡 Phase A） | Phase A 启动当日做 §8.3 4 项验证 |
| inducer SQL 在 unit 量大时慢 | 中 | 加 5min cache + LIMIT；监控耗时，必要时改增量 |
| LLM 给 collabType 标签长期错误 → 用户每天点叉 | 中 | §6.3 反馈通道是硬要求；上线后第二周做一次抽样审查 |
| `expectedButMissing` 误报让 attention "建议补抄一堆人" 显得啰嗦 | 中 | §7.4 cap=5；上线后看 dismiss 率，必要时再收紧 |
| 用户改名 / 调岗后图没及时刷新 | 低 | larkOrgCollector 24h TTL；变化大的话用户可以触发 manual `runCollectorsOnce` |

---

## 11. 不在本期范围

- 跨用户图（多人共享同一张图）
- 图历史快照 / 时间旅行查询
- 图编辑 UI（拖边、增删节点）
- 飞书部门树全量同步
- 项目间「阻塞」关系（永远在工作项层，不在项目层）
