/**
 * MVP13 §3.5 / §4.3-4.6：chat_affinity candidates & evidence v2 builder.
 *
 * 输出 `ChatAffinityCandidate[]`：包含规则评分、evidence 摘要、fallbackEligible
 * 信号；后续传给 [llmChatAffinityRanker.ts](apps/server/src/spaces/llmChatAffinityRanker.ts)。
 *
 * 关键约束：
 *   1. 召回放宽：units7d >= 2 且至少一个弱信号（directHits / personOverlap /
 *      docOverlap / nameSimilarity / tokenOverlap / keywordOverlap /
 *      workMapTokenOverlap 任一）。
 *   2. fallback：MVP12 阈值 OR (nameSimilarity >= 0.72 AND units7d >= 3)。
 *   3. 所有 unit title / meaning 进 evidence 前过 [sanitizeExcerpt](apps/server/src/bootstrap/workMapDraftPrompt.ts:72)。
 *   4. ruleScore + candidateSortScore 全在这里算好，ranker 不再算。
 */
import { sanitizeExcerpt } from '../bootstrap/workMapDraftPrompt.js';
import { decodeSpaceIntent } from './contextSpaceService.js';
import { getContextSpace } from '../db.js';
import {
  countDirectHits,
  countFeedbackHits,
  countIntersection,
  distinctDocsInUnits,
  distinctPersonsInUnits,
  distinctSendersInUnits,
  fetchSummarizedUnits,
  listActiveSpacesWithSeeds,
  listChatEntities,
  safeParseJsonArray,
  seedEntitySummary,
  topDocsInUnits,
  topPersonsInUnits,
  topUnitKinds,
  unitsForChatEntity,
  type SpaceWithSeeds,
} from './chatAffinityQueries.js';
import { nameSimilarity, tokenize } from './keywordExtractor.js';

export const RANKER_VERSION = 'mvp13.chat_affinity.v1';

const RECENT_DAYS = 7;
const BIG_CHAT_SENDER_CAP = 30;
const BIG_CHAT_UNIT_CAP = 200;

const FALLBACK_DIRECT = 3;
const FALLBACK_PERSON = 2;
const FALLBACK_DOC = 1;
const FALLBACK_NAME_SIM = 0.72;
const FALLBACK_NAME_SIM_UNITS = 3;

const MIN_UNITS_PER_CHAT = 2; // 召回门槛
const MAX_CANDIDATES_GLOBAL = 50;
const MAX_SPACES_PER_CHAT = 5;
const MAX_CHATS_PER_SPACE = 10;

// ---------- Types ----------

export type ChatAffinityRuleSignals = {
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

export type ChatAffinityEvidenceV2 = {
  schemaVersion: 2;
  generatedAt: string;
  workerRunId: string;
  rankerVersion: string;
  recentDays: number;
  window: { since: string; until: string };

  // MVP12 兼容字段
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
    seedEntities: ReturnType<typeof seedEntitySummary>;
    workMap: {
      goalTitles: string[];
      riskTitles: string[];
      stakeholderNames: string[];
      authoritativeDocNames: string[];
    };
  };

  ruleSignals: ChatAffinityRuleSignals;

  summarizedUnits: Array<{
    id: string;
    kind: string;
    title: string;
    meaning?: string;
    updatedAt: string;
    linkTypesToSpace: string[];
    entityRefs: string[];
  }>;
};

export type ChatAffinityCandidate = {
  candidateId: string;
  spaceId: string;
  chatEntityId: string;
  ruleScore: number;
  fallbackEligible: boolean;
  candidateSortScore: number;
  evidence: ChatAffinityEvidenceV2;
};

