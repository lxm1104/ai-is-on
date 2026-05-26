# MVP16-C Commitment 状态识别技术方案

> MVP16 路线图的第三阶段。依赖 MVP16-A（双向消息可见）已上线，强烈建议 MVP16-B（thread 整段对话作为单 signal 输入）也已上线——thread 完整性显著提高 LLM 判断 status 的准确率。
> 跨阶段上线策略、成本测算、隐私边界、历史数据回放等共性内容见 MVP16-A 文档末尾的"上线策略与跨阶段考量"章节。

## 背景

MVP16-A 让 LLM 看到对话双方；MVP16-B 让一段对话作为整体出现在 LLM 面前。但当前 `context_units` 中 `kind=commitment` 的语义只有"存在 / 不存在"两态——一旦写入，下次扫窗即便对方已经"OK"或"我已发了"，commitment 仍然以 active 状态影响 attention engine。

这造成两类常见问题：

1. **已解决的 commitment 反复出卡**。Attention LLM 看到 `commitments` 列表里某条 unit 还在，就可能再次包装成 attention item，即使 recentEvents 里已经有"对方说好的"的对话。
2. **跨多日 commitment 无法逐步收敛**。同一 mergeHint 的 commitment 在不同对话里被反复更新（content 重写），但状态层面没有递推关系，无法表达"对方曾催过两次，我已回应一次，仍待最终交付"。

MVP16-C 给 commitment 引入 **lifecycle status**，让 Triage 提取与 Attention 排序在同一语义单元上看到时间维度的进展，并允许 resolved 后**重新打开**（关键设计修订，见下文）。

## 目标

1. `context_units(kind='commitment')` 携带显式 status：`open` / `acknowledged` / `in_progress` / `resolved` / `dropped`。
2. Triage 在提取 commitment 时同时输出 status（**软落地**：缺失时默认 'open'，不强制 LLM 必填）。
3. 允许 `resolved → open` 重开，并用 `reopened_count` 记录重启次数——这是真实的信号（"反复推不动"）而不是要避免的脏数据。
4. Attention engine 按 status 过滤：默认只把 active 状态（open / acknowledged / in_progress）的 commitment 当作活跃信号；resolved 在可配置时长内保留为历史上下文但不出卡。
5. 用户可在卡片上点"已完成"动作，**仅对该卡片关联的 primary commitment** 推到 `resolved`（而不是所有 signalIds）。

## 非目标

- 不为 goal / uncertainty / state 引入完整 lifecycle（state 已天然瞬时；goal 由 work map 管理；uncertainty 解决靠 LLM 重新提取）。schema 列对所有 kind 通用，但只对 commitment 主动维护。
- 不引入"承诺自动到期"的时间判断（已有 `time.dueAt`，attention prompt 自然会用）。
- 不重写 attention_interactions 表（MVP14）；只在它产生的 action 与 commitment status 之间加一个映射。

## 数据模型

### `context_units` 新增列

沿用 db.ts 的 idempotent + ensureColumn 模式：

```ts
ensureColumn('context_units', 'status', 'TEXT');                       // 'open'|...|'dropped'|NULL
ensureColumn('context_units', 'status_updated_at', 'TEXT');            // ISO
ensureColumn('context_units', 'status_evidence_event_id', 'TEXT');     // 最新一次让 status 变化的 event_id
ensureColumn('context_units', 'reopened_count', 'INTEGER NOT NULL DEFAULT 0');
```

- 非 commitment 的 unit `status` 留 NULL。
- 历史 commitment 一次性回填：
  ```ts
  db.exec(`
    UPDATE context_units
       SET status='open', status_updated_at=updated_at
     WHERE kind='commitment' AND status IS NULL;
  `);
  ```

### 状态机（含 reopen）

```
                 ┌──────────────┐
   first emit ──►│    open      │◄────────┐
                 └──────┬───────┘         │
                        │  我方表达"      │
                        │  知道了/会做"   │
                        ▼                 │
                 ┌──────────────┐         │
                 │ acknowledged │◄──┐     │
                 └──────┬───────┘   │     │
                        │           │     │
                        ▼           │     │
                 ┌──────────────┐   │     │
                 │ in_progress  │◄──┤     │
                 └──────┬───────┘   │     │
                        │           │     │
                        ▼           │     │
                 ┌──────────────┐   │     │
                 │   resolved   │───┴─────┘
                 └──────────────┘
                     reopened_count++
                                ↑
                 ┌──────────────┐
                 │   dropped    │  ← 用户决策 / boundary rule
                 └──────────────┘
                 （dropped 不可 reopen）
```

