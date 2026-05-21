# MVP13 · LLM 驱动的 Space 建议方案

> 状态：R3 定稿。
> 上游：[MVP12-Space关联优化方案.md](MVP12-Space关联优化方案.md) Phase 2 已落地，但纯规则阈值在真实 dogfood 数据下召回不足。

---

## 0. TL;DR

MVP13 把 Phase 2 `chat_affinity` worker 从纯规则升级为「规则宽召回 + evidence 摘要 + LLM 评审 + 人工 confirm/reject + 反馈演化」。

核心结论：

1. **LLM 不进 hot path**：resolver 仍保持本地纯规则；LLM 只在 [suggestionWorker.ts](apps/server/src/spaces/suggestionWorker.ts) 这条 warm path 上运行。
2. **规则不被替代**：规则负责粗筛、排序、fallback；LLM 负责语义评审。
3. **第一版只送摘要**：送 Space intent、Work Map 摘要、chat 统计、entity overlap、sanitized unit title/meaning，不送 IM 原文。
4. **召回放宽，展示严格**：弱信号进入 candidate；只有 LLM `accept/strong_accept` 且分数过阈值才 surfaced。
5. **Claude Code 本地调用**：复用 [backgroundRuntime.ts](apps/server/src/triage/backgroundRuntime.ts) 的 `runOneShot` 模式；prompt 内小 batch，串行调用。
6. **confirm 才生效**：LLM 只产 `suggested`，用户 confirm 后才写 chat seed。
7. **反馈进入系统**：confirm/reject 必须带 reason；写 feedback history 和 snapshot，供 few-shot、calibration、后续 eval 使用。
8. **Work Map 自动供给 Space intent**：Work Map 是世界本体，Space 是带 intent 的收件箱；Work Map 可同步 intent，但 Space confirm chat 不反写 Work Map 本体。

---

## 1. 背景

### 1.1 MVP12 Phase 2 现状

MVP12 已落地：

- [suggestionWorker.ts](apps/server/src/spaces/suggestionWorker.ts)：扫近 7 天 chat entity，基于 `directHits/personOverlap/docOverlap` 产 `chat_affinity` suggestion。
- [contextSpaceService.ts](apps/server/src/spaces/contextSpaceService.ts)：Space CRUD、confirm/reject、reconcile。
- [db.ts](apps/server/src/db.ts)：`context_space_suggestions` 已存在。
- [mvp12-suggestion-worker.test.ts](apps/server/test/mvp12-suggestion-worker.test.ts)：现有 worker 测试。

MVP12 的 `chat_affinity` 硬阈值：

```ts
directHits >= 3 || personOverlap >= 2 || docOverlap >= 1
```

### 1.2 Dogfood 痛点

真实数据：

| 指标 | 数据 |
|---|---:|
| 7d active units | 1025 |
| 7d IM events | 477 |
| chat entity | 12 |
| Space seed 类型 | 基本全是 `project` |
| worker 首次 `chatAffinityInserted` | 0 |

原因：

1. 用户创建 Space 时通常只填名字，默认 seed 是同名 `project` entity；`personOverlap/docOverlap` 长期为 0。
2. 每个 chat 7 天内通过 person/doc 直接命中某 Space 的 unit 数很少，`directHits >= 3` 卡死。
3. 群名「【 Badcase 】Chatbot badcase 跟进群」与 Space「Chatbot」语义高度相关，但规则识别不出。
4. reject 只有 30 天 cooldown，无 reason、无 replay snapshot、无 prompt feedback。

### 1.3 上层共识

| 决策 | 选择 | 理由 |
|---|---|---|
| LLM 进 hot path | 否 | resolver 对延迟敏感，不能引入子进程/超时 |
| LLM 进 worker | 是 | worker 低频，可接受几十秒级异步处理 |
| LLM 数据 | evidence 摘要 | 隐私边界清楚，成本可控 |
| LLM runtime | Claude Code 本地 | stack 已在用，零边际成本 |
| LLM 与规则关系 | 规则粗筛 + LLM rank + 规则 fallback | 稳定性与语义能力兼得 |
| Work Map / Space | Work Map = 世界本体；Space = 带 intent 的收件箱 | 避免 chat seed 污染本体 |
| 反馈 | prompt few-shot + calibration report | 先记录和提示，不自动调参 |

---

