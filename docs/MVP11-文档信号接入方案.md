# AI is ON：MVP11 文档信号接入方案

> 目标：把"文档评论 / 会议纪要 / 飞书妙记"这三类**文档与沟通衍生信号**纳入现有 collector → ContextUnit → trigger → agent 链路，让 Agent 看到"别人在我的文档上说了什么、会上决了什么"。

本方案经 Claude × Codex 5 轮对抗性 review 达成共识。

---

## 1. 当前 MVP10 代码基线

### 1.1 已有的链路

核心链路：

```text
collector / manual input
→ events
→ minimal ContextUnit (kind='event')
→ triage contextUpdates (LLM)
→ contextStore.upsertContextUnit
→ triggerEvaluator (纯函数)
→ AgentRunQueue
→ agent handler (sliced AgentContextPacket)
→ action_proposal
→ card
→ user feedback / correction / boundary / audit
```

主要落地模块：

- `apps/server/src/collectors/{calendarCollector,driveCollector,imCollector,scheduler,ingest,types}.ts`
- `apps/server/src/context/{ContextUnit,contextStore,activeContext,entityResolver,changeContext,agentContextAssembler}.ts`
- `apps/server/src/triggers/{triggerEvaluator,triggerScheduler}.ts`
- `apps/server/src/agents/{AgentRunQueue,agentRegistry,commitmentAgent,prepareMeetingAgent,syncDraftAgent,caringAgent,dailyDigestAgent}.ts`
- `apps/server/src/boundary/*`、`apps/server/src/correction/*`、`apps/server/src/bootstrap/*`

### 1.2 文档信号当前的死角

- driveCollector 只拿"我编辑过的 doc"，**别人对我相关文档的评论 / @我** 完全没采集
- 飞书会议的 AI 纪要 / action item 完全没采集
- 飞书妙记（录音转写）完全没采集
- Work Map 写的"权威文档 URL"（`entity{doc, name:url}`）和 driveCollector 抓的 `doc:<token>` **没有自动桥接**，是两个独立 entity

---

## 2. 思路与原点

MVP11 沿用 MVP7-10 的核心心智：

> Agent 正确处理 context = 在正确主体、正确目标、正确关系、正确边界、正确时间和正确置信度下，对 context 变化做可解释、可校正、可回流的处理。

五条设计原则（与 Codex 共识）：

1. **Collector 写结构化事实，evaluator 纯读 ContextUnit** —— "是不是 @ 我 / 我加的 / 是不是权威文档" 等判断在 collector 阶段完成，结果落 ContextUnit 字段；evaluator 永远不解析 events.raw_json
2. **Collector 内零 LLM** —— scheduler tick 必须秒级返回；摘要 / action item 抽取走 AgentRunQueue 后台异步
3. **Doc identity 不建新表** —— 复用 MVP10 `entityResolver.mergeEntities`：`entity{doc, name:'doc:<token>'}` 合并到 `entity{doc, name:url}`，Work Map 权威 URL 是 alias target
4. **跨源 dedup 通过统一 sourceId** —— vc notes 与 minutes 合并成 `source='minutes', kind='meeting_artifact', sourceId=minute:<token>`，依靠现有 `UNIQUE(source, source_id, content_hash)` 物理去重
5. **行动项永远走 ask** —— LLM 抽出的 action item 生成 ask 卡片，用户确认后才转 commitment，不自动落

非目标：

- 不主动给评论者发消息 / 评论回复
- 不自动把 action item 落 commitment
- 不解析每份文档的全文 diff（只采评论 + 纪要 + 妙记）
- 不引入新数据库表

---

## 3. 路线决策

```text
MVP11.0  评论闭环（拆为 11.0-a 基座 + 11.0-b 评论 collector & 卡片）
MVP11.1  会议纪要 / 妙记闭环（统一 collector + LLM 抽 action items + ask 卡片）
MVP11.2  Backfill 与优化（命中率打点 / rate cap / size cap 压测）
```

理由：

- 11.0 是最小价值闭环；11.0-a / -b 拆分让基座可独立单测，不被 lark-cli 评论样本阻塞
- 11.1 引入 LLM agent + ask→commitment 控制流，需要更长周期
- 11.2 在真实数据跑过后再调参，避免提前过度设计

