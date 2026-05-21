# MVP12 · Space 关联优化方案

> 通过 Claude × Codex 双向 coreview（3 轮共识）产出的实施方案。
> Codex session id：`019e496f-39b1-74b1-b08a-7818f8060ca8`（可 `codex exec resume` 续）。

---

## 0. TL;DR

把当前 `resolveUnitToSpaces` 的「实体一阶交集」升级为「**source / semantic 分层 + materialized routing cache + 半自动 chat 亲和学习**」三件套：

1. **Source entity 分层**：raw signal 上的路由证据（`chat` / `app` / `doc`）只写 `kind=event` 的 raw event ContextUnit；语义 ContextUnit（commitment / goal / state…）的 `entities` 不写 chat/app，避免污染 `mergeKey`。
2. **Routing cache**：新增 `unit_sources` + `unit_routing_cache` 两张表，semantic unit 通过多对一关系拿到所有源 event 的 routing entities，resolver 只读 cache（O(1) hot path）。
3. **chat_affinity suggestions**：后台 worker 统计「群里的 unit 通过 person/doc 已命中哪些 Space」+「群成员 / 文档与 Space seed 的重叠」，超阈值产 `suggested` → 用户在 Space 详情页 confirm → 等同 chat seed；rejected 30 天冷却。

机器人 `cli_xxx` 网关帐号识别成 `type:'app'`，不被当成 person，不参与人际网络聚类，但参与 chat-as-context 路由。

---

## 1. 背景

### 1.1 现状

[apps/server/src/spaces/contextSpaceService.ts:111](apps/server/src/spaces/contextSpaceService.ts:111) `resolveUnitToSpaces(unit)` 当前唯一逻辑：

```ts
for (const e of unit.entities) {
  const ent = resolveOrCreateEntity(e.type, e.name);
  const links = listSpacesForTarget('entity', ent.id);
  for (const l of links) matchedSpaceIds.add(l.space_id);
}
```

即 `unit.entities ∩ space.seed_entities` 的实体一阶交集。

### 1.2 痛点

| # | 痛点 | 证据 |
|---|---|---|
| 1 | IM kind=event unit 的 entities 经常只有发送者，且发送者常是机器人 / 网关帐号（`cli_xxx`）。机器人不会是任何 Space 的 seed → 即便消息明显跟某 Space 主题相关也不会进 Space | [imCollector.ts:308-344, 361-393](apps/server/src/collectors/imCollector.ts:308) |
| 2 | 群（chat_id / chat_name）没被建模成 entity，没法跟 Space 关联 | [imCollector.ts:104-115](apps/server/src/collectors/imCollector.ts:104) `summarizeOne` 把 chat_name 写进文本不写进 entities |
| 3 | 人际网络没用：同项目人会重复出现在多个群，群本身应该跟 Space 有概率关联，而非必须靠用户手动配 seed | resolver 没有任何聚合 / 共现统计逻辑 |
| 4 | 链接里的飞书文档 token 没自动被当 entity（前端 `apps/web/src/lib/resolveNames.ts` 解析了但后端没用） | [driveCollector.ts:108-120](apps/server/src/collectors/driveCollector.ts:108) |

### 1.3 思考方向（用户）

- 机器人往群里发的内容，只要是这个群里的东西，就是跟这个群相关的
- 同一个项目的人会在多个群里重复出现
- 群跟 Space 可能还有相关性

---

## 2. 关键设计决策（共识纪要）

| 决策 | 选择 | 理由 |
|---|---|---|
| chat 建模 | first-class entity (`type:'chat'`) | 复用现有 entity / seed / link 路径，最小 schema 改动 |
| chat 稳定 key | `lark_chat:<chat_id>` | 群可改名，chat_id 才稳定 |
| chat 展示名 | `context_entities.aliases_json[0]`（取最近一次 chat_name） | 不新建 cache 表 |
| 机器人 sender | `type:'app'`，不伪装 person | 当前痛点之一就是机器人被当成唯一 person 后无法路由 |
| 语义 unit 是否含 chat/app | **不含**；只在 routing cache 里 | 避免 chat 进 `mergeKey`，导致同一承诺跨群被拆 |
| 多源聚合 | `unit_sources` 多对一表 | upsert 合并多 event 时全部源都保留路由证据 |
| Resolver hot path | 只读 `unit_routing_cache`，不回查 event unit | hook push path 必须轻量 |
| Cache 写入顺序 | **在 `invokeHook` 之前**完成 | 否则首次 push 路由读不到 cache |
| Event 重新 upsert | DELETE 后重建 `unit_routing_cache`（同 source_event_id） | 应对 raw event 被 update（追加 doc URL 等） |
| doc key | canonical URL，token 走 `mergeDocIdentity` | 对齐 Work Map 的 doc URL seed 与 drive token identity |
| Link rank | `person/project direct` (3) > `doc direct` (2) > `chat seed direct` (1) | 显式可比；相同 rank 取高 confidence；reason_json append |
| Confidence 数值 | placeholder，仅作内部排序 | 上线 14d 收数据后用 confusion matrix 校准 |
| 学习结果 | suggested → 用户 confirm 才生效 | 避免自动错关联污染下游 trigger / Active Context |
| 状态机 | suggested / confirmed / rejected 终态；rejected 30d 冷却 | 避免 worker 重复打扰 |
| 人际聚类 | advisory only | 高风险，先建议而非自动；group size cap + bot 过滤 |