## 2. 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| LLM 放置位置 | 只放 worker warm path | resolver hot path 必须轻量 |
| Ranker 形态 | 规则宽召回 + LLM 评审 + 规则 fallback | LLM 不可用时系统仍可工作 |
| 输入内容 | evidence 摘要，不送 IM 原文 | 隐私与成本优先 |
| 摘要脱敏 | 进 LLM 前统一 `sanitizeExcerpt` | 低成本剥 email/URL/长数字 |
| 候选召回 | `units7d >= 2` 且至少一个弱信号 | 解决 `directHits >= 3` 卡死 |
| 展示阈值 | decision gate + finalScore 阈值 | LLM reject 不会被高 ruleScore 穿透 |
| fallback | `MVP12 OR (nameSimilarity >= 0.72 && units7d >= 3)` | Claude 不可达时仍能挽救明显群名匹配 |
| batch 语义 | prompt 内含 5 个 candidate，串行调用 | 不是并发；平衡上下文质量和调用成本 |
| ranker cache | `input_hash` 24h TTL 复用 | 避免手动重复扫描浪费 LLM |
| cache GC | 默认不 GC；提供 admin cleanup route | dogfood 阶段数据量小，保留审计优先 |
| feedback 存储 | 新建 history 表 + snapshot_json | suggestion 行会 upsert，历史不能丢 |
| cooldown | reason-aware：14/30/90/365 天 | 不同 reject 信号强度不同 |
| Work Map 同步 | Work Map 自动补 Space intent；用户 intent 不被覆盖 | 自动化与用户控制兼顾 |
| person_co_occur | 继续 MVP12 规则，不接 LLM | MVP13 范围聚焦 `chat_affinity` |
| Stats 扩展 | 扩展 [suggestionWorker.ts](apps/server/src/spaces/suggestionWorker.ts) 已 export 的 `SuggestionWorkerStats` | 旧字段保留，新字段追加，向后兼容 |
| 测试命名 | 全部 `mvp13-*.test.ts` | 对齐现有 MVP 测试惯例 |

---

## 3. 数据模型 DDL

### 3.1 `context_spaces` 增列

```sql
ALTER TABLE context_spaces ADD COLUMN intent_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE context_spaces ADD COLUMN work_map_ref_json TEXT;
ALTER TABLE context_spaces ADD COLUMN suggestion_policy TEXT NOT NULL DEFAULT 'manual_confirm';
```

`intent_json` 是 JSON-encoded 空对象，不是 `NULL` 或空字符串。应用层必须通过 codec decode，业务层拿 `SpaceIntentJson` 对象。

建议在 [contextSpaceService.ts](apps/server/src/spaces/contextSpaceService.ts) 增加：

```ts
export type SpaceIntentJson = {
  schemaVersion: 1;
  summary?: string;
  aliases?: string[];
  keywords?: string[];
  negativeKeywords?: string[];
  workMapGoalTitles?: string[];
  workMapRiskTitles?: string[];
  authoritativeDocNames?: string[];
  stakeholderNames?: string[];
  updatedBy?: 'user' | 'work_map_writer' | 'system';
  updatedAt?: string;
};

function decodeSpaceIntent(raw: string | null): SpaceIntentJson {
  if (!raw) return { schemaVersion: 1 };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object'
      ? { schemaVersion: 1, ...v }
      : { schemaVersion: 1 };
  } catch {
    return { schemaVersion: 1 };
  }
}
```

`work_map_ref_json` 定义：Space 与 Work Map 条目的 provenance binding，不是业务事实本身。

示例：

```json
{
  "source": "work_map_writer",
  "projectName": "Chatbot",
  "origin": "work_map",
  "unitMergeKeys": [
    "work_map:goal:chatbot:*",
    "work_map:risk:chatbot:*"
  ],
  "updatedAt": "2026-05-21T00:00:00.000Z"
}
```

读取时机：

- evidence builder 读取它补充 Work Map goal/risk/doc 摘要。
- intent sync 读取它判断 Space 是否仍由 Work Map 派生。
- calibration/debug 可用它分组分析 Work Map 派生 Space 的建议质量。

### 3.2 `context_space_suggestions` 增列

```sql
ALTER TABLE context_space_suggestions ADD COLUMN rule_score REAL;
ALTER TABLE context_space_suggestions ADD COLUMN llm_score REAL;
ALTER TABLE context_space_suggestions ADD COLUMN final_score REAL;
ALTER TABLE context_space_suggestions ADD COLUMN llm_decision TEXT;
ALTER TABLE context_space_suggestions ADD COLUMN llm_confidence REAL;
ALTER TABLE context_space_suggestions ADD COLUMN ranker_status TEXT NOT NULL DEFAULT 'rule_only';
ALTER TABLE context_space_suggestions ADD COLUMN ranker_version TEXT;
ALTER TABLE context_space_suggestions ADD COLUMN model_id TEXT;
ALTER TABLE context_space_suggestions ADD COLUMN decided_at TEXT;
ALTER TABLE context_space_suggestions ADD COLUMN decided_by TEXT;

CREATE INDEX IF NOT EXISTS idx_css_ranker_status
  ON context_space_suggestions(ranker_status);
CREATE INDEX IF NOT EXISTS idx_css_decided_at
  ON context_space_suggestions(decided_at);
```