---

## 4. MVP11.0 — 文档评论闭环

### 4.1 目标

> 别人在我相关的飞书文档上加了评论，特别是 @ 我或在我标为权威的文档上 → Agent 出一张 P1 卡片，用户能 ack / 打开原文 / 让 AI 起草回复。

MVP11.0 验证：评论被加上 → 卡片出现 ≤ 5 分钟；@ 我 / 权威文档外评论稳定触发；自己加的评论不触发。

### 4.2 产品范围

做：

- 扩 RawSignal 类型（向前兼容，全部 optional）+ `insertMinimalEventContextUnit` 升级
- `encodeSemanticTags / decodeSemanticTags` helper
- `mergeDocIdentity` 幂等 helper
- 新增 `driveCommentCollector`
- 新增 trigger `doc_comment_attention`
- 新增 agent `doc_comment_agent`（纯本地不调 LLM）

不做：

- 不写新数据库表
- 不自动生成回复（与现有 sync_draft 边界一致）
- attendee/参与人姓名抽取（依赖 contact lookup，留 MVP11.x）

### 4.3 数据模型变更

#### 4.3.1 RawSignal 扩展（apps/server/src/collectors/types.ts）

```ts
export type RawSignal = {
  sourceId: string;
  source: 'calendar' | 'im' | 'mail' | 'drive' | 'minutes';   // +'minutes'
  kind: string;
  occurredAt: string;
  title?: string;
  text: string;
  actor?: string;
  url?: string;
  raw: unknown;
  contentHash: string;
  // === 新增，全部 optional，老 collector 不动 ===
  entities?: ContextEntityRef[];
  contextMergeHint?: string;
  scope?: ContextScope;
  actionability?: ContextActionability;
  /** 结构化机器判定（不进自然语言）。如 { signal_kind:'doc_comment', is_at_me:true, content_hash_bucket:'a1b2...'}。 */
  semanticTags?: Record<string, string | boolean>;
  /** 已结构化的信号默认 true 跳过 triage LLM，避免双处理。 */
  skipTriage?: boolean;
};
```

#### 4.3.2 scheduler 升级（apps/server/src/collectors/scheduler.ts）

**索引绑定**（避免 `signals[i]` 与 `newRows` 因 dedup 错位）：

```ts
type InsertedRow = { row: EventRow; skipTriage: boolean };
const newRows: InsertedRow[] = [];
for (const sig of signals) {
  const id = randomUUID();
  const row: EventRow = { /* ... 已有字段 ... */ };
  if (tryInsertEvent(row)) {
    newRows.push({ row, skipTriage: sig.skipTriage === true });
    try {
      insertMinimalEventContextUnit({
        eventId: row.id,
        scope: sig.scope ?? scopeForSource(row.source),
        title: row.title ?? row.text.slice(0, 30),
        content: row.text,
        occurredAt: row.occurred_at,
        source: row.source,
        actor: row.actor ?? undefined,
        actorRole: 'actor',
        // 新增传递
        entities: sig.entities,
        contextMergeHint: sig.contextMergeHint,
        actionability: sig.actionability,
        semanticTags: sig.semanticTags,
      });
      markEventContextExtracted(row.id, now.toISOString());
    } catch (err) { /* warn */ }
  }
}
upsertCollectorState({ /* ... */ });

const triagedRows = newRows.filter((x) => !x.skipTriage).map((x) => x.row);
if (triagedRows.length) enqueueEvents(triagedRows);
```

#### 4.3.3 insertMinimalEventContextUnit 升级

- 优先用 `sig.entities`（若有），否则旧 actor fallback
- 优先用 `sig.scope`，否则 `scopeForSource(source)`
- 优先用 `sig.contextMergeHint`，否则 fallback `event:<eventId>`
- 优先用 `sig.actionability`，否则 'record'
- `sig.semanticTags` 通过 `encodeSemanticTags(tags, plainMeaning)` helper 写入 ContextUnit.meaning 字段

#### 4.3.4 encodeSemanticTags / decodeSemanticTags