---

## 3. 数据模型

```sql
-- 1. unit→sources 多对一（应对 mergeKey 合并多 event）
CREATE TABLE unit_sources (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(unit_id, event_id)
);
CREATE INDEX idx_unit_sources_unit ON unit_sources(unit_id);
CREATE INDEX idx_unit_sources_event ON unit_sources(event_id);

-- 2. materialized routing cache（resolver hot path 读这里）
CREATE TABLE unit_routing_cache (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  routing_entities_json TEXT NOT NULL,  -- [{type:'chat'|'doc'|'app', name, role, aliases?}]
  updated_at TEXT NOT NULL,
  UNIQUE(unit_id, source_event_id)
);
CREATE INDEX idx_unit_routing_unit ON unit_routing_cache(unit_id);

-- 3. Space 建议（chat_affinity / person_co_occur / doc_overlap）
CREATE TABLE context_space_suggestions (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,                -- 首期 'entity'
  target_id TEXT NOT NULL,                  -- context_entities.id
  space_id TEXT NOT NULL,
  suggestion_type TEXT NOT NULL,            -- 'chat_affinity' | 'person_co_occur' | 'doc_overlap'
  score REAL NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'suggested', -- suggested | confirmed | rejected
  cooldown_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(target_type, target_id, space_id, suggestion_type)
);

-- 4. ALTER：context_space_links 加 reason_json
-- ensureColumn('context_space_links', 'reason_json', 'TEXT')
-- 内容：{ via, sourceEntityId, sourceEntityName, more?: [{via, sourceEntityName}] }
-- cap：top 5 条 evidence
```

---

## 4. Phase 1 — Source entity + cache（最小可落地切片）

### 4.1 改动清单（精确到文件 / 函数）

