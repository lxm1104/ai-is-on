/**
 * MVP13 §4 / §S4：chat_affinity LLM ranker。
 *
 * 接收 [chatAffinityEvidence](apps/server/src/spaces/chatAffinityEvidence.ts) 出的 candidates，
 *   - 串行 batch（默认 5/批），调用 [backgroundRuntime.runOneShot](apps/server/src/triage/backgroundRuntime.ts:22)
 *   - 解析 JSON {results:[...]}；batch parse 失败 → 拆单 candidate retry 一次
 *   - 24h input_hash 复用上次 ok 输出
 *   - finalScore = decision-gated 加权（accept/strong_accept 时 0.25·rule + 0.75·llm，
 *     否则 0.20·rule + 0.30·llm）
 *   - surfaced gate：decision ∈ {accept, strong_accept} && llmConfidence >= 0.55 && finalScore >= 0.62
 *
 * runner 可注入，方便测试 mock；默认走 runOneShot。
 */
import { createHash, randomUUID } from 'node:crypto';
import { jsonrepair } from 'jsonrepair';
import { config } from '../config.js';
import {
  findRecentRankerRunByInputHash,
  insertContextSpaceRankerRun,
  listSuggestionFeedbackExamples,
  updateContextSpaceRankerRun,
  type ContextSpaceSuggestionFeedbackRow,
} from '../db.js';
import { runOneShot, type OneShotResult } from '../triage/backgroundRuntime.js';
import {
  RANKER_VERSION,
  type ChatAffinityCandidate,
} from './chatAffinityEvidence.js';

export const PROMPT_VERSION = 'mvp13.chat_affinity.prompt.v1';

export type ChatAffinityRankDecision =
  | 'strong_accept'
  | 'accept'
  | 'maybe'
  | 'reject';

export type ChatAffinityMatchedSignal =
  | 'chat_name'
  | 'space_name'
  | 'space_intent'
  | 'work_map_goal'
  | 'person_overlap'
  | 'doc_overlap'
  | 'direct_hits'
  | 'recent_activity'
  | 'feedback';

export type ChatAffinityRankResult = {
  candidateId: string;
  decision: ChatAffinityRankDecision;
  llmScore: number;
  confidence: number;
  reasons: string[];
  concerns: string[];
  matchedSignals: ChatAffinityMatchedSignal[];
};

export type RankerCandidateOutcome = {
  candidate: ChatAffinityCandidate;
  rankerStatus:
    | 'llm_ok'
    | 'llm_skipped'
    | 'llm_failed'
    | 'cache_hit';
  llmResult?: ChatAffinityRankResult;
  llmRunId?: string;
  llmModelId?: string;
  finalScore: number;
  surfaced: boolean;
  fallbackEligible: boolean;
  error?: string;
};

export type RankerRunner = (
  userMessage: string,
  systemPrompt: string,
  timeoutMs: number
) => Promise<OneShotResult>;

export const defaultRankerRunner: RankerRunner = (
  userMessage,
  systemPrompt,
  timeoutMs
) =>
  runOneShot(userMessage, {
    agentName: 'aiisn-ranker',
    systemPrompt,
    timeoutMs,
  });

// ---------- System prompt（§4.7） ----------

export const RANKER_SYSTEM_PROMPT = `你是 ai-is-on 的 Space 建议评审器。你的任务是判断一个 IM chat 是否应该被建议加入某个 Space，作为该 Space 的 chat seed。

重要规则：
1. 只根据输入的结构化摘要判断；不要假设你看过消息原文。
2. Space 是带 intent 的收件箱；Work Map 是用户工作世界的本体。chat 只有在会持续产生该 Space 相关上下文时才建议加入。
3. 群名/别名与 Space 名、intent、Work Map goal 语义强相关时，可以接受，即使 directHits/personOverlap/docOverlap 很低。
4. 如果只是偶然提到、群过宽、像公司公告/闲聊/跨项目大群，应 reject。
5. 对证据不足但可能相关的输出 maybe，不要为了召回强行 accept。
6. 只输出 JSON，不要 Markdown，不要解释 JSON 之外的内容。`;