`ranker_status`：

- `rule_only`
- `llm_ok`
- `llm_skipped`
- `llm_failed`
- `cache_hit`

### 3.3 ranker run 审计表

```sql
CREATE TABLE IF NOT EXISTS context_space_ranker_runs (
  id TEXT PRIMARY KEY,
  worker_run_id TEXT NOT NULL,
  ranker_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_id TEXT,
  status TEXT NOT NULL, -- ok | failed | timeout | parse_error | cache_hit
  candidate_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL,
  input_summary_json TEXT NOT NULL,
  output_json TEXT,
  reused_from_run_id TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_csr_input_hash
  ON context_space_ranker_runs(input_hash, started_at);
CREATE INDEX IF NOT EXISTS idx_csr_worker
  ON context_space_ranker_runs(worker_run_id);
CREATE INDEX IF NOT EXISTS idx_csr_status
  ON context_space_ranker_runs(status);
```

`input_hash` 用途：24h TTL 内同输入复用上次 `ok` output。

hash 输入范围：

- `rankerVersion`
- `promptVersion`
- system prompt hash
- sanitized evidence
- Space `intent_json`
- few-shot examples
- final score / surface 阈值配置

不包含 `workerRunId/generatedAt/decidedAt`。

### 3.4 feedback history 表

```sql
CREATE TABLE IF NOT EXISTS context_space_suggestion_feedback (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  suggestion_type TEXT NOT NULL,
  action TEXT NOT NULL, -- confirmed | rejected
  reason_code TEXT NOT NULL,
  comment TEXT,
  cooldown_until TEXT,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cssf_space
  ON context_space_suggestion_feedback(space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cssf_target
  ON context_space_suggestion_feedback(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cssf_reason
  ON context_space_suggestion_feedback(reason_code);
```

### 3.5 `evidence_json` v2

旧字段保留，兼容现有 UI：

- `unitsInChat`
- `directHits`
- `personOverlap`
- `docOverlap`
- `distinctSenders`
- `chatName`
- `chatAliases`
- `recentDays`

新增结构：

```ts
type ChatAffinityEvidenceV2 = {
  schemaVersion: 2;
  generatedAt: string;
  workerRunId: string;
  rankerVersion: 'mvp13.chat_affinity.v1';
  recentDays: 7;
  window: { since: string; until: string };

  unitsInChat: number;
  directHits: number;
  personOverlap: number;
  docOverlap: number;
  distinctSenders: number;
  chatName: string;
  chatAliases: string[];

  chat: {
    id: string;
    name: string;
    aliases: string[];
    displayName: string;
    normalizedName: string;
    nameTokens: string[];
    units7d: number;
    units30d: number;
    distinctPersonSenders7d: number;
    distinctAppSenders7d: number;
    topPersons: Array<{ id: string; name: string; count: number; roles: string[] }>;
    topDocs: Array<{ id: string; name: string; count: number }>;
    topUnitKinds: Array<{ kind: string; count: number }>;
  };

  space: {
    id: string;
    type: string;
    name: string;
    description: string | null;
    intentSummary?: string;
    aliases: string[];
    keywords: string[];
    seedEntities: {
      project: Array<{ id: string; name: string }>;
      topic: Array<{ id: string; name: string }>;
      person: Array<{ id: string; name: string }>;
      doc: Array<{ id: string; name: string }>;
      chat: Array<{ id: string; name: string }>;
    };
    workMap: {
      goalTitles: string[];
      riskTitles: string[];
      stakeholderNames: string[];
      authoritativeDocNames: string[];
    };
  };

  ruleSignals: {
    directHits: number;
    directHitRatio: number;
    personOverlap: number;
    docOverlap: number;
    nameSimilarity: number;
    tokenOverlap: string[];
    keywordOverlap: string[];
    workMapTokenOverlap: string[];
    negativeFeedbackHits30d: number;
    positiveFeedbackHits90d: number;
    bigChatSkipped: boolean;
    ruleScore: number;
    fallbackEligible: boolean;
  };

  summarizedUnits: Array<{
    id: string;
    kind: string;
    title: string;
    meaning?: string;
    updatedAt: string;
    linkTypesToSpace: string[];
    entityRefs: string[];
  }>;

  feedbackHints?: Array<{
    scope: 'space' | 'global';
    action: 'confirmed' | 'rejected';
    reasonCode: string;
    targetDisplayName: string;
    createdAt: string;
  }>;

  llm?: {
    status: 'ok' | 'failed' | 'skipped' | 'cache_hit';
    decision?: 'strong_accept' | 'accept' | 'maybe' | 'reject';
    score?: number;
    confidence?: number;
    reasons?: string[];
    concerns?: string[];
    modelId?: string;
    runId?: string;
  };
};
```