```ts
// apps/server/src/context/semanticTags.ts
const TAG_RE = /^\[tags:([A-Za-z0-9_-]+)\]\s?/;

export function encodeSemanticTags(
  tags: Record<string, string | boolean>,
  plainMeaning?: string
): string {
  const enc = Buffer.from(JSON.stringify(tags), 'utf8').toString('base64url');
  return `[tags:${enc}] ${plainMeaning ?? ''}`.trim();
}

export function decodeSemanticTags(
  meaning?: string | null
): { tags: Record<string, string | boolean>; plainMeaning: string } {
  if (!meaning) return { tags: {}, plainMeaning: '' };
  const m = meaning.match(TAG_RE);
  if (!m) return { tags: {}, plainMeaning: meaning };
  try {
    const json = Buffer.from(m[1], 'base64url').toString('utf8');
    const tags = JSON.parse(json) as Record<string, string | boolean>;
    return { tags, plainMeaning: meaning.slice(m[0].length) };
  } catch {
    return { tags: {}, plainMeaning: meaning };
  }
}
```

#### 4.3.5 mergeDocIdentity helper

在 `apps/server/src/context/entityResolver.ts` 新增：

```ts
export function mergeDocIdentity(token: string, url: string): void {
  if (!token || !url) return;
  try {
    const tokenEnt = resolveOrCreateEntity('doc', `doc:${token}`);
    const urlEnt = resolveOrCreateEntity('doc', url);
    const resolvedToken = resolveAliased(tokenEnt.id);
    const resolvedUrl = resolveAliased(urlEnt.id);
    if (resolvedToken === resolvedUrl) return;
    mergeEntities(resolvedToken, resolvedUrl);
  } catch (err) {
    console.warn('[entity] mergeDocIdentity failed:', err);
  }
}
```

幂等：已合并 / 同 id / 循环 / 异常都吞掉，不让 collector fail。

### 4.4 driveCommentCollector

文件：`apps/server/src/collectors/driveCommentCollector.ts`

#### 4.4.1 扫描范围

每 tick 收集 `file_token` 列表（去重）：

1. Work Map 权威 URL → 解析得 token+type；解析失败保留 entity 标 `unresolved=true` 但**跳过评论扫描**
2. events 表近 24h `source='drive' kind='doc_update'` 的全部 doc（不依赖 actor 过滤；当前 driveCollector 的 edit_user 不是 open_id，无法可靠区分）
3. 现有 Space 关联的 doc entity

#### 4.4.2 调用与裁剪

- 每 file_token：`lark-cli drive file.comments list --params '{"file_token":..,"file_type":..}'`
- 每条 comment 调 `drive file.comment.replys`
- per-tick cap：doc ≤ 50, per-doc comment ≤ 100
- 超出走 `collector_state` JSON cursor round-robin（下轮从未扫的 token 继续）

#### 4.4.3 RawSignal emit

每条 comment / reply emit 一个 signal：

```ts
{
  source: 'drive',
  kind: 'doc_comment' | 'doc_comment_reply',
  sourceId: `comment:${file_token}:${comment_id}`
       | `reply:${file_token}:${comment_id}:${reply_id}`,
  occurredAt: comment.updated_at ?? comment.created_at,
  title: `<author>在「<doc_title>」评论`,
  text: 短摘要 (≤200字, 走 sanitizeExcerpt),
  actor: author.name,
  url: comment_deep_link_or_doc_url,
  raw: original_comment_payload,
  contentHash: sha256(comment_id|reply_id|updated_at|content),
  entities: [
    { type:'doc', name:url, role:'about' },
    { type:'person', name:author.name, role:'author', aliases:[author.open_id] },
    ...mentioned_persons.map((p) => ({ type:'person', name:p.name, role:'mention' })),
  ],
  contextMergeHint: `drive_comment:${file_token}:${comment_id}:${reply_id ?? 'root'}`,
  scope: 'work',
  // 现场判定：is_at_me 或 on_authoritative_doc 才升 notify；否则 record
  actionability: (is_at_me || on_authoritative_doc) ? 'notify' : 'record',
  semanticTags: {
    signal_kind: kind,
    is_at_me,
    author_is_self,
    on_authoritative_doc,
    content_hash_bucket: contentHash.slice(0, 16),
  },
  skipTriage: true,
}
```

