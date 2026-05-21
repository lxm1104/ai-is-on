/**
 * MVP12 Phase 2/3 + MVP13 §S5 — chat_affinity + person_co_occur suggestion worker.
 *
 * 流程（每次 run）：
 *   1. listChatEntities + listActiveSpacesWithSeeds
 *   2. buildChatAffinityCandidates（MVP13 宽召回 + evidence v2）
 *   3. rankChatAffinityCandidates（MVP13 LLM ranker，可注入 runner，可禁用走 fallback）
 *   4. 对 surfaced outcome upsert 'suggested'；对未 surfaced 不写表
 *   5. 继续 MVP12 person_co_occur 规则（30d 窗口、小群，与 LLM 无关）
 *
 * stats 向后兼容：旧 6 个字段保留，新增 candidate / llm / rankerCacheHit / fallbackSuggested。
 */
import { randomUUID } from 'node:crypto';
import { db, type ContextSpaceLinkRow } from '../db.js';
import {
  buildChatAffinityCandidates,
  RANKER_VERSION,
  type ChatAffinityEvidenceV2,
} from './chatAffinityEvidence.js';
import {
  rankChatAffinityCandidates,
  type RankerCandidateOutcome,
  type RankerRunner,
} from './llmChatAffinityRanker.js';
import {
  distinctPersonsInUnits,
  distinctSendersInUnits,
  listActiveSpacesWithSeeds,
  listChatEntities,
  unitsForChatEntity,
} from './chatAffinityQueries.js';

// ---------- 配置 ----------
const RECENT_DAYS_PERSON_CO_OCCUR = 30;
const BIG_CHAT_SENDER_CAP = 30;
const BIG_CHAT_UNIT_CAP = 200;
const PERSON_CO_OCCUR_THRESHOLD = 5;

// ---------- Stats ----------

export type SuggestionWorkerStats = {
  // MVP12 字段（保留）
  chatsScanned: number;
  chatsBigSkipped: number;
  chatAffinityInserted: number;
  chatAffinityUpdated: number;
  personCoOccurInserted: number;
  personCoOccurUpdated: number;
  // MVP13 新增
  candidateGenerated: number;
  candidateRanked: number;
  llmAccepted: number;
  llmRejected: number;
  llmFailed: number;
  rankerCacheHit: number;
  fallbackSuggested: number;
};

// ---------- suggestion upsert ----------

type ChatAffinityUpsertInput = {
  spaceId: string;
  chatEntityId: string;
  finalScore: number;
  ruleScore: number;
  llmScore: number | null;
  llmDecision: string | null;
  llmConfidence: number | null;
  rankerStatus: string;
  modelId: string | null;
  evidence: ChatAffinityEvidenceV2 & { llm?: unknown };
};

function upsertChatAffinity(
  input: ChatAffinityUpsertInput
): 'inserted' | 'updated' | 'skipped' {
  const now = new Date().toISOString();
  const existing = db
    .prepare(
      `SELECT id, status, cooldown_until FROM context_space_suggestions
       WHERE target_type = 'entity' AND target_id = ? AND space_id = ?
         AND suggestion_type = 'chat_affinity'`
    )
    .get(input.chatEntityId, input.spaceId) as
    | { id: string; status: string; cooldown_until: string | null }
    | undefined;

  if (existing) {
    if (existing.status === 'confirmed') return 'skipped';
    if (
      existing.status === 'rejected' &&
      existing.cooldown_until &&
      existing.cooldown_until > now
    )
      return 'skipped';
    db.prepare(
      `UPDATE context_space_suggestions
       SET score = @score,
           evidence_json = @evidence_json,
           status = 'suggested',
           cooldown_until = NULL,
           updated_at = @now,
           rule_score = @rule_score,
           llm_score = @llm_score,
           final_score = @final_score,
           llm_decision = @llm_decision,
           llm_confidence = @llm_confidence,
           ranker_status = @ranker_status,
           ranker_version = @ranker_version,
           model_id = @model_id
       WHERE id = @id`
    ).run({
      id: existing.id,
      score: input.finalScore,
      evidence_json: JSON.stringify(input.evidence),
      now,
      rule_score: input.ruleScore,
      llm_score: input.llmScore,
      final_score: input.finalScore,
      llm_decision: input.llmDecision,
      llm_confidence: input.llmConfidence,
      ranker_status: input.rankerStatus,
      ranker_version: RANKER_VERSION,
      model_id: input.modelId,
    });
    return 'updated';
  }
  try {
    db.prepare(
      `INSERT INTO context_space_suggestions
         (id, target_type, target_id, space_id, suggestion_type, score, evidence_json,
          status, cooldown_until, created_at, updated_at,
          rule_score, llm_score, final_score, llm_decision, llm_confidence,
          ranker_status, ranker_version, model_id)
       VALUES (@id, 'entity', @target_id, @space_id, 'chat_affinity', @score, @evidence_json,
          'suggested', NULL, @now, @now,
          @rule_score, @llm_score, @final_score, @llm_decision, @llm_confidence,
          @ranker_status, @ranker_version, @model_id)`
    ).run({
      id: randomUUID(),
      target_id: input.chatEntityId,
      space_id: input.spaceId,
      score: input.finalScore,
      evidence_json: JSON.stringify(input.evidence),
      now,
      rule_score: input.ruleScore,
      llm_score: input.llmScore,
      final_score: input.finalScore,
      llm_decision: input.llmDecision,
      llm_confidence: input.llmConfidence,
      ranker_status: input.rankerStatus,
      ranker_version: RANKER_VERSION,
      model_id: input.modelId,
    });
    return 'inserted';
  } catch {
    return 'skipped';
  }
}

