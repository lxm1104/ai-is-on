/**
 * MVP27 §6.3-§6.5 — Matter 候选召回 + 规则评分 + LLM 判定。
 *
 *   recallCandidates  →  scoreCandidate(top 8)  →  judgeMatter(LLM)
 *
 * active Matter 数量预计不多，做较宽召回再用 cheap scoring 收窄，最后只对 top-K 打一次
 * 轻量 LLM。判定结果（MatterReduceDecision）交给 matterReducer 按阈值落地。
 * judgeMatter 可注入（测试用 stub），生产走 runOneShot('aiisn-matter-reducer')。
 */
import { config } from '../config.js';
import {
  getContextEntityById,
  getContextSpace,
  getContextUnit,
  listEntitiesForUnit,
  listSpacesForTarget,
} from '../db.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import { resolveAliased } from '../context/entityResolver.js';
import { classifyContextUnit } from '../context/layerClassifier.js';
import { resolveUnitToSpaces } from '../spaces/contextSpaceService.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import type { Matter, MatterReduceDecision, MatterStatus } from './matterTypes.js';
import { canonicalizeMatterTitle } from './matterTypes.js';
import {
  listMatterContextLinks,
  listMatterEntities,
  listMatters,
} from './matterStore.js';
import {
  type MatterCandidateSketch,
  type NewUnitSketch,
  buildMatterReduceUserMessage,
  parseMatterReduceDecision,
} from './matterReducerPrompt.js';

const ACTIVE_STATUSES: MatterStatus[] = [
  'open',
  'acknowledged',
  'in_progress',
  'waiting',
  'blocked',
];

// §9.4：明确的"又被催 / 没收到 / 要重做"信号才允许召回 resolved Matter 去 reopen。
const REOPEN_HINT_RE =
  /(再次|又一次|还没|没收到|未收到|没回复|重做|重新做|怎么还没|催一下|催了|催促|没做完|未完成|没交付|没搞定|again|still\s+not|not\s+received)/i;

export function hasReopenHint(unit: ContextUnit): boolean {
  return REOPEN_HINT_RE.test(`${unit.title} ${unit.content}`);
}

// ---- 实体/类型工具 ----

type TypedEntityIds = {
  all: Set<string>;
  person: Set<string>;
  projectOrg: Set<string>;
  docTask: Set<string>;
  chat: Set<string>;
};

function emptyTyped(): TypedEntityIds {
  return {
    all: new Set(),
    person: new Set(),
    projectOrg: new Set(),
    docTask: new Set(),
    chat: new Set(),
  };
}

function bucketEntity(acc: TypedEntityIds, entityId: string, type: string) {
  const id = resolveAliased(entityId);
  acc.all.add(id);
  const t = type.toLowerCase();
  if (t === 'person') acc.person.add(id);
  else if (t === 'project' || t === 'org' || t === 'topic') acc.projectOrg.add(id);
  else if (t === 'doc' || t === 'task') acc.docTask.add(id);
  else if (t === 'chat') acc.chat.add(id);
}

export function typedEntityIdsOfUnit(unit: ContextUnit): TypedEntityIds {
  const acc = emptyTyped();
  for (const row of listEntitiesForUnit(unit.id)) {
    const ent = getContextEntityById(row.entity_id);
    bucketEntity(acc, row.entity_id, ent?.type ?? 'person');
  }
  return acc;
}

function typedEntityIdsOfMatter(matterId: string): TypedEntityIds {
  const acc = emptyTyped();
  for (const e of listMatterEntities(matterId)) {
    const ent = getContextEntityById(e.entityId);
    bucketEntity(acc, e.entityId, ent?.type ?? 'person');
  }
  return acc;
}

function matterSpaceIds(matter: Matter): Set<string> {
  const out = new Set<string>();
  if (matter.primarySpaceId) out.add(matter.primarySpaceId);
  for (const l of listSpacesForTarget('matter', matter.id)) out.add(l.space_id);
  return out;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// ---- 标题相似（char-bigram Jaccard）----

function bigrams(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < norm.length - 1; i++) out.add(norm.slice(i, i + 2));
  return out;
}

export function titleSimilarity(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  return inter / (ba.size + bb.size - inter);
}

// ---- §6.4 规则评分 ----

export type ScoreFeatures = {
  personOverlap: boolean;
  projectOrSpaceOverlap: boolean;
  docTaskOverlap: boolean;
  chatOverlap: boolean;
  titleSimilar: boolean;
  unitAfterMatterCreated: boolean;
  actionResultOnActiveMatter: boolean;
  selfRoleConsistent: boolean;
  matterResolvedNoReopen: boolean;
};

/** 纯函数：把 §6.4 特征加权求和。便于单测权重。 */
export function scoreFeatures(f: ScoreFeatures): number {
  let s = 0;
  if (f.personOverlap) s += 0.35;
  if (f.projectOrSpaceOverlap) s += 0.3;
  if (f.docTaskOverlap) s += 0.25;
  if (f.chatOverlap) s += 0.2;
  if (f.titleSimilar) s += 0.25;
  if (f.unitAfterMatterCreated) s += 0.1;
  if (f.actionResultOnActiveMatter) s += 0.25;
  if (f.selfRoleConsistent) s += 0.2;
  if (f.matterResolvedNoReopen) s -= 0.4;
  return s;
}

const TITLE_SIM_THRESHOLD = 0.3;

