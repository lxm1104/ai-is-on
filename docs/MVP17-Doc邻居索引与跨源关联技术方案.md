# AI is ON：MVP17 Doc 邻居索引与跨源关联技术方案

> 目标：把"散落在群消息 / 单聊 / 评论 / 妙记里的同一份文档相关内容"在 context 层显式串起来，给 agent 一个 `<artifactContext>` slice：当 packet 含某 doc entity 时，能稳定看到"跟它一伙"的其他 doc / minute / 评论摘要清单，不靠 LLM 现猜也不串错信。

本方案基于 2026-05-26 与用户的对话，经一轮自审后返工。

---

## 0. TL;DR

不做 cluster、不做 union-find、不新建表。复用 MVP15 `entity_edges` 加 `edge_kind='doc_co_mention'`，给 doc entity 之间建带权重的协作边；`artifactIndexService` 只做"给定 doc entity，按边权重返回 top-K 邻居 artifact"；`agentContextAssembler` 加一个 `<artifactContext>` slice，**强制接 boundary 过滤**；doc 的 `displayTitle / lastSnippet` 在 collector 阶段回填到 `entity_aliases.attributes_json`，assembler 同步链路不外呼飞书 API。

三个 phase 单独可落、单独有用：

- **Phase A**：`entity_aliases` 扩 `attributes_json`，collector 回填 doc 标题 / snippet（1-2 天）
- **Phase B**：`docCoMentionInducer` 跑 SQL 出 doc-doc 边（依赖 MVP15 Phase B 的 `entity_edges` 表；若 MVP15 未落，本期自建最小子集）（2 天）
- **Phase C**：`artifactIndexService` + `<artifactContext>` slice + boundary 接入（1 天）

合计 4-5 天。tool call (`lookup_artifact` 让 LLM 按需拉正文) 拆到 MVP17.1 独立做，因为要改 agent 的多轮 tool-use 框架，本期不动。

---

## 1. 背景

### 1.1 现状

文档信号链路（MVP11 已落）：

- `driveCollector` 采"我编辑过的 doc" → unit `kind='doc_update'`
- `driveCommentCollector` 采评论 + @我 → unit `kind='doc_comment'` / `doc_comment_reply`
- `meetingArtifactCollector` 采妙记 + 会议 AI 纪要 → unit `kind='meeting_artifact'`
- `imCollector` 通过 `extractFeishuDocEntities(text)` 从消息正文抽飞书 URL → 挂成 `entity{type:'doc', name:url}` 到 message unit 上（[imCollector.ts:591](../apps/server/src/collectors/imCollector.ts:591)）
- `entityResolver.mergeEntities` 把 `doc:<token>` 和 `doc:<url>` 合成 alias 链（MVP11 §2-3）

doc 身份归一是有的，**doc 之间的关联完全没有**。

### 1.2 痛点

1. **同一件事的 artifact 散在各处但看不见**：doc A 的需求文档、关联的会议妙记、群里贴出来时同事追问的 doc B、评论里 @我 的 thread —— 每一条都有 unit，但 agent 拿到 A 时不知道 B/会议/评论的存在
2. **每个 agent 都要现拼 SQL**：`recap` 想看"这周关于 doc A 的所有动静"、`attention` 想知道"群里追问 doc A 时还提了哪些 doc"，都得自己写 join
3. **MVP13 LLM space 建议是粗粒度归类**：space 是"文件夹"级别，回答不了"这份具体文档背后的小卷宗"
4. **MVP15 Work Map 只画了人和项目的图**：doc 这一类节点没进图

### 1.3 思考方向（用户提出，2026-05-26 对话）

> 「context 中的文档、会议纪要等等在群里出现过的内容，也应该作为 context 被记录下来，有一个表可以索引。这些文档会散落在不同的地方，但它其实都是跟一个事情相关的，所以应该在 context 层面把这些关联建立起来，这样当用户针对其中某一个问题需要解决或提出疑问的时候，能够把所有的文档关联串起来，作为 context 的输入提供给 LLM。」

