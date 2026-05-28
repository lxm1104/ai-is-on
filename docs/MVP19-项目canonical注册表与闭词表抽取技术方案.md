# MVP19 项目 Canonical 注册表与闭词表抽取技术方案

## 背景

当前项目（project）语义在系统里有三个独立来源：

| 来源 | 表 | 谁写入 | 粒度 |
|---|---|---|---|
| ① 用户/work-map 显式声明 | `context_spaces` | `work-map writer` / 用户 | 粗（4 个 space） |
| ② LLM 从信号文本归纳的 canonical | `org_project_taxonomy` | LLM (`induceProjectTaxonomy`) | 细（已 50+ 行） |
| ③ 每次 triage 抽出的 entity mention | `context_entities (type='project')` | 每次 triage LLM | 散，每个 mention 可能创建一行 |

**三层之间没有任何关系链路**，由此产生两类系统性故障：

### 故障 A：源头幻觉

triage prompt §schema 示例里写过 `{"type":"project","name":"AI is ON","role":"about"}`。LLM 在不知道用户实际有哪些项目的开放抽取条件下，把示例值当真照抄、或从无证据的文本里造出新项目名。下游 `personProjectInducer` 据此把伪 project 写进 `entity_edges`，再被 `selfCollaboratorRanking` 算成 `sharedProjects`，最终在 attention 推理里以"程圣淳是 AI is ON 共项目成员"这种站不住脚的论据出现。

### 故障 B：子项目孤儿

② 中已经存在 `Chatbot`、`Chatbot Skill Market`、`Chatbot Agent Builder`、`Chatbot Badcase 收集跟进`、`Chatbot 接入 Workspace`、`Chatbot 支持在会话内分享`、`Chatbot一期` 等 8 个 Chatbot-* canonical，它们彼此孤立，也跟 ① 中唯一的 `Chatbot 产研协同` space 无关。用户跟某人聊"Chatbot Skill Market"具体某个文档时，triage 抽出的 project entity 落到一个无 space 关联的 canonical 上，整段对话无主漂流，attention 后续既不能算到对应 space，也无法跟同业务的其他信号合并。

两类故障同根：**LLM 在 project 维度是开放抽取的，且抽出的结果没有归属/层级元信息**。挨条修是 O(N)，N 还在增长；这个 MVP 从源头治理。

## 目标

1. **D**：把 `org_project_taxonomy` 升级为带层级的 canonical 注册表，让 ② 内部的细粒度 canonical 可以挂到 ① 的粗粒度 space 对应 canonical 之下，形成树状归属关系。
2. **E**：所有产出 project entity 的 LLM 调用（triage 是主战场）改成**闭词表抽取**——只能从已知 canonical 列表里选，列表外的命中必须显式落进 `proposedNewProjects` 字段，进入审核队列等待用户确认或归并。
3. 下游 resolver（`resolveProjectCanonical`、`selfCollaboratorRanking.computeSharedProjects`、`resolveUnitToSpaces` 在 project entity 路径上的匹配）沿 parent 链向上展开，使子项目命中的证据自动算到父级空间。
4. 配套一次冷启动洗数据：把现有 8 个 Chatbot-* canonical 挂到 `Chatbot 产研协同` 之下，其他孤立 canonical 不动，由 E 的审核流逐步归并。

## 非目标

- 不引入多 parent / DAG，单 parent 树足以覆盖所有当前场景。复杂度留给真实需求出现时。
- 不为每个 sub-canonical 自动建 `context_spaces` 行。space 仍是用户/work-map 决定的"我要为这件事开一个仪表盘"。
- 不做"LLM 自动猜 parent"的归并 inducer——不再引入新幻觉源头，parent 关系一律由用户或 work-map writer 显式声明。
- 不做 person/doc 维度的同类治理——本 MVP 仅覆盖 project。person canonical 走 Lark ID 已足够稳定；doc canonical 重复问题（同一 doc 4 个 entity 行）单独走 MVP17 邻居索引方向修。
- 不做完整审核 UI；初期审核走 SQL + 一个最小列表页（路由占位即可）。

## 数据模型