- `reply_id` 缺失时降级为 `sha1(comment_id + created_at + author_id + content)` 并 warning
- self 比较走 `author.open_id === getMyOpenId()`，name 不可信
- 同时调 `mergeDocIdentity(token, url)`

### 4.5 trigger `doc_comment_attention`

文件：`apps/server/src/triggers/triggerEvaluator.ts`

```ts
function checkDocCommentAttention(unit: ContextUnit, now: number): TriggerDraft | null {
  const { tags } = decodeSemanticTags(unit.meaning);
  if (tags.signal_kind !== 'doc_comment' && tags.signal_kind !== 'doc_comment_reply') return null;
  if (tags.author_is_self === true) return null;
  if (tags.is_at_me !== true && tags.on_authoritative_doc !== true) return null;
  const docEnt = unit.entities.find((e) => e.type === 'doc');
  const authorEnt = unit.entities.find((e) => e.role === 'author');
  return {
    triggerType: 'doc_comment_attention',
    contextUnitId: unit.id,
    dueAtBucket: new Date(now).toISOString().slice(0, 10),
    reasoning: tags.is_at_me ? `${authorEnt?.name} 在文档评论 @ 你` : `权威文档收到 ${authorEnt?.name} 的评论`,
    payload: {
      signalKind: tags.signal_kind,
      docUrl: docEnt?.name,
      authorName: authorEnt?.name,
      isAtMe: tags.is_at_me === true,
      onAuthoritativeDoc: tags.on_authoritative_doc === true,
    },
  };
}
```

evaluator 全程纯函数，只读 ContextUnit + semanticTags。

### 4.6 agent `doc_comment_agent`

文件：`apps/server/src/agents/docCommentAgent.ts`

- 纯本地，不调 LLM
- slices: `['focalUnit', 'boundary', 'subject']`
- 输出 P1 卡片：
  - title: `<作者> 在「<doc>」评论了你`（is_at_me）/ `<作者> 在你的权威文档「<doc>」加了评论`
  - body: ContextUnit 的 text 摘要 + author + url
  - actions: ack / 打开原文 / 让 AI 起草回复（走现有 ask_agent 通道）
- `action_proposals.agent_run_id` 必填（MVP8.1 约定）
- `createCardFromProposal` 透传 `triggerType / kind / entities`

### 4.7 验收标准

输入：在一份 Work Map 权威文档上别人 @ 我加评论

系统应：

1. ≤ 5 分钟，events 表出现 `source='drive' kind='doc_comment'` 行
2. ContextUnit 落地，`meaning` 前缀 `[tags:<base64url>]` 解出含 `is_at_me=true, on_authoritative_doc=true, author_is_self=false`
3. doc entity 通过 `mergeDocIdentity` 合并到 Work Map URL entity（`resolveAliased(tokenEntId) === urlEntId`）
4. triggerEvaluator 生成 `doc_comment_attention` trigger
5. `doc_comment_agent` 出 P1 卡片，链接可点
6. 自己加的评论同样进 ContextUnit 但**不触发** trigger
7. `triagedRows` 中不含该评论 event（skipTriage 生效）

---

## 5. MVP11.1 — 会议纪要 / 妙记闭环

### 5.1 目标

> 飞书会议结束 → AI 生成纪要 / 妙记 → Agent 抽 action item → 出 ask 卡片让用户确认 → 确认后落 commitment。

MVP11.1 验证：会议结束 ≤ 30 分钟出现 ask 卡片；用户点确认后 commitment 入库 + dueAt 合理；用户拒绝只留 audit。

### 5.2 `meetingArtifactCollector`

文件：`apps/server/src/collectors/meetingArtifactCollector.ts`

#### 5.2.1 Discovery 串行

频率：10 分钟

- 步骤 A：扫近 3 天 calendar events → 批量 `vc +recording`（每批 10 个 event_id 规避不明上限） → minute_token 集合 X
- 步骤 B：`minutes +search --participant-ids me --start <since>` → 补漏集合 Y
- token = X ∪ Y，per-tick ≤ 50

