/**
 * MVP27 §6 — Matter Reducer：context upsert 后判断「这条证据如何影响事项」。
 *
 *   reduceMatterForContextUnit(unit)
 *     1. rehydrate（hook 给的 unit.entities 可能不全，重新取全量）
 *     2. kind gate（只处理 commitment/intent/action_result/decision/uncertainty）
 *     3. 同 unit 已 created_from 的 Matter → 刷新，不重复建
 *     4. 召回+评分（matterMatcher）
 *     5. 无候选：create-kind → 规则建 Matter（无 LLM）；effect-kind → ignore
 *        有候选：LLM 判定 create/attach/ignore
 *     6. 按**保守阈值**落地（§6.5）：≥0.78 改 status，0.55-0.78 只 attach evidence，<0.55 ignore
 *
 * 状态变更比"漏提醒"更伤信任，所以 resolve 门槛高、reducer 永不自动 drop、dropped 不自动 reopen。
 */
import { randomUUID } from 'node:crypto';
import {
  getContextEntityById,
  getSetting,
  insertContextLink,
  listContextLinksFor,
  listEntitiesForUnit,
  listSpacesForTarget,
} from '../db.js';
import type { ChangeContext } from '../context/changeContext.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import { getContextUnitById } from '../context/contextStore.js';
import { resolveAliased } from '../context/entityResolver.js';
import { classifyContextUnit } from '../context/layerClassifier.js';
import { computeSelfRoleOnUnit } from '../context/selfRoleOnUnit.js';
import {
  type Matter,
  type MatterContextEffect,
  type MatterContextRelation,
  type MatterReduceDecision,
  type MatterStatus,
  type MatterType,
  canonicalizeMatterTitle,
  classifyMatterType,
  computeMatterCanonicalKey,
  inferMatterPriority,
  mapContextRoleToMatterRole,
} from './matterTypes.js';
import {
  type CreateMatterEntityInput,
  attachMatterContextLink,
  attachMatterEntity,
  createMatter,
  getMatterById,
  getMatterByCreatedFromContextUnit,
  recordMatterTransition,
  saveMatter,
} from './matterStore.js';
import { type MatterJudge, llmJudge, scoreAndRank } from './matterMatcher.js';

// §6.2：reducer 处理的 kind。其余（event/state/relationship/...）只作辅助证据，不直接动 Matter。
// MVP33 U2：导出给 matterObservationConsumer 做让路判断（这些 kind 的单元已走 reducer hook）。
export const HANDLED_KINDS = new Set(['commitment', 'intent', 'action_result', 'decision', 'uncertainty']);
const PRIMARY_ENTITY_TYPES = new Set(['person', 'project', 'doc', 'task', 'org']);

// §6.5 阈值
const AUTO_APPLY = 0.78; // ≥ 自动改 status
const ATTACH_ONLY = 0.55; // [0.55, 0.78) 只 attach evidence

export type MatterReduceResult = {
  action: 'create' | 'attach' | 'ignore';
  matterId?: string;
  effect?: MatterContextEffect;
  applied: boolean; // 是否真的改了 status
  reason: string;
};

const IGNORE = (reason: string): MatterReduceResult => ({
  action: 'ignore',
  applied: false,
  reason,
});

export type ReduceOptions = {
  now?: number;
  /** 注入判定器（测试用 stub）；默认走 runOneShot('aiisn-matter-reducer')。 */
  judge?: MatterJudge;
};

