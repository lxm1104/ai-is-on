# MVP20 · Commitment 用户角色识别与差异化提醒技术方案

## 0. TL;DR

**问题**：系统不区分"我**提的**需求"和"我**承诺要做的**事"——两者在 work_map 里都是 `kind=commitment`，结构一模一样。结果：用户在 Base UX 群只是需求方/观察者，写文案的是别人；DDL 临近时系统把它当成"用户该交了"P0 推到顶上。

**根因**：抽取阶段（[triagePrompt.ts](../apps/server/src/triage/triagePrompt.ts)）已经在 `entities[].role` 里标了"谁是 target / 谁是 actor"，存进了 `context_unit_entities.role`。但 **attention 装配层 ([agentContextAssembler.ts](../apps/server/src/context/agentContextAssembler.ts)) 把 self 在这条 unit 上是什么角色这个信息丢掉了**——[attentionPrompt.ts:301-305](../apps/server/src/attention/attentionPrompt.ts) 渲染 unit 时只输出 `{type:name}`，不含 role。

**方案**：派生层（不是新建数据层）补这块。三件事：

1. **`agentContextAssembler` 在序列化 commitment 时计算派生字段 `selfRoleOnUnit`**——查 self 在这条 unit 的 `context_unit_entities.role`（**JS 双路或**：A 路 `resolveAliased(eid)===self` + B 路 `ename==='我'` 兜底，见 §3.3），归一化成 `executor | requester | reviewer | observer`
2. **`attentionPrompt` 在 commitments 行尾输出 `[role=requester]` 等标签**，并在 §3 加铁律 13：`requester`/`observer` 优先级上限 P2/P3，DDL 临期不升级，只在进度变化或 `actionability='ask'` 时通知
3. **`commitmentAgent` handler 内部调 `computeSelfRoleOnUnit`，加 if-else 分支**（agent 是确定性 TS handler，不是 LLM agent）：executor=催办、requester=追单、reviewer=等审、observer=同步进展

**工时 2.5-4 天**，拆 3 个 PR（PR1 数据派生 / PR2 prompt 暴露不加铁律灰度一周 / PR3 加铁律 + 文案分支）。零 schema 迁移，不改 triage——除非 spike 1 验证（§7）发现现有 triage 标 self role 准确率 < 80%，才触发 spike 2 加强 triagePrompt。

**关键概念修正（review v2）**：`target` 归 **requester**——`self=target` 语义是"别人答应我做某事"，正好是 Base UX case 的形态；第一版误把 target 归 observer 会把 bug 修反。

不做：commitment 抽取 schema 加 `initiatorId/executorIds` 字段（数据已经在 entities[].role）、新建 `commitmentRoleInducer` 表（无价值的中间层）、改 boundaryRule（preference 文案能解决 80% 场景，留到 MVP20.5）、goal/uncertainty 也挂 selfRoleOnUnit（语义比 commitment 复杂，先攒数据）。

---

## 1. 起点：bug 场景与代码定位

### 1.1 真实 case

用户反馈（2026-05-27）：

> Base UX 群本身我只是一个观察者，它不需要我处理任何东西，只是让我知道写文案的同学在处理就行了，并不是应该我来提交，而是有进展的时候可以让我知道我提的文案需求被响应、被解决了。

系统当前输出（attention 卡片）：

```
Base UX Image 文案修改 2 条 明天到期
commitment cad8d3c4 DDL 为 05/28 23:59，仅剩不到 24 小时
建议：今天完成 2 条 Image 文案修改并提交
```

**这条 commitment 用户做不了**——执行方不是用户本人。卡片应该长这样：

```
Base UX Image 文案：你提的 2 条需求还没动静
DDL 05/28，距离 24h，执行方还没响应
建议：要不要在群里催一下？
```

### 1.2 三个相关层 + 数据现状

| 层 | 文件 | 现状 |
|---|---|---|
| **抽取** | [apps/server/src/triage/triagePrompt.ts:67-68](../apps/server/src/triage/triagePrompt.ts) | LLM 输出 `entities: [{name, role: 'target'\|'about'\|'actor'\|...}]`。已有提示词约束（§11 MVP16-A "区分谁在向谁承诺"） |
| **存储** | [apps/server/src/context/contextStore.ts:210-217](../apps/server/src/context/contextStore.ts) | 直接 pass-through 写入 `context_unit_entities(context_unit_id, entity_id, role)`，默认 `'about'` |
| **聚合** | [apps/server/src/context/personProjectInducer.ts:264-279](../apps/server/src/context/personProjectInducer.ts) | `ACTOR_LIKE_ROLES` (22 个) + `ABOUT_LIKE_ROLES` (17 个) 归一化成 `'actor' \| 'about'`，再频次推 `PersonProjectRole`（**person-project 边粒度，跨 unit 聚合，丢失单 unit 语义**） |
| **装配** | [apps/server/src/context/agentContextAssembler.ts](../apps/server/src/context/agentContextAssembler.ts) | 序列化 commitment 给 packet，**未读取 self 的 role** |
| **prompt** | [apps/server/src/attention/attentionPrompt.ts:301-305](../apps/server/src/attention/attentionPrompt.ts) | `renderUnitOneLine` 只输出 `{type:name}`，**role 字段完全没暴露给 LLM** |

### 1.3 关键发现：数据在，没人用

triage 已经在为 commitment 标 self 的 role 了。把 [Base UX 文案 commitment cad8d3c4] 的 DB 行抓出来，`context_unit_entities` 里 self 那一行的 `role` 很可能已经是 `'requester'` 或 `'about'`（spike 1 的第一步就是验证这件事，见 §7）。

也就是说——**这不是个"加新概念"的需求，是个"把已有数据接出来"的需求**。这决定了方案的复杂度上限。

---

## 2. 范围

### 2.1 在 MVP20 范围内

| 模块 | 文件 | 输出 |
|---|---|---|
| M1 数据 spike | 新建 `apps/server/scripts/probe-commitment-self-role.ts` | 扫所有 active commitment，统计 self 在每条上的 raw role 分布。**先决条件**：决定 spike 1 是否够 |
| M2 派生函数 | `apps/server/src/context/selfRoleOnUnit.ts`（新建，50-80 行） | `computeSelfRoleOnUnit(unit, selfCanonicalId): SelfRoleOnUnit \| null` |
| M3 装配集成 | `agentContextAssembler.ts` 改 ~1 处 | commitment 序列化时挂 `selfRoleOnUnit` 字段；扩 `GlobalContextPacket['commitments'][]` 类型（goal/uncertainty 不接，见 §M3 设计决定） |
| M4 prompt 暴露 | `attentionPrompt.ts:renderUnitOneLine` 改 ~10 行 + §3 加 1 条铁律 | 行尾输出 `[role=requester]` / `[role=observer]` 标签 |
| M5 commitmentAgent handler 分支 | `apps/server/src/agents/commitmentAgent.ts` 改 ~30 行（**非 prompt——agent 是纯本地 TypeScript handler，review v4 校准**） | M5.1 agent 自调 computeSelfRoleOnUnit；M5.2 按 selfRole 改 priority / cardTitle / bodyLines；M5.3 调权放在 graphContext 之后 |
| M6 测试 + 文档 | `apps/server/test/self-role-on-unit.test.ts`（PR1）+ `attention-self-role-integration.test.ts`（PR1）+ `commitment-agent-self-role.test.ts`（PR3）+ amend `.opencode/agent/aiisn-attention.md` | 见 §9 |