// ---------- 输入瘦身：candidate → prompt payload ----------

function trimCandidateForPrompt(c: ChatAffinityCandidate) {
  const ev = c.evidence;
  return {
    candidateId: c.candidateId,
    chat: {
      displayName: ev.chat.displayName,
      name: ev.chat.name,
      aliases: ev.chat.aliases,
      nameTokens: ev.chat.nameTokens.slice(0, 8),
      units7d: ev.chat.units7d,
      units30d: ev.chat.units30d,
      distinctPersonSenders7d: ev.chat.distinctPersonSenders7d,
      topPersons: ev.chat.topPersons.slice(0, 5),
      topDocs: ev.chat.topDocs.slice(0, 5),
      topUnitKinds: ev.chat.topUnitKinds,
    },
    space: {
      name: ev.space.name,
      type: ev.space.type,
      intentSummary: ev.space.intentSummary,
      aliases: ev.space.aliases,
      keywords: ev.space.keywords,
      seedEntities: {
        person: ev.space.seedEntities.person.slice(0, 8).map((e) => e.name),
        doc: ev.space.seedEntities.doc.slice(0, 5).map((e) => e.name),
        project: ev.space.seedEntities.project.slice(0, 3).map((e) => e.name),
        topic: ev.space.seedEntities.topic.slice(0, 3).map((e) => e.name),
      },
      workMap: ev.space.workMap,
    },
    ruleSignals: {
      directHits: ev.ruleSignals.directHits,
      directHitRatio: Number(ev.ruleSignals.directHitRatio.toFixed(3)),
      personOverlap: ev.ruleSignals.personOverlap,
      docOverlap: ev.ruleSignals.docOverlap,
      nameSimilarity: Number(ev.ruleSignals.nameSimilarity.toFixed(3)),
      tokenOverlap: ev.ruleSignals.tokenOverlap,
      keywordOverlap: ev.ruleSignals.keywordOverlap,
      workMapTokenOverlap: ev.ruleSignals.workMapTokenOverlap,
      negativeFeedbackHits30d: ev.ruleSignals.negativeFeedbackHits30d,
      positiveFeedbackHits90d: ev.ruleSignals.positiveFeedbackHits90d,
      ruleScore: Number(ev.ruleSignals.ruleScore.toFixed(3)),
    },
    summarizedUnits: ev.summarizedUnits.slice(0, 3).map((u) => ({
      kind: u.kind,
      title: u.title,
      meaning: u.meaning,
      entityRefs: u.entityRefs,
    })),
  };
}

// ---------- Few-shot examples（§6.4） ----------

type PromptExample = {
  scope: 'space' | 'global';
  action: 'confirmed' | 'rejected';
  reasonCode: string;
  chatDisplayName: string;
  comment?: string;
};

function rowToExample(
  row: ContextSpaceSuggestionFeedbackRow,
  scope: 'space' | 'global'
): PromptExample {
  let chatDisplayName = row.target_id;
  try {
    const snap = JSON.parse(row.snapshot_json) as {
      evidence?: { chat?: { displayName?: string; name?: string } };
    };
    chatDisplayName =
      snap.evidence?.chat?.displayName ??
      snap.evidence?.chat?.name ??
      row.target_id;
  } catch {
    /* keep id */
  }
  return {
    scope,
    action: row.action as 'confirmed' | 'rejected',
    reasonCode: row.reason_code,
    chatDisplayName,
    comment: row.comment ?? undefined,
  };
}

export function loadFewShotExamples(spaceId: string): PromptExample[] {
  const spaceRows = listSuggestionFeedbackExamples({
    spaceId,
    windowDays: config.mvp13RankerFewShotWindowDays,
    perAction: config.mvp13RankerFewShotPerAction,
  });
  if (spaceRows.length > 0) {
    return spaceRows.map((r) => rowToExample(r, 'space'));
  }
  const global = listSuggestionFeedbackExamples({
    windowDays: config.mvp13RankerFewShotWindowDays,
    perAction: config.mvp13RankerFewShotGlobal,
  });
  return global.map((r) => rowToExample(r, 'global'));
}