---

## 4. LLM Ranker 设计

### 4.1 模块边界

新增：

- [chatAffinityEvidence.ts](apps/server/src/spaces/chatAffinityEvidence.ts)
- [llmChatAffinityRanker.ts](apps/server/src/spaces/llmChatAffinityRanker.ts)

[suggestionWorker.ts](apps/server/src/spaces/suggestionWorker.ts) 只负责编排：

1. 扫 chat。
2. build candidates。
3. rank candidates。
4. upsert surfaced suggestions。
5. 继续执行 MVP12 `person_co_occur` 规则路径。

### 4.2 输入 / 输出 type

```ts
export type ChatAffinityCandidate = {
  candidateId: string;
  spaceId: string;
  chatEntityId: string;
  ruleScore: number;
  fallbackEligible: boolean;
  evidence: ChatAffinityEvidenceV2;
};

export type ChatAffinityRankDecision =
  | 'strong_accept'
  | 'accept'
  | 'maybe'
  | 'reject';

export type ChatAffinityRankResult = {
  candidateId: string;
  decision: ChatAffinityRankDecision;
  llmScore: number;
  confidence: number;
  reasons: string[];
  concerns: string[];
  matchedSignals: Array<
    | 'chat_name'
    | 'space_name'
    | 'space_intent'
    | 'work_map_goal'
    | 'person_overlap'
    | 'doc_overlap'
    | 'direct_hits'
    | 'recent_activity'
    | 'feedback'
  >;
};
```

### 4.3 粗筛

前置过滤：

```ts
units7d >= 2
&& !bigChat
&& !alreadyChatSeed
&& !cooldownActive
```

弱候选条件，满足任一即可：

```ts
directHits >= 1
|| personOverlap >= 1
|| docOverlap >= 1
|| nameSimilarity >= 0.35
|| tokenOverlap.length >= 1
|| keywordOverlap.length >= 1
|| workMapTokenOverlap.length >= 1
```

`nameSimilarity`：

- normalize：小写、去 `【】[]()（）`、常见噪声词；保留 `badcase` 等业务词。
- token Jaccard：`intersection / union`。
- substring bonus：Space name 是 chat displayName 子串时至少 `0.72`。
- 最终取 `max(jaccard, substringScore)`。

### 4.4 ruleScore

```ts
const direct = Math.min(directHits, 5) / 5 * 0.30;
const person = Math.min(personOverlap, 3) / 3 * 0.18;
const doc = Math.min(docOverlap, 2) / 2 * 0.16;
const name = nameSimilarity * 0.22;
const token =
  Math.min(tokenOverlap.length + keywordOverlap.length, 3) / 3 * 0.10;
const recency = Math.min(units7d, 20) / 20 * 0.04;
const negativePenalty = Math.min(negativeFeedbackHits30d, 2) * 0.15;

const ruleScore = clamp(
  direct + person + doc + name + token + recency - negativePenalty,
  0,
  1
);
```

进入 LLM 的排序：

```ts
candidateSortScore =
  ruleScore
  + (nameSimilarity >= 0.72 ? 0.18 : 0)
  + (keywordOverlap.length > 0 ? 0.08 : 0)
  + (workMapTokenOverlap.length > 0 ? 0.08 : 0)
  - (negativeFeedbackHits30d > 0 ? 0.20 : 0);
```

限制：

- 全局 top 50 candidates。
- 每个 chat 最多 5 个 Space。
- 每个 Space 最多 10 个 chat。
- prompt 内 `batchSize=5`，ENV 可调到 10。
- 串行调用，并发 1。

### 4.5 finalScore / surfaced 规则

```ts
if (decision === 'strong_accept' || decision === 'accept') {
  finalScore = clamp(0.25 * ruleScore + 0.75 * llmScore, 0, 1);
} else {
  finalScore = clamp(0.20 * ruleScore + 0.30 * llmScore, 0, 1);
}

surface =
  ['strong_accept', 'accept'].includes(decision) &&
  llmConfidence >= 0.55 &&
  finalScore >= 0.62;
```

反例验证：