### 2.2 不在范围（推后或不做）

| 推迟项 | 推到哪 | 原因 |
|---|---|---|
| ContextUnit schema 加 `initiatorId / executorIds` 字段 | **不做** | 数据已经在 `context_unit_entities.role`，再加是冗余；如果发现 entities[].role 不够用，应当先收紧 triagePrompt §11，而不是加新字段 |
| 新建 `commitmentRoleInducer` 表 / 后台 job | **不做** | 派生字段在 prompt 装配时算（O(commitments) per attention tick，每次几十行 SQL）；没有跨 tick 复用价值，不值得入库 |
| BoundaryRule schema 加 `selfRoleOnUnit` 条件 | **MVP20.5** | 等 §5 上线后看用户用偏好文案描述这个意图的频率；如果 ≥3 次/月，再上结构化 boundary |
| triagePrompt §11 提示词加强（明确要求 self 角色标注） | **MVP20.5（条件触发）** | 看 spike 1 数据。如果 self role 在现有 entities[].role 里 ≥80% 能正确推出（actor/author = executor、requester/proposer = requester、about/mentioned = observer），跳过；< 80% 才做 |
| commitmentAgent 之外的 specialist agent（prepareMeeting / recap / sync）集成 selfRoleOnUnit | **各自独立 PR** | 每个 agent 文案需调优，MVP20 只接 commitmentAgent 作示范，模板复用即可 |
| 前端 SignalCard 显示 role badge | **MVP20.5** | 看 prompt 改动后 attention 输出文案是否已能让用户分辨；如果文案够清楚，不必加 UI 元素 |

---

## 3. 数据模型

### 3.1 `SelfRoleOnUnit` 类型

```typescript
// apps/server/src/context/selfRoleOnUnit.ts

export type SelfRoleOnUnit =
  | 'executor'   // 我是这条 unit 的执行方（要做事的人）
  | 'requester'  // 我是这条 unit 的提出方/需求方（发起人，但执行不是我）
  | 'reviewer'   // 我是这条 unit 的审阅方（决定行不行，但执行不是我）
  | 'observer';  // 我只是被通知/被抄送/被提及，跟我没直接行动责任
```

**注意刻意不要的值**：
- 没有 `'unknown'`——找不到 self entity 时返回 `null`，由调用方决定 fallback
- 没有 `'owner'`——commitment 上的"我做"语义统一用 `executor`，避免和 `PersonProjectRole.owner`（项目级）混淆

### 3.2 从 raw role 到 SelfRoleOnUnit 的映射表

复用 [personProjectInducer.ts:264-274](../apps/server/src/context/personProjectInducer.ts) 现有的归一化表（ACTOR_LIKE 22 项 + ABOUT_LIKE 16 项），但**再细分一层**——把它们重新分进 4 个 SelfRoleOnUnit 桶：

```typescript
const EXECUTOR_ROLES = new Set([
  'actor', 'author', 'owner', 'assignee', 'handler', 'fixer',
  'developer', 'editor', 'tester', 'verifier', 'evaluator', 'responder',
  'organizer', 'coordinator', 'speaker',   // 主动驱动者，是"在做事"
]);

const REQUESTER_ROLES = new Set([
  'requester', 'reporter', 'proposer', 'initiator', 'source',
  'target',   // ★ 关键：self=target 意味着"别人答应我做某事"，self 是需求方
]);

const REVIEWER_ROLES = new Set([
  'reviewer', 'decision_maker', 'confirmer', 'gatekeeper',
]);

const OBSERVER_ROLES = new Set([
  'about', 'subject', 'mentioned', 'cc', 'observer', 'participant',
  'peer', 'forwarder', 'counterpart', 'concerned_party',
  'blocker_source', 'stakeholder', 'involved', 'explainer',
]);

export function mapToSelfRole(rawRole: string): SelfRoleOnUnit | null {
  const r = rawRole.toLowerCase();
  if (EXECUTOR_ROLES.has(r)) return 'executor';
  if (REQUESTER_ROLES.has(r)) return 'requester';
  if (REVIEWER_ROLES.has(r)) return 'reviewer';
  if (OBSERVER_ROLES.has(r)) return 'observer';
  return null; // 未知 role，调用方 fallback 处理
}
```

**关键设计决定：`target` 归 requester（review B1 修正）**

[triagePrompt.ts:67](../apps/server/src/triage/triagePrompt.ts) 的语义：commitment `"周三前补 MVP2 方案"` → `actor` 是答应做的人，`target` 是被承诺的人。

**triagePrompt §11 (MVP16-A) 已经规定**：用户向对方承诺时 actor=我、对方=target；**对方向用户承诺时 actor=对方、target=我**。所以：

- self=actor → executor（我在做）
- self=target → **requester**（别人答应我做的，我是需求方）
- self=mentioned/cc/about → observer

这正好对应 Base UX case——"写文案的同学答应我做 2 条" → self=target → requester → 文案改成"还没动静要不要催"。**这是本方案的核心修正**，第一版误把 target 归 observer 会让所有"别人答应我的事"全部被静音，把 bug 修反。

**`organizer` / `coordinator` 归 executor（review B2 修正）**

第一版把这两个归 requester，实际语义是"主动驱动的人"——organizer 在组织、coordinator 在协调，都在做事。修正归 executor。

### 3.3 取 self role 的正确模式

**关键修正（review v3）**：第一版 SQL 用了 `WHERE e.canonical_id = ?` —— 但 [context_entities](../apps/server/src/db.ts) 表**没有 `canonical_id` 列**。canonical 解析是另一种机制：单独的 [`entity_aliases(id, alias_of)`](../apps/server/src/db.ts) 表 + 运行时 [`resolveAliased()`](../apps/server/src/context/entityResolver.ts) 函数。