#### 5.2.2 内容抓取

对每个 minute_token：

- `lark-cli vc +notes --minute-tokens=<token>` 拿 AI 纪要 + action items 段
- `lark-cli minutes minutes get` 拿 transcript / summary
- 任一失败降级用另一边，记 warning

#### 5.2.3 内容裁剪

- ContextUnit.content：优先级抓取 `AI summary` → `action items` → fallback 前 800 字
- raw_json size cap：`JSON.stringify(raw)` 后 UTF-8 字节数 ≤ **256 KB**；超出时把 transcript 字段替换为：

  ```json
  { "head": "前 64KB", "tail": "后 64KB", "omittedBytes": 123456, "truncated": true }
  ```

- 全部 text 字段过 `sanitizeExcerpt`（MVP7.1 已有）

#### 5.2.4 RawSignal emit

```ts
{
  source: 'minutes',
  kind: 'meeting_artifact',
  sourceId: `minute:${minute_token}`,
  occurredAt: meeting.end_time ?? minute.created_at,
  title: meeting_title ?? minute_title,
  text: 规则裁剪短摘要,
  actor: organizer_or_owner.name,
  url: minute_view_url,
  raw: { notes, transcript_truncated, ... },
  contentHash: sha256(minute_token|note_hash|summary_hash|transcript_updated_at),
  entities: [
    { type:'meeting', name: event_id ?? minute_token, role:'about' },
    { type:'person', name: organizer.name, role:'organizer' },
    ...mentioned_persons,
  ],
  contextMergeHint: `meeting_artifact:${minute_token}`,
  scope: (owner_is_me && participants_count <= 1) ? 'personal' : 'work',
  actionability: 'record',          // 自然降权 activeContext
  semanticTags: {
    signal_kind: 'meeting_artifact',
    minute_token,
    content_hash_bucket: contentHash.slice(0, 16),
    truncated: raw_truncated,
    has_action_items: notes_contain_action_items,
    owner_is_me,
  },
  skipTriage: true,
}
```

### 5.3 trigger `meeting_artifact_ready`

```ts
function checkMeetingArtifactReady(unit: ContextUnit, now: number): TriggerDraft | null {
  const { tags } = decodeSemanticTags(unit.meaning);
  if (tags.signal_kind !== 'meeting_artifact') return null;
  const minuteToken = tags.minute_token as string | undefined;
  const bucket = tags.content_hash_bucket as string | undefined;
  if (!minuteToken || !bucket) return null;
  return {
    triggerType: 'meeting_artifact_ready',
    contextUnitId: unit.id,
    dueAtBucket: `${minuteToken}:${bucket}`,
    reasoning: `会议纪要 ${minuteToken} 首次到位（或内容更新）`,
    payload: {
      minuteToken,
      contentHashBucket: bucket,
      hasActionItems: tags.has_action_items === true,
    },
  };
}
```

idempotency：`(trigger_type, unit_id, dueAtBucket=${minuteToken}:${bucket})` —— 同 minute_token 同 contentHash 不重复触发；transcript 变了 bucket 也变，会再触发一次 enrichment（预期行为）。

### 5.4 agent `recap_action_items`

文件：`apps/server/src/agents/recapActionItemsAgent.ts`

- 调 LLM（runOneShot，120s timeout）
- slices: `['focalUnit', 'spaces', 'goals', 'stakeholders', 'subject', 'boundary']`
- Prompt 输入：meeting_artifact ContextUnit（含 raw transcript 摘录）+ 关联 calendar event + 关联 doc + Work Map subject
- LLM 输出 schema：

  ```json
  {
    "summary": "≤80 字会议主旨",
    "actionItems": [
      { "owner": "我 / Alice / 待定", "task": "...", "suggestedDueAt": "ISO 或 null", "confidence": 0.7 }
    ],
    "decisions": ["关键决策 1"],
    "openQuestions": ["未决问题"]
  }
  ```