后续讨论中达成的关键纠偏：

- **不做 cluster / union-find**：共现图 + 传递闭包会塌成超大连通分量，用"邻居查询"代替
- **不让 LLM 增删拓扑**：边由 SQL 推，跟 MVP15 D6 一致
- **必须接 boundary**：跨 chat 的 doc 邻居要按当前 actor / chat 的可见性过滤，避免隐性串信息

---

## 2. 关键设计决策（共识纪要）

| # | 决策 | 替代方案与不选原因 |
|---|---|---|
| D1 | **邻居查询，不做 cluster** | union-find 会塌成超大连通分量（doc A→B→C→…几乎全连通），top-N 退化成"全局热门 doc"。改成"以 packet 主 doc 为锚，按边权重取 top-K"，不做传递闭包 |
| D2 | **复用 MVP15 `entity_edges` 表，加 `edge_kind='doc_co_mention'`** | 新建 `doc_doc_edges` 表会跟 MVP15 D8 撞车（"同质边收一张表"）。doc 边的 schema 跟 person-person 边几乎相同，复用即可 |
| D3 | **doc 标题 / snippet 在 collector 阶段回填到 entity attributes，assembler 不外呼** | assembler 是同步链路，外呼飞书 API 会卡 agent run；title 是 doc 稳定属性，回填一次缓存 24h 即可 |
| D4 | **强制接 boundary**：`artifactIndexService` 返回前必须按 `boundaryEvaluator` 过滤 | 不接 boundary 会泄漏：用户在 chat#X 问 doc A，assembler 拉出 doc A 在 chat#Y（敏感同事）共现的 doc B snippet → 隐性串信息 |
| D5 | **边权重 = 共现次数 × recency半衰期(30d)，单聊 thread 共现 ×2 加权** | 单聊里贴的 doc 信号比群里强；MVP16B 落地后接 thread 共现，本期先按 unit 共现做 |
| D6 | **tool call (`lookup_artifact`) 拆到 MVP17.1，本期只做 assembler 静态注入** | tool-use loop 改造涉及 agent handler / LLM 调用层 / response parser / loop control，是独立 3-5 天工程 |
| D7 | **本期不引入 cluster id 概念**。`artifactIndexService` 只暴露 `getNeighbors(docEntityId)`，不暴露 `getCluster()` | 一旦暴露 cluster id，下游就会依赖；后期想改成 community detection 就被锁死 |
| D8 | **doc 节点身份完全复用 entityResolver canonical**：`getNeighbors` 入参先 `resolveAliased`，出参也是 canonical | MVP10 已经投资了 alias 链，这里不能绕开 |

---

## 3. 数据模型

### 3.1 doc 节点（不新建表，扩 `entity_aliases.attributes_json`）

不新建表，给 `entity_aliases` 增 `attributes_json TEXT` 列（已经在 MVP15 给 `context_entities` 加过同名列；如 MVP15 未落，本期独立加到 `entity_aliases`）。在 `type='doc'` 时按下面 schema 填：

```ts
type DocAttributes = {
  // ====== 来自 driveCollector / driveCommentCollector / meetingArtifactCollector 的首见时回填 ======
  displayTitle?: string;            // 文档标题（飞书 metadata API 返回的 title）
  ownerOpenId?: string;             // 文档所有者 open_id（用于 boundary 判定）
  docType?: 'docx' | 'sheet' | 'bitable' | 'wiki' | 'minute' | 'unknown';
  lastSnippet?: string;             // 最近一次 unit 的 summary_text 截 80 字
  lastSnippetUnitId?: string;       // 上面 snippet 来自哪个 unit
  fetchedAt?: string;               // ISO，TTL 24h；过期由后台任务刷新
  // ====== 由 imCollector 旁路统计的弱信号，不参与 boundary，仅供边权重 prior ======
  seenInChatIds?: string[];         // 这份 doc 在哪些 chat 被贴过；上限 20，FIFO
  seenInP2pPeers?: string[];        // 这份 doc 在跟谁的单聊里贴过；上限 20，FIFO
};
```