**正确模式**（跟 [personProjectInducer.ts:101](../apps/server/src/context/personProjectInducer.ts) 一致）：SQL 取原始 `entity_id` + `name` + `type`，**在 JS 里调 `resolveAliased()` 判断**。

```typescript
// 一条 SQL，批量取多个 unit 上所有 person entity 的 (entity_id, role, name)
const rows = db.prepare(`
  SELECT
    cue.context_unit_id AS uid,
    cue.role            AS role,
    cue.entity_id       AS eid,
    e.name              AS ename
  FROM context_unit_entities cue
  JOIN context_entities e ON e.id = cue.entity_id    -- ★ 表名是 context_entities，不是 entities
  WHERE cue.context_unit_id IN (${placeholders})
    AND e.type = 'person'
`).all(...unitIds) as Array<{ uid: string; role: string; eid: string; ename: string }>;

for (const { uid, role, eid, ename } of rows) {
  // A 路：按 alias 链解析后等于 selfCanonicalId
  // B 路：name='我' 兜底（triage 大概率输出 {name:'我'}，跟 self entity 没 alias 关联——见 §8.1 R1）
  const isSelf = resolveAliased(eid) === selfCanonicalId || ename === '我';
  if (!isSelf) continue;
  // ... 调 mapToSelfRole(role)，按 ROLE_PRIORITY 取最强累积到 acc
}
```

一条 unit 上 self 可能多次出现（多 alias、多 role），按 §3.2 的 `ROLE_PRIORITY` 取最强：`executor > requester > reviewer > observer`。

---

## 4. 三层映射图

```
原文（IM message）
   │
   │  triage LLM (triagePrompt.ts §8 + §11)
   ▼
ContextUnitDraft.entities = [
  { type: 'person', name: '林新明', role: 'requester' },    ← LLM 标的
  { type: 'person', name: '张三', role: 'assignee' },
  { type: 'project', name: 'Base UX', role: 'about' }
]
   │
   │  contextStore.upsertContextUnit → linkUnitEntity
   ▼
DB: context_unit_entities (context_unit_id, entity_id, role)
   │
   │  agentContextAssembler.buildUnit(...)  ← MVP20 在这里加派生
   ▼
GlobalContextPacket.commitments[i] = {
  id, title, ..., entities: [...],
  selfRoleOnUnit: 'requester'    ← 新增派生字段
}
   │
   │  attentionPrompt.renderUnitOneLine  ← MVP20 在这里暴露给 LLM
   ▼
<commitments>
- [cad8d3c4-...] (commitment) Base UX Image 文案修改 2 条 due 2026-05-28T23:59 {project:Base UX} [role=requester]
</commitments>
   │
   │  attention LLM + 新铁律 §3.X
   ▼
priority=P2 (而不是 P0)，文案变成"你提的需求还没动静，要不要催一下"
```

---

## 5. 实现 M1-M6

### M1 数据 spike (0.5 天，前置)

**目的**：在动代码前回答一个问题——现有 `context_unit_entities.role` 数据里，self 的角色标注分布是什么样？决定是否需要 spike 2 的 triagePrompt 加强。

**脚本** `apps/server/scripts/probe-commitment-self-role.ts`（review v3 修正——schema 校准 + 四路命中数）：

```typescript
// 伪代码
const selfId = getSetting('self_person_entity_id') ?? '';
const selfCanonical = selfId ? resolveAliased(selfId) : '';

// 全量取所有 (commitment / goal / uncertainty) × person entity 边（含 status='active' 过滤）
const rows = db.prepare(`
  SELECT cu.id AS uid, cu.kind, cu.title, cu.created_at, cu.updated_at,
         cue.role, cue.entity_id AS eid, e.name AS ename
  FROM context_units cu
  JOIN context_unit_entities cue ON cue.context_unit_id = cu.id
  JOIN context_entities e ON e.id = cue.entity_id          -- ★ context_entities, 不是 entities
  WHERE cu.kind IN ('commitment', 'goal', 'uncertainty')
    AND cu.status = 'active'
    AND e.type = 'person'
`).all();

// 在 JS 里分四路统计每条 unit 上 self 的命中情况：
let hitA_only = 0, hitB_only = 0, hitBoth = 0, hitNone = 0;
const unitToBestRole = new Map<string, SelfRoleOnUnit | null>();
for (const r of rows) {
  const matchA = selfCanonical && resolveAliased(r.eid) === selfCanonical;
  const matchB = r.ename === '我';
  if (matchA && matchB) hitBoth++;
  else if (matchA) hitA_only++;
  else if (matchB) hitB_only++;
  else hitNone++;
  if (matchA || matchB) {
    const mapped = mapToSelfRole(r.role);
    if (mapped) {
      const prev = unitToBestRole.get(r.uid) ?? null;
      if (!prev || ROLE_PRIORITY[mapped] > ROLE_PRIORITY[prev]) {
        unitToBestRole.set(r.uid, mapped);
      }
    }
  }
}

// 输出 4 个核心数字 + 各 kind 的 SelfRoleOnUnit 分布 + null 比例
// 再随机抽 20 条 commitment 人工对照原文校对
```

**判定标准**：

| 指标 | 阈值 | 含义 / 触发后果 |
|---|---|---|
| 双路总命中率 `(hitA_only+hitB_only+hitBoth) / (hit + hitNone)` | ≥ 70% | self entity 至少 7 成 commitment 上能匹配到——派生函数可用 |
| 双路总命中率 | < 70% | 触发 spike 2：收紧 triagePrompt §11，强制 self 出现时必标 role |
| B 路独占占比 `hitB_only / 总命中` | ≥ 30%（**预期**） | 证实 R1 风险（LLM 字面输出 `name='我'`）；启动独立工单：larkOrgCollector merge "我" alias 治本 |
| B 路独占占比 | < 5% | A 路（resolveAliased）已经够，"我" 字面输出反而是少数；独立工单可缓办 |
| 抽样 20 条人工校对准确率（确认 selfRoleOnUnit 跟原文语义一致） | ≥ 80% | spike 1 够用，跳过 spike 2 |
| 抽样准确率 | < 80% | 触发 spike 2：收紧 triagePrompt §11，加 few-shot |

如果命中 spike 2，时间 +1 天。

### M2 派生函数 `selfRoleOnUnit.ts`