- **不直接落 commitment**：把 LLM 输出全量写入 `action_proposals.payload_json`：

  ```json
  {
    "priority": "P1",
    "contextUnitId": "...",
    "minuteToken": "...",
    "actionItems": [...],
    "decisions": [...],
    "openQuestions": [...]
  }
  ```

- 生成 ask 卡片：
  - title: `会议「<标题>」抽到 N 条待办，确认入库？`
  - body: 按 actionItem 列表展示
  - actions:
    - `confirm_all` → 后端 controller 把所有 items 转 commitment
    - `confirm_none` → 仅记 audit
    - 标准 ack / dismiss
  - subset 选择 MVP11.x 再补

### 5.5 ask → commitment 转换 controller

文件：`apps/server/src/routes/actionItems.ts`

```text
POST /api/cards/:id/action-items/confirm
body: { accept: 'all' | 'none' }
```

服务端：

```ts
const card = getCard(req.params.id);
const proposal = getActionProposal(card.source_ref_id!);
const payload = JSON.parse(proposal.payload_json!);    // { minuteToken, actionItems: [...] }
if (req.body.accept === 'all') {
  for (let i = 0; i < payload.actionItems.length; i++) {
    const item = payload.actionItems[i];
    upsertContextUnit({
      kind: 'commitment',
      title: item.task,
      content: item.task,
      entities: [{ type:'meeting', name: payload.minuteToken, role:'about' }],
      scope: 'work',
      origin: { kind: 'card_action', refId: card.id },
      time: item.suggestedDueAt ? { dueAt: item.suggestedDueAt } : undefined,
      actionability: 'act',
      confidence: item.confidence ?? 0.7,
      mergeHint: `action_item:${payload.minuteToken}:${i}`,
    });
  }
  writeAudit({ action: 'action_items_confirmed', cardId: card.id });
}
```

读 `action_proposals.payload_json`，不依赖 `agent_runs.output_json`。

### 5.6 验收标准

输入：一个真实结束的飞书会议（含 AI 纪要 + 行动项）

系统应：

1. ≤ 10 分钟，meetingArtifactCollector tick 后 events / ContextUnit 落地
2. trigger `meeting_artifact_ready` 出现
3. `recap_action_items` 在 AgentRunQueue 异步跑通（不阻塞 scheduler）
4. ask 卡片出现，列出 actionItems
5. 用户"全部入库" → commitment unit 入库，dueAt 合理（取 LLM 给的或 fallback 7 天后）
6. 用户"全都不要" → audit_log 记录 + 卡片 dismissed

---

## 6. MVP11.2 — Backfill 与优化

- minutes search vs calendar discovery 命中率打点（看私会 / calendar-orphan 比例，决定后续优先级）
- per-tick rate cap 真实校准（首批跑 1 周看 scheduler 抖动）
- transcript size cap 256KB 是否合适，超大会议截断策略验证
- Work Map URL 解析覆盖率统计（unresolved 数量做面板暴露）

---

## 7. 评测体系

### 7.1 Fixture 目录

```text
apps/server/test/fixtures/mvp11/
  doc_comment_at_me.json
  meeting_artifact_basic.json
  expected_signals.json
  expected_action_items.json
```

### 7.2 Eval runner

- `apps/server/test/eval/mvp11.eval.ts`
- 复用 MVP7 模式：fixture header 含 `evalVersion / judgeModel / seed`
- 结构化字段 JSON-diff；语义字段（action item 抽取）可选 LLM judge

### 7.3 指标

| 指标 | 定义 | 目标 |
|---|---|---|
| 评论延迟 | 评论 created_at → 卡片创建时间 | < 5 min P90 |
| @我准确率 | 评论确实 @我 / 触发卡片数 | ≥ 90% |
| 自评论漏触发率 | 自己加的评论触发 trigger 数 | 0 |
| 会议纪要覆盖率 | 已结束 calendar 会议中有 ContextUnit 的比例 | ≥ 80% |
| Action item 入库率 | LLM 抽到 → 用户确认 / 总抽到 | 基线观测，无目标 |
| Doc identity 桥接成功率 | `mergeDocIdentity` 调用成功比例 | ≥ 95% |

---

## 8. 单一开发顺序