| rule | llm | decision | final | 期望 |
|---:|---:|---|---:|---|
| 0.80 | 0.10 | reject | 0.19 | 不展示，LLM 强否决不会蒙混 |
| 0.35 | 0.91 | strong_accept | 0.77 | 展示，Chatbot badcase 可召回 |
| 0.80 | 0.70 | accept | 0.73 | 展示，规则和 LLM 都支持 |
| 0.25 | 0.72 | accept | 0.60 | 不展示，证据太薄 |
| 0.90 | 0.55 | maybe | 0.35 | 不展示，maybe 永不 surfaced |

### 4.6 fallback

LLM 调用失败、timeout、spawn error、parse error 时走 fallback。

fallback 条件明确为 OR：

```ts
fallbackEligible =
  directHits >= 3 ||
  personOverlap >= 2 ||
  docOverlap >= 1 ||
  (nameSimilarity >= 0.72 && units7d >= 3);
```

即：

```text
MVP12 OR (nameSimilarity >= 0.72 AND units7d >= 3)
```

### 4.7 Prompt 框架

System prompt：

```text
你是 ai-is-on 的 Space 建议评审器。你的任务是判断一个 IM chat 是否应该被建议加入某个 Space，作为该 Space 的 chat seed。

重要规则：
1. 只根据输入的结构化摘要判断；不要假设你看过消息原文。
2. Space 是带 intent 的收件箱；Work Map 是用户工作世界的本体。chat 只有在会持续产生该 Space 相关上下文时才建议加入。
3. 群名/别名与 Space 名、intent、Work Map goal 语义强相关时，可以接受，即使 directHits/personOverlap/docOverlap 很低。
4. 如果只是偶然提到、群过宽、像公司公告/闲聊/跨项目大群，应 reject。
5. 对证据不足但可能相关的输出 maybe，不要为了召回强行 accept。
6. 只输出 JSON，不要 Markdown，不要解释 JSON 之外的内容。
```

User message skeleton：

```text
请评审以下 chat_affinity candidates。

输出 JSON 格式：
{
  "results": [
    {
      "candidateId": "string",
      "decision": "strong_accept|accept|maybe|reject",
      "llmScore": 0.0,
      "confidence": 0.0,
      "reasons": ["最多3条短句"],
      "concerns": ["最多3条短句"],
      "matchedSignals": ["chat_name|space_name|space_intent|work_map_goal|person_overlap|doc_overlap|direct_hits|recent_activity|feedback"]
    }
  ]
}

评分参考：
- strong_accept: 0.85-1.00，证据强，建议用户确认加入。
- accept: 0.70-0.84，证据足够，值得展示。
- maybe: 0.45-0.69，可能相关但不应展示。
- reject: 0.00-0.44，不相关或太宽。

Candidates:
<json>
...
</json>

历史 examples:
仅当存在 examples 时出现本段；无 Space examples 时使用全局兜底。
```

### 4.8 Badcase regression 示例

输入 candidate：

```json
{
  "candidateId": "space_chatbot:chat_badcase:2026-05-14",
  "chat": {
    "displayName": "【 Badcase 】Chatbot badcase 跟进群",
    "nameTokens": ["badcase", "chatbot", "跟进"],
    "units7d": 8,
    "distinctPersonSenders7d": 6
  },
  "space": {
    "name": "Chatbot",
    "intentSummary": "Chatbot 项目的评测、badcase 和上线跟进",
    "keywords": ["chatbot", "badcase", "评测"],
    "workMap": {
      "goalTitles": ["降低 Chatbot badcase 率"],
      "riskTitles": ["线上 badcase 跟进不及时"]
    }
  },
  "ruleSignals": {
    "directHits": 0,
    "personOverlap": 0,
    "docOverlap": 0,
    "nameSimilarity": 0.82,
    "keywordOverlap": ["chatbot", "badcase"],
    "workMapTokenOverlap": ["badcase"]
  }
}
```

期望 mock LLM 输出：

```json
{
  "results": [
    {
      "candidateId": "space_chatbot:chat_badcase:2026-05-14",
      "decision": "strong_accept",
      "llmScore": 0.91,
      "confidence": 0.78,
      "reasons": [
        "chat 名同时命中 Chatbot 和 badcase",
        "Space intent 与 Work Map goal 都指向 badcase 跟进",
        "群规模较小且近期活跃"
      ],
      "concerns": [],
      "matchedSignals": ["chat_name", "space_intent", "work_map_goal", "recent_activity"]
    }
  ]
}
```

---

## 5. Work Map ↔ Space 联动

### 5.1 Work Map 自动同步 intent

[workMapWriter.ts](apps/server/src/bootstrap/workMapWriter.ts) 的 `writeProject(p)` 增强：