### D-1：扩展 `org_project_taxonomy`

用现有 [`ensureColumn` helper](apps/server/src/db.ts:400)（与 `cards.actions_json`、`events.context_extracted_at` 等列同模式）：

```ts
ensureColumn('org_project_taxonomy', 'parent_canonical_name', 'TEXT');
ensureColumn('org_project_taxonomy', 'authoritative_space_id', 'TEXT');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_opt_parent
    ON org_project_taxonomy(parent_canonical_name);
`);
```

- `ensureColumn` 已经做了 `PRAGMA table_info` 探测 + `ALTER TABLE ADD COLUMN`，replay-safe。
- 不写 `REFERENCES` 子句（`PRAGMA foreign_keys` 未启用，写了也是装饰），引用关系由应用层校验。
- 命名遵循现有 snake_case（同表已有 `canonical_name`、`aliases_json`、`parsed_by` 等）。

字段语义：

- `parent_canonical_name`：归属的父 canonical。**NULL = 顶层**（要么本身就是 work-map space 对应的 canonical，要么是用户尚未归类的散点）。禁止形成环（由 application-layer 校验）。
- `authoritative_space_id`：本 canonical 直接对应一个 `context_spaces.id` 时填。父 canonical 一般填；子 canonical 通常不填（它们的归属通过 parent 链解析到父）。这一列是 ① ↔ ② 的**显式锚点**，避免靠 name 字符串相等去对齐 space 和 canonical。

不动的字段：`canonical_name`（仍是 PK）、`aliases_json`（仍是该 canonical 的别名集）、`summary`、`parsed_by`、`parsed_at`。

### D-2：alias 跨行唯一性强化

现状：[`upsertProjectTaxonomy`（db.ts:2933）](apps/server/src/db.ts:2933) 已经做"同 canonical 行内 aliases 并集合并"——这部分**保留**。

新增：在该函数顶部加跨行检查——proposed `aliases_json` 里的每个字符串（lower-case 化后比对），不能出现在**其他** canonical 行的 `aliases_json` 中；冲突即 throw `AliasConflictError`，要求显式合并。

不通过 DB 唯一约束实现（SQLite 对 JSON 字段做 UNIQUE 成本高且不通用），仅在 upsert 入口做。

### E-1：新建 `project_canonical_proposals`

```sql
CREATE TABLE IF NOT EXISTS project_canonical_proposals (
  id TEXT PRIMARY KEY,
  proposed_name TEXT NOT NULL,         -- LLM 原文抽出来的项目字符串
  source_unit_ids_json TEXT NOT NULL,  -- triage 出处 unit id（用于审核时看上下文）
  source_event_id TEXT,                -- 触发 triage 的 raw event id，可选
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'approved_new' | 'approved_alias' | 'rejected'
  resolved_canonical_name TEXT,        -- approved 时填：归到哪个 canonical
  resolved_as_parent_canonical TEXT,   -- approved_new 时可选：直接指定 parent
  resolved_by TEXT,
  resolved_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pcp_proposed_pending
  ON project_canonical_proposals(proposed_name)
  WHERE status='pending';

CREATE INDEX IF NOT EXISTS idx_pcp_status_lastseen
  ON project_canonical_proposals(status, last_seen_at DESC);
```

去重逻辑：同一个 `proposed_name` 在 `pending` 状态下只允许一行，重复触发只 bump `occurrences` + `last_seen_at` + append `source_unit_ids_json`（保留最近 N 条，避免无限增长，N=20）。

### 不动的表

- `context_spaces` / `context_space_links`：不动。
- `entity_edges (person_project)`：schema 不动，**写入语义不变**（继续按抽出来的细 canonical 写边，weight 不拆给 parent；展开 parent 由读侧 resolver 做）。
- `context_entities (type='project')`：不动。E 的闭词表强约束 LLM 不再发明新 entity 名，存量伪 entity 由冷启动洗一次。

## 行为设计

### D：解析与展开

对外 API 拆成三个函数，签名最小破坏现状：

- `resolveProjectCanonical(name) -> string`：**保持现有签名不变**（[db.ts:2985](apps/server/src/db.ts:2985)），所有 4 处现有调用方（`personProjectInducer.ts:102`、`graphContextAssembler.ts:195`、`util/projectTaxonomy.ts:183/186` 内部用）无需修改。
  - 内部改一处：alias 命中**改为大小写不敏感比较**（`lower(input) === lower(alias)`），注册表存储仍保持原始大小写（人类可读）。例：LLM 抽出 `"chatbot"` 命中 alias `"Chatbot"`，返回 canonical 仍是 `"Chatbot"`。`canonical_name` 是 PK 仍大小写敏感（避免 `Chatbot`/`chatbot` 共存两行）；upsert 入口做规范化。
- `getProjectAncestorChain(canonical: string) -> string[]`：**新增**。沿 `parent_canonical_name` 上溯到 NULL 组成 chain（不含自身）。环防护：traversal 超过 32 层立刻 throw + 写 audit。canonical 不存在返回 `[]`。
- `getProjectCanonicalSet(name: string) -> Set<string>`：**新增便利函数** = `{canonical} ∪ ancestorChain`。给 `selfCollaboratorRanking` / `resolveUnitToSpaces` 这类需要求交的下游用。

三个函数都放在 [db.ts:2912 现有 org_project_taxonomy 章节](apps/server/src/db.ts:2912) 末尾追加，**不新建文件**。

`getProjectCanonicalSet` 给两个下游用：

**`selfCollaboratorRanking.makeEntry`**（[selfCollaboratorRanking.ts:175](apps/server/src/context/selfCollaboratorRanking.ts:175)）—— 现状 line 84 `selfProjects = Set(self person_project edges to_id)`、line 188-193 同样取 `otherProjects`，line 193 直接 filter 求交。改造：把这两个 set 都通过 `getProjectCanonicalSet` 展开为"自身 + 祖先"的并集，再求交。`sharedProjectCanonicalNames` 字段语义不变，但实际命中会更宽（带父）。

例：self 的 person_project 边里有 `Chatbot 产研协同`，other 的边里有 `Chatbot Skill Market`（parent = `Chatbot 产研协同`）。展开后 self = `{Chatbot 产研协同}`、other = `{Chatbot Skill Market, Chatbot 产研协同}`，交集 = `{Chatbot 产研协同}`，正确。

**`resolveUnitToSpaces`**（[contextSpaceService.ts:322](apps/server/src/spaces/contextSpaceService.ts:322)）—— 现状对每个 routing entity 走 `resolveOrCreateEntity` + `listSpacesForTarget('entity', entId)`。改造：当 `e.type === 'project'` 时，**额外**走一条路径——`getProjectCanonicalSet(e.name)` 拿到名字集合，遍历集合 + 各自的 alias 反查 `org_project_taxonomy.authoritative_space_id`，命中即作为一个 `SpaceLinkHit` 候选进入同一个 `bestPerSpace` 比较。entity 自身的 seed 路径（`listSpacesForTarget`）继续保留作为兜底。新增的 hit 用 `via='project_canonical'` 写入 reason，rank 复用 project 档（rank=3）。

**渲染层**：
- `renderMyTopCollaborators` 的 `共项目=[...]` 标签直接读 `sharedProjects`（已展开过 parent），无需改逻辑，但渲染出来的项目名会自然偏向**父 canonical**（因为 ancestorChain 把子拉到父）。
- attentionPrompt §13.f 不需要改文案。

### E：闭词表抽取

#### 1) triagePrompt 注入 `<knownProjects>`

[triagePrompt.ts:buildUserMessage](apps/server/src/triage/triagePrompt.ts) 在 user message 里增加 block：

```xml
<knownProjects count="N">
- "Chatbot 产研协同" (alias: "Chatbot", "Chatbot 产研")
  sub: "Chatbot Skill Market", "Chatbot Badcase 收集跟进", ...
- "harness 优化原则" (alias: ...)
- ...
</knownProjects>
```

渲染来源：
- 顶层一行 = 父 canonical（`parent_canonical_name IS NULL`），优先排有 `authoritative_space_id` 的；
- `alias:` 来自该 canonical 的 `aliases_json`（截前 5 条，过长省略）；
- `sub:` 来自直接子 canonical（取前 8 条，过长省略）。

数量预算：当前实际 ~50 canonical，渲染后预计 ≤ 80 行，约 1500 tokens；超过 200 行时按 (a) 是否有 authoritative_space_id (b) 最近 30d 是否被 person_project 边引用 排序截断到 top 100。

block 放 **user message**（不是 system prompt），因为它会随时间漂移；放 system 会污染 prompt cache。

#### 2) triage 输出 schema 扩展

```json
{
  "items": [
    {
      ...
      "contextUpdates": [
        {
          "kind": "...",
          "entities": [
            {
              "type": "project",
              "name": "<必须是 knownProjects 里的 canonical 或 alias 之一>",
              "role": "about"
            }
          ]
        }
      ],
      "proposedNewProjects": [
        {
          "name": "<原文里出现但 knownProjects 里没有的项目名>",
          "evidence": "<不超过 60 字、引用原文片段>",
          "suggestedParent": "<可选；若 LLM 能判断属于哪个已知 canonical>"
        }
      ]
    }
  ]
}
```

#### 3) triagePrompt 铁律改写

原 §8 改为：

> **8. entities：每条 contextUpdate 列出涉及的人/项目/文档/任务。**
> - `type='project'` 时，`name` **必须**严格等于 `<knownProjects>` 里某行的 canonical 或 alias 字符串。原文里出现但匹配不到的项目名，**绝对不要写进 entities**，改为放进当前 item 的 `proposedNewProjects` 字段。
> - `type` 为 person/doc/task/org 时仍按原规则提取（这些不在本次治理范围内）。
> - 不要发明 entities，不要从示例值照抄。

`schema` 例子里 project entity 行同步改成 `"name":"<必须从 knownProjects 选；不在列表里则放进 proposedNewProjects>"`。

#### 4) triage 写库流程改造

[triage 落库处] 拿到 LLM output 后：

```
for each item:
  for each proposedNewProject:
    upsertProjectCanonicalProposal({
      proposedName, sourceUnitIds: 当前 item 内将 emit 的 unit id 集,
      sourceEventId
    })  -- pending 行 bump occurrences；新名字插入 pending 行

  // entities.project 走原 path，但 resolveProjectCanonical 此刻应该都命中
  // （因为 LLM 已按闭词表约束写出 canonical/alias）
  // 如果还是命中不到（LLM 抗指令）→ 同样转 proposedNewProjects，并写 audit
```

#### 5) 审核入口（最小可用）

新建 `/projects/proposals` GET（列 `status='pending'` 行，按 `last_seen_at desc`）和 POST（处理 approve/reject）。前期不做精致 UI，左侧导航加个入口跳一个朴素表格即可。

approve 行为：
- `approved_new`：写一行新 `org_project_taxonomy`，`parsed_by='user'`，可选填 parent；同时把 proposal 行的 status 置位、写 resolved_at。
- `approved_alias`：把 `proposed_name` 追加到 target canonical 的 `aliases_json`（先经过 D-2 的 alias 唯一性校验）；status 置位。
- `rejected`：仅 status 置位。被 reject 后下次同名再触发 → 又走 pending（occurrences 重置）；如果反复噪音可手动加 deny list（后续工作）。

### work-map writer 接入注册表

[bootstrap/workMapMutator](apps/server/src/bootstrap/workMapMutator.ts) 创建/更新 space 时同步：

- 如果 space 对应的 canonical 不在 taxonomy 里，自动 `upsertProjectCanonical({ canonical_name: space.name, parsed_by: 'work_map_writer', authoritative_space_id: space.id, parent_canonical_name: null })`。
- 如果存在但 `authoritative_space_id` 为 NULL，更新它指向当前 space。
- 不自动猜 parent。

这样 user-curated space 在 `<knownProjects>` 里始终是顶层选项，不会被 LLM 选成"某个 sub 的别名"。

## 关键改动点

| 文件 | 改动 |
|---|---|
| [`apps/server/src/db.ts`](apps/server/src/db.ts) | DDL：`ensureColumn` 加两列 + 建 idx_opt_parent；`CREATE TABLE IF NOT EXISTS project_canonical_proposals`。位置：紧贴现有 `org_project_taxonomy` schema 段（line 520-528）后追加 |
| [`apps/server/src/db.ts:2912`](apps/server/src/db.ts:2912) (现有 taxonomy helper 段) | `resolveProjectCanonical` 内部加 lower-case alias 比较；**新增** `getProjectAncestorChain` / `getProjectCanonicalSet` / `getProjectAuthoritativeSpaceId`；`upsertProjectTaxonomy` 顶部加 alias 跨行唯一性检查（throw `AliasConflictError`） |
| [`apps/server/src/context/personProjectInducer.ts:102`](apps/server/src/context/personProjectInducer.ts:102) | **无需改动**——继续 `resolveProjectCanonical(name) -> string` 单字符串签名，写边仍只写直接 canonical（不展开 parent，由读侧展开） |
| [`apps/server/src/context/selfCollaboratorRanking.ts:84,193`](apps/server/src/context/selfCollaboratorRanking.ts:84) | line 84 `selfProjects` 构建后过一遍 `getProjectCanonicalSet` 展开；line 193 `otherProjects` 同样展开后再求交 |
| [`apps/server/src/context/graphContextAssembler.ts:195`](apps/server/src/context/graphContextAssembler.ts:195) | **无需改动**——单字符串签名保留，下游 set 比较若需要"同业务大盘"语义可后续切到 `getProjectCanonicalSet`；本 MVP 不动 |
| [`apps/server/src/spaces/contextSpaceService.ts:322`](apps/server/src/spaces/contextSpaceService.ts:322) | `resolveUnitToSpaces` 在 `e.type === 'project'` 分支额外走 `getProjectCanonicalSet` → `getProjectAuthoritativeSpaceId` 查询，命中即作为候选 hit 进入 `bestPerSpace` 比较；reason `via='project_canonical'` |
| [`apps/server/src/triage/triagePrompt.ts:84`](apps/server/src/triage/triagePrompt.ts:84) (`buildTriageUserMessage`) | user message 增 `<knownProjects>` block；铁律 §8 改写（**supersede 当前已有的"entities.name 必须是信号原文里出现过的具体名字" hotfix**，新的 §8 同时覆盖闭词表 + 防发明两件事）；schema 例子加 `proposedNewProjects` |
| [`apps/server/src/triage/parseTriage.ts:129`](apps/server/src/triage/parseTriage.ts:129) | output schema 加 `proposedNewProjects: Array<{name, evidence, suggestedParent?}>` 解析 + 类型 |
| [`apps/server/src/triage/triageQueue.ts:170`](apps/server/src/triage/triageQueue.ts:170) | 持久化 contextUpdates 时：(a) 对 `entities.type === 'project'` 走一次 `resolveProjectCanonical`，命中失败的转 proposal；(b) item 上的 `proposedNewProjects` 直接 upsert 到新 proposal 表 |
| [`apps/server/src/bootstrap/workMapWriter.ts:172`](apps/server/src/bootstrap/workMapWriter.ts:172) | `createSpace` 调用后追加：`upsertProjectTaxonomy(canonical=space.name, parsed_by='work_map_writer', authoritative_space_id=space.id)`，不动 parent / aliases |
| `apps/server/src/routes/projects.ts`（新建） | `/projects/proposals` GET / POST |
| `apps/web/src/components/ProjectProposalsPanel.tsx`（新建） | 最小列表 + approve/reject（M4 锁死最小，不再加投资） |
| `.opencode/agent/aiisn-triage.md` | 同步 triage prompt §8 改动（保持单一来源） |
| `apps/server/test/mvp15a-project-taxonomy.test.ts` (现有) | **扩展现有文件**——加 ancestor chain / 大小写不敏感 / alias 跨行唯一性 / cycle 防护单测 |
| `apps/server/test/mvp19-*.test.ts`（新建） | E 路径的 closed-vocab triage 解析、proposal upsert、resolveUnitToSpaces project_canonical 路径 |
| `apps/server/src/attention/attentionPrompt.ts` | **不改**（rule 13.f 不动；shared projects 数据上游展开后渲染语义自然正确）|

## 冷启动 / 迁移

按以下顺序执行，全程可中断、可重跑：

**Step 1**：DDL 升级 + 新表创建（启动时迁移）。

**Step 2**：对每个现有 `context_spaces` 行，在 `org_project_taxonomy` 里：
  - 若 `canonical_name = space.name` 不存在 → INSERT 新行（`parsed_by='work_map_writer'`、`authoritative_space_id=space.id`、`parent_canonical_name=NULL`、`aliases_json='[space.name]'`）；
  - 若已存在 → 只 UPDATE 两列：`parsed_by='work_map_writer'`、`authoritative_space_id=space.id`。**不动 `aliases_json`、`parent_canonical_name`、`summary`**（避免覆盖 LLM 已积累的别名或人工已设置的 parent）。

**Step 3**：手工合并已知 Chatbot-* 家族（一次性 SQL，spec 落地时随迁移脚本一起跑）：

```sql
UPDATE org_project_taxonomy
   SET parent_canonical_name = 'Chatbot 产研协同'
 WHERE canonical_name IN (
   'Chatbot',
   'Chatbot Skill Market',
   'Chatbot Agent Builder',
   'Chatbot Badcase 收集跟进',
   'Chatbot 接入 Workspace',
   'Chatbot 支持在会话内分享',
   'Chatbot一期'
 );
```

其他 50+ 孤立 canonical **不动**——它们大多是真的散点，让 E 上线后的审核流自然合并。

**Step 4**：清理伪 project entity（参照前一次 "AI is ON" 清洗法）。删除条件**同时**满足：
  - `context_unit_entities` 里没有任何行引用该 entity_id
  - 该 entity 的 `name` 不在任何 `org_project_taxonomy.aliases_json` 数组里

满足上述两条的就是真孤儿（既没人引用又不在 canonical 注册表里），删除安全。本步可与 Step 1-3 解耦后续单独跑。

**Step 5**：E 上线后 24h 由**运维人眼检查**一次 `project_canonical_proposals` 表的 pending 行数（直接 SQL `SELECT count(*) WHERE status='pending'`）：

- 行数明显高于预期（量级感：本人当前每日新 event 约 N 条，预期 pending 行 ≪ N，因为大部分 event 命中存量 canonical 不需提议）→ 说明 LLM 在大量发明新词，可能是闭词表 prompt 没栓住。处理：降 triage 模型温度，或在 prompt 顶部加更严的负例 few-shot。
- 行数符合预期且 approve/reject 操作流畅 → 进入正常运行。

这一步是判断性而非阈值化的——不在 spec 写死数字，由运维基于上线第一天的实际分布决定基线。

## 测试计划

### 单测

- `projectTaxonomy.resolveProjectCanonical`
  - 单层：`"Chatbot Skill Market"` → canonical `"Chatbot Skill Market"`, ancestorChain `["Chatbot 产研协同"]`
  - 多层：人为构造 3 层，验证 ancestorChain 顺序
  - 环：构造 A→B→A，断言抛错
  - 别名：alias 命中后 canonical 正确
- `upsertProjectCanonical`：alias 唯一性冲突拒写
- `selfCollaboratorRanking.computeSharedProjects`：sub-vs-parent 交集正确
- `resolveUnitToSpaces`：project entity 走 ancestorChain → 命中父 space
- triage closed-vocab 解析：
  - 合法 entity (canonical 命中) → 正常写入
  - 合法 entity (alias 命中) → resolve 到 canonical 后写入
  - `proposedNewProjects` 数组解析正确，writeProposal upsert 行为正确
  - LLM 抗指令（entities 里写了 knownProjects 之外的名字）→ 转 proposal + audit
  - 同名 proposal **reject 后再次触发** → 应该重新进 pending，且不撞 `WHERE status='pending'` 的 partial UNIQUE 约束（reject 行的 status 已变更，partial index 不再包含它）
  - 审核 sub-canonical 但 `suggestedParent` 指向一个**尚未 approve 的 pending** proposal → approve 表单需提示"parent 未就绪"，禁用提交直到 parent 先 approve（或允许 approve 后 parent 字段留空，由用户后续补）

### 集成

- 跑一次完整 triage→inducer→ranking→attention 链路，构造一条"我跟程圣淳聊 Skill 市场"的伪信号：
  - 当 Skill 市场是 Chatbot 产研协同 的子 canonical 时，attention prompt 收到的 `myTopCollaborators` 里 程圣淳 的 `共项目` 字段应包含 `Chatbot 产研协同`
  - resolveUnitToSpaces 把该 unit 落到 Chatbot 产研协同 space
- triage 跑一条无任何 project 的 IM signal → 不出 proposedNewProjects、不污染 entity 表
- 跑一条带新项目名（如 "新项目 X"）的 signal → 写入 proposal 队列、entities.project 为空

## 上线窗口期行为

M1→M2 完成后数据层已具备 hierarchy 能力，但 triage prompt 闭词表 (M3) 尚未上线。这段窗口期内：

- 旧路径**完全保留**：triage 继续开放抽取、`personProjectInducer` 继续按新出现的 canonical 名写边；
- 新路径**已可用但未必命中**：`selfCollaboratorRanking` / `resolveUnitToSpaces` 已经走 ancestorChain 展开，Chatbot-* 家族已有的 person_project 边能立刻享受到归并好处；
- 行为变化：**不会变差，只会部分变好**——存量已被 Step 3 合并的 Chatbot-* 立即生效；新抽出的伪 canonical 仍会污染但不再继续滋生层级问题。

M3 上线那一刻 LLM 开始走闭词表，新增 canonical 行的增长率应骤降。Step 5 的监控以此为基线。

## 风险与对策

| 风险 | 对策 |
|---|---|
| `<knownProjects>` block 让 triage prompt 长度暴涨 | 截断策略（按 authoritative_space_id / recent edge ref 排序），监控 `inputSummary.tokenEstimate` |
| LLM 抗指令仍发明 entity | 兜底转 proposal + audit；累计 >N 次同模型出错 → 在 prompt 顶部加 negative few-shot |
| 用户不审核 proposal 队列，积压成噪音 | proposal 表 status=pending 行在 attention prompt 不参与；UI 加未审计数提示；积压 >30d 自动 reject 但保留 history |
| Cycle 在 hierarchy 中被人手造出 | resolver traversal 防御性检查 + audit；upsertProjectCanonical 写入前做 reachability 检查 |
| 现存 `Chatbot 产研协同` space 名字日后改了 | `authoritative_space_id` 是 id 锚点不依赖名字；canonical_name 改动需走显式 rename 流程（后续工作）|

## 非本次范围（明确留给后续）

- Person canonical / doc canonical 同模型治理。
- DAG（多 parent）；当真出现"Chatbot Skill Market 也属于 Cowork 业务"这种 cross-cut 需求时再扩。
- 自动 parent 推断 inducer（避免再开 LLM 幻觉口子）。
- canonical_name 改名 / 合并流程的 UI。
- proposal 队列高级管理（deny list、批量操作）。
- 把 sub-canonical 的 person_project edge 自动 lift 到 parent（当前选 read-side 展开；如果将来读侧成为热点，可加 dual-write，但要解决 weight double-count 问题）。

## 里程碑

- **M1（半天）**：D-1 / D-2 DDL + projectTaxonomy.ts 单测过。
- **M2（半天）**：selfCollaboratorRanking + resolveUnitToSpaces 接入展开逻辑；冷启动 Step 1-3 跑通；集成测过。
- **M3（一天）**：triagePrompt closed-vocab 改造 + proposal 写库 + parser 测过。
- **M4（半天）**：最小 proposals 路由 + 前端列表；端到端跑一次伪信号。**审核 UI 锁死在这一档**——纯 GET 列表、点击行触发 approve/reject POST、无样式、无分页、无批量操作；本 MVP 之后也不再继续投入 UI，必要时直接 SQL 操作。
- **M5（半天）**：上线观察 24h；冷启动 Step 4-5；记录基线指标（每日 proposal 增量、命中率）。

总计约 3 天。