转移规则：
- 正向递进：`open → acknowledged → in_progress → resolved`。
- **resolved → open / acknowledged / in_progress 允许**，但每次回退把 `reopened_count` +1。回退原因通过 status_evidence_event_id 追溯。
- `dropped` 可从任何状态进入；**不可 reopen**（dropped 表示用户主动放弃，不应被自动重启）。
- 历史 status 不保留时间线（如需可在未来用 audit_logs 实现），只保留当前快照 + reopen 次数。

## 实现步骤

### 1. Schema 改造

[apps/server/src/db.ts](../apps/server/src/db.ts) 在现有 `ensureColumn` 列表末尾追加：

```ts
ensureColumn('context_units', 'status', 'TEXT');
ensureColumn('context_units', 'status_updated_at', 'TEXT');
ensureColumn('context_units', 'status_evidence_event_id', 'TEXT');
ensureColumn('context_units', 'reopened_count', 'INTEGER NOT NULL DEFAULT 0');

// 一次性回填（幂等，因为 WHERE status IS NULL）
db.exec(`
  UPDATE context_units
     SET status='open',
         status_updated_at=updated_at
   WHERE kind='commitment' AND status IS NULL;
`);
```

### 2. ContextUnit 类型与持久化层

[apps/server/src/context/ContextUnit.ts](../apps/server/src/context/ContextUnit.ts)（路径以仓库实际为准）：

```ts
export type CommitmentStatus =
  | 'open'
  | 'acknowledged'
  | 'in_progress'
  | 'resolved'
  | 'dropped';

export type ContextUnit = {
  // ... 原字段
  status?: CommitmentStatus | null;
  statusUpdatedAt?: string | null;
  statusEvidenceEventId?: string | null;
  reopenedCount?: number;
};
```

`upsertContextUnit()`（被 [triageQueue.ts:158-202](../apps/server/src/triage/triageQueue.ts) 调用）增加合并逻辑：

```ts
type StatusMergeInput = {
  prev: CommitmentStatus | null;
  next: CommitmentStatus | null;
  prevReopenedCount: number;
  // 用于"以最新源为准"的仲裁
  prevStatusUpdatedAt: string | null;
  nextOccurredAt: string;
};

function mergeStatus(input: StatusMergeInput): {
  status: CommitmentStatus | null;
  reopenedCount: number;
} {
  const { prev, next, prevReopenedCount, prevStatusUpdatedAt, nextOccurredAt } = input;
  if (!prev) return { status: next ?? null, reopenedCount: prevReopenedCount };
  if (!next) return { status: prev, reopenedCount: prevReopenedCount };

  // dropped 是终态，不可改
  if (prev === 'dropped') return { status: 'dropped', reopenedCount: prevReopenedCount };
  if (next === 'dropped') return { status: 'dropped', reopenedCount: prevReopenedCount };

  // 多源仲裁：若 next 来自比 prev 更早的事件，忽略 next（旧消息不该覆盖新结论）
  if (prevStatusUpdatedAt && nextOccurredAt < prevStatusUpdatedAt) {
    return { status: prev, reopenedCount: prevReopenedCount };
  }

  // resolved → 任意 active：reopen
  const ACTIVE: CommitmentStatus[] = ['open', 'acknowledged', 'in_progress'];
  if (prev === 'resolved' && ACTIVE.includes(next)) {
    return { status: next, reopenedCount: prevReopenedCount + 1 };
  }

  // 正向单调
  const order: CommitmentStatus[] = ['open', 'acknowledged', 'in_progress', 'resolved'];
  const pi = order.indexOf(prev);
  const ni = order.indexOf(next);
  if (pi === -1 || ni === -1) return { status: prev, reopenedCount: prevReopenedCount };
  return {
    status: ni > pi ? next : prev,
    reopenedCount: prevReopenedCount,
  };
}
```

upsert 路径：同 merge_key 命中已有 unit 时调用 `mergeStatus`，status 或 reopened_count 变化则更新 `status_updated_at` 与 `status_evidence_event_id`。