| # | 文件 / 函数 | 改动 |
|---|---|---|
| **P1.1** | `apps/server/src/collectors/imCollector.ts` | raw signal `entities` 同时输出：<br>• `{type:'chat', name:'lark_chat:<chat_id>', aliases:[chat_name], role:'container', confidence:1.0}`<br>• sender entity：`type:'app'` (当 `sender.sender_type==='app'` 或 `sender.id.startsWith('cli_')`) 否则 `type:'person'`，`role:'actor'`<br>聚合消息（aggregate）entities：chat entity + 最多 8 个 distinct human senders，机器人只保 `type:'app'` |
| **P1.2** | 新建 `apps/server/src/util/extractFeishuDocRefs.ts` | regex 与前端 `apps/web/src/lib/resolveNames.ts`（FEISHU_URL_RE / MD_LINK_RE）**对齐**；命中 token 调 [entityResolver.ts:114-139](apps/server/src/context/entityResolver.ts:114) `mergeDocIdentity(token, url)`；输出 `{type:'doc', name:canonical_url, role:'about'}`。接入：imCollector / driveCollector / driveCommentCollector。<br>**附加 vitest 共享 corpus 测试**：前后端 regex 对同一批输入产出 token/url 集合一致 |
| **P1.3** | `apps/server/src/context/contextStore.ts:351-359` `insertMinimalEventContextUnit` | entities merge：<br>• dedup key = `(type, name, role)`（不光是 type+name；A''3）<br>• collector entities 与 actor fallback **不互斥**：如果 collector entities 已有 `role==='actor'` 的项就不再 fallback；否则 fallback 仍补一个<br>• aliases / confidence 各自 union |
| **P1.4** | `apps/server/src/triage/triageQueue.ts:183-192` | semantic contextUpdate 过滤 LLM 误产出的 `type:'chat'`、`type:'app'`；**doc 保留**（doc 可能是 commitment 的真实语义对象，如"完成 spec.md"） |
| **P1.5** | `apps/server/src/context/contextStore.ts` `upsertContextUnit`（核心顺序约束） | **必须在 `invokeHook` 之前** 完成（A''1）：<br>1. 在事务里写 `unit_sources(unit_id, event_id)`<br>2. 若 `kind='event'`：从 unit.entities 提取 routing entities (type ∈ chat/doc/app)，`DELETE FROM unit_routing_cache WHERE source_event_id = ev.id`，对所有 `unit_sources WHERE event_id = ev.id` 的 unit 重新 materialize 一行；也为自己写 1 行 (unit_id = event_unit.id, source_event_id = ev.id)<br>3. 若是 semantic upsert：根据本次 origin event id 即时 materialize 一行<br>4. **然后** 才 `invokeHook(unit, changeContext)` |
| **P1.6** | `apps/server/src/spaces/contextSpaceService.ts:111` resolver | 重写：<br>```ts<br>function collectRoutingEntities(unit) {<br>  const own = unit.entities;<br>  if (unit.kind === 'event') return own;<br>  const cache = listUnitRoutingCache(unit.id);<br>  const merged = [...own];<br>  for (const row of cache)<br>    merged.push(...JSON.parse(row.routing_entities_json));<br>  return dedupBy(merged, e => `${e.type}::${e.name}::${e.role ?? ''}`);<br>}<br>```<br>`scoreSpacesForUnit`：按 rank 表算 `{rank, linkType, confidence}`，同 Space 多 hit 取 max rank（并列取高 confidence），reason 累加。<br>**Rank 表**：<br>• `person/project direct` → `rank:3, linkType:'about', confidence:0.80`<br>• `doc direct` → `rank:2, linkType:'about_via_doc', confidence:0.85`<br>• `chat seed direct` → `rank:1, linkType:'about_via_chat', confidence:0.75` |
| **P1.7** | `apps/server/src/db.ts` `upsertContextSpaceLinkBestHit(spaceId, target, hit)` | 新 helper：<br>• 不存在 → INSERT<br>• 已存在 → 比较 rank：新 rank > 旧 → 升级 link_type/confidence；同 rank 取较大 confidence；reason_json append（**cap 5 条 evidence**）<br>• 只适用于 `target_type='context_unit'`；Space seed entity link 不走此路径 |
| **P1.8** | `apps/server/src/context/activeContext.ts:169-173` | entities 渲染过滤 `role==='container'` 或 `type ∈ {'chat','app'}`；如需显示群名，从 chat entity `aliases[0]` 取，fallback "群聊"。注意：仅展示过滤，**路由仍用 chat** |
| **P1.9** | Backfill 脚本（独立 commit） | `unit_sources` 是新表，没法直接扫；从 [context_units.origin_kind='event' + 关联的 event_id] 反推（A''4）：<br>1. 遍历 `context_units` 找出 origin.kind='event' 的 unit + 对应 event_id，写入 `unit_sources`<br>2. 从 `events.raw_json` 抽 routing entities，写入 `unit_routing_cache`（idempotent on UNIQUE） |

### 4.2 实施顺序

```
Step 1 [基础设施]   表迁移 + db helpers + util/extractFeishuDocRefs + corpus 测试
Step 2 [collector]  IM source entities + doc extract 接入 + contextStore fix (P1.3/P1.4/P1.5)
Step 3 [resolver]   P1.6 + P1.7（依赖 Step 1/2 完成）
Step 4 [UI]         P1.8（独立可并行）
Step 5 [backfill]   P1.9（Step 1-3 稳定后单独 commit）
```

Step 1 / 4 可并行；Step 2 → Step 3 串行；Step 5 必须最后。

### 4.3 验证（vitest 测试矩阵）

| 测试 | 验证点 |
|---|---|
| IM event entities 完整性 | sender 是机器人 + chat 路由，最终 unit.entities 同时包含 chat + sender 两个 entity；任一缺失 → fail |
| Semantic mergeKey 跨群合并 | 同一 mergeKey 在 chat_A、chat_B 触发，最终是 1 条 unit + 2 行 unit_sources，**不是 2 条 unit** |
| Routing cache 失效重建 | event 第一次只有 chat 路由 → semantic unit 通过 chat 命中 Space；event 被 update 追加 doc URL 后，downstream semantic unit 能拿到 doc，命中新 Space |
| Link upsert rank 升级 | unit 先通过 chat（rank=1）命中 Space → link_type='about_via_chat'；同 unit 再通过 person 直接命中（rank=3）→ link_type 升级为 'about'，confidence=0.80，reason_json append "more" |
| 前后端 regex corpus | 同一批 markdown link + 裸 Feishu URL + 非 Feishu URL，前后端输出 token/url 集合 diff = ∅ |
| Active Context 渲染 | 含 `type:'chat'` 的 unit 渲染时不出现 `lark_chat:<id>`；出现 chat_name 或 "群聊"；路由仍能命中 chat seed |
| insertMinimalEventContextUnit dedup | 同 (type, name, role) 输入两次只产生 1 个 entity；不同 role 保留各自 |