```ts
const intent: SpaceIntentJson = {
  schemaVersion: 1,
  summary: p.description || p.goals.slice(0, 2).join('；'),
  aliases: [p.name],
  keywords: extractKeywords([p.name, ...p.goals, ...p.risks].join('\n')).slice(0, 12),
  workMapGoalTitles: p.goals,
  workMapRiskTitles: p.risks,
  authoritativeDocNames: p.authoritativeDocs,
  updatedBy: 'work_map_writer',
  updatedAt: now,
};
```

### 5.2 用户 intent 不被覆盖

merge 规则：

- `updatedBy='work_map_writer'` 或缺失：Work Map sync 可覆盖自动生成字段。
- `updatedBy='user'`：Work Map sync 不覆盖用户字段，只 patch 缺失字段和追加非冲突数组项。
- 用户在 Space UI 手改 intent 时，后端把 `updatedBy` 置为 `user`。

### 5.3 Confirm chat 不反写 Work Map 本体

Confirm `chat_affinity` 后保持 MVP12 行为：写 Space chat seed。

`reason_json` 扩展：

```json
{
  "via": "chat_seed_confirmed",
  "source": "mvp13_llm_ranker",
  "suggestionId": "...",
  "llmScore": 0.91,
  "ruleScore": 0.34,
  "reasonCode": "exact_project_chat"
}
```

不自动写 `context_relations(chat -> project)`，避免把收件箱配置误当世界事实。

---

## 6. 反馈与演化体系

### 6.1 Confirm / reject reason

Confirm reason：

- `exact_project_chat`
- `useful_context_source`
- `name_match`
- `people_match`
- `doc_match`
- `other`

Reject reason：

- `wrong_space`
- `chat_too_broad`
- `only_incidental_mention`
- `obsolete`
- `duplicate_seed`
- `private_or_noise`
- `permanent_not_relevant`
- `other`

### 6.2 Cooldown

| reason | cooldown |
|---|---:|
| `obsolete` | 14d |
| `wrong_space` / `private_or_noise` | 90d |
| `duplicate_seed` / `permanent_not_relevant` | 365d |
| default | 30d |

### 6.3 API / UI

[routes/contextSpaces.ts](apps/server/src/routes/contextSpaces.ts)：

```ts
POST /api/context-spaces/:id/suggestions/:sid/confirm
body: { reasonCode?: ConfirmReasonCode; comment?: string }

POST /api/context-spaces/:id/suggestions/:sid/reject
body: { reasonCode?: RejectReasonCode; comment?: string; cooldownDays?: number }
```

[SpacesPanel.tsx](apps/web/src/components/SpacesPanel.tsx)：

- confirm 可默认 `exact_project_chat`，允许展开修改。
- reject 展示快捷 reason：错 Space / 群太泛 / 偶然提到 / 噪声 / 其他。

### 6.4 Few-shot examples

每次 ranker run 前拉 examples：

1. 优先同 Space 最近 30d：
   - 5 条 confirmed：优先 `exact_project_chat/useful_context_source/name_match`
   - 5 条 rejected：优先 `wrong_space/chat_too_broad/only_incidental_mention/private_or_noise`
2. 如果同 Space 没有 examples，则使用全局兜底：
   - 最近 30d 不分 Space，最多 3 confirmed + 3 rejected。
3. 若仍无 examples，prompt 直接省略 examples 段，不塞空数组。

examples 只包含：

```ts
type PromptExample = {
  scope: 'space' | 'global';
  action: 'confirmed' | 'rejected';
  reasonCode: string;
  chatDisplayName: string;
  comment?: string;
};
```

### 6.5 Calibration response schema

Admin route：

```text
GET /api/admin/suggestion-calibration?windowDays=14
```

输出：

```ts
type CalibrationReport = {
  generatedAt: string;
  windowDays: number;
  totals: {
    suggestionsSurfaced: number;
    confirmed: number;
    rejected: number;
    pending: number;
  };
  confusion: {
    strong_accept: { confirmed: number; rejected: number; pending: number };
    accept: { confirmed: number; rejected: number; pending: number };
    maybe: { confirmed: number; rejected: number; pending: number };
    reject: { confirmed: number; rejected: number; pending: number };
  };
  rejectReasonBreakdown: Array<{
    reasonCode: string;
    count: number;
    pctOfReject: number;
  }>;
  ruleVsLlm: {
    correlation: number;
    disagreement: number;
  };
  recommendation: {
    thresholdSuggestionsToReview: Array<{
      field: 'finalScore' | 'llmConfidence';
      current: number;
      suggested: number;
      basis: string;
    }>;
  };
};
```

`recommendation.thresholdSuggestionsToReview` 只给人工 review 建议，不自动改阈值。