// ---------- Prompt builder ----------

export function buildUserPrompt(
  candidates: ChatAffinityCandidate[],
  examples: PromptExample[]
): string {
  const candidatesJson = candidates.map((c) => trimCandidateForPrompt(c));
  const lines: string[] = [];
  lines.push('请评审以下 chat_affinity candidates。');
  lines.push('');
  lines.push('输出 JSON 格式：');
  lines.push('{');
  lines.push('  "results": [');
  lines.push('    {');
  lines.push('      "candidateId": "string",');
  lines.push(
    '      "decision": "strong_accept|accept|maybe|reject",'
  );
  lines.push('      "llmScore": 0.0,');
  lines.push('      "confidence": 0.0,');
  lines.push('      "reasons": ["最多3条短句"],');
  lines.push('      "concerns": ["最多3条短句"],');
  lines.push(
    '      "matchedSignals": ["chat_name|space_name|space_intent|work_map_goal|person_overlap|doc_overlap|direct_hits|recent_activity|feedback"]'
  );
  lines.push('    }');
  lines.push('  ]');
  lines.push('}');
  lines.push('');
  lines.push('评分参考：');
  lines.push('- strong_accept: 0.85-1.00，证据强，建议用户确认加入。');
  lines.push('- accept: 0.70-0.84，证据足够，值得展示。');
  lines.push('- maybe: 0.45-0.69，可能相关但不应展示。');
  lines.push('- reject: 0.00-0.44，不相关或太宽。');
  lines.push('');
  lines.push('Candidates:');
  lines.push('<json>');
  lines.push(JSON.stringify(candidatesJson, null, 2));
  lines.push('</json>');
  if (examples.length > 0) {
    lines.push('');
    lines.push('历史 examples（仅参考，不要复制原文）：');
    lines.push('<json>');
    lines.push(JSON.stringify(examples, null, 2));
    lines.push('</json>');
  }
  return lines.join('\n');
}

// ---------- 解析 ----------

function tryParseJson(text: string): unknown | null {
  // 1) 干净 JSON
  try {
    return JSON.parse(text);
  } catch {
    /* */
  }
  // 2) fenced ```json ... ``` 围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* */
    }
    try {
      return JSON.parse(jsonrepair(fenced[1]));
    } catch {
      /* */
    }
  }
  // 3) 最外层大括号抠出来
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = text.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch {
      /* */
    }
    try {
      return JSON.parse(jsonrepair(slice));
    } catch {
      /* */
    }
  }
  // 4) 兜底 repair（容易出垃圾，但已经走到这步）
  try {
    return JSON.parse(jsonrepair(text));
  } catch {
    /* */
  }
  return null;
}