```typescript
// apps/server/src/context/selfRoleOnUnit.ts
import { db } from '../db.js';
import { resolveAliased } from './entityResolver.js';

export type SelfRoleOnUnit = 'executor' | 'requester' | 'reviewer' | 'observer';

const EXECUTOR_ROLES = new Set([/* §3.2 */]);
const REQUESTER_ROLES = new Set([/* §3.2 */]);
const REVIEWER_ROLES = new Set([/* §3.2 */]);
const OBSERVER_ROLES = new Set([/* §3.2 */]);

export function mapToSelfRole(rawRole: string): SelfRoleOnUnit | null { /* §3.2 */ }

const ROLE_PRIORITY: Record<SelfRoleOnUnit, number> = {
  executor: 4, requester: 3, reviewer: 2, observer: 1,
};

/**
 * 批量取多个 unit 的 self role，避免装配层 N+1。
 * 实现见 §3.3：SQL 取原始 entity_id，JS 里 resolveAliased + name='我' 兜底。
 * 一条 unit 上 self 多次出现时按 ROLE_PRIORITY 取最强。
 *
 * selfCanonicalId 为空字符串 / 未传 → 返回全 null Map（settings 没 self_person_entity_id 时）。
 */
export function computeSelfRolesOnUnits(
  unitIds: string[],
  selfCanonicalId: string,
): Map<string, SelfRoleOnUnit | null> {
  const acc = new Map<string, SelfRoleOnUnit | null>();
  for (const uid of unitIds) acc.set(uid, null);
  if (unitIds.length === 0 || !selfCanonicalId) return acc;

  const placeholders = unitIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      cue.context_unit_id AS uid,
      cue.role            AS role,
      cue.entity_id       AS eid,
      e.name              AS ename
    FROM context_unit_entities cue
    JOIN context_entities e ON e.id = cue.entity_id
    WHERE cue.context_unit_id IN (${placeholders})
      AND e.type = 'person'
  `).all(...unitIds) as Array<{ uid: string; role: string; eid: string; ename: string }>;

  for (const { uid, role, eid, ename } of rows) {
    // A 路：alias 链解析后等于 self；B 路：name='我' 兜底（见 §8.1 R1）
    const isSelf = resolveAliased(eid) === selfCanonicalId || ename === '我';
    if (!isSelf) continue;

    const mapped = mapToSelfRole(role);
    if (!mapped) continue;
    const prev = acc.get(uid) ?? null;
    if (!prev || ROLE_PRIORITY[mapped] > ROLE_PRIORITY[prev]) acc.set(uid, mapped);
  }
  return acc;
}

/** 单 unit 版本（测试用 / 边路调用），底层走批量 */
export function computeSelfRoleOnUnit(
  unitId: string,
  selfCanonicalId: string,
): SelfRoleOnUnit | null {
  return computeSelfRolesOnUnits([unitId], selfCanonicalId).get(unitId) ?? null;
}
```

**Schema 校准（review v3 修正）**：
- 表名 `context_entities`（不是 `entities`）；查表用 `context_entities.id`
- 没有 `canonical_id` 列；alias 通过单独的 `entity_aliases(id, alias_of)` 表 + 运行时 `resolveAliased()` 函数（[entityResolver.ts:22](../apps/server/src/context/entityResolver.ts)）
- 性能：commitment ≤ 10 条（[GLOBAL_SLICE_CAPS.commitments](../apps/server/src/context/agentContextAssembler.ts)），每条 ≤ 5 person entity → 一次 SQL 最多 50 行，JS 端调 resolveAliased 50 次（每次 ≤ 5 跳）—— 完全在可接受范围

**MVP16C 交互（review R4 修正）**：派生函数对 unit kind / status 不做过滤——是装配层的责任。MVP20 调用方在 §M3 只对 `packet.commitments`（装配前 `listActiveContextUnits` 已默认按 `status='active'` 过滤，见 [db.ts:1228-1229](../apps/server/src/db.ts)）调用本函数；MVP16C 维护的 `status='done'/'cancelled'` commitment 根本不会进入 packet.commitments，自然不会算 selfRoleOnUnit。

### M3 装配集成 `agentContextAssembler.ts`

类型扩：

```typescript
// GlobalContextPacket commitments / goals / uncertainties
type PacketUnit = ContextUnit & {
  selfRoleOnUnit?: SelfRoleOnUnit | null;
};
```

装配逻辑（伪代码，在 `buildGlobalContextPacket` 内）：

```typescript
// 复用 buildMyTopCollaboratorsSlice 已用过的 self 解析模式（agentContextAssembler.ts:1029-1032）
const selfRow = db
  .prepare(`SELECT value FROM settings WHERE key='self_person_entity_id'`)
  .get() as { value: string } | undefined;
const selfCanonical = selfRow?.value ? resolveAliasedCanonical(selfRow.value) : '';

// MVP20 只接 commitment——goal/uncertainty 的"我提的 vs 我承担的"语义比 commitment 复杂
// （goal 可能是团队级），先攒数据再扩，见 §8.2 open question #3
const commitmentIds = commitments.map(u => u.id);
const selfRoles = computeSelfRolesOnUnits(commitmentIds, selfCanonical);
// computeSelfRolesOnUnits 已处理 selfCanonical='' 的退化情形（返回全 null Map）

packet.commitments = commitments.map(u => ({
  ...u,
  selfRoleOnUnit: selfRoles.get(u.id) ?? null,
}));
// packet.goals / packet.uncertainties 不变（不挂 selfRoleOnUnit）
```

**为什么只接 commitment（review N1 修正）**：

- **commitment**：语义清晰——"我做" vs "别人答应我做"是同一种关系的对偶
- **goal**：语义模糊——"我提的目标" 可能是团队级 OKR，"requester" 在这里反而怪。等 MVP15B 的 graphContext.decisionPath 接进 goal 优先级判定后再扩
- **uncertainty**：语义模糊——"我提的问题"和"别人问我的问题"在原文里很难分清楚，spike 风险高

**为什么不在 attention 之外的 packet（caringAgent / recapAgent 等）做**：caring/recap 各自有不同的"哪些 unit 跟我有关"的判定逻辑，单独适配。MVP20 只 attention + commitmentAgent。

### M4 prompt 暴露 `attentionPrompt.ts`

改 [renderUnitOneLine](../apps/server/src/attention/attentionPrompt.ts) (line 290):

```typescript
function renderUnitOneLine(u: ContextUnit & { selfRoleOnUnit?: SelfRoleOnUnit | null }, opts: RenderUnitsOpts): string {
  const parts: string[] = [`- [${u.id}] (${u.kind})`];
  parts.push(u.title);
  // ... 现有 time / entities / meaning 渲染逻辑保留 ...

  // MVP20: 行尾标 self 在这条 unit 上的角色
  if (u.selfRoleOnUnit) {
    parts.push(`[role=${u.selfRoleOnUnit}]`);
  }
  return parts.join(' ');
}
```

§3 加 1 条铁律（紧跟现有的 orgRole / collabType 规则后）：

```
13. (MVP20) commitment 行尾 [role=...] 标签是「self 在这条 commitment 上的角色」，
    取值 executor / requester / reviewer / observer：

    a) role=executor → 现状逻辑不变，DDL 临期可以升级到 P0/P1，
       文案"该交了 / 建议今天推进"。

    b) role=requester → priority 上限 P2，DDL 临期不作为升级理由。
       文案改为"你提的需求 X 还没动静，要不要追一下 <对方>"。
       仅当符合以下任一条件才生成 attention item，否则跳过：
         - packet.recentEvents 里有跟本 commitment 关联的新事件
           （signalIds 命中 commitment.entities 中的 project/doc）
         - commitment.actionability='ask' 或 'act'
         - 距 commitment.updatedAt 已超过 (DDL - createdAt) × 0.5

    c) role=reviewer → priority 上限 P1。文案聚焦"等你审 / 等你确认"，
       DDL 临期可升级到 P1（不到 P0，避免把审核拖到执行方等不及）。

    d) role=observer → priority 上限 P3，归并进 daily digest，不单独提醒。
       例外：commitment.actionability='ask' → 升 P2
       （actionability='ask' 由 triage 标，表示需要 self 回应；
       不依赖 LLM 重解析原文判疑问句，见方案 §8.1 R3）。

    e) [role=...] 标签缺失（null）→ 现状逻辑不变，按 P0-P3 原规则判，
       不要因为缺标签反向 downgrade。