### 3. Triage Prompt 软落地

[triagePrompt.ts](../apps/server/src/triage/triagePrompt.ts) 第 4 条 commitment 规则补充（不替换原文，**追加**）：

```text
4 (cont.) commitment 字段补充：
   - status（可选）：当前承诺状态，取值：
       'open'         —— 对方刚提出请求，我尚未明确回应
       'acknowledged' —— 我已明确说"知道/会做/收到"但未开始执行
       'in_progress'  —— 我或对方明确表示已在执行中、已开始动手
       'resolved'     —— 已完成/已发/已交付，对方收到或我明确表态完成
       'dropped'      —— 因取消、过期或被明确放弃
     若 text 中无明确证据，**省略 status**（系统会按 'open' 处理）。
     **不要凭文本语气猜测 status**——"看起来对方在催"≠ status='open'。
   - statusEvidence（仅在你给出 status 时必填）：≤40 字，引用决定 status 的
     原句或行号（如"text 末行：我:已发"）。
```

schema 示例（第 50-66 行）的 commitment 块对应补字段，**保持可选**。

### 4. Server-side Status 兜底与置信度调整

[triageQueue.ts persistContextUpdates](../apps/server/src/triage/triageQueue.ts) 中：

```ts
if (draft.kind === 'commitment') {
  // 缺失 status → 默认 open
  if (!draft.status) {
    draft.status = 'open';
  }
  // 给出 status 但 evidence 缺失 → 降低 confidence，但保留 status
  if (draft.statusEvidence == null || draft.statusEvidence.length < 5) {
    draft.confidence = Math.min(draft.confidence ?? 0.5, 0.5);
  }
  // 把当前 event id 作为 status_evidence_event_id 注入 upsert
  draft._statusEvidenceEventId = ev.id;
}
```

这是把 prompt 软约束 + server 强兜底结合，避免 LLM JSON 不稳定时整条数据丢失。

### 5. Context Assembler 暴露 status

[apps/server/src/context/agentContextAssembler.ts](../apps/server/src/context/agentContextAssembler.ts) 在组装 GlobalContextPacket 时，commitments 数组每项添加：

```ts
type CommitmentRef = {
  // ... 原字段
  status: CommitmentStatus;           // null 在 assembler 层兜底为 'open'
  statusUpdatedAt: string | null;
  reopenedCount: number;
};
```

并在 SQL 中加上过滤：

```sql
-- resolved 在保留窗口外不暴露给 assembler
SELECT ... FROM context_units
 WHERE kind='commitment'
   AND (
     status IN ('open','acknowledged','in_progress')
     OR (status='resolved' AND status_updated_at > :resolved_retention_cutoff)
   );
```

`resolved_retention_cutoff = now - config.commitmentResolvedRetentionHours`。dropped 直接不查。

### 6. Attention Prompt 调整

[attentionPrompt.ts](../apps/server/src/attention/attentionPrompt.ts) `buildAttentionUserMessage` 在渲染 `<commitments>` 时附加 status 与 reopened_count：

```ts
for (const c of packet.commitments) {
  const tag = `status=${c.status}` +
              (c.reopenedCount > 0 ? `,reopened=${c.reopenedCount}` : '');
  lines.push(`  - [${c.id}] (commitment) ${c.title} [${tag}] ...`);
}
```

system prompt 铁律新增第 14 条：

```text
14. <commitments> 每条带 [status=...] / [reopened=N] 标签：
    - status='open' / 'acknowledged' / 'in_progress'：仍是活跃承诺，按 dueAt 与
      stakeholder 关系判断 priority。
    - status='resolved' 出现在 packet 中表示"刚解决不久"，**默认不出 attention
      item**；仅在用户明确询问历史或 boundary rule 要求复盘时才引用。
    - reopened ≥ 2：意味着这件事曾被关闭又重启多次，本身就是高优信号——
      `why` 必须明确写出"已重启 N 次"，priority 可上推一档。
    - status='dropped' 不会出现在 packet（assembler 已过滤）。
```

### 7. 卡片交互与 primaryCommitmentId

#### 7.1 Attention output 增加 primaryCommitmentId

[attentionTypes.ts](../apps/server/src/attention/attentionTypes.ts) AttentionItem 类型增加：