export function extractScoreFeatures(
  unit: ContextUnit,
  unitTyped: TypedEntityIds,
  unitSpaces: Set<string>,
  matter: Matter,
  reopenHint: boolean
): ScoreFeatures {
  const mt = typedEntityIdsOfMatter(matter.id);
  const mSpaces = matterSpaceIds(matter);
  const projectOrSpaceOverlap =
    intersects(unitTyped.projectOrg, mt.projectOrg) || intersects(unitSpaces, mSpaces);
  const matterActive = ACTIVE_STATUSES.includes(matter.status);
  const unitTime = unit.time?.occurredAt ?? unit.createdAt;
  return {
    personOverlap: intersects(unitTyped.person, mt.person),
    projectOrSpaceOverlap,
    docTaskOverlap: intersects(unitTyped.docTask, mt.docTask),
    chatOverlap: intersects(unitTyped.chat, mt.chat),
    titleSimilar:
      titleSimilarity(canonicalizeMatterTitle(unit.title), matter.title) >= TITLE_SIM_THRESHOLD,
    unitAfterMatterCreated: !!unitTime && unitTime >= matter.createdAt,
    actionResultOnActiveMatter: unit.kind === 'action_result' && matterActive,
    // 我侧 action_result 命中以「我」为 owner 的 Matter（executor commitment + 我侧动作）
    selfRoleConsistent:
      unit.kind === 'action_result' &&
      !!matter.ownerEntityId &&
      unitTyped.all.has(resolveAliased(matter.ownerEntityId)),
    matterResolvedNoReopen:
      (matter.status === 'resolved' || matter.status === 'dropped') && !reopenHint,
  };
}

// ---- 召回 + 评分 ----

export type ScoredCandidate = { matter: Matter; score: number };

export function recallCandidates(unit: ContextUnit, now: number): Matter[] {
  const ninetyAgo = new Date(now - 90 * 86400_000).toISOString();
  const active = listMatters({
    statuses: ACTIVE_STATUSES,
    updatedSince: ninetyAgo,
    limit: 100,
  });
  let pool = active;
  if (hasReopenHint(unit)) {
    const thirtyAgo = new Date(now - 30 * 86400_000).toISOString();
    const resolved = listMatters({
      statuses: ['resolved'],
      updatedSince: thirtyAgo,
      limit: 50,
    });
    pool = [...active, ...resolved];
  }
  // 排除「就是这条 unit 自己 created_from 的 Matter」（同 unit 再次 upsert，由 reducer 单独处理）
  return pool.filter((m) => m.createdFromContextUnitId !== unit.id);
}

const RECALL_CAP = 30;
const TOP_K = 8;
const MIN_RECALL_SCORE = 0.2;

/** 召回 + 评分 + 取 top-K（默认 8）。score < MIN_RECALL_SCORE 的丢弃。 */
export function scoreAndRank(unit: ContextUnit, now: number): ScoredCandidate[] {
  const unitTyped = typedEntityIdsOfUnit(unit);
  let unitSpaces = new Set<string>();
  try {
    unitSpaces = new Set(resolveUnitToSpaces(unit));
  } catch {
    /* routing 未就绪不致命 */
  }
  const reopenHint = hasReopenHint(unit);
  const recalled = recallCandidates(unit, now).slice(0, RECALL_CAP);
  const scored = recalled
    .map((matter) => ({
      matter,
      score: scoreFeatures(
        extractScoreFeatures(unit, unitTyped, unitSpaces, matter, reopenHint)
      ),
    }))
    .filter((c) => c.score >= MIN_RECALL_SCORE)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, TOP_K);
}

// ---- sketch 构造（喂给 LLM）----

export function buildNewUnitSketch(unit: ContextUnit): NewUnitSketch {
  return {
    id: unit.id,
    kind: unit.kind,
    title: unit.title,
    content: unit.content.length > 400 ? unit.content.slice(0, 400) + '…' : unit.content,
    actionability: unit.actionability,
    scope: unit.scope,
    source: classifyContextUnit(unit).source,
    time: unit.time?.occurredAt || unit.time?.dueAt
      ? { occurredAt: unit.time?.occurredAt, dueAt: unit.time?.dueAt }
      : undefined,
    entities: unit.entities.map((e) => ({
      type: e.type,
      name: e.name,
      role: e.role ?? 'about',
    })),
  };
}

export function buildCandidateSketch(matter: Matter): MatterCandidateSketch {
  const entities = listMatterEntities(matter.id).map((e) => {
    const ent = getContextEntityById(e.entityId);
    return { type: ent?.type ?? '?', name: ent?.name ?? e.entityId, role: e.role };
  });
  const spaces: string[] = [];
  for (const sid of matterSpaceIds(matter)) {
    const sp = getContextSpace(sid);
    if (sp) spaces.push(sp.name);
  }
  const recentEvidence = listMatterContextLinks(matter.id)
    .slice(-3)
    .map((l) => {
      const u = getContextUnit(l.contextUnitId);
      return { kind: u?.kind, title: u?.title, effect: l.effect, at: l.createdAt };
    });
  return {
    id: matter.id,
    title: matter.title,
    type: matter.type,
    status: matter.status,
    priority: matter.priority,
    currentSummary: matter.currentSummary,
    entities,
    spaces,
    recentEvidence,
  };
}

// ---- LLM 判定（可注入）----

export type MatterJudge = (
  unit: ContextUnit,
  candidates: Matter[]
) => Promise<MatterReduceDecision>;

/** 生产判定：runOneShot('aiisn-matter-reducer') + parse。 */
export const llmJudge: MatterJudge = async (unit, candidates) => {
  const userMsg = buildMatterReduceUserMessage({
    unit: buildNewUnitSketch(unit),
    candidates: candidates.map(buildCandidateSketch),
  });
  const res = await runOneShot(userMsg, {
    agentName: 'aiisn-matter-reducer',
    timeoutMs: config.triageTimeoutMs,
  });
  return parseMatterReduceDecision(res.text);
};