```

**为什么 R2 改成 `(DDL - createdAt) × 0.5`**：原版"长时间停滞 ≥ 等待时长 ×1.5"里"等待时长"没定义起点。改成"距 updatedAt 超过 commitment 总周期的一半"是装配层可计算的硬指标——commitment 创建到 DDL 一共 7 天，更新时间超过 3.5 天没动 → 触发追单。LLM 不用瞎猜。

**为什么 R3 改成依赖 `actionability`**：原版"原文有疑问句"在 attention prompt 里看不到原文（只有 unit.title 和 meaning，[attentionPrompt.ts:290-308](../apps/server/src/attention/attentionPrompt.ts)）。`actionability` 是 triage 已经标好的字段，5 档枚举 `none/record/notify/ask/act`（intensity 阶梯，见 [activeContext.ts:35-41](../apps/server/src/context/activeContext.ts)），`'ask'` 表示"需要问/响应/确认"程度的行动信号——结构化、可靠、零额外推理成本。

**Caveat**：actionability 阶梯**不区分"谁来行动"**——`'ask'` 既可能是"self 需要回应"也可能是"别人需要响应自己"。所以这条规则是个**启发式**，会有 FP；上线后靠 attentionFeedback 数据收紧。详见 §8.1 R3。

### M5 commitmentAgent handler 分支（review v4 重写）

**重要校准（review v4）**：[commitmentAgent.ts:19-20](../apps/server/src/agents/commitmentAgent.ts) 注释明写 **"仍然不调 LLM，纯本地"**——它是确定性 TypeScript handler，**没有 prompt**。所以 M5 不是"改 prompt 模板"，而是**改 handler 里的 if-else 文案拼装**。

#### M5.1 让 commitmentAgent 拿到 selfRoleOnUnit

commitmentAgent 接收的是 [AgentContextPacket](../apps/server/src/context/agentContextAssembler.ts) + `unit: ContextUnit | null` 参数。**AgentContextPacket 跟 GlobalContextPacket 是不同类型**，M3 的派生只写到 GlobalContextPacket.commitments，agent 看不到。

最便宜的做法是 agent 自给自足——在 handler 内直接调派生函数（M2 已经 export）：

```typescript
import { computeSelfRoleOnUnit } from '../context/selfRoleOnUnit.js';
import { resolveAliased } from '../context/entityResolver.js';
import { getSetting } from '../db.js';

// 在 handler 顶部：
const selfId = getSetting('self_person_entity_id') ?? '';
const selfCanonical = selfId ? resolveAliased(selfId) : '';
const selfRole = unit && selfCanonical
  ? computeSelfRoleOnUnit(unit.id, selfCanonical)
  : null;
```

不污染 AgentContextPacket 类型，selfRoleOnUnit 仍然只有 commitmentAgent 这一个消费方。如果以后其他 agent（prepareMeeting / recap）也要用，再考虑提到装配层。

#### M5.2 handler 分支：cardTitle / bodyLines / priority

[commitmentAgent.ts:53-72](../apps/server/src/agents/commitmentAgent.ts) 现状是按 overdue / hours / criticalSpace / projectPhase 算 priority + 拼 cardTitle。在这套逻辑里**叠加** selfRole 分支：

```typescript
// 现有：基础 priority
let priority: 'P0'|'P1'|'P2'|'P3' = overdue || hours < 24 ? 'P1' : 'P2';
// 现有 criticalSpace / graphContext 调权 ...

// MVP20 §3.13 铁律 13：selfRole 调权（最后做，覆盖之前的）
if (selfRole === 'requester') {
  // P2 上限，DDL 临期不升级
  if (priority === 'P0' || priority === 'P1') priority = 'P2';
  // 仅当有进展信号 / actionability='ask' / 超过总周期一半才出卡
  const hasProgress = /* TODO: 查 packet.relatedContext 里是否有跟本 commitment
                        entities 关联的近 24h 事件 */ false;
  const isUrgentAsk = unit?.actionability === 'ask' || unit?.actionability === 'act';
  const stalled = /* TODO: 距 createdAt 超过 (dueAt - createdAt) × 0.5 */ false;
  if (!hasProgress && !isUrgentAsk && !stalled) {
    return { summary: 'skipped (requester, no progress signal)',
             proposalIds: [], cardIds: [], data: { skipped: 'requester_silent' } };
  }
} else if (selfRole === 'observer') {
  // P3 上限，归 daily digest（不出实时卡）
  // 例外：actionability='ask' → 升 P2
  if (unit?.actionability !== 'ask') {
    return { summary: 'skipped (observer)', proposalIds: [], cardIds: [],
             data: { skipped: 'observer_digest_only' } };
  }
  priority = 'P2';
} else if (selfRole === 'reviewer') {
  // 上限 P1，避免审核拖到执行方等不及
  if (priority === 'P0') priority = 'P1';
}
// selfRole === 'executor' || null → 现状逻辑不变