export async function reduceMatterForContextUnit(
  inputUnit: ContextUnit,
  _changeContext?: ChangeContext,
  opts: ReduceOptions = {}
): Promise<MatterReduceResult> {
  const unit = getContextUnitById(inputUnit.id) ?? inputUnit; // §6.1 rehydrate
  if (!HANDLED_KINDS.has(unit.kind)) return IGNORE(`unhandled kind=${unit.kind}`);

  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const judge = opts.judge ?? llmJudge;

  // 同 unit 已建过 Matter（commitment 再次 upsert）→ 刷新元信息，不重复建。
  const own = getMatterByCreatedFromContextUnit(unit.id);
  if (own) {
    refreshOwnMatter(own, unit, nowIso);
    return { action: 'attach', matterId: own.id, effect: 'no_change', applied: false, reason: 'refreshed own matter' };
  }

  const ranked = scoreAndRank(unit, now);

  if (ranked.length === 0) {
    if (isCreateKind(unit)) {
      const m = createFromUnit(unit, now, nowIso);
      return { action: 'create', matterId: m.id, applied: true, reason: 'no candidate → created' };
    }
    return IGNORE('no candidate, non-create kind');
  }

  // 有候选 → LLM 判定
  let decision: MatterReduceDecision;
  try {
    decision = await judge(unit, ranked.map((r) => r.matter));
  } catch (err) {
    return IGNORE(`judge failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return applyDecision(unit, decision, ranked.map((r) => r.matter), now, nowIso);
}

/**
 * MVP33 U2：观察消费通路（matterObservationConsumer）的入口。调用方自备候选
 * （召回轴 = 实体 ∪ 观察标题相似，与 reducer 的 scoreAndRank 不完全相同），
 * 复用同一个 LLM 判定与同一套保守阈值落地（applyDecision：≥0.78 改状态、
 * 0.55-0.78 只挂证据、guardEffect 守卫不变）。
 * 与 reduceMatterForContextUnit 的差异：观察只作用于既有 Matter——
 * decision.action==='create' 一律降级 ignore（创建语义归 commitment 单元路径，
 * 那条路有 actionability/实体门槛，防观察类噪声开新 Matter）。
 */
export async function reduceUnitWithCandidates(
  unit: ContextUnit,
  candidates: Matter[],
  opts: ReduceOptions = {}
): Promise<MatterReduceResult> {
  if (candidates.length === 0) return IGNORE('no candidates');
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const judge = opts.judge ?? llmJudge;
  let decision: MatterReduceDecision;
  try {
    decision = await judge(unit, candidates);
  } catch (err) {
    return IGNORE(`judge failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (decision.action === 'create') return IGNORE('observation path never creates matters');
  return applyDecision(unit, decision, candidates, now, nowIso);
}

// ---- create 路径 ----

function isCreateKind(unit: ContextUnit): boolean {
  switch (unit.kind) {
    case 'commitment':
      return ['ask', 'act', 'notify'].includes(unit.actionability);
    case 'intent':
      return unit.entities.some((e) => ['person', 'project', 'doc'].includes(e.type));
    case 'uncertainty':
      return unit.actionability !== 'record';
    // action_result / decision 只 attach，不建新 Matter
    default:
      return false;
  }
}

function loadSelfCanonicalId(): string {
  const raw = getSetting('self_person_entity_id');
  if (!raw || !raw.trim()) return '';
  try {
    return resolveAliased(raw.trim());
  } catch {
    return raw.trim();
  }
}

function deriveEntities(unit: ContextUnit): {
  entities: CreateMatterEntityInput[];
  primaryEntityIds: string[];
} {
  const entities: CreateMatterEntityInput[] = [];
  const primaryEntityIds: string[] = [];
  for (const er of listEntitiesForUnit(unit.id)) {
    const ent = getContextEntityById(er.entity_id);
    const type = ent?.type ?? 'person';
    const cid = resolveAliased(er.entity_id);
    entities.push({ entityId: cid, role: mapContextRoleToMatterRole(type, er.role), confidence: er.confidence });
    if (PRIMARY_ENTITY_TYPES.has(type)) primaryEntityIds.push(cid);
  }
  return { entities, primaryEntityIds };
}

function pickPrimarySpaceId(unitId: string): string | null {
  const links = listSpacesForTarget('context_unit', unitId);
  if (links.length === 0) return null;
  links.sort((a, b) => b.confidence - a.confidence);
  return links[0].space_id;
}

function summarize(unit: ContextUnit): string {
  const base = (unit.meaning && unit.meaning.trim()) || unit.content || '';
  const oneLine = base.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? oneLine.slice(0, 199) + '…' : oneLine;
}

function createFromUnit(unit: ContextUnit, now: number, nowIso: string, titleOverride?: string): Matter {
  const { entities, primaryEntityIds } = deriveEntities(unit);
  const selfId = loadSelfCanonicalId();
  const selfRole = computeSelfRoleOnUnit(unit.id, selfId);
  const isWorkMapSeed = classifyContextUnit(unit).source === 'work_map_seed';
  const title = titleOverride?.trim() || canonicalizeMatterTitle(unit.title);
  const type: MatterType =
    unit.kind === 'uncertainty' ? 'blocker' : classifyMatterType({ title: unit.title, content: unit.content });
  const status: MatterStatus = unit.kind === 'uncertainty' ? 'blocked' : 'open';
  return createMatter({
    subjectId: unit.subjectId,
    scope: unit.scope,
    type,
    title,
    canonicalKey: computeMatterCanonicalKey({
      subjectId: unit.subjectId,
      primaryEntityIds,
      actionPhrase: title,
    }),
    status,
    priority: inferMatterPriority({
      dueAt: unit.time?.dueAt ?? null,
      actionability: unit.actionability,
      selfRole,
      isWorkMapSeed,
      now,
    }),
    ownerEntityId: selfRole === 'executor' && selfId ? selfId : null,
    primarySpaceId: pickPrimarySpaceId(unit.id),
    dueAt: unit.time?.dueAt ?? null,
    currentSummary: summarize(unit),
    createdFromContextUnitId: unit.id,
    confidence: unit.confidence,
    entities,
    createdReason: `MVP27 reducer: created from ${unit.kind} ${unit.id}`,
    now: nowIso,
  });
}

// commitment 再次 upsert：刷新 dueAt / title / summary，不动 status / 不写 transition。
function refreshOwnMatter(matter: Matter, unit: ContextUnit, nowIso: string): void {
  const dueAt = unit.time?.dueAt ?? matter.dueAt ?? null;
  const title = canonicalizeMatterTitle(unit.title) || matter.title;
  saveMatter({
    ...matter,
    title,
    dueAt,
    currentSummary: summarize(unit) || matter.currentSummary,
    lastEvidenceContextUnitId: unit.id,
    lastEvidenceAt: nowIso,
    version: matter.version + 1,
    updatedAt: nowIso,
  });
}

// ---- attach / apply 路径 ----

function relationForEffect(effect: MatterContextEffect): MatterContextRelation {
  switch (effect) {
    case 'create':
      return 'created_by';
    case 'progress':
      return 'progressed_by';
    case 'resolve':
      return 'resolved_by';
    case 'block':
      return 'blocked_by';
    case 'reopen':
      return 'reopened_by';
    case 'drop':
      return 'dismissed_by';
    default:
      return 'evidence';
  }
}

function nextStatus(current: MatterStatus, effect: MatterContextEffect): MatterStatus {
  switch (effect) {
    case 'resolve':
      return 'resolved';
    case 'block':
      return 'blocked';
    case 'reopen':
      return 'in_progress';
    case 'progress':
      return current === 'resolved' || current === 'dropped' ? current : 'in_progress';
    default:
      return current;
  }
}

// effect 在当前状态下是否合法（保守 guard）。返回归一后的 effect（可能被降级）。
function guardEffect(matter: Matter, effect: MatterContextEffect): MatterContextEffect {
  if (effect === 'drop') return 'no_change'; // reducer 永不自动 drop
  if (effect === 'reopen') {
    // 仅 resolved 可自动 reopen；dropped 永不；active 则 reopen 无意义
    if (matter.status === 'dropped') return 'no_change';
    if (matter.status !== 'resolved') return 'no_change';
    return 'reopen';
  }
  // dropped 的 Matter 不接受自动状态推进
  if (matter.status === 'dropped') return 'no_change';
  return effect;
}

function applyDecision(
  unit: ContextUnit,
  decision: MatterReduceDecision,
  candidates: Matter[],
  now: number,
  nowIso: string
): MatterReduceResult {
  if (decision.action === 'ignore') return IGNORE(decision.reason || 'judge: ignore');

  if (decision.action === 'create') {
    if (decision.confidence < ATTACH_ONLY) return IGNORE(`create conf<${ATTACH_ONLY}`);
    const m = createFromUnit(unit, now, nowIso, decision.title);
    return { action: 'create', matterId: m.id, applied: true, reason: decision.reason || 'judge: create' };
  }

  // attach
  const matter = candidates.find((c) => c.id === decision.matterId) ?? null;
  if (!matter) return IGNORE(`attach: matterId not in candidates (${decision.matterId})`);
  if (decision.confidence < ATTACH_ONLY) return IGNORE(`attach conf<${ATTACH_ONLY}`);

  const rawEffect = decision.effect ?? 'no_change';
  const effect = guardEffect(matter, rawEffect);
  const changesStatus = effect !== 'no_change' && nextStatus(matter.status, effect) !== matter.status;

  // 中置信（0.55-0.78）：只 attach evidence，不改 status（§6.5）
  if (changesStatus && decision.confidence < AUTO_APPLY) {
    attachMatterContextLink({
      matterId: matter.id,
      contextUnitId: unit.id,
      relation: 'evidence',
      effect: 'no_change',
      confidence: decision.confidence,
      reason: `low-conf ${rawEffect} (${decision.confidence.toFixed(2)}): ${decision.reason}`,
      now: nowIso,
    });
    bumpLastEvidence(matter, unit, nowIso);
    return { action: 'attach', matterId: matter.id, effect: 'no_change', applied: false, reason: 'mid-conf evidence only' };
  }

  // 高置信或 no_change：正常落地
  const relation = relationForEffect(effect);
  attachMatterContextLink({
    matterId: matter.id,
    contextUnitId: unit.id,
    relation,
    effect,
    confidence: decision.confidence,
    reason: decision.reason || effect,
    now: nowIso,
  });
  // 继承新实体，改进后续召回
  for (const er of listEntitiesForUnit(unit.id)) {
    const ent = getContextEntityById(er.entity_id);
    attachMatterEntity({
      matterId: matter.id,
      entityId: resolveAliased(er.entity_id),
      role: mapContextRoleToMatterRole(ent?.type ?? 'person', er.role),
      confidence: er.confidence,
      now: nowIso,
    });
  }

  // 统一落地：summaryPatch / nextAction 在任何 effect（含 no_change，如 decision 更新 summary）下都应用；
  // 只有状态真正改变才写 transition。
  const from = matter.status;
  const to = effect === 'no_change' ? from : nextStatus(from, effect);
  const patched: Matter = {
    ...matter,
    status: to,
    currentSummary: decision.summaryPatch?.trim() ? decision.summaryPatch.trim() : matter.currentSummary,
    nextAction: decision.nextAction !== undefined ? decision.nextAction : matter.nextAction,
    lastEvidenceContextUnitId: unit.id,
    lastEvidenceAt: nowIso,
    version: matter.version + 1,
    updatedAt: nowIso,
    reopenedCount: effect === 'reopen' ? matter.reopenedCount + 1 : matter.reopenedCount,
    resolvedAt: to === 'resolved' ? nowIso : effect === 'reopen' ? null : matter.resolvedAt,
  };
  saveMatter(patched);

  let applied = false;
  if (to !== from) {
    recordMatterTransition({
      matterId: matter.id,
      fromStatus: from,
      toStatus: to,
      triggerContextUnitId: unit.id,
      effect,
      reason: decision.reason || effect,
      confidence: decision.confidence,
      now: nowIso,
    });
    applied = true;
  }
  // §6.7 兼容：action_result → 原 commitment 写 context_links('updates')，喂 workItemInducer。
  if (unit.kind === 'action_result' && effect !== 'no_change') {
    ensureContextLink(unit.id, matter.createdFromContextUnitId, 'updates', nowIso);
  }

  return { action: 'attach', matterId: matter.id, effect, applied, reason: decision.reason || effect };
}

function bumpLastEvidence(matter: Matter, unit: ContextUnit, nowIso: string): void {
  saveMatter({
    ...matter,
    lastEvidenceContextUnitId: unit.id,
    lastEvidenceAt: nowIso,
    updatedAt: nowIso,
  });
}

// §6.7 note：context_links 无唯一约束，兼容写必须先查重。
function ensureContextLink(
  fromId: string,
  toId: string,
  linkType: 'updates' | 'satisfies',
  nowIso: string
): void {
  if (!fromId || !toId || fromId === toId) return;
  const exists = listContextLinksFor(fromId).some(
    (l) => l.from_context_id === fromId && l.to_context_id === toId && l.link_type === linkType
  );
  if (exists) return;
  insertContextLink({
    id: randomUUID(),
    from_context_id: fromId,
    to_context_id: toId,
    link_type: linkType,
    confidence: 0.8,
    created_at: nowIso,
  });
}