回填规则（**collector 阶段同步写**，不走 LLM）：

- driveCollector 首次见某 doc → 取 `displayTitle` / `ownerOpenId` / `docType` 写入
- driveCommentCollector 处理评论时，若 entity attributes 缺 `displayTitle`，调一次飞书 doc metadata API 回填（throttle: 同 doc 24h 只调一次）
- meetingArtifactCollector 写 minute unit 时，给 `entity{type:'doc', name:'minute:<token>'}` 写 `displayTitle = minute.title`、`docType = 'minute'`、`lastSnippet = summary.first_paragraph`
- imCollector 抽 doc URL 时，append `chatId` 到 `seenInChatIds`、append peer 到 `seenInP2pPeers`（去重 + FIFO 20）

### 3.2 DocCoMentionEdge（复用 MVP15 `entity_edges`）

依赖：MVP15 Phase B `entity_edges` 表已落。若 MVP15 未落，本期独立建一张最小子集（schema 一致，无 evidence 数组以外的字段，迁移时合并）。

schema（已存在 / 待建）：

```sql
CREATE TABLE IF NOT EXISTS entity_edges (
  id TEXT PRIMARY KEY,
  edge_kind TEXT NOT NULL,           -- 'person_person' | 'doc_co_mention' (本期新增)
  entity_a_id TEXT NOT NULL,         -- 字典序 min(a, b)，保证无向边唯一
  entity_b_id TEXT NOT NULL,         -- 字典序 max(a, b)
  weight REAL NOT NULL,
  evidence_unit_ids TEXT NOT NULL,   -- JSON 数组，上限 10
  last_seen_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(edge_kind, entity_a_id, entity_b_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_edges_a ON entity_edges(edge_kind, entity_a_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_entity_edges_b ON entity_edges(edge_kind, entity_b_id, weight DESC);
```

`doc_co_mention` 边的语义：两个 canonical doc entity 在 ≥1 个 ContextUnit 上共同出现。

边权重计算（确定性 SQL，本方案 §5.1 给出片段）：

```text
weight = Σ over evidence units e:
           src_factor(e) × recency_decay(e.timestamp, halflife=30d)
where
  src_factor(unit) = 2.0  if unit 来自单聊 thread (source='im_p2p')
                   | 1.0  if unit 来自群消息 (source='im_group')
                   | 1.5  if unit 来自 meeting_artifact / doc_comment
                   | 0.5  if unit 来自 doc_update（仅"我编辑过"信号弱）
  recency_decay(t, h) = 0.5 ^ ((now - t) / h)
```

权重不归一化、不做阈值切边。读侧（artifactIndexService）按 weight DESC 取 top-K。

### 3.3 不引入的概念

- ❌ cluster id / community id
- ❌ doc → person / doc → project 的边（这两个分别由 MVP15 PersonProjectEdge 和现有 `context_unit_entities` 覆盖）
- ❌ doc-doc 边的 LLM 语义类型（"是同一份文档的版本" / "互相引用" 等；本期不让 LLM 推，未来 phase 再加）

---

## 4. Phase A — entity attributes 扩列 + collector 回填

### 4.1 改动清单