建议规则示例：

- `accept/strong_accept` reject rate > 50%：建议提高 `finalScore` 或 `llmConfidence`。
- `strong_accept` confirm rate > 80% 且 pending 低：可建议降低 `finalScore` 0.03。
- `rule>=0.6 && llm<=0.3` 占比高：检查 prompt 是否过度否定规则 evidence。

---

## 7. 实施切片

### S1. DDL + db helpers

文件：

- [db.ts](apps/server/src/db.ts)

验收：

- 新增列/表存在。
- `ContextSpaceRow` / `ContextSpaceSuggestionRow` 扩展。
- 新增 helpers：
  - `insertContextSpaceRankerRun`
  - `updateContextSpaceRankerRun`
  - `findRecentRankerRunByInputHash`
  - `insertContextSpaceSuggestionFeedback`
  - `listSuggestionFeedbackExamples`
- [mvp12-suggestion-worker.test.ts](apps/server/test/mvp12-suggestion-worker.test.ts) 仍通过。

### S2. Space intent sync

文件：

- [contextSpaceService.ts](apps/server/src/spaces/contextSpaceService.ts)
- [workMapWriter.ts](apps/server/src/bootstrap/workMapWriter.ts)
- [workMapService.ts](apps/server/src/bootstrap/workMapService.ts)

验收：

- Work Map project 写入后，Space 有 `intent_json.keywords`。
- `updatedBy='user'` 时 Work Map sync 不覆盖用户字段。

### S3. Evidence builder

文件：

- [chatAffinityEvidence.ts](apps/server/src/spaces/chatAffinityEvidence.ts)
- [suggestionWorker.ts](apps/server/src/spaces/suggestionWorker.ts)

验收：

- `Chatbot badcase` 在 `directHits/personOverlap/docOverlap=0` 时仍生成 candidate。
- summarized unit title/meaning 经过 `sanitizeExcerpt`。

### S4. LLM ranker

文件：

- [llmChatAffinityRanker.ts](apps/server/src/spaces/llmChatAffinityRanker.ts)
- [config.ts](apps/server/src/config.ts)

配置：

```ts
MVP13_LLM_RANKER_ENABLED=false
MVP13_LLM_RANKER_TIMEOUT_MS=90000
MVP13_LLM_RANKER_MAX_CANDIDATES=50
MVP13_LLM_RANKER_BATCH_SIZE=5
MVP13_LLM_RANKER_CACHE_TTL_HOURS=24
```

验收：

- mock LLM JSON 可解析。
- batch parse 失败时可单 candidate retry。
- spawn/timeout 时 fallback，不让 worker 500。
- `input_hash` 24h 内命中 `cache_hit`。

### S5. Worker async 集成

文件：

- [suggestionWorker.ts](apps/server/src/spaces/suggestionWorker.ts)
- [routes/contextSpaces.ts](apps/server/src/routes/contextSpaces.ts)
- [api.ts](apps/web/src/lib/api.ts)
- [SpacesPanel.tsx](apps/web/src/components/SpacesPanel.tsx)

要求：

- 扩展 [suggestionWorker.ts](apps/server/src/spaces/suggestionWorker.ts) 已 export 的 `SuggestionWorkerStats`，旧字段保留，新字段追加。

```ts
export type SuggestionWorkerStats = {
  chatsScanned: number;
  chatsBigSkipped: number;
  chatAffinityInserted: number;
  chatAffinityUpdated: number;
  personCoOccurInserted: number;
  personCoOccurUpdated: number;

  candidateGenerated: number;
  candidateRanked: number;
  llmAccepted: number;
  llmRejected: number;
  llmFailed: number;
  rankerCacheHit: number;
  fallbackSuggested: number;
};
```

验收：

- LLM disabled 时 MVP12 行为不变。
- LLM accept surfaced。
- LLM maybe/reject 不 surfaced。
- LLM failed 走 fallback。

### S6. Feedback API/UI

文件：

- [contextSpaceService.ts](apps/server/src/spaces/contextSpaceService.ts)
- [routes/contextSpaces.ts](apps/server/src/routes/contextSpaces.ts)
- [api.ts](apps/web/src/lib/api.ts)
- [SpacesPanel.tsx](apps/web/src/components/SpacesPanel.tsx)

验收：

- confirm/reject reason 写 feedback 表。
- reason-aware cooldown 生效。
- 下次 ranker 能拉到同 Space examples；无 Space examples 时拉全局 3+3。

### S7. Calibration admin route + cleanup route

文件：

- 新增 admin calibration service / route。

Routes：