```text
MVP11.0-a 结构化信号基座
  - RawSignal 扩展（optional 字段 + skipTriage）
  - scheduler 升级（索引绑定 skipTriage + 传新字段给 insertMinimalEventContextUnit）
  - encodeSemanticTags / decodeSemanticTags helper (含 base64url JSON)
  - mergeDocIdentity helper
  - getContextEntityById 已存在，复用
  - 单测：sanitize-style 测 encode/decode + mergeDocIdentity 幂等 + scheduler skipTriage 索引绑定

MVP11.0-b 评论闭环
  - driveCommentCollector
  - trigger doc_comment_attention（纯函数）
  - agent doc_comment_agent
  - smoke：mock 一份评论 → 卡片
  - 验收：§4.7 全部 7 项

MVP11.1 会议纪要 / 妙记闭环
  - meetingArtifactCollector（vc + minutes 统一）
  - trigger meeting_artifact_ready
  - agent recap_action_items（LLM, 写 payload_json）
  - routes/actionItems.ts 确认 controller
  - smoke：mock 一个 meeting_artifact → ask 卡片 → confirm → commitment 入库
  - 验收：§5.6

MVP11.2 Backfill 与优化
  - 命中率打点
  - rate cap 校准
  - size cap 压测
  - 暴露 unresolved doc URL 统计
```

---

## 9. 关键 Invariant（机器可检）

- **I-1 物理 dedup**：events `UNIQUE(source, source_id, content_hash)` 不变；统一 `source='minutes'` 后 vc + minutes 跨路径都被挡住
- **I-2 Doc identity 透传**：调用 `mergeDocIdentity(token, url)` 后，`resolveAliased(token entity id) === url entity id`
- **I-3 Collector 零 LLM**：`driveCommentCollector` / `meetingArtifactCollector` 文件内不 import `runOneShot` 等 LLM 调用
- **I-4 Evaluator 不查 events / 不解析 raw_json**：`triggerEvaluator.ts` 不 `import` / 不 `list` / 不 `fetch` events 行，不读 raw_json；新增触发判断只依赖 ContextUnit + semanticTags + entities + changeContext
- **I-5 Action item 无自动落 commitment**：`recapActionItemsAgent` 文件内不 import `upsertContextUnit`；只通过 `action_proposals.payload_json` + 用户 confirm 触发的 controller 写 commitment
- **I-6 skipTriage 与 row 绑定**：scheduler 内 `InsertedRow { row, skipTriage }` 元组保存，禁止用 `signals[i]` 与 `newRows[i]` 对齐

---

## 10. 最终系统形态

MVP11 之后的主循环：

```text
用户给出 Work Map（含权威文档 URL）
→ collectors 持续拉 calendar / im / drive doc 编辑 / drive 评论 / 会议纪要 / 妙记
→ doc identity 通过 mergeDocIdentity 自动桥接
→ ContextUnit 含结构化 semanticTags，evaluator 纯函数判定
→ doc_comment_attention 出本地卡片
→ meeting_artifact_ready 触发 LLM 抽 action items，出 ask 卡片
→ 用户确认 → commitment 入库 → 进入 track_commitment 后续闭环
→ 全程沿用 MVP10 boundary + correction + autonomy 机制
```

---

## Review 记录

本方案经 Claude × Codex（gpt-5.5-codex）5 轮对抗性 review 收敛：

- Round 1: Claude 出方案 A（评论 + vc + minutes 三 collector），Codex 出方案 B（结构化 RawSignal + 统一 meeting_artifact + 不在 collector 跑 LLM），review A 出 5 P0 + 7 P1 + 3 P2
- Round 2: Claude 修订为 A'（采纳 B 主干 + 用 mergeEntities 替代新表），Codex 出 B'（同方向），共识达成
- Round 3: Claude 提交文档骨架，Codex 找 3 P0（contentHash 不可读 / triage 双处理 / proposal output_json 不存在）+ 5 P1
- Round 4: Claude 修复全部 P0/P1，Codex 再发现 1 真 P0（scheduler `signals[i]` 索引错位 bug）
- Round 5: Claude 修 + 改 hash bucket 长度到 16，Codex 确认 `[{ status: 'OK', issues: [] }]`