// ---------- ruleScore / candidateSortScore ----------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function computeRuleScore(s: {
  directHits: number;
  unitsInChat: number;
  personOverlap: number;
  docOverlap: number;
  nameSimilarity: number;
  tokenOverlap: string[];
  keywordOverlap: string[];
  workMapTokenOverlap: string[];
  negativeFeedbackHits30d: number;
  units7d: number;
}): number {
  const direct = (Math.min(s.directHits, 5) / 5) * 0.30;
  const person = (Math.min(s.personOverlap, 3) / 3) * 0.18;
  const doc = (Math.min(s.docOverlap, 2) / 2) * 0.16;
  const name = s.nameSimilarity * 0.22;
  const tok =
    (Math.min(
      s.tokenOverlap.length + s.keywordOverlap.length,
      3
    ) / 3) * 0.10;
  const recency = (Math.min(s.units7d, 20) / 20) * 0.04;
  const neg = Math.min(s.negativeFeedbackHits30d, 2) * 0.15;
  return clamp(direct + person + doc + name + tok + recency - neg, 0, 1);
}

function computeCandidateSortScore(
  ruleScore: number,
  sig: ChatAffinityRuleSignals
): number {
  return (
    ruleScore +
    (sig.nameSimilarity >= 0.72 ? 0.18 : 0) +
    (sig.keywordOverlap.length > 0 ? 0.08 : 0) +
    (sig.workMapTokenOverlap.length > 0 ? 0.08 : 0) -
    (sig.negativeFeedbackHits30d > 0 ? 0.20 : 0)
  );
}

function passesWeakSignalGate(sig: {
  directHits: number;
  personOverlap: number;
  docOverlap: number;
  nameSimilarity: number;
  tokenOverlap: string[];
  keywordOverlap: string[];
  workMapTokenOverlap: string[];
}): boolean {
  return (
    sig.directHits >= 1 ||
    sig.personOverlap >= 1 ||
    sig.docOverlap >= 1 ||
    sig.nameSimilarity >= 0.35 ||
    sig.tokenOverlap.length >= 1 ||
    sig.keywordOverlap.length >= 1 ||
    sig.workMapTokenOverlap.length >= 1
  );
}

function isFallbackEligible(sig: {
  directHits: number;
  personOverlap: number;
  docOverlap: number;
  nameSimilarity: number;
  units7d: number;
}): boolean {
  return (
    sig.directHits >= FALLBACK_DIRECT ||
    sig.personOverlap >= FALLBACK_PERSON ||
    sig.docOverlap >= FALLBACK_DOC ||
    (sig.nameSimilarity >= FALLBACK_NAME_SIM &&
      sig.units7d >= FALLBACK_NAME_SIM_UNITS)
  );
}

// ---------- main builder ----------

export type BuildCandidatesOptions = {
  workerRunId: string;
  now?: Date;
};