```text
GET /api/admin/suggestion-calibration?windowDays=14
DELETE /api/admin/ranker-runs?olderThanDays=N
```

说明：

- calibration 只报告，不自动改阈值。
- ranker run 默认不 GC；cleanup route 留人工清理口子。

### 测试文件命名

统一使用 `mvp13-` 前缀：

- [mvp13-llm-ranker-prompt.test.ts](apps/server/test/mvp13-llm-ranker-prompt.test.ts)
- [mvp13-worker-with-ranker.test.ts](apps/server/test/mvp13-worker-with-ranker.test.ts)
- [mvp13-ranker-fallback.test.ts](apps/server/test/mvp13-ranker-fallback.test.ts)
- [mvp13-feedback-cooldown.test.ts](apps/server/test/mvp13-feedback-cooldown.test.ts)
- [mvp13-badcase-regression.test.ts](apps/server/test/mvp13-badcase-regression.test.ts)

---

## 8. 验证 / 回滚

### 8.1 验证命令

```bash
npx tsx --test apps/server/test/mvp12-suggestion-worker.test.ts
npx tsx --test apps/server/test/mvp13-llm-ranker-prompt.test.ts
npx tsx --test apps/server/test/mvp13-worker-with-ranker.test.ts
npx tsx --test apps/server/test/mvp13-ranker-fallback.test.ts
npx tsx --test apps/server/test/mvp13-feedback-cooldown.test.ts
npx tsx --test apps/server/test/mvp13-badcase-regression.test.ts
npm --prefix apps/server run typecheck
npm --prefix apps/web run typecheck
```

### 8.2 手动 dogfood

```bash
MVP13_LLM_RANKER_ENABLED=true \
MVP13_LLM_RANKER_MAX_CANDIDATES=50 \
MVP13_LLM_RANKER_BATCH_SIZE=5 \
npm --prefix apps/server run dev
```

在 Space UI 点重新扫描，检查：

- `candidateGenerated > 0`
- `candidateRanked > 0`
- Chatbot badcase 群进入 `suggested`
- evidence 不含 IM 原文
- ranker run 有 `ok/cache_hit/failed` 审计记录

### 8.3 回滚

轻回滚：

```bash
MVP13_LLM_RANKER_ENABLED=false
```

错误 confirmed 的 chat seed：

```sql
DELETE FROM context_space_links
WHERE space_id = ?
  AND target_type = 'entity'
  AND target_id = ?;
```

然后跑 `reconcileAllUnitsToSpaces()`。

DDL 保留，无需 drop column；resolver 不读新增列。

---

## 9. Coreview 流程纪要

| 轮次 | 产物 | 结论 |
|---|---|---|
| R1 Claude v1 | [MVP13-LLM驱动的Space建议方案.md](docs/MVP13-LLM驱动的Space建议方案.md) 旧版 | 提出规则粗筛 + LLM rank + feedback + calibration |
| R1 Codex 独立版 | `/tmp/codex-coreview-mvp13-r1-codex.md` | 增补 DDL 拍平、ranker_runs、snapshot_json、reason-aware cooldown、intent_json |
| R2 merged | `/tmp/codex-coreview-mvp13-r2-merged.md` | 收敛 batch 语义、decision-gated finalScore、input_hash cache、intent merge、person_co_occur 范围 |
| R3 final | [MVP13-LLM驱动的Space建议方案.md](docs/MVP13-LLM驱动的Space建议方案.md) | 吸收 C1-C7，覆盖 Claude v1，形成定稿 |

Session id：当前 Codex 环境未暴露可持久引用的外部 session id；以轮次文件路径作为 coreview 索引。

---

## 10. 开放问题

1. `title/meaning` 虽非原文但仍可能敏感；MVP13 先 sanitize，后续可加用户 opt-out。
2. 大群是否永远跳过；后续看 missed-confirm 数据决定是否给高 intent 大群白名单。
3. 同一 chat 多 Space accept 时，本期允许多建议；后续可做 cross-space arbitration。
4. `person_co_occur` 暂不接 LLM，下一期可单独评审。
5. 是否展示 `maybe` 到 debug/admin 视图；本期不进普通 UI。
6. 自动阈值调参至少等 14 天 feedback 数据后再做。
7. `context_space_ranker_runs` 默认不 GC；未来按需加 vacuum 定时任务。

---

## 11. 不在 MVP13 范围

- LLM 进 resolver hot path。
- 消息原文进 LLM。
- 自动创建 Space。
- 自动合并 / 拆分 / 迁移 Space。
- 自动阈值调参并写配置。
- `person_co_occur` LLM 化。
- Space confirm chat 后反写 Work Map 本体关系。

=== R3 DONE ===