function upsertPersonCoOccur(input: {
  spaceId: string;
  personEntityId: string;
  count: number;
  evidence: Record<string, unknown>;
}): 'inserted' | 'updated' | 'skipped' {
  const now = new Date().toISOString();
  const existing = db
    .prepare(
      `SELECT id, status, cooldown_until FROM context_space_suggestions
       WHERE target_type = 'entity' AND target_id = ? AND space_id = ?
         AND suggestion_type = 'person_co_occur'`
    )
    .get(input.personEntityId, input.spaceId) as
    | { id: string; status: string; cooldown_until: string | null }
    | undefined;

  if (existing) {
    if (existing.status === 'confirmed') return 'skipped';
    if (
      existing.status === 'rejected' &&
      existing.cooldown_until &&
      existing.cooldown_until > now
    )
      return 'skipped';
    db.prepare(
      `UPDATE context_space_suggestions
       SET score = ?, evidence_json = ?, status = 'suggested',
           cooldown_until = NULL, updated_at = ?
       WHERE id = ?`
    ).run(
      input.count,
      JSON.stringify(input.evidence),
      now,
      existing.id
    );
    return 'updated';
  }
  try {
    db.prepare(
      `INSERT INTO context_space_suggestions
       (id, target_type, target_id, space_id, suggestion_type, score, evidence_json,
        status, cooldown_until, created_at, updated_at)
       VALUES (?, 'entity', ?, ?, 'person_co_occur', ?, ?, 'suggested', NULL, ?, ?)`
    ).run(
      randomUUID(),
      input.personEntityId,
      input.spaceId,
      input.count,
      JSON.stringify(input.evidence),
      now,
      now
    );
    return 'inserted';
  } catch {
    return 'skipped';
  }
}

// ---------- 主 entry ----------

export type RunSuggestionWorkerOptions = {
  runner?: RankerRunner;
  enableLlm?: boolean;
  workerRunId?: string;
};

export async function runSuggestionWorker(
  opts: RunSuggestionWorkerOptions = {}
): Promise<SuggestionWorkerStats> {
  const stats: SuggestionWorkerStats = {
    chatsScanned: 0,
    chatsBigSkipped: 0,
    chatAffinityInserted: 0,
    chatAffinityUpdated: 0,
    personCoOccurInserted: 0,
    personCoOccurUpdated: 0,
    candidateGenerated: 0,
    candidateRanked: 0,
    llmAccepted: 0,
    llmRejected: 0,
    llmFailed: 0,
    rankerCacheHit: 0,
    fallbackSuggested: 0,
  };
  const workerRunId = opts.workerRunId ?? randomUUID();

  // ---------- Phase 2: chat_affinity（MVP13 LLM ranker 走起） ----------
  const candidates = buildChatAffinityCandidates({
    workerRunId,
    now: new Date(),
  });
  stats.candidateGenerated = candidates.length;

  const rankSummary = await rankChatAffinityCandidates(candidates, {
    workerRunId,
    runner: opts.runner,
    enableLlm: opts.enableLlm,
  });
  stats.candidateRanked = rankSummary.outcomes.length;
  stats.llmAccepted = rankSummary.llmAccepted;
  stats.llmRejected = rankSummary.llmRejected;
  stats.llmFailed = rankSummary.llmFailed;
  stats.rankerCacheHit = rankSummary.rankerCacheHit;
  stats.fallbackSuggested = rankSummary.fallbackSuggested;

  for (const o of rankSummary.outcomes) {
    if (!o.surfaced) continue;
    const r = upsertChatAffinityFromOutcome(o);
    if (r === 'inserted') stats.chatAffinityInserted++;
    else if (r === 'updated') stats.chatAffinityUpdated++;
  }

  // ---------- Phase 3: person_co_occur（保留 MVP12 规则路径） ----------
  const personStats = runPersonCoOccurPath(stats);
  stats.personCoOccurInserted = personStats.inserted;
  stats.personCoOccurUpdated = personStats.updated;

  return stats;
}