// 现有：cardTitle / bodyLines 拼装，按 selfRole 改文案
let cardTitle: string;
if (selfRole === 'requester') {
  cardTitle = overdue ? `你提的需求逾期未响应：${title}` : `你提的需求还没动静：${title}`;
} else if (selfRole === 'reviewer') {
  cardTitle = overdue ? `等你审（已逾期）：${title}` : `等你审：${title}`;
} else if (selfRole === 'observer') {
  cardTitle = `进展同步：${title}`;
} else {
  // executor / null → 现状文案
  cardTitle = overdue ? `承诺已逾期：${title}` : `承诺即将到期：${title}`;
}
// bodyLines 同理：requester 加"要不要催一下 <对方>"等
```

具体文案 PR3 落地时按 [commitmentAgent.ts:74-91](../apps/server/src/agents/commitmentAgent.ts) bodyLines 现有结构 fit。M5.2 的 `hasProgress` / `stalled` 计算需要读 packet.relatedContext 或 unit.createdAt——PR3 实现时再具体写，本方案先确定接口。

#### M5.3 跟 graphContext 调权的关系

commitmentAgent 已有 [MVP15B graphContext 调权](../apps/server/src/agents/commitmentAgent.ts) (line 57-70)：projectPhase=overdue → 升档，frozen → 降档。

selfRole 调权放在 graphContext 调权 **之后**——graphContext 是项目级状态（项目整体逾期了），selfRole 是 unit 级角色（这条具体 commitment 我是谁），后者更细，应当覆盖前者。如果项目逾期但我只是 requester，priority 仍降到 P2（不强制升 P0）。

### M6 测试 + 文档

见 §9。

---

## 6. Prompt 与代码改动汇总

| 文件 | 位置 | 改动类型 | 改动 |
|---|---|---|---|
| [attentionPrompt.ts](../apps/server/src/attention/attentionPrompt.ts) | `renderUnitOneLine` ~L290 | prompt 渲染 | 行尾追加 `[role=...]` 标签 |
| [attentionPrompt.ts](../apps/server/src/attention/attentionPrompt.ts) | 铁律 §3 末尾 | prompt 文本 | 新增第 13 条铁律（见 M4） |
| [commitmentAgent.ts](../apps/server/src/agents/commitmentAgent.ts) | handler 主体 | **TypeScript 代码（非 prompt）** | 注入 computeSelfRoleOnUnit；按 selfRole 加 if-else 分支改 priority / cardTitle / bodyLines（见 M5） |
| [triagePrompt.ts](../apps/server/src/triage/triagePrompt.ts) | §11 末尾 | prompt 文本 | **仅 spike 2 触发时**：加 few-shot "我向 X 承诺 → entities 必须有 `{name:'我', role:'actor'}`；X 向我提需求 → entities 必须有 `{name:'我', role:'requester'}`" |
| [.opencode/agent/aiisn-attention.md](../.opencode/agent/aiisn-attention.md) | §13 后追加 §14 | agent 文档 | 同步铁律 13 全文，agent 文档与 prompt 对齐（仿照 MVP15B M7 流程） |

**review v4 校准**：commitmentAgent 是纯本地 TypeScript handler（[commitmentAgent.ts:19-20](../apps/server/src/agents/commitmentAgent.ts) "仍然不调 LLM，纯本地"），不是 LLM agent，没有 prompt。文案分支是代码层 if-else，不是模板。

---

## 7. 验证计划（Spike 1）

### 7.1 准入测试用例（必过）

| 用例 | 期望 `selfRoleOnUnit` | 期望 attention 行为 |
|---|---|---|
| 用户在 Base UX 群提"Image 文案改 2 条"，DDL 24h | `requester` | priority ≤ P2；文案不含"该交了"，含"催一下" |
| 用户答应张三"周三前补 MVP2 方案"，DDL 24h | `executor` | priority P0/P1；文案"该交了 / 建议今天推进" |
| 用户被 cc 在 launch plan 邮件里，DDL 7d | `observer` | priority P3，进 daily digest，不单独弹卡 |
| 设计稿等用户审，DDL 12h | `reviewer` | priority P1；文案"等你审" |
| commitment 抽出来时 entities 里没有 self | `null`（不强行兜底） | 现状规则不变 |

### 7.2 回归测试

跑现有 [apps/server/test/attention-parse-whitelist.test.ts](../apps/server/test/attention-parse-whitelist.test.ts) 等 attention 相关测试，确保 packet 类型扩展没破其它装配路径。

### 7.3 灰度

- **第一周**：PR1 + PR2 上线 = M1-M3 装配 + M4 prompt 行尾暴露 `[role=...]`，但**不加铁律 13**。让 LLM 自发学会用这个信号，对比 attention 输出有无变化（前后各 50 条人工评分）
- **第二周**：PR3 上线 = 加铁律 13 + M5 commitmentAgent 文案分支 + M6 测试。再做一轮 50 条人工评分对比 PR1+PR2 基线

（这与 §10 的 PR1/PR2/PR3 切分对齐，详见 §10。）

---

## 8. 风险与开放问题

### 8.1 已知风险

| 风险 | 缓解 |
|---|---|
| **R1（review v2 发现，v3 收紧）"我"字符串 vs localizedName 别名不通**：[larkOrgCollector.ts:418-450](../apps/server/src/collectors/larkOrgCollector.ts) 把 self entity 用 `localizedName`（如"刘昕明"）落库，alias 只有 `open_id`。triagePrompt §11 line 35 写"entities.actor 是『我』"，结合 §8 "entities.name 必须是信号原文里出现过的具体名字"——IM 文本前缀就是"我"，**LLM 几乎必然字面输出 `{name:"我"}`**。这个"我" entity 跟 self canonical id 没有 alias 链关联，A 路 (resolveAliased) 查不到 | §3.3 / §M2 实现：JS 里**双路或**——A 路 `resolveAliased(eid)===selfCanonicalId`；B 路 `ename==='我'` 兜底。**预期 B 路命中数会是多数**，spike 1 必须报"A 路 vs B 路 vs 双路 vs 总命中"四个数字。**独立工单**（不阻塞 PR1）：在 larkOrgCollector ensureSelfEntity 末尾把 `"我"` entity merge 进 self 的 entity_aliases，治本 |
| **triage 没把 self 标进 entities** —— spike 1 一旦发现 null 比例 > 30%（双查后），§3.2 归一表救不了 | 触发 spike 2 改 triagePrompt §11，加 few-shot 强制要求 self 出现时必须有 role |
| **role 标错**（应该 `requester` 标成 `actor`） | 准入测试 §7.1 人工验证 20 条；上线后 attention 反馈通道（[attentionFeedback.ts](../apps/server/src/attention/attentionFeedback.ts)）增加"角色判错"反馈分类，攒数据回头收紧 triagePrompt |
| **同一 unit self 出现多次且角色冲突**（既是 cc 又被 @） | §3.2 ROLE_PRIORITY 取最强（executor > requester > reviewer > observer）；冲突案例复杂时再讨论按 entity_edge 时间取 |
| **R3（review v2 发现，v3 收紧）observer 例外条款依赖 LLM 重解析原文**：attention prompt 里没有原文，"有疑问句就升 P2"判不出 | §3.13.d 改为依赖结构化字段：`commitment.actionability='ask' → 升 P2`。**caveat**（review v3 标注）：actionability 是**行动强度阶梯**（none<record<notify<ask<act，见 [activeContext.ts:35-41](../apps/server/src/context/activeContext.ts)），表示"需要多大动作"，**不区分谁来动**。所以 `'ask'` 升 P2 是个**启发式**，会有 FP（别人需要回应别人的事被误升）；但仍优于"原文有疑问句"（后者根本判不出）。FP 上线后靠 attentionFeedback 攒数据再收紧 |
| **R4（review 发现）跟 MVP16C commitment 状态识别交互未定义**：done/cancelled 的 commitment 算 selfRoleOnUnit 无意义 | M3 装配只对 `packet.commitments`（只含 active）调用派生函数；MVP16C 维护的 status 过滤在装配前就完成。selfRoleOnUnit.ts 派生函数不做 status 过滤，是装配层职责 |
| **observer 一刀切静音导致漏球**（执行方违约、阻塞、@我了） | §3.13.d 例外（actionability='ask' → P2）+ M5 commitmentAgent 文案分支也明确"observer 仅在事件触发时输出" |
| **prompt token 多 5-10%** | 行尾 `[role=requester]` 一条 commitment +12 token。[GLOBAL_SLICE_CAPS.commitments=10](../apps/server/src/context/agentContextAssembler.ts)，10 条 × 12 = ~120 token，相对 packet 总量 30-50k 完全可忽略（review v4 校准：第一版高估 5×，cap 是 10 不是 50） |

### 8.2 开放问题（PR 之前需定）

1. **PacketUnit 类型放哪**：是给 `ContextUnit` 加 optional `selfRoleOnUnit` 字段，还是在 packet 层另起 `PacketUnit = ContextUnit & {...}`？倾向后者，避免污染 ContextUnit 的"原始数据"语义。
2. **`computeSelfRolesOnUnits` 缓存**：每次 attention tick 都跑 SQL。如果发现成本高（实测 > 50ms），可在 contextStore 加 in-memory cache（按 unit.updatedAt 失效）。先不预优化。
3. **goal / uncertainty 的 self role 语义是否完全一样**：goal 上的 `requester` 是"别人定的 KR 落到我身上"还是"我提的 goal 但落到团队"？这俩语义不同。spike 1 同时抽样 goal/uncertainty，看实际数据再决定要不要拆。

### 8.3 跟现有体系的边界

| 概念 | 粒度 | 跟 SelfRoleOnUnit 的关系 |
|---|---|---|
| `PersonProjectRole` (`owner/driver/...`) | 人-项目边 | **正交**：项目级聚合，回答"我在 Base UX 项目里整体是 owner"。MVP20 不改 |
| `OrgRoleFromMe` (`peer_same_dept/...`) | 人-人 | **正交**：组织关系，不变 |
| `DecisionRoleHint` (`co_owner/reviewer/...`) | 协作者排名 | **正交**：MVP15B 字段，是关于"别人"的 |
| `ContextEntityRef.role` (`actor/target/about/...`) | unit-entity | **数据源**：MVP20 派生计算的输入 |
| **`SelfRoleOnUnit`** (本方案新增) | **unit 级** | **填补 MVP15B 之后剩下的空白**：回答"我对这一条具体 commitment 是 requester 还是 executor" |

---

## 9. 测试计划

### 9.1 unit test (vitest)

`apps/server/test/self-role-on-unit.test.ts`（新建）：

| 测试 | 内容 |
|---|---|
| `mapToSelfRole` 覆盖归一表 | 每个 EXECUTOR/REQUESTER/REVIEWER/OBSERVER 项 + 未知 role + 大小写 |
| `computeSelfRoleOnUnit` 单 unit 单 role | 各类 role 返回正确 SelfRoleOnUnit |
| `computeSelfRoleOnUnit` 单 unit 多 role | ROLE_PRIORITY 取最强 |
| `computeSelfRoleOnUnit` self 不在 entities | 返回 null |
| `computeSelfRoleOnUnit` self 在 entities 但 role 未归类 | 返回 null |
| `computeSelfRolesOnUnits` 批量 | N 个 unit 一次 SQL，结果与 N 次单调用一致 |

### 9.2 integration test

`apps/server/test/attention-self-role-integration.test.ts`（新建，PR1）：

| 测试 | 内容 |
|---|---|
| 装配端到端 | 构造 fixture：3 条 commitment（self=executor / requester / observer），verify packet.commitments[i].selfRoleOnUnit 正确 |
| prompt 渲染 | snapshot `renderUnitOneLine` 输出含 `[role=requester]` 标签 |
| name='我' 兜底命中 | fixture：unit entities 里 self 以 `{name:'我', type:'person'}` 出现（无 alias 链），验证 B 路兜底命中 |

`apps/server/test/commitment-agent-self-role.test.ts`（新建，PR3）：

| 测试 | 内容 |
|---|---|
| selfRole='requester' 且无进展信号 | handler 返回 `skipped: 'requester_silent'`，无 cardId |
| selfRole='requester' 且 actionability='ask' | 出 card，title 含"你提的需求"，priority ≤ P2 |
| selfRole='observer' 默认 | handler 返回 `skipped: 'observer_digest_only'` |
| selfRole='observer' 且 actionability='ask' | 出 card，priority=P2 |
| selfRole='reviewer' | 出 card，title 含"等你审"，priority ≤ P1 |
| selfRole='executor' / null | 现状逻辑完全不变（regression baseline） |
| graphContext.projectPhase='overdue' + selfRole='requester' | selfRole 覆盖项目级升档，最终 P2 不到 P0（验证 M5.3 调权顺序） |

### 9.3 smoke

`apps/server/scripts/smoke-self-role-attention.ts`（新建，仿照现有 smoke 脚本）：

- 用真实 DB（开发环境）跑一次 attention tick
- 输出"近 20 条 commitment 的 selfRoleOnUnit 分布"
- 输出"近 5 条 attention item 的 priority 是否符合预期"

### 9.4 文档同步

- amend `.opencode/agent/aiisn-attention.md` §14（按 MVP15B M7 流程）
- 在 `docs/MVP-PRD.md` 加一条 changelog："MVP20 区分 commitment 用户角色"

---

## 10. 时间预估

| 阶段 | 工时 | 累计 |
|---|---|---|
| M1 spike 数据探测 | 0.5d | 0.5d |
| M2 派生函数 + unit test | 0.5d | 1.0d |
| M3 装配集成 | 0.5d | 1.5d |
| M4 prompt 暴露 + 铁律 13 | 0.5d | 2.0d |
| M5 commitmentAgent 文案分支 | 0.5d | 2.5d |
| M6 integration test + smoke + 文档 | 0.5d | 3.0d |
| **（条件触发）spike 2: triagePrompt 加 few-shot + 回测** | +1d | 4.0d |

**总计 2.5-4 天**，PR 拆 3 个（review v2 B3 修正、v4 调整范围）：

- **PR1（M1-M3，~1.5d）**：spike 探测脚本 + 派生函数 + GlobalContextPacket 装配集成。纯后端数据，attention prompt 不变。可以上 main 不影响线上 LLM 行为。**M2 派生函数 export 全部 public 符号**（`computeSelfRoleOnUnit` / `computeSelfRolesOnUnits` / `mapToSelfRole` / `SelfRoleOnUnit` type），PR3 commitmentAgent 直接 import 用。
- **PR2（M4 部分，~0.5d）**：attentionPrompt 行尾暴露 `[role=...]`，**不加铁律 13**。让 LLM 自发学习一周，观察 attention 输出变化
- **PR3（M4 剩余 + M5 + M6，~1d）**：加铁律 13 + **commitmentAgent handler 加 selfRole 分支**（M5.1 内部调 computeSelfRoleOnUnit，M5.2 改 priority/cardTitle/bodyLines，M5.3 放在 graphContext 调权之后）+ 完整测试 + 文档同步。等 PR2 灰度一周稳了再上

PR 之间是顺序依赖（PR2 的 prompt 改动需要 PR1 派生字段存在；PR3 的 commitmentAgent 改动依赖 PR1 export 的派生函数；PR3 的铁律需要 PR2 的标签暴露）。

---

## 11. 决策记录

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-05-27 | 不在 ContextUnit schema 加 `initiatorId/executorIds` | 数据已在 entities[].role，加新字段是冗余 |
| 2026-05-27 | 不新建 `commitmentRoleInducer` 后台 job | 派生字段算一次很便宜，无跨 tick 复用价值 |
| 2026-05-27 | 加在 agentContextAssembler 派生层而不是 personProjectInducer 聚合层 | 聚合层是"跨 unit 平均我对项目什么角色"，跟"这一条具体 unit 我什么角色"是不同粒度，混在一起会重蹈本 bug 的覆辙 |
| 2026-05-27 | spike 1 先验证现有 triage 数据够不够，spike 2 条件触发 | 避免在不知道数据质量前先动 triagePrompt（改 prompt 会影响所有抽取，回滚成本高） |
| 2026-05-27 | BoundaryRule 不加 `selfRoleOnUnit` 条件 | 偏好文案能 cover 80% 场景，结构化 boundary 投入产出比低；攒数据再说 |
| 2026-05-27 (review v2) | `target` 归 requester（不是 observer） | self=target 语义是"别人答应我做某事"，正好是 Base UX case 形态。第一版把 target 归 observer 是把 bug 修反 |
| 2026-05-27 (review v2) | `organizer` / `coordinator` 归 executor | 它们是主动驱动者；第一版误归 requester |
| 2026-05-27 (review v2) | PR 切 3 个不是 2 个 | 原方案 2 个 PR 跟 §7.3 灰度（先暴露不加铁律→再加铁律）自相矛盾。拆 3 个对齐 |
| 2026-05-27 (review v2 / v3 修正) | self 取数双路或（A 路 resolveAliased + B 路 name='我' 兜底；v2 误写成 SQL UNION，v3 校准为 JS 端） | larkOrgCollector 落 self 时 alias 不含字符串"我"；triagePrompt §11 又让 LLM 输出 `name:'我'`。不兜底会大面积 null |
| 2026-05-27 (review v2) | observer 例外条款依赖 `actionability='ask'` 而非"原文有疑问句" | attention prompt 里没原文，原版规则跑不出来；改用 triage 已标的结构化字段 |
| 2026-05-27 (review v2) | requester "长时间停滞"用 `(DDL - createdAt) × 0.5` 替代"等待时长 ×1.5" | 后者起算时间未定义，前者是装配层可计算的硬指标 |
| 2026-05-27 (review v2) | MVP20 只接 commitment，goal/uncertainty 不挂 selfRoleOnUnit | goal 可能是团队级 OKR，uncertainty "我提的 vs 别人问我的"原文很难分清，spike 风险高；先攒 commitment 数据 |
| 2026-05-27 (review v3) | SQL 改成"取原始 entity_id + JS resolveAliased"模式 | review v2 的 SQL `WHERE e.canonical_id=?` 跑不起来——[context_entities](../apps/server/src/db.ts) 没有 `canonical_id` 列。canonical 解析是 `entity_aliases(id,alias_of)` 表 + 运行时 `resolveAliased()` 函数。新模式跟 [personProjectInducer.ts:101](../apps/server/src/context/personProjectInducer.ts) 一致 |
| 2026-05-27 (review v3) | actionability='ask' 升 P2 是启发式，文档标 caveat | actionability 阶梯不区分"谁动"；FP 难免，靠 feedback 攒数据再收紧 |
| 2026-05-27 (review v3) | spike 1 必须报"A 路 vs B 路 vs 双路 vs 总命中"四个数字 | §11 文字让 LLM 字面输出 `name='我'` 几乎必然；预期 B 路（name='我' 兜底）命中是多数，必须量化以决定是否启动独立工单（larkOrgCollector merge '我' alias 治本） |
| 2026-05-27 (review v4) | commitmentAgent 改 handler if-else，不是 prompt 模板 | [commitmentAgent.ts:19-20](../apps/server/src/agents/commitmentAgent.ts) "仍然不调 LLM，纯本地"，根本没 prompt。v3 写"加 prompt 模板"是空中楼阁 |
| 2026-05-27 (review v4) | commitmentAgent 内部调用派生函数，不污染 AgentContextPacket | GlobalContextPacket 与 AgentContextPacket 是两个不同类型——M3 只挂前者，agent 看不到。selfRoleOnUnit 唯一消费方就是 commitmentAgent，集中改一个文件比扩 packet 类型清爽 |
| 2026-05-27 (review v4) | token 估算 ≤ 10 条（不是 ≤ 50 条） | [GLOBAL_SLICE_CAPS.commitments=10](../apps/server/src/context/agentContextAssembler.ts)，v2/v3 高估 5×；overhead 实际 ~120 token，可忽略 |
| 2026-05-27 (review v4) | selfRole 调权放在 graphContext 调权之后 | graphContext 是项目级（项目逾期），selfRole 是 unit 级（这条 commitment 我是谁），后者更细应当覆盖前者。项目逾期但我只是 requester，仍降到 P2 |