### 4.4 手测（dogfood）

1. 在某 IM 群里发一条"PRD 评审"消息（不 @ 任何人）
2. 把该群手动设为某 Space 的 chat seed (`context_space_links target='entity', target_id=<chat_entity_id>`)
3. 确认该消息被路由进 Space（resolver hit + `context_space_links(target='context_unit')` 写入 `link_type='about_via_chat'`）
4. 移除 chat seed → 之后的新消息不再进 Space（历史 link 不回收）

---

## 5. Phase 2 — chat_affinity suggestions（半自动学习）

### 5.1 后台 worker

频率：每 6h（首期可手动触发）。

```pseudo
BIG_CHAT_FILTER:
  distinct_senders > 30
  OR (units_in_chat > 200 AND distinct_senders > 30)

for each chat entity ce (排除 BIG_CHAT_FILTER):
  units_in_chat = COUNT DISTINCT unit_id
                  WHERE ce in unit_routing_cache
                  AND recent 7d

  # A''2: person 不在 routing cache 里，要从 unit.entities 取
  chat_persons = SELECT DISTINCT person_entity_id
                 FROM context_unit_entities
                 WHERE unit_id IN (...units_in_chat) AND type='person'
  chat_docs    = SELECT DISTINCT doc_entity_id
                 FROM unit_routing_cache + unit.entities
                 WHERE unit_id IN (...units_in_chat) AND type='doc'

  for each Space s:
    # A''5: 排除 about_via_chat 避免循环指标
    direct_hits = COUNT units in chat linked to s via link_type ∈ {about, about_via_doc}
    person_overlap = |chat_persons ∩ s.seed_person_entity_ids|
    doc_overlap    = |chat_docs ∩ s.seed_doc_entity_ids|

    if direct_hits >= 3 OR person_overlap >= 2 OR doc_overlap >= 1:
      score = direct_hits / log(1 + units_in_chat)
              × (1 + 0.3 × person_overlap + 0.5 × doc_overlap)

      upsertSuggestion(target_id=ce.id, space_id=s.id,
                       suggestion_type='chat_affinity', score, evidence):
        - existing.status='confirmed' → skip
        - existing.status='rejected' AND cooldown_until > now → skip
        - existing.status='suggested' → update score + evidence
        - none → INSERT 'suggested'
```

### 5.2 API（新增）

| Method | Path | 行为 |
|---|---|---|
| GET | `/api/context-spaces/:spaceId/suggestions` | 列该 Space 当前所有 suggested |
| POST | `/api/context-spaces/:spaceId/suggestions/:sid/confirm` | 写 `context_space_links(target='entity', target_id=chat_entity_id, link_type='about', confidence=1.0)` + 触发 reconcile（把历史 unit 也关联进去） |
| POST | `/api/context-spaces/:spaceId/suggestions/:sid/reject` | `status='rejected', cooldown_until=now+30d` |

### 5.3 UI

Space 详情页新增 "📥 建议加入" 区块：列 suggested 的 chat（展示 alias + chat_id 后 6 位 + evidence_json 关键字段），每条带 Confirm / Reject 按钮。

---

## 6. Phase 3 — person co-occurrence advisory（纯建议）

仅在以下条件成立时累加 person 邻接：
- chat distinct_senders ≤ 30
- units ≥ 5
- 排除 type='app'
- recency 30d

person X 与 Space.seed_persons 共现 ≥ 5 次 → 建 `person_co_occur` suggestion。

**不进入 resolver hot path**。纯人工 confirm 才会写 Space seed。

---

## 7. 回滚

### 7.1 Phase 1 回滚

```sql
-- 切回旧 resolveUnitToSpaces 一行还原（git revert）

-- 删除新增 link（保留 created_at 前的旧数据）
DELETE FROM context_space_links
WHERE link_type IN ('about_via_chat', 'about_via_doc')
  AND created_at >= '<go_live_iso>';

-- cache 表保留也无害；若需彻底清除：
DROP TABLE unit_routing_cache;
DROP TABLE unit_sources;
```