function upsertChatAffinityFromOutcome(
  o: RankerCandidateOutcome
): 'inserted' | 'updated' | 'skipped' {
  const c = o.candidate;
  const llm = o.llmResult;
  // evidence_json 写 v2 + llm 摘要
  const evidence: ChatAffinityEvidenceV2 & { llm?: unknown } = {
    ...c.evidence,
    llm: llm
      ? {
          status: o.rankerStatus === 'cache_hit' ? 'cache_hit' : 'ok',
          decision: llm.decision,
          score: llm.llmScore,
          confidence: llm.confidence,
          reasons: llm.reasons,
          concerns: llm.concerns,
          modelId: o.llmModelId,
          runId: o.llmRunId,
        }
      : {
          status:
            o.rankerStatus === 'llm_failed'
              ? 'failed'
              : o.rankerStatus === 'llm_skipped'
                ? 'skipped'
                : 'ok',
          modelId: o.llmModelId,
          runId: o.llmRunId,
        },
  };
  return upsertChatAffinity({
    spaceId: c.spaceId,
    chatEntityId: c.chatEntityId,
    finalScore: o.finalScore,
    ruleScore: c.ruleScore,
    llmScore: llm ? llm.llmScore : null,
    llmDecision: llm ? llm.decision : null,
    llmConfidence: llm ? llm.confidence : null,
    rankerStatus: o.rankerStatus,
    modelId: o.llmModelId ?? null,
    evidence,
  });
}

// ---------- Phase 3 person_co_occur（与 MVP12 等价） ----------

function runPersonCoOccurPath(stats: SuggestionWorkerStats): {
  inserted: number;
  updated: number;
} {
  let inserted = 0;
  let updated = 0;
  const since = new Date(
    Date.now() - RECENT_DAYS_PERSON_CO_OCCUR * 86400_000
  ).toISOString();
  const chats = listChatEntities();
  const spaces = listActiveSpacesWithSeeds();
  if (chats.length === 0 || spaces.length === 0) return { inserted, updated };

  for (const c of chats) {
    stats.chatsScanned++;
    const units = unitsForChatEntity(c.id, since);
    const unitIds = units.map((u) => u.unitId);
    if (unitIds.length === 0) continue;
    const senders = distinctSendersInUnits(unitIds);
    const isBig =
      senders.persons > BIG_CHAT_SENDER_CAP ||
      (unitIds.length > BIG_CHAT_UNIT_CAP &&
        senders.persons > BIG_CHAT_SENDER_CAP);
    if (isBig) {
      stats.chatsBigSkipped++;
      continue;
    }
    if (unitIds.length < 5) continue;

    const chatPersons = distinctPersonsInUnits(unitIds);
    if (chatPersons.size === 0) continue;

    for (const sp of spaces) {
      if (sp.personSeedIds.size === 0) continue;
      for (const personId of chatPersons) {
        if (sp.personSeedIds.has(personId)) continue;
        const seedIds = Array.from(sp.personSeedIds);
        const ph1 = unitIds.map(() => '?').join(',');
        const ph2 = seedIds.map(() => '?').join(',');
        const row = db
          .prepare(
            `SELECT COUNT(DISTINCT cu1.context_unit_id) as n
             FROM context_unit_entities cu1
             JOIN context_unit_entities cu2
               ON cu1.context_unit_id = cu2.context_unit_id
             WHERE cu1.context_unit_id IN (${ph1})
               AND cu1.entity_id = ?
               AND cu2.entity_id IN (${ph2})`
          )
          .get(...unitIds, personId, ...seedIds) as { n: number };
        if (row.n < PERSON_CO_OCCUR_THRESHOLD) continue;
        const r = upsertPersonCoOccur({
          spaceId: sp.spaceId,
          personEntityId: personId,
          count: row.n,
          evidence: {
            chatId: c.id,
            chatName: c.name,
            coOccurCount: row.n,
            recentDays: RECENT_DAYS_PERSON_CO_OCCUR,
          },
        });
        if (r === 'inserted') inserted++;
        else if (r === 'updated') updated++;
      }
    }
  }
  return { inserted, updated };
}

// ---------- 兼容 export ----------

export type ListSpaceLinkRowExtra = ContextSpaceLinkRow;