export function buildChatAffinityCandidates(
  opts: BuildCandidatesOptions
): ChatAffinityCandidate[] {
  const now = opts.now ?? new Date();
  const sinceIso = new Date(
    now.getTime() - RECENT_DAYS * 86400_000
  ).toISOString();
  const since30Iso = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const generatedAt = now.toISOString();

  const chats = listChatEntities();
  const spaces = listActiveSpacesWithSeeds();
  if (chats.length === 0 || spaces.length === 0) return [];

  // 预读 Space intent + meta
  const spaceMetaById = new Map<
    string,
    {
      base: SpaceWithSeeds;
      typeName: string;
      name: string;
      description: string | null;
      intentSummary?: string;
      aliases: string[];
      keywords: string[];
      goalTitles: string[];
      riskTitles: string[];
      stakeholderNames: string[];
      authoritativeDocNames: string[];
      seedEntities: ReturnType<typeof seedEntitySummary>;
      // 预算 token 集合，用于 overlap
      nameTokenSet: Set<string>;
      keywordSet: Set<string>;
      workMapTokenSet: Set<string>;
    }
  >();
  for (const sp of spaces) {
    const row = getContextSpace(sp.spaceId);
    if (!row) continue;
    const intent = decodeSpaceIntent(row.intent_json);
    const goalTitles = intent.workMapGoalTitles ?? [];
    const riskTitles = intent.workMapRiskTitles ?? [];
    const nameTokenSet = new Set<string>([
      ...tokenize(row.name),
      ...(intent.aliases ?? []).flatMap((a) => tokenize(a)),
    ]);
    const keywordSet = new Set<string>([
      ...(intent.keywords ?? []).flatMap((k) => tokenize(k)),
    ]);
    const workMapTokenSet = new Set<string>([
      ...goalTitles.flatMap((g) => tokenize(g)),
      ...riskTitles.flatMap((r) => tokenize(r)),
    ]);
    spaceMetaById.set(sp.spaceId, {
      base: sp,
      typeName: row.type,
      name: row.name,
      description: row.description,
      intentSummary: intent.summary,
      aliases: intent.aliases ?? [],
      keywords: intent.keywords ?? [],
      goalTitles,
      riskTitles,
      stakeholderNames: intent.stakeholderNames ?? [],
      authoritativeDocNames: intent.authoritativeDocNames ?? [],
      seedEntities: seedEntitySummary(sp.spaceId),
      nameTokenSet,
      keywordSet,
      workMapTokenSet,
    });
  }

  const candidates: ChatAffinityCandidate[] = [];

  for (const c of chats) {
    const chatAliases = safeParseJsonArray(c.aliases_json);
    const displayName = chatAliases[0] ?? c.name;
    const chatNameTokens = tokenize([c.name, ...chatAliases].join(' '));
    const chatNameTokenSet = new Set(chatNameTokens);

    const unitsPrimary = unitsForChatEntity(c.id, sinceIso);
    const unitIdsPrimary = unitsPrimary.map((u) => u.unitId);
    const unitsInChat = unitIdsPrimary.length;
    if (unitsInChat < MIN_UNITS_PER_CHAT) continue;

    const senders = distinctSendersInUnits(unitIdsPrimary);
    const isBig =
      senders.persons > BIG_CHAT_SENDER_CAP ||
      (unitsInChat > BIG_CHAT_UNIT_CAP &&
        senders.persons > BIG_CHAT_SENDER_CAP);
    if (isBig) continue; // bigChat 整体跳过（与 MVP12 一致）

    const chatPersons = distinctPersonsInUnits(unitIdsPrimary);
    const chatDocs = distinctDocsInUnits(unitIdsPrimary);
    const units30 = unitsForChatEntity(c.id, since30Iso).length;
    const tpPersons = topPersonsInUnits(unitIdsPrimary);
    const tpDocs = topDocsInUnits(unitIdsPrimary);
    const tpKinds = topUnitKinds(unitIdsPrimary);
    const summarized = fetchSummarizedUnits(unitIdsPrimary).map((u) => ({
      id: u.id,
      kind: u.kind,
      title: sanitizeExcerpt(u.title),
      meaning: u.meaning ? sanitizeExcerpt(u.meaning) : undefined,
      updatedAt: u.updatedAt,
      linkTypesToSpace: [] as string[],
      entityRefs: u.entityRefs.slice(0, 5),
    }));

    for (const sp of spaces) {
      if (sp.chatSeedIds.has(c.id)) continue; // 已经是 chat seed
      const meta = spaceMetaById.get(sp.spaceId);
      if (!meta) continue;

      const directHits = countDirectHits(unitIdsPrimary, sp.spaceId);
      const personOverlap = countIntersection(chatPersons, sp.personSeedIds);
      const docOverlap = countIntersection(chatDocs, sp.docSeedIds);

      const { similarity: simScore, tokenOverlap } = nameSimilarity(
        meta.name,
        displayName
      );
      // tokenOverlap from nameSimilarity 用 chat 完整 name 与 Space name；
      // 还要算 keyword 与 workMap goal token 的 overlap（用 chat token set）
      const keywordOverlap: string[] = [];
      for (const k of meta.keywordSet) {
        if (chatNameTokenSet.has(k)) keywordOverlap.push(k);
      }
      const workMapTokenOverlap: string[] = [];
      for (const k of meta.workMapTokenSet) {
        if (chatNameTokenSet.has(k)) workMapTokenOverlap.push(k);
      }

      const fb30 = countFeedbackHits('entity', c.id, sp.spaceId, 30);
      const fb90 = countFeedbackHits('entity', c.id, sp.spaceId, 90);

      const gateInput = {
        directHits,
        personOverlap,
        docOverlap,
        nameSimilarity: simScore,
        tokenOverlap,
        keywordOverlap,
        workMapTokenOverlap,
      };
      if (!passesWeakSignalGate(gateInput)) continue;

      const ruleScore = computeRuleScore({
        ...gateInput,
        unitsInChat,
        negativeFeedbackHits30d: fb30.negative,
        units7d: unitsInChat,
      });

      const fallbackEligible = isFallbackEligible({
        directHits,
        personOverlap,
        docOverlap,
        nameSimilarity: simScore,
        units7d: unitsInChat,
      });

      const ruleSignals: ChatAffinityRuleSignals = {
        directHits,
        directHitRatio: unitsInChat > 0 ? directHits / unitsInChat : 0,
        personOverlap,
        docOverlap,
        nameSimilarity: simScore,
        tokenOverlap,
        keywordOverlap,
        workMapTokenOverlap,
        negativeFeedbackHits30d: fb30.negative,
        positiveFeedbackHits90d: fb90.positive,
        bigChatSkipped: false,
        ruleScore,
        fallbackEligible,
      };

      const evidence: ChatAffinityEvidenceV2 = {
        schemaVersion: 2,
        generatedAt,
        workerRunId: opts.workerRunId,
        rankerVersion: RANKER_VERSION,
        recentDays: RECENT_DAYS,
        window: { since: sinceIso, until: generatedAt },

        unitsInChat,
        directHits,
        personOverlap,
        docOverlap,
        distinctSenders: senders.persons,
        chatName: c.name,
        chatAliases,

        chat: {
          id: c.id,
          name: c.name,
          aliases: chatAliases,
          displayName,
          normalizedName: tokenize(c.name).join(' '),
          nameTokens: chatNameTokens,
          units7d: unitsInChat,
          units30d: units30,
          distinctPersonSenders7d: senders.persons,
          distinctAppSenders7d: senders.apps,
          topPersons: tpPersons,
          topDocs: tpDocs,
          topUnitKinds: tpKinds,
        },

        space: {
          id: sp.spaceId,
          type: meta.typeName,
          name: meta.name,
          description: meta.description,
          intentSummary: meta.intentSummary,
          aliases: meta.aliases,
          keywords: meta.keywords,
          seedEntities: meta.seedEntities,
          workMap: {
            goalTitles: meta.goalTitles,
            riskTitles: meta.riskTitles,
            stakeholderNames: meta.stakeholderNames,
            authoritativeDocNames: meta.authoritativeDocNames,
          },
        },

        ruleSignals,
        summarizedUnits: summarized,
      };

      const candidateSortScore = computeCandidateSortScore(
        ruleScore,
        ruleSignals
      );
      candidates.push({
        candidateId: `${sp.spaceId}:${c.id}`,
        spaceId: sp.spaceId,
        chatEntityId: c.id,
        ruleScore,
        fallbackEligible,
        candidateSortScore,
        evidence,
      });
    }
  }

  // 限流：全局 top 50；每个 chat 最多 5 个 Space；每个 Space 最多 10 个 chat
  candidates.sort((a, b) => b.candidateSortScore - a.candidateSortScore);
  const perChat = new Map<string, number>();
  const perSpace = new Map<string, number>();
  const kept: ChatAffinityCandidate[] = [];
  for (const c of candidates) {
    if (kept.length >= MAX_CANDIDATES_GLOBAL) break;
    const cn = perChat.get(c.chatEntityId) ?? 0;
    const sn = perSpace.get(c.spaceId) ?? 0;
    if (cn >= MAX_SPACES_PER_CHAT) continue;
    if (sn >= MAX_CHATS_PER_SPACE) continue;
    perChat.set(c.chatEntityId, cn + 1);
    perSpace.set(c.spaceId, sn + 1);
    kept.push(c);
  }
  return kept;
}