| 文件 | 改动 |
|---|---|
| `apps/server/src/db.ts` | `entity_aliases` 加 `attributes_json TEXT`；migration 幂等 |
| `apps/server/src/context/entityResolver.ts` | 新函数 `getDocAttributes(entityId)` / `mergeDocAttributes(entityId, partial)`；后者深合并 + 写库 |
| `apps/server/src/util/larkDocMetadata.ts`（新建） | `fetchDocMetadata(token, type)` → `{ title, ownerOpenId }`；24h TTL 内存缓存 |
| `apps/server/src/collectors/driveCollector.ts` | 处理 doc_update 时调 `mergeDocAttributes`，写 displayTitle / ownerOpenId / docType / fetchedAt |
| `apps/server/src/collectors/driveCommentCollector.ts` | 同上，对评论关联的 doc 回填 |
| `apps/server/src/collectors/meetingArtifactCollector.ts` | 给 minute entity 写 displayTitle / docType='minute' / lastSnippet |
| `apps/server/src/collectors/imCollector.ts` | 抽 doc URL 后 `mergeDocAttributes` 写 seenInChatIds / seenInP2pPeers |

### 4.2 实施顺序

1. db migration（独立 PR，无行为变化）
2. `larkDocMetadata.ts` + 单测（mock 飞书 API）
3. `entityResolver` 新增 getter / merger + 单测
4. 各 collector 接入 + 现有 collector 测试不应回归
5. dogfood：跑一遍 scheduler，检查 `entity_aliases.attributes_json` 是否被填上

### 4.3 验证

- 单测：`test/mvp17-doc-attributes.test.ts`
  - mergeDocAttributes 深合并语义（seenInChatIds 去重 + FIFO 20）
  - larkDocMetadata 24h TTL 命中第二次不调 API
  - driveCollector 首次见 doc 触发回填
- 手测：把一份新 doc 在群里贴一次 → `select attributes_json from entity_aliases where canonical_name like 'doc:%'` 看到 `displayTitle / seenInChatIds=[chat_id]`

### 4.4 回滚

- 单纯加列 + 写入；不读不影响现有逻辑
- 回滚只需把各 collector 的 `mergeDocAttributes` 调用注释掉；attributes_json 列保留无害

---

## 5. Phase B — `docCoMentionInducer`

### 5.1 改动清单

| 文件 | 改动 |
|---|---|
| `apps/server/src/db.ts` | 若 MVP15 `entity_edges` 已存在，verify schema；否则按 §3.2 建表 |
| `apps/server/src/context/artifactGraph.ts`（新建） | `induceDocCoMentionEdges()`：纯 SQL，从 `context_unit_entities` 推共现，写 `entity_edges` |
| `apps/server/src/bootstrap/workMapService.ts` | scheduler 注册：日 batch 全量 + 5min 增量（仅扫近 6h 的新 unit） |

### 5.2 inducer SQL 关键片段

全量推导（日 batch，约凌晨 3 点跑）：

```sql
-- 第一步：找所有 unit 上出现的 doc entity（已 resolve 到 canonical）
WITH unit_docs AS (
  SELECT
    cue.unit_id,
    ea.canonical_id AS doc_id,
    u.source,
    u.created_at
  FROM context_unit_entities cue
  JOIN entity_aliases ea ON ea.id = cue.entity_id
  JOIN context_units u ON u.id = cue.unit_id
  WHERE ea.canonical_type = 'doc'
    AND u.created_at >= datetime('now', '-180 days')  -- 半年窗口，避免无限累积
),
-- 第二步：在同一 unit 上两两共现，字典序去重
pair_evidence AS (
  SELECT
    MIN(a.doc_id, b.doc_id) AS doc_a_id,
    MAX(a.doc_id, b.doc_id) AS doc_b_id,
    a.unit_id,
    a.source,
    a.created_at
  FROM unit_docs a
  JOIN unit_docs b
    ON a.unit_id = b.unit_id AND a.doc_id < b.doc_id
),
-- 第三步：聚合 + 加权
weighted AS (
  SELECT
    doc_a_id,
    doc_b_id,
    SUM(
      CASE source
        WHEN 'im_p2p'           THEN 2.0
        WHEN 'meeting_artifact' THEN 1.5
        WHEN 'doc_comment'      THEN 1.5
        WHEN 'im_group'         THEN 1.0
        WHEN 'drive'            THEN 0.5
        ELSE 0.5
      END
      *
      POWER(0.5, (julianday('now') - julianday(created_at)) / 30.0)
    ) AS weight,
    json_group_array(unit_id) AS all_unit_ids,
    MAX(created_at) AS last_seen_at
  FROM pair_evidence
  GROUP BY doc_a_id, doc_b_id
)
-- 第四步：upsert 到 entity_edges
INSERT INTO entity_edges (id, edge_kind, entity_a_id, entity_b_id, weight, evidence_unit_ids, last_seen_at, detected_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  'doc_co_mention',
  doc_a_id,
  doc_b_id,
  weight,
  -- evidence 列表截 top-10 最近
  json_array_slice(all_unit_ids, -10),
  last_seen_at,
  datetime('now'),
  datetime('now')
FROM weighted
WHERE weight >= 0.1   -- 噪声地板：过期且仅 1 次共现的边丢掉
ON CONFLICT(edge_kind, entity_a_id, entity_b_id) DO UPDATE SET
  weight = excluded.weight,
  evidence_unit_ids = excluded.evidence_unit_ids,
  last_seen_at = excluded.last_seen_at,
  updated_at = datetime('now');
```