```ts
type AttentionItem = {
  // ... 原字段
  primaryCommitmentId?: string | null;   // signalIds 中的某个 commitment unit id
};
```

attention prompt 在 output schema 中说明：

```text
若本条 item 主要围绕单个 commitment 展开，**必须**在 primaryCommitmentId 中
明确指出 signalIds 里的哪个 commitment unit id 是"卡片所讲的那件事"；
若 item 不围绕特定 commitment（如日程提醒、信息变更），留空。
```

#### 7.2 "已完成"按钮的精确语义

[apps/web/src/components/SignalCard.tsx](../apps/web/src/components/SignalCard.tsx)：仅当 `attention_item.primaryCommitmentId` 非空时，渲染"已完成"按钮。

[apps/server/src/routes/attention.ts](../apps/server/src/routes/attention.ts) 新增 action `mark_commitment_resolved`：

```ts
1. 写入 attention_interactions(action='mark_commitment_resolved')
2. const cid = attention_item.primaryCommitmentId
3. if (cid) updateCommitmentStatus(cid, 'resolved', triggerEventId=null,
                                    source='user_action')
4. attention_item.status = 'acted'（沿用 MVP14 路径）
```

不再批量 resolve 所有 signalIds 中的 commitment。

#### 7.3 "忽略这类"映射到 dropped

类似地，"忽略这类"动作：

```ts
if (action === 'dismiss' && cid) {
  updateCommitmentStatus(cid, 'dropped', triggerEventId=null, source='user_action');
}
```

`dropped` 后不会再出现在 packet 中，自然不会再出卡。

## Prompt 工程注意点

- Triage 与 Attention 都在 prompt 中提到 `status`，必须在 user message 渲染中真的输出它，否则 LLM 拿不到证据会乱猜。
- MVP16-B 的 `p2p_thread` 信号天然提供"完整对话上下文"——这是 status 判断的关键前提。MVP16-C 严格建议 MVP16-B 已上线。若仅 A 上线就引入 C，预期 status 判断准确率 < 70%，可接受但远不如 A+B+C。

## 配置

```ts
// apps/server/src/config.ts
commitmentResolvedRetentionHours: envInt('COMMITMENT_RESOLVED_RETENTION_HOURS', 48),
// 关闭整套 status 行为的硬开关，便于回滚
commitmentStatusEnabled: envBool('COMMITMENT_STATUS_ENABLED', true),
```

`commitmentStatusEnabled=false` 时：

- assembler 不过滤 resolved，所有 commitment 都暴露（退回 MVP16-B 行为）。
- prompt 中 [status=...] 标签照样渲染但 LLM 可以忽略。
- 卡片按钮 mark_commitment_resolved 仍可写库（不影响 attention 但留下用户意图）。

## 兼容性 / 回滚

- 新增列默认 NULL / 0；旧代码读到 unit.status 为 undefined 时仍按"open"处理（在 assembler 默认填 'open'）。
- 回滚：把 `COMMITMENT_STATUS_ENABLED=false` 即可——assembler / prompt 都失效，schema 列保留。
- 完全回滚（删列）成本极低（SQLite drop column 麻烦但可重建表），实操不必。

## 验证

### 单元测试

文件：`apps/server/test/triage/commitmentStatus.spec.ts`

| 用例 | prev / next / 时间 | 期望 status / reopened |
|------|--------------------|-----------------------|
| 首次 open | null / 'open' / T0 | open / 0 |
| 升级 | open / in_progress / T1 | in_progress / 0 |
| 同序 | acknowledged / open / T1 | acknowledged / 0（不退）|
| reopen | resolved / open / T2 | open / 1 |
| 二次 reopen | resolved(reopened=1) / in_progress / T3 | in_progress / 2 |
| dropped 终态 | resolved / dropped / T2 | dropped / 0 |
| dropped 不可 reopen | dropped / open / T3 | dropped / 0 |
| 旧消息不覆盖新结论 | resolved@T2 / open@T1 | resolved / 0 |

### 端到端回放

复用 5/26 程圣淳对话（前提 MVP16-A + MVP16-B 已上线）：