const VALID_DECISIONS = new Set<ChatAffinityRankDecision>([
  'strong_accept',
  'accept',
  'maybe',
  'reject',
]);
const VALID_SIGNALS = new Set<ChatAffinityMatchedSignal>([
  'chat_name',
  'space_name',
  'space_intent',
  'work_map_goal',
  'person_overlap',
  'doc_overlap',
  'direct_hits',
  'recent_activity',
  'feedback',
]);

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function coerceResult(obj: unknown): ChatAffinityRankResult | null {
  if (!obj || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;
  const candidateId =
    typeof r.candidateId === 'string' ? r.candidateId : null;
  const decision = r.decision as ChatAffinityRankDecision;
  if (!candidateId) return null;
  if (!VALID_DECISIONS.has(decision)) return null;
  return {
    candidateId,
    decision,
    llmScore: clamp01(Number(r.llmScore ?? 0)),
    confidence: clamp01(Number(r.confidence ?? 0)),
    reasons: Array.isArray(r.reasons)
      ? (r.reasons as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 3)
      : [],
    concerns: Array.isArray(r.concerns)
      ? (r.concerns as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 3)
      : [],
    matchedSignals: Array.isArray(r.matchedSignals)
      ? ((r.matchedSignals as unknown[]).filter(
          (s): s is ChatAffinityMatchedSignal =>
            typeof s === 'string' &&
            VALID_SIGNALS.has(s as ChatAffinityMatchedSignal)
        ) as ChatAffinityMatchedSignal[])
      : [],
  };
}

export function parseRankerResponse(
  text: string
): ChatAffinityRankResult[] | null {
  const obj = tryParseJson(text);
  if (!obj) return null;
  if (typeof obj !== 'object') return null;
  const results = (obj as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  const out: ChatAffinityRankResult[] = [];
  for (const r of results) {
    const c = coerceResult(r);
    if (c) out.push(c);
  }
  return out;
}

// ---------- finalScore / surface ----------

function computeFinalScore(
  decision: ChatAffinityRankDecision,
  ruleScore: number,
  llmScore: number
): number {
  if (decision === 'strong_accept' || decision === 'accept') {
    return clamp01(0.25 * ruleScore + 0.75 * llmScore);
  }
  return clamp01(0.20 * ruleScore + 0.30 * llmScore);
}

function isSurfaced(
  decision: ChatAffinityRankDecision,
  finalScore: number,
  confidence: number
): boolean {
  if (decision !== 'accept' && decision !== 'strong_accept') return false;
  if (confidence < config.mvp13SurfaceLlmConfidence) return false;
  if (finalScore < config.mvp13SurfaceFinalScore) return false;
  return true;
}

// ---------- input_hash ----------

function stableStringify(value: unknown): string {
  // 简易稳定 JSON：按 key 排序后 stringify
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function computeInputHash(
  candidates: ChatAffinityCandidate[],
  examples: PromptExample[]
): string {
  const payload = {
    rankerVersion: RANKER_VERSION,
    promptVersion: PROMPT_VERSION,
    systemPrompt: RANKER_SYSTEM_PROMPT,
    candidates: candidates.map(trimCandidateForPrompt),
    examples,
    surfaceThresholds: {
      finalScore: config.mvp13SurfaceFinalScore,
      confidence: config.mvp13SurfaceLlmConfidence,
    },
  };
  return createHash('sha1').update(stableStringify(payload)).digest('hex');
}

// ---------- 主 entry ----------

export type RankCandidatesOptions = {
  workerRunId: string;
  runner?: RankerRunner;
  enableLlm?: boolean;
  cacheTtlHours?: number;
};

export type RankCandidatesSummary = {
  outcomes: RankerCandidateOutcome[];
  llmAccepted: number;
  llmRejected: number;
  llmFailed: number;
  rankerCacheHit: number;
  fallbackSuggested: number;
  rankerRunIds: string[];
};

export async function rankChatAffinityCandidates(
  candidates: ChatAffinityCandidate[],
  opts: RankCandidatesOptions
): Promise<RankCandidatesSummary> {
  const summary: RankCandidatesSummary = {
    outcomes: [],
    llmAccepted: 0,
    llmRejected: 0,
    llmFailed: 0,
    rankerCacheHit: 0,
    fallbackSuggested: 0,
    rankerRunIds: [],
  };
  if (candidates.length === 0) return summary;
  const runner = opts.runner ?? defaultRankerRunner;
  const enableLlm = opts.enableLlm ?? config.mvp13RankerEnabled;
  const cacheTtl = opts.cacheTtlHours ?? config.mvp13RankerCacheTtlHours;

  // LLM disabled：全走 fallback
  if (!enableLlm) {
    for (const c of candidates) {
      const outcome: RankerCandidateOutcome = {
        candidate: c,
        rankerStatus: 'llm_skipped',
        finalScore: c.ruleScore,
        surfaced: c.fallbackEligible,
        fallbackEligible: c.fallbackEligible,
      };
      summary.outcomes.push(outcome);
      if (c.fallbackEligible) summary.fallbackSuggested++;
    }
    return summary;
  }

  // Group by Space → 每个 Space 独立拉 examples → 独立 cache key（candidate set 不同）
  const bySpace = new Map<string, ChatAffinityCandidate[]>();
  for (const c of candidates) {
    const list = bySpace.get(c.spaceId) ?? [];
    list.push(c);
    bySpace.set(c.spaceId, list);
  }

  const batchSize = config.mvp13RankerBatchSize;

  for (const [spaceId, list] of bySpace) {
    // 拉 examples（同 Space 优先；否则 global 兜底）
    const examples = loadFewShotExamples(spaceId);

    // 拆 batch
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      await rankBatch({
        batch,
        examples,
        summary,
        opts: { workerRunId: opts.workerRunId, runner, cacheTtlHours: cacheTtl },
      });
    }
  }

  return summary;
}

async function rankBatch(args: {
  batch: ChatAffinityCandidate[];
  examples: PromptExample[];
  summary: RankCandidatesSummary;
  opts: {
    workerRunId: string;
    runner: RankerRunner;
    cacheTtlHours: number;
  };
}): Promise<void> {
  const { batch, examples, summary, opts } = args;
  const inputHash = computeInputHash(batch, examples);

  // ---- cache hit?
  const cached = findRecentRankerRunByInputHash(inputHash, opts.cacheTtlHours);
  if (cached && cached.output_json) {
    const results = parseRankerResponse(cached.output_json) ?? [];
    applyResults(batch, results, summary, {
      rankerStatus: 'cache_hit',
      runId: cached.id,
      modelId: cached.model_id ?? undefined,
    });
    summary.rankerCacheHit += batch.length;
    return;
  }

  // ---- fresh ranker run
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  insertContextSpaceRankerRun({
    id: runId,
    worker_run_id: opts.workerRunId,
    ranker_version: RANKER_VERSION,
    prompt_version: PROMPT_VERSION,
    model_id: null,
    status: 'running',
    candidate_count: batch.length,
    accepted_count: 0,
    rejected_count: 0,
    input_hash: inputHash,
    input_summary_json: JSON.stringify({
      candidateIds: batch.map((c) => c.candidateId),
      examplesCount: examples.length,
    }),
    output_json: null,
    reused_from_run_id: null,
    error: null,
    started_at: startedAt,
    completed_at: null,
  });
  summary.rankerRunIds.push(runId);

  const userPrompt = buildUserPrompt(batch, examples);
  let raw: OneShotResult | null = null;
  let parseError: Error | null = null;
  try {
    raw = await opts.runner(
      userPrompt,
      RANKER_SYSTEM_PROMPT,
      config.mvp13RankerTimeoutMs
    );
  } catch (err) {
    parseError = err instanceof Error ? err : new Error(String(err));
  }

  let results: ChatAffinityRankResult[] | null = null;
  if (raw) {
    results = parseRankerResponse(raw.text);
  }

  // batch parse 失败 → 拆单 candidate 重试一次
  if (raw && !results && batch.length > 1) {
    const collected: ChatAffinityRankResult[] = [];
    let anyOk = false;
    for (const single of batch) {
      try {
        const onePrompt = buildUserPrompt([single], examples);
        const oneRaw = await opts.runner(
          onePrompt,
          RANKER_SYSTEM_PROMPT,
          config.mvp13RankerTimeoutMs
        );
        const parsed = parseRankerResponse(oneRaw.text);
        if (parsed && parsed.length > 0) {
          collected.push(...parsed);
          anyOk = true;
        }
      } catch {
        /* skip */
      }
    }
    if (anyOk) results = collected;
  }

  if (parseError || !raw) {
    updateContextSpaceRankerRun(runId, {
      status: 'failed',
      error: parseError?.message ?? 'no result',
      completed_at: new Date().toISOString(),
    });
    fallbackAllInBatch(batch, summary, parseError?.message ?? 'no result');
    return;
  }

  if (!results) {
    updateContextSpaceRankerRun(runId, {
      status: 'parse_error',
      error: 'parse JSON failed',
      output_json: raw.text,
      completed_at: new Date().toISOString(),
    });
    fallbackAllInBatch(batch, summary, 'parse_error');
    return;
  }

  // 收集 model id（若 raw.raw 有 model 字段）
  let modelId: string | undefined;
  if (raw.raw && typeof raw.raw === 'object') {
    const rawObj = raw.raw as Record<string, unknown>;
    if (typeof rawObj.model === 'string') modelId = rawObj.model;
  }

  applyResults(batch, results, summary, {
    rankerStatus: 'llm_ok',
    runId,
    modelId,
  });

  const acceptedCount = summary.outcomes
    .filter((o) => o.llmRunId === runId)
    .filter(
      (o) =>
        o.llmResult &&
        (o.llmResult.decision === 'accept' ||
          o.llmResult.decision === 'strong_accept')
    ).length;
  const rejectedCount = summary.outcomes
    .filter((o) => o.llmRunId === runId)
    .filter(
      (o) =>
        o.llmResult &&
        (o.llmResult.decision === 'reject' ||
          o.llmResult.decision === 'maybe')
    ).length;
  updateContextSpaceRankerRun(runId, {
    status: 'ok',
    candidate_count: batch.length,
    accepted_count: acceptedCount,
    rejected_count: rejectedCount,
    output_json: JSON.stringify({ results }),
    completed_at: new Date().toISOString(),
    model_id: modelId,
  });
}

function applyResults(
  batch: ChatAffinityCandidate[],
  results: ChatAffinityRankResult[],
  summary: RankCandidatesSummary,
  meta: {
    rankerStatus: 'llm_ok' | 'cache_hit';
    runId: string;
    modelId?: string;
  }
): void {
  const byId = new Map<string, ChatAffinityRankResult>();
  for (const r of results) byId.set(r.candidateId, r);
  for (const c of batch) {
    const r = byId.get(c.candidateId);
    if (!r) {
      // LLM 没覆盖到这个 candidate → 视为 llm_failed，走 fallback
      const outcome: RankerCandidateOutcome = {
        candidate: c,
        rankerStatus: 'llm_failed',
        finalScore: c.ruleScore,
        surfaced: c.fallbackEligible,
        fallbackEligible: c.fallbackEligible,
        llmRunId: meta.runId,
        error: 'no result for candidate',
      };
      summary.outcomes.push(outcome);
      summary.llmFailed++;
      if (c.fallbackEligible) summary.fallbackSuggested++;
      continue;
    }
    const finalScore = computeFinalScore(r.decision, c.ruleScore, r.llmScore);
    const surfaced = isSurfaced(r.decision, finalScore, r.confidence);
    const outcome: RankerCandidateOutcome = {
      candidate: c,
      rankerStatus: meta.rankerStatus,
      llmResult: r,
      llmRunId: meta.runId,
      llmModelId: meta.modelId,
      finalScore,
      surfaced,
      fallbackEligible: c.fallbackEligible,
    };
    summary.outcomes.push(outcome);
    if (r.decision === 'accept' || r.decision === 'strong_accept') {
      summary.llmAccepted++;
    } else {
      summary.llmRejected++;
    }
  }
}

function fallbackAllInBatch(
  batch: ChatAffinityCandidate[],
  summary: RankCandidatesSummary,
  error: string
): void {
  for (const c of batch) {
    const outcome: RankerCandidateOutcome = {
      candidate: c,
      rankerStatus: 'llm_failed',
      finalScore: c.ruleScore,
      surfaced: c.fallbackEligible,
      fallbackEligible: c.fallbackEligible,
      error,
    };
    summary.outcomes.push(outcome);
    summary.llmFailed++;
    if (c.fallbackEligible) summary.fallbackSuggested++;
  }
}