增量推导（5min tick）：把 `unit_docs` 的 WHERE 改成 `u.created_at >= datetime('now', '-6 hours')`，只对涉及到的 doc pair 做局部 recompute。

> SQLite 没有 `POWER` / `json_array_slice` 内置；实际实现里用 application-side 计算（在 JS 里跑权重和截断），或注册自定义 SQL 函数。这里 SQL 是表达意图。

### 5.3 索引与体积估算

- 半年窗口下，假设 100 doc × 平均每对共现 2 次 = ~10K pair 上限
- `entity_edges(doc_co_mention)` 估 ≤ 5K 行（weight ≥ 0.1 过滤后）
- 单 doc 的邻居数 P95 ≤ 30；top-K（K=8）查询 < 1ms

### 5.4 验证

- 单测：`test/mvp17-doc-co-mention-inducer.test.ts`
  - 给 3 个 unit，每个挂 2-3 个 doc，断言生成的 edges 集合和 weight
  - 同一 pair 跨 6 个月的 evidence，断言旧 evidence 权重被衰减到 < 0.1 触发地板过滤
  - 单聊 source 加权系数 ×2 生效
- 手测：跑全量 → 看 `entity_edges where edge_kind='doc_co_mention' order by weight desc limit 20`，肉眼判断 top 20 边是否合理

### 5.5 回滚

- 删 `entity_edges where edge_kind='doc_co_mention'`
- 从 scheduler 反注册 `induceDocCoMentionEdges`
- 其他 edge_kind 不受影响

---

## 6. Phase C — `artifactIndexService` + `<artifactContext>` slice + boundary

### 6.1 `artifactIndexService.getNeighbors`

```ts
// apps/server/src/context/artifactIndexService.ts

export interface ArtifactNeighbor {
  docEntityId: string;           // canonical
  displayTitle: string;
  docType: 'docx' | 'sheet' | 'bitable' | 'wiki' | 'minute' | 'unknown';
  lastSnippet: string;           // 80 字
  lastSeenAt: string;            // ISO
  weight: number;
  evidenceUnitIds: string[];     // 已经 boundary 过滤过的 unit id
  atMe: boolean;                 // 任一 evidence unit 上 semantic_tags 含 at_me
}

export async function getNeighbors(
  anchorDocEntityId: string,
  ctx: {
    actorOpenId: string;         // 当前 agent 代表的人
    visibleChatIds: Set<string>; // 当前 agent 可见的 chat 范围
    topK?: number;               // 默认 8
  }
): Promise<ArtifactNeighbor[]>
```

实现关键点：