### 7.2 Phase 2/3 回滚

```sql
-- suggestions 清空
DELETE FROM context_space_suggestions;

-- 删除 chat seed（用户 confirm 产生的）
DELETE FROM context_space_links
WHERE created_at >= '<go_live_iso>'
  AND link_type = 'about'
  AND target_type = 'entity'
  AND target_id IN (SELECT id FROM context_entities WHERE type = 'chat')
  AND confidence = 1.0;
```

---

## 8. 开放问题（P1，进 backlog）

| # | 问题 | 处理 |
|---|---|---|
| O1 | 评分权重 calibration | 上线 14d 收数据后用 confusion matrix 校准；当前数值是 placeholder |
| O2 | BIG_CHAT_THRESHOLD（senders 30 / units 200）首期粗值 | dogfooding 期间观察分布再调 |
| O3 | chat alias 自动更新 | 群改名后 `aliases_json` 是否实时同步、UI 展示是否会有延迟 |
| O4 | `reason_json` cap=5 是否够 | 不够再独立 evidence 表 |
| O5 | reconcile 历史回填 chat seed 时 | confirm 后是否要对历史 unit 也写 link？默认写。性能可观察 |
| O6 | 大群（>30 sender）是否完全不参与 | 首期完全排除；未来可能用更高阈值参与（如 person_overlap ≥ 5）|

---

## 9. Coreview 过程纪要（参考）

3 轮共识过程，时间戳和完整对话保存在：

```
/tmp/codex-coreview-r1.md   /tmp/codex-coreview-r1.out
/tmp/codex-coreview-r2.md   /tmp/codex-coreview-r2.out
/tmp/codex-coreview-r3.md   /tmp/codex-coreview-r3.out
```

Codex session id：`019e496f-39b1-74b1-b08a-7818f8060ca8`，可续：

```bash
codex exec -s read-only --skip-git-repo-check \
  -C /Users/xinming/MyProject/ai-is-on \
  resume 019e496f-39b1-74b1-b08a-7818f8060ca8 \
  "<新问题>"
```

### 3 轮关键收敛点

| Round | 关键发现 / 修订 |
|---|---|
| R1 (Codex review) | Codex 发现两个 P0 实现坑：(1) `insertMinimalEventContextUnit` 一旦传 entities 就不走 actor fallback，sender 会丢失；(2) chat/doc 直接进 semantic unit 会污染 `mergeKey` → 提出 **source / semantic 分层** + **origin routing** 概念 |
| R2 (Claude review B + 修订 A) | Claude 发现 B 的 origin routing 缺多源聚合（mergeKey 合并多 event）和 hot path 性能放大 → 引入 `unit_sources` + `unit_routing_cache`；Codex 继续修 8 处实现细节（doc 不 blanket 过滤、reason_json schema、BIG_CHAT 用 distinct_senders 等）|
| R3 (达成共识) | 关键执行顺序：cache 必须在 `invokeHook` 前写入；chat_affinity 的 person evidence 不能从只含 chat/doc/app 的 routing cache 取（要从 unit.entities）；event update 后 cache 必须 DELETE 重建 |

### 关键设计反思

- 最危险的盲点是 **mergeKey 污染**：如果不分层，"周三前补 MVP2 方案" 这种 commitment 会因为在不同群里被提到而拆成 N 条 unit
- 第二危险是 **hot path 性能**：resolveUnitToSpaces 是 push hook 每次 upsert 都跑，回查 origin event 的 entities 在大流量下会放大
- 第三危险是 **学习闭环**：如果 chat seed 命中也算 direct_hits，会形成自激励循环（A 被 chat seed 关联 → direct_hits 增加 → score 升高 → 更可能 confirm 更多群）
- 最有价值的设计是 **Source / Semantic 分层**：让 chat/app/doc 作为路由证据而不进语义 mergeKey，鱼与熊掌兼得

---

## 10. 实施建议

下一步建议（按优先级）：

1. 先开 PR Step 1（基础设施 + 测试），独立 review 表结构和 helper API
2. Step 2-3 一个 PR，包含 collector + resolver 的端到端测试
3. Step 4 UI 单独 PR（小改）
4. Step 5 backfill 脚本 PR，跑一遍 dry-run 看影响范围
5. Phase 2/3 在 Phase 1 稳定 1-2 周后再做

每一步都有独立回滚路径，不会一次失败搞坏整条 context 链路。