1. 该对话产出 1 条 `p2p_thread` event。
2. Triage 提取 commitment，预期 status='in_progress' 或 'resolved'（取决于"已发"语义识别），含 statusEvidence。
3. Attention engine 看到 status=in_progress 但 dueAt 已临，可能 P2/P3；用户在卡片上点"已完成"后，下一轮 attention 不再引用该 commitment。
4. 在测试库手工构造"对方重新发起"事件 → Triage 应识别 reopen，reopened_count 变 1，attention prompt 出 `reopened=1` 标签。

### 观测指标

- commitments 表中各 status 分布（预期 active 占多数；resolved 累积增长；dropped 极少）。
- attention 卡片"重复出现同 commitment"的频次（预期 → 0）。
- 用户点"已完成"按钮的次数 / 周（衡量 UX 是否有用）。
- reopen 次数分布（若某些 commitment reopen ≥ 3，反映用户真实工作流问题，值得报警）。

## 已知风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| LLM 误判 status（如把"嗯"理解为 acknowledged） | 真正未做的承诺被标 ack/resolved | confidence 兜底（缺 statusEvidence 时降 confidence）；用户卡片"重新打开"按钮可手动 reopen |
| 同 mergeHint 跨多源 status 冲突 | 仲裁错误 | mergeStatus 的"以更晚 occurredAt 为准"规则；多源冲突时优先采纳"对方明确确认"类证据 |
| 用户依赖按钮但忘点 | resolved 比例偏低 | attention prompt 明确"对话中已结清的，主动忽略不出卡"，让 LLM 接管自动 resolve |
| commitment 在不同 chat 里被合并语义有误 | 同 mergeHint 但实际不是同一件事被错误合并 | mergeKey 由 LLM 提供，本方案不改合并算法；若发现频繁错合并，应在 mergeKey 算法层修，属另一专题 |
| dropped 不可逆，用户手贱误点 | 该 commitment 永久消失 | UI 加二次确认；audit_logs 留痕；运维 SQL 可手动改回 |
| primaryCommitmentId 留空导致按钮缺失 | 部分 commitment 类卡片没"已完成"按钮 | attention prompt 强约束（item 围绕 commitment 时必须填）；retention 期内 LLM 会被推到自动 resolve |

## 与 A / B 的关系

- 依赖 MVP16-A 的双向消息可见（status='in_progress' 的"我在做"判断离不开 me-row）。
- 强烈依赖 MVP16-B 的 thread 整段对话（碎片 burst 信号下 LLM 无法稳定判断 status）。
- C 单独跑（不上 B）效果约 70%；C + B 效果约 90%；A 缺失则 C 无意义。

## 工作量估计

| 任务 | 估计 |
|------|------|
| schema ensureColumn + 历史回填 | 0.25 day |
| ContextUnit 类型 + mergeStatus + 单测 | 1 day |
| Triage prompt + server 兜底 + persistContextUpdates 改造 | 0.75 day |
| Attention assembler 过滤 + prompt 改造 | 0.5 day |
| primaryCommitmentId 路径（attention prompt + 类型 + 前端按钮 + route）| 1.25 day |
| 端到端回放 + 观测 setup | 0.5 day |
| 合计 | **4.25 days** |

## 总体路线图（修订）

| 阶段 | 关键产出 | 工作量 | 依赖 | 决策门 |
|------|---------|--------|------|--------|
| MVP16-A-1 | 单聊侧双向（去 self-filter + thread_replies + 排序 + 渲染）| 1 day | 无 | A-1 后观测 3-5 天 |
| MVP16-A-2 | 群聊侧双向（新增 listMyGroupMessages + 合并去重）| 1.25 day | A-1 | A 整体观测 1 周，催促类误判下降 ≥ 60% 则暂缓 B |
| MVP16-A 通用 | prompt 调整 + triage_results token 列 | 0.5 day | 与 A-1 / A-2 并行 | |
| MVP16-B | Thread 聚合 + payload 累积 + 增量 lookback | 4 day | A 完成 | B 后观测 1 周，commitment 状态混淆是否仍频繁 |
| MVP16-C | Commitment lifecycle + reopen + primaryCommitmentId | 4.25 day | A + B | 是否上 C 视 B 后观察 |
| **合计**（若全部上线）| | **11 days** | | |

A 单独上线即可解决最常见误判；A+B 解决对话碎片问题；A+B+C 形成承诺生命周期闭环。三阶段之间设置决策门，不必预先全包。