1. **入参先 resolveAliased**：保证用 canonical id 查
2. **SQL 一次拉出**：`SELECT entity_b_id, weight, evidence_unit_ids, last_seen_at FROM entity_edges WHERE edge_kind='doc_co_mention' AND entity_a_id=? UNION ALL ... AND entity_b_id=?`
3. **boundary 过滤**：对每条 evidence_unit_ids，调 `boundaryEvaluator.canActorSee(actorOpenId, unitId)`；**任一 evidence 不可见 → 不从邻居列表中删，而是把对应 unit id 从 evidenceUnitIds 移除**；若过滤后 evidenceUnitIds 为空 → 整个邻居丢弃
4. **chat 范围过滤**：若 unit 来自 chat 且该 chat 不在 `visibleChatIds` → 该 evidence 不计
5. **doc 元数据补齐**：从 `entity_aliases.attributes_json` 读 displayTitle / docType / lastSnippet；如缺，跳过该邻居（不阻塞）
6. **排序**：按 weight DESC 取 top-K；ties 按 lastSeenAt DESC

### 6.2 `<artifactContext>` slice

在 [agentContextAssembler.ts](../apps/server/src/context/agentContextAssembler.ts) 加新 slice。触发条件：packet 中存在 ≥1 个 `entity{type:'doc'}`。

```xml
<artifactContext anchor="doc:<canonical-name>">
  <!-- 每个 anchor doc 展开 top-K 邻居；多个 anchor 时合并去重 -->
  <artifact id="doc:abc" title="Q2 产品 PRD" type="docx" lastSeenAt="2026-05-20T10:00:00Z" weight="3.4" atMe="false">
    最近一次提到：李四在群里追问需求范围是否包含海外
  </artifact>
  <artifact id="minute:xyz" title="2026-05-18 PRD 评审纪要" type="minute" lastSeenAt="2026-05-18T14:30:00Z" weight="2.1" atMe="true">
    会议结论：海外范围本期不做，待 Q3 重评
  </artifact>
  <!-- ... 最多 8 条 -->
</artifactContext>
```

prompt 文案约束（写进 attention / recap / chat agent 的 system prompt）：

> `<artifactContext>` 列出了与当前讨论文档**直接相关**的其他文档 / 会议纪要 / 评论 thread。这些是**线索摘要**，不是事实陈述。当你需要引用其中某条具体内容时，**只能引用 anchor 文档本身或 evidence units 已包含的内容**；对邻居 artifact 的正文，只能说"另有相关文档《title》提到过 X（lastSeenAt）"，不能编造细节。本期没有 `lookup_artifact` tool，无法拉正文，请勿假装看过。

### 6.3 token 预算

- 每个 artifact ~50 token（title 10 + snippet 30 + 元数据 10）
- top-K=8 → ~400 token
- 不挤压现有 slice：当 packet 总 token 接近 budget 时，artifactContext 整体降级到 K=4

### 6.4 验证

- 单测：`test/mvp17-artifact-index.test.ts`
  - getNeighbors 命中 alias canonical
  - boundary 过滤：mock 一个 unit 不可见，邻居的 evidenceUnitIds 收缩；全 evidence 不可见 → 邻居被剔除
  - chat 范围过滤：actor 不在该 chat → 该 evidence 不计
  - top-K 按 weight DESC + lastSeenAt tiebreak
- 集成测：跑一个含 doc entity 的 packet 通过 assembler，断言 `<artifactContext>` 出现在 prompt 里且不超 400 token
- 手测：在某 doc 上贴一条评论 + 在群里贴该 doc + 另一个相关 doc → 触发一次 attention agent → 看 prompt log 是否含正确 `<artifactContext>`

### 6.5 回滚

- 删 `<artifactContext>` slice 的注入代码
- artifactIndexService 保留但无 caller，无害

---

## 7. 与现有模块的关系

| 模块 | 关系 |
|---|---|
| MVP10 `entityResolver` | 严格依赖。所有 doc id 必须先 `resolveAliased` |
| MVP11 doc 信号链路 | 上游。本方案不动 collector 业务逻辑，只在 collector 末尾加 `mergeDocAttributes` |
| MVP13 LLM space 建议 | 正交。space 是"文件夹"粗粒度；本方案是"邻居"细粒度。prompt 里同时出现 `<spaceContext>` 和 `<artifactContext>`，文案上明确职责 |
| MVP15 Work Map 图 | **强依赖** `entity_edges` 表（Phase B）。若 MVP15 未落，本期独立建该表，schema 一致；MVP15 落地时合并不冲突 |
| MVP16A/B 单聊 / Thread | 上游。MVP16B 落地后，"同一 thread 共现"作为额外强边接入（D5）；本期先按 unit 共现做 |
| Boundary 模块 | **强依赖**。D4 是阻塞性约束 |

---

## 8. 自审

### 8.1 已知薄弱点

1. **half-life 30d 是拍的**：没有数据支撑。Phase B 上线后跑一周看分布，若 top-K 总是被一两条远古重边占据，再调到 14d
2. **single-doc unit 不贡献边**：评论 unit / doc_update unit 大多只挂 1 个 doc entity，不会进 pair 表。短期影响有限（这类信号通过其他方式接入 prompt），但长期可能让评论密集 / 编辑密集的孤立 doc"边孤独"。**已接受**：本期不补，等观察到具体 case 再加"评论提到的 URL → 也算共现"
3. **boundary 接入会让邻居列表"看上去不稳定"**：同一份 doc 被两个 agent 查邻居，结果可能不同。这是设计意图（不串信），但对 debug 是个麻烦 —— 必须在 prompt log 里同时记录"原始邻居 + 过滤后邻居"，便于复盘
4. **larkDocMetadata 24h TTL**：标题改了 24h 内看不到。**已接受**：标题修改极低频，回填延迟可容忍
5. **不接 chat / app entity 邻居**：本期只做 doc-doc。"同一 doc 在哪些 chat 被讨论过"对 agent 也有用，但属于另一个维度（doc → chat 边），留 MVP17.2

### 8.2 没做的事（明确非目标）

- ❌ doc-doc 边的语义类型（版本关系 / 引用关系 / 同主题）
- ❌ tool call `lookup_artifact`（拆 MVP17.1）
- ❌ doc → chat 邻居（拆 MVP17.2）
- ❌ 让 LLM 看到正文 diff
- ❌ doc 邻居图的 UI 展示（用户暂时不可校正；先用 prompt log 做 dogfood）
- ❌ cluster id / 命名空间

### 8.3 与"用户原始诉求"的回扣

> 用户："有一个表可以索引"

本方案的"表"是 `entity_edges`（已有，加 edge_kind）+ `entity_aliases.attributes_json`（扩列），合在一起就是用户想要的"artifact 索引表"。读模型由 `artifactIndexService` 暴露。**没有引入新的 doc-doc 专用表，遵守 MVP11/15 的非目标。**

> 用户："当用户针对其中某一个问题需要解决或提出疑问的时候，能够把所有的文档关联串起来"

通过 `<artifactContext>` slice 在 assembler 阶段静态注入摘要清单实现。tool call 拉正文是下期能力，本期先让 LLM 知道"还有这些东西"。

---

## 9. 时间表

| Phase | 内容 | 估时 | 可独立落地 |
|---|---|---|---|
| A | entity attributes 扩列 + collector 回填 | 1-2 天 | ✅ |
| B | docCoMentionInducer + entity_edges | 2 天 | 依赖 A |
| C | artifactIndexService + `<artifactContext>` + boundary | 1 天 | 依赖 B |
| **合计** | | **4-5 天** | |

MVP17.1（tool call）：3-5 天，需要先评估各 agent 的 LLM 调用框架改造范围。

MVP17.2（doc → chat 邻居）：1-2 天，等 MVP17 上线 2 周后看是否真的需要。
