/**
 * MVP8.1 §5.3 AgentContextAssembler.
 *
 * 每次 AgentRun 装配一份按 agent registry 声明 slice 构造的 packet：
 * - 复用 activeContext 的 scorer（含 workMapBoost），不再重写排序
 * - 只构造声明过的 slice，避免给纯本地 agent 拼 1500-token 大包
 * - bootstrap_completed_at 未设置时，跳过 subject/spaces/goals/stakeholders
 *
 * packet 本身不持久化；AgentRunQueue 只把摘要 (sliceVersion + materializedSlices
 * topItemIds≤3 + focalUnitId + changeContext) 落 agent_runs.input_json。
 */

import {
  type ChangeContext,
} from './changeContext.js';
import type { ContextUnit, ContextUnitKind } from './ContextUnit.js';
import { getContextUnitById, listActiveContextUnits } from './contextStore.js';
import { scoreContextUnit } from './activeContext.js';
import {
  db,
  type ContextSpaceLinkRow,
  type ContextSpaceRow,
  type TriggerRow,
  getContextEntityById,
  getContextEntityByTypeName,
  getSetting,
  listSpaceLinks,
  listSpacesForTarget,
} from '../db.js';
import { evaluateCard } from '../boundary/boundaryEvaluator.js';
import type { Priority } from '../boundary/BoundaryRule.js';
import { resolveOrCreateEntity } from './entityResolver.js';
import {
  parsePersonAttributesFromRow,
  type OrgRoleFromMe,
  type PersonAttributes,
} from './personAttributes.js';
import { computeOrgRoleFromMe } from './personOrgRole.js';
import {
  assembleGraphContext,
  type GraphContextSlice,
} from './graphContextAssembler.js';
import { buildSelfCollaboratorRanking } from './selfCollaboratorRanking.js';
import { listEntityEdges as listEntityEdgesFromDb } from '../db.js';
import { resolveAliased as resolveAliasedCanonical } from './entityResolver.js';
import {
  computeSelfRolesOnUnits,
  type SelfRoleOnUnit,
} from './selfRoleOnUnit.js';

export type PacketSlice =
  | 'subject'
  | 'focalUnit'
  | 'spaces'
  | 'goals'
  | 'uncertainties'
  | 'relatedContext'
  | 'stakeholders'
  | 'latestActionResult'
  | 'boundary'
  | 'missingInfo'
  // MVP15B §6.3：focal-scoped 图邻域 slice。assembleGraphContext(focalUnitId)
  // 现算，60s in-memory cache。给 commitmentAgent / attention prompt 用。
  | 'graphContext';

export type SpaceInPacket = {
  id: string;
  name: string;
  type: string;
  /** doc §5.5.1: 由 Space 关联的 goal/commitment 推出的运行时优先级。 */
  priority: 'critical' | 'high' | 'normal';
  /** 关联到 Space 的 doc-type entity（含 Work Map 写入的权威文档 url）。 */
  docs: Array<{ id: string; name: string }>;
};

export type StakeholderInPacket = {
  name: string;
  /** relationship ContextUnit 的 meaning，可选。 */
  note?: string;
  // MVP15 §4: 由 larkOrgCollector 写入的 PersonAttributes.orgRoleFromMe 透出，
  // attention prompt 据此调权（external 降一档、cross_dept 倾向 P2）。
  // self 还没拉到飞书数据时返回 undefined（避免冒充判断）。
  orgRole?: OrgRoleFromMe;
  // MVP15 §4 (revision): 解析后的业务 / 职能，供 attention prompt 做更细判断。
  business?: string;
  functionLabel?: string;
};

export type SubjectInPacket = {
  id: 'me';
  roleTitle?: string;
  teamName?: string;
  responsibilities: string[];
  preferences: string[];
};

export type BoundaryInPacket = {
  /** 模拟此次 agent 即将产出的 card 形态，得到的 boundary 决定。 */
  decision: 'allow' | 'soften' | 'block';
  matchedRuleIds: string[];
  reason?: string;
};

export type RecommendedHandling = 'record' | 'notify' | 'ask' | 'draft' | 'act';

export type AgentContextPacket = {
  packetAssemblerVersion: number;
  packetSliceVersion: number;
  materializedSlices: Array<{ name: PacketSlice; itemCount: number; topItemIds: string[] }>;

  agentRunId: string;
  trigger: {
    id: string;
    type: string;
    reasoning: string | null;
    changeContext?: ChangeContext;
  };

  subject?: SubjectInPacket;
  focalUnit?: ContextUnit;
  spaces?: SpaceInPacket[];
  goals?: ContextUnit[];
  uncertainties?: ContextUnit[];
  relatedContext?: ContextUnit[];
  stakeholders?: StakeholderInPacket[];
  latestActionResult?: ContextUnit;
  boundary?: BoundaryInPacket;
  missingInfo?: string[];
  recommendedHandling?: RecommendedHandling;
  // MVP15B §6.3：图邻域 slice，仅当 declared 'graphContext' AND input.unit 非 null 时填
  graphContext?: GraphContextSlice;
};

// 全局版本号：排序/裁剪/token 预算逻辑变化时 ++
export const PACKET_ASSEMBLER_VERSION = 1;

// 每个 slice 默认的硬上限（agent registry 没特别约束时使用）
const SLICE_CAPS: Record<PacketSlice, number> = {
  subject: 1,
  focalUnit: 1,
  spaces: 5,
  goals: 6,
  uncertainties: 6,
  relatedContext: 12,
  stakeholders: 8,
  latestActionResult: 1,
  boundary: 1,
  graphContext: 1,  // MVP15B：一次 agent run 一个 graphContext slice
  missingInfo: 8,
};

const STAKEHOLDER_NAME_DENY = new Set(['me', '我', 'Me']);

export type AssembleInput = {
  agentRunId: string;
  trigger: TriggerRow;
  unit: ContextUnit | null;
  slices: PacketSlice[];
  /** agent 自己声明的 sliceVersion，写入 packet 供下游 audit。 */
  packetSliceVersion: number;
};

export function assembleAgentContextPacket(input: AssembleInput): AgentContextPacket {
  const now = Date.now();
  const declared = new Set(input.slices);
  const bootstrapped = !!getSetting('bootstrap_completed_at');

  const materialized: AgentContextPacket['materializedSlices'] = [];

  // changeContext lives on trigger payload (MVP8.0)
  let cc: ChangeContext | undefined;
  try {
    const payload = JSON.parse(input.trigger.payload_json) as { changeContext?: ChangeContext };
    cc = payload.changeContext;
  } catch {}

  const packet: AgentContextPacket = {
    packetAssemblerVersion: PACKET_ASSEMBLER_VERSION,
    packetSliceVersion: input.packetSliceVersion,
    materializedSlices: materialized,
    agentRunId: input.agentRunId,
    trigger: {
      id: input.trigger.id,
      type: input.trigger.trigger_type,
      reasoning: input.trigger.reasoning,
      changeContext: cc,
    },
  };

  // -------- subject (Work Map only) --------
  if (declared.has('subject') && bootstrapped) {
    const subj = buildSubjectSlice();
    if (subj) {
      packet.subject = subj;
      materialized.push({ name: 'subject', itemCount: 1, topItemIds: ['me'] });
    }
  }

  // -------- focalUnit --------
  if (declared.has('focalUnit') && input.unit) {
    packet.focalUnit = input.unit;
    materialized.push({ name: 'focalUnit', itemCount: 1, topItemIds: [input.unit.id] });
  }

  // -------- spaces (focal unit's entities → spaces) --------
  let spacesForUnit: SpaceInPacket[] = [];
  if (declared.has('spaces') && bootstrapped && input.unit) {
    spacesForUnit = collectSpacesForUnit(input.unit, SLICE_CAPS.spaces);
    if (spacesForUnit.length > 0) {
      packet.spaces = spacesForUnit;
      materialized.push({
        name: 'spaces',
        itemCount: spacesForUnit.length,
        topItemIds: spacesForUnit.slice(0, 3).map((s) => s.id),
      });
    } else {
      materialized.push({ name: 'spaces', itemCount: 0, topItemIds: [] });
    }
  }

  // -------- goals --------
  if (declared.has('goals') && bootstrapped) {
    const goals = collectByKind(['goal'], now, SLICE_CAPS.goals, input.unit, spacesForUnit);
    packet.goals = goals;
    materialized.push({
      name: 'goals',
      itemCount: goals.length,
      topItemIds: goals.slice(0, 3).map((u) => u.id),
    });
  }

  // -------- uncertainties --------
  if (declared.has('uncertainties')) {
    const us = collectByKind(['uncertainty'], now, SLICE_CAPS.uncertainties, input.unit, spacesForUnit);
    packet.uncertainties = us;
    materialized.push({
      name: 'uncertainties',
      itemCount: us.length,
      topItemIds: us.slice(0, 3).map((u) => u.id),
    });
  }

  // -------- relatedContext (entity overlap with focal unit) --------
  if (declared.has('relatedContext') && input.unit) {
    const rel = collectRelatedContext(input.unit, now, SLICE_CAPS.relatedContext);
    packet.relatedContext = rel;
    materialized.push({
      name: 'relatedContext',
      itemCount: rel.length,
      topItemIds: rel.slice(0, 3).map((u) => u.id),
    });
  }

  // -------- stakeholders --------
  if (declared.has('stakeholders') && bootstrapped) {
    const stake = collectStakeholders(input.unit, SLICE_CAPS.stakeholders);
    packet.stakeholders = stake;
    materialized.push({
      name: 'stakeholders',
      itemCount: stake.length,
      topItemIds: stake.slice(0, 3).map((s) => s.name),
    });
  }

  // -------- graphContext (MVP15B §6.3) --------
  // 仅在 declared AND input.unit 非 null 时填；走 graphContextAssembler 现算 + 60s cache
  if (declared.has('graphContext') && input.unit) {
    const gc = assembleGraphContext(input.unit.id, { now });
    if (gc) {
      packet.graphContext = gc;
      // materializedSlices.topItemIds 取 decisionPath 的人名（≤3 已经 cap 过）
      materialized.push({
        name: 'graphContext',
        itemCount:
          gc.decisionPath.length +
          gc.expectedButMissing.persons.length +
          gc.activeBlockers.length +
          (gc.projectPhase ? 1 : 0),
        topItemIds: gc.decisionPath.map((d) => d.name),
      });
    } else {
      materialized.push({ name: 'graphContext', itemCount: 0, topItemIds: [] });
    }
  }

  // -------- latestActionResult (same primary entity as focalUnit) --------
  if (declared.has('latestActionResult') && input.unit) {
    const ar = collectLatestActionResult(input.unit);
    if (ar) {
      packet.latestActionResult = ar;
      materialized.push({
        name: 'latestActionResult',
        itemCount: 1,
        topItemIds: [ar.id],
      });
    } else {
      materialized.push({ name: 'latestActionResult', itemCount: 0, topItemIds: [] });
    }
  }

  // -------- boundary (simulate evaluateCard) --------
  if (declared.has('boundary')) {
    const b = simulateBoundary(input.trigger, input.unit);
    packet.boundary = b;
    materialized.push({
      name: 'boundary',
      itemCount: b.matchedRuleIds.length,
      topItemIds: b.matchedRuleIds.slice(0, 3),
    });
  }

  // -------- missingInfo (focal unit 关键字段缺失) --------
  if (declared.has('missingInfo') && input.unit) {
    const mi = computeMissingInfo(input.unit);
    if (mi.length > 0) {
      packet.missingInfo = mi;
      materialized.push({ name: 'missingInfo', itemCount: mi.length, topItemIds: [] });
    }
  }

  return packet;
}

// --------------------------------------------------------------------------
// builders
// --------------------------------------------------------------------------

function buildSubjectSlice(): SubjectInPacket | null {
  // Work Map 单元筛 mergeKey 前缀，避免命中其他 work-scope context
  const units = listActiveContextUnits({ limit: 500 }).filter(
    (u) => u.scope === 'work' && (u.mergeKey?.startsWith('work_map:') ?? false)
  );
  if (units.length === 0) return null;
  const role = units.find((u) => u.mergeKey === 'work_map:role:self');
  let teamName: string | undefined;
  if (role) {
    const m = role.content.match(/团队[:：]\s*(.+)/);
    if (m) teamName = m[1].trim();
  }
  const responsibilities = units
    .filter((u) => u.mergeKey?.startsWith('work_map:responsibility:'))
    .map((u) => u.title);
  const preferences = units
    .filter((u) => u.mergeKey?.startsWith('work_map:preference:'))
    .map((u) => u.title);
  return {
    id: 'me',
    roleTitle: role?.title.replace(/^我的角色：/, ''),
    teamName,
    responsibilities,
    preferences,
  };
}

function collectSpacesForUnit(unit: ContextUnit, cap: number): SpaceInPacket[] {
  const spaceIds = new Set<string>();
  for (const e of unit.entities ?? []) {
    try {
      const ent = resolveOrCreateEntity(e.type, e.name);
      const links = listSpacesForTarget('entity', ent.id);
      for (const l of links) spaceIds.add(l.space_id);
    } catch {}
  }
  if (spaceIds.size === 0) return [];

  const out: SpaceInPacket[] = [];
  // 拉每个 space 的元信息和关联 doc / 关联 unit
  for (const spaceId of spaceIds) {
    const space = getContextSpaceById(spaceId);
    if (!space) continue;
    const links = listSpaceLinks(spaceId);
    const priority = computeSpacePriority(links);
    const docs = collectSpaceDocs(links);
    out.push({
      id: space.id,
      name: space.name,
      type: space.type,
      priority,
      docs,
    });
  }
  out.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  return out.slice(0, cap);
}

function priorityRank(p: SpaceInPacket['priority']): number {
  return p === 'critical' ? 0 : p === 'high' ? 1 : 2;
}

import { getContextSpace } from '../db.js';
function getContextSpaceById(id: string): ContextSpaceRow | null {
  return getContextSpace(id);
}

/**
 * Doc §5.5.1：Space 优先级 = 关联 goal/commitment 的"最高紧迫性"。
 * - 任一 active commitment dueAt ≤ 24h → 'critical'
 * - 关联 ≥1 active goal 或 commitment（无 dueAt 限制） → 'high'
 * - 否则 → 'normal'
 */
export function computeSpacePriority(
  links: ContextSpaceLinkRow[],
  now: number = Date.now()
): SpaceInPacket['priority'] {
  let hasGoalOrCommit = false;
  let hasCritical = false;
  for (const l of links) {
    if (l.target_type !== 'context_unit') continue;
    const u = getContextUnitById(l.target_id);
    if (!u || u.status !== 'active') continue;
    if (u.kind === 'goal' || u.kind === 'commitment') {
      hasGoalOrCommit = true;
      const due = u.time?.dueAt;
      if (u.kind === 'commitment' && due) {
        const t = new Date(due).getTime();
        if (Number.isFinite(t) && t - now <= 24 * 3600_000) {
          hasCritical = true;
        }
      }
    }
  }
  if (hasCritical) return 'critical';
  if (hasGoalOrCommit) return 'high';
  return 'normal';
}

function collectSpaceDocs(links: ContextSpaceLinkRow[]): Array<{ id: string; name: string }> {
  const docs: Array<{ id: string; name: string }> = [];
  for (const l of links) {
    if (l.target_type !== 'entity') continue;
    const ent = resolveEntityById(l.target_id);
    if (ent && ent.type === 'doc') docs.push({ id: ent.id, name: ent.name });
  }
  return docs.slice(0, 8);
}

function resolveEntityById(id: string) {
  // 这里没必要导入完整 entityResolver；db.listContextEntities 也有 helper，但用稍轻量的 prepared 直查。
  // 复用 contextStore 内已有的 listContextEntities path 简洁起见就 OK，量级不大。
  // 但 entityResolver 已经有 listContextEntities 包装，这里我直接 inline：
  return listAllEntitiesById().get(id) ?? null;
}

let _entityCache: Map<string, { id: string; type: string; name: string }> | null = null;
let _entityCacheAt = 0;
const ENTITY_CACHE_TTL_MS = 5_000;
function listAllEntitiesById() {
  const now = Date.now();
  if (_entityCache && now - _entityCacheAt < ENTITY_CACHE_TTL_MS) return _entityCache;
  // import 在顶部已经加载，避免循环
  const all = listContextEntitiesAll();
  const m = new Map<string, { id: string; type: string; name: string }>();
  for (const e of all) m.set(e.id, { id: e.id, type: e.type, name: e.name });
  _entityCache = m;
  _entityCacheAt = now;
  return m;
}
import { listContextEntities } from '../db.js';
function listContextEntitiesAll() {
  return listContextEntities(5000);
}

function collectByKind(
  kinds: ContextUnitKind[],
  now: number,
  cap: number,
  focal: ContextUnit | null,
  spaces: SpaceInPacket[]
): ContextUnit[] {
  const focalEntityKey = focal
    ? new Set(focal.entities.map((e) => `${e.type}|${e.name}`))
    : new Set<string>();
  const spaceNameKey = new Set(spaces.map((s) => `${s.type}|${s.name}`));

  const rows = listActiveContextUnits({ limit: 200 });
  const scored = rows
    .filter((u) => kinds.includes(u.kind))
    .map((u) => {
      let s = scoreContextUnit(u, now);
      // overlap bonus
      const overlapWithFocal = u.entities.some((e) => focalEntityKey.has(`${e.type}|${e.name}`));
      if (overlapWithFocal) s += 0.4;
      const overlapWithSpace = u.entities.some((e) => spaceNameKey.has(`${e.type}|${e.name}`));
      if (overlapWithSpace) s += 0.3;
      return { u, s };
    })
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, cap).map((x) => x.u);
}

function collectRelatedContext(focal: ContextUnit, now: number, cap: number): ContextUnit[] {
  const focalKey = new Set(focal.entities.map((e) => `${e.type}|${e.name}`));
  if (focalKey.size === 0) return [];
  const rows = listActiveContextUnits({ limit: 300 });
  const scored = rows
    .filter((u) => u.id !== focal.id)
    .map((u) => {
      const overlap = u.entities.some((e) => focalKey.has(`${e.type}|${e.name}`));
      if (!overlap) return null;
      const s = scoreContextUnit(u, now) + 0.5;
      return { u, s };
    })
    .filter((x): x is { u: ContextUnit; s: number } => x !== null)
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, cap).map((x) => x.u);
}

export function collectStakeholders(
  focal: ContextUnit | null,
  cap: number
): StakeholderInPacket[] {
  // 1) Work Map relationship units（高权威）
  const wm = listActiveContextUnits({ limit: 200 }).filter(
    (u) =>
      u.scope === 'work' &&
      u.kind === 'relationship' &&
      (u.mergeKey?.startsWith('work_map:relationship:') ?? false)
  );
  const seen = new Set<string>();
  const out: StakeholderInPacket[] = [];
  for (const u of wm) {
    const personEntity = u.entities.find((e) => e.type === 'person');
    if (!personEntity) continue;
    if (STAKEHOLDER_NAME_DENY.has(personEntity.name)) continue;
    if (seen.has(personEntity.name)) continue;
    seen.add(personEntity.name);
    out.push({ name: personEntity.name, note: u.meaning });
    if (out.length >= cap) break;
  }
  // 2) focal unit 的 person entities 兜底
  if (out.length < cap && focal) {
    for (const e of focal.entities) {
      if (e.type !== 'person') continue;
      if (STAKEHOLDER_NAME_DENY.has(e.name)) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({ name: e.name });
      if (out.length >= cap) break;
    }
  }
  // 3) MVP15 §4: 给每个 stakeholder 推断 orgRoleFromMe。
  // self attrs 在本次调用内复用一份；失败时 orgRole 留空——不冒充。
  enrichStakeholdersWithOrgRole(out);
  return out;
}

function enrichStakeholdersWithOrgRole(items: StakeholderInPacket[]): void {
  if (items.length === 0) return;
  const self = getSelfPersonAttributesCached();
  for (const item of items) {
    const target = findPersonAttributesByName(item.name);
    if (!target) continue;
    const role = computeOrgRoleFromMe(self, target);
    if (role) item.orgRole = role;
    if (target.larkDeptBusiness) item.business = target.larkDeptBusiness;
    if (target.larkDeptFunctionLabel) item.functionLabel = target.larkDeptFunctionLabel;
  }
}

// ----------------------------------------------------------------------------
// MVP15 §4: self / target PersonAttributes 解析（agentContextAssembler 内部专用）
// ----------------------------------------------------------------------------
const SELF_ENTITY_SETTING_KEY = 'self_person_entity_id';
const SELF_ATTRS_CACHE_TTL_MS = 60_000;
let _selfAttrsCache: { attrs: PersonAttributes | null; cachedAt: number } | null = null;

function getSelfPersonAttributesCached(): PersonAttributes | null {
  const now = Date.now();
  if (_selfAttrsCache && now - _selfAttrsCache.cachedAt < SELF_ATTRS_CACHE_TTL_MS) {
    return _selfAttrsCache.attrs;
  }
  const id = getSetting(SELF_ENTITY_SETTING_KEY);
  let attrs: PersonAttributes | null = null;
  if (id) {
    const row = getContextEntityById(id);
    if (row) attrs = parsePersonAttributesFromRow(row);
  }
  _selfAttrsCache = { attrs, cachedAt: now };
  return attrs;
}

/**
 * 按 entity.name 反查 person attributes。focal-unit / work_map relationship 把人名作为
 * entity 名（也是当前 stakeholder slice 的标识），匹配 type='person' AND name=...。
 * resolveAliased 不再加，因为 attributes 总写在 canonical id 上、collectStakeholders
 * 已通过 name 去重。
 */
function findPersonAttributesByName(name: string): PersonAttributes | null {
  const row = getContextEntityByTypeName('person', name);
  if (!row) return null;
  return parsePersonAttributesFromRow(row);
}

function collectLatestActionResult(focal: ContextUnit): ContextUnit | null {
  const focalKey = new Set(focal.entities.map((e) => `${e.type}|${e.name}`));
  const rows = listActiveContextUnits({ limit: 200 }).filter(
    (u) => u.kind === 'action_result' && u.id !== focal.id
  );
  // 与 focal 同实体集 + 时间新的优先
  const candidates = rows
    .filter((u) => u.entities.some((e) => focalKey.has(`${e.type}|${e.name}`)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return candidates[0] ?? null;
}

function simulateBoundary(trigger: TriggerRow, unit: ContextUnit | null): BoundaryInPacket {
  // 模拟"假设 agent 即将产出一张 priority=P1, source=agent 的卡片"，让 evaluator 给个意见
  // 真实 cardsService 在落卡时还会再过一遍。
  const decision = evaluateCard({
    priority: 'P1',
    source: 'agent',
    scope: 'work',
    kind: unit?.kind,
    triggerType: trigger.trigger_type as never,
    entities: unit?.entities.map((e) => ({ type: e.type, name: e.name })) ?? [],
  });
  return {
    decision: decision.decision,
    matchedRuleIds: decision.decision === 'allow' ? [] : [decision.matchedRule.id],
    reason: decision.decision === 'allow' ? undefined : decision.reason,
  };
}

function computeMissingInfo(u: ContextUnit): string[] {
  const out: string[] = [];
  if (u.kind === 'commitment' && !u.time?.dueAt) out.push('commitment 缺少 dueAt');
  if (u.kind === 'event' && !u.time?.startsAt && !u.time?.occurredAt) {
    out.push('event 缺少 startsAt/occurredAt');
  }
  if (!u.meaning) out.push('meaning 缺失');
  if (u.confidence < 0.5) out.push('confidence < 0.5');
  if (u.entities.length === 0) out.push('没有任何关联实体');
  return out;
}

// --------------------------------------------------------------------------
// handlingPolicy（doc §5.4 简化版）
// --------------------------------------------------------------------------

/**
 * MVP8.1 §5.4：agent 侧推荐 handling。
 * 简单规则版（后续可换 LLM）：
 *   - latestActionResult 命中 → 'record'（commitment 已完成只记录）
 *   - missingInfo 不空且包含 'commitment 缺少 dueAt' / 类似关键缺口 → 'ask'
 *   - changeContext.changedFields 含 time.dueAt / actionability → 'notify'
 *   - spaces 中存在 critical / high → 'notify'
 *   - boundary.decision = 'soften' → 'record'
 *   - default → 'notify'
 */
export function recommendHandling(p: AgentContextPacket): {
  handling: RecommendedHandling;
  reason: string;
} {
  if (p.latestActionResult) {
    return { handling: 'record', reason: 'latestActionResult 已存在，无需重复提醒' };
  }
  if (p.boundary?.decision === 'soften') {
    return { handling: 'record', reason: 'boundary 规则推 digest' };
  }
  if (p.missingInfo?.some((m) => m.includes('缺少'))) {
    return { handling: 'ask', reason: '关键字段缺失，建议向用户确认' };
  }
  const urgent =
    p.trigger.changeContext?.changedFields.includes('time.dueAt') ||
    p.trigger.changeContext?.changedFields.includes('actionability');
  if (urgent) return { handling: 'notify', reason: '关键字段变更' };
  const hasCritical = p.spaces?.some((s) => s.priority === 'critical');
  if (hasCritical) return { handling: 'notify', reason: '关联 Space 有临近 deadline' };
  return { handling: 'notify', reason: 'default' };
}

// --------------------------------------------------------------------------
// MVP14 Step 1: Global packet for Attention Engine
//
// 与 assembleAgentContextPacket 的差别：
// - 不针对单个 focalUnit；面向 "用户全局视图"
// - 不需要 trigger / agentRunId；由 attentionEngine 自己分配
// - 复用同一批 helper（scoreContextUnit / collectStakeholders / computeSpacePriority）
// - 输出 inputHash，attentionEngine 用它做 cache / supersede
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { getCurrentWorkMap } from '../bootstrap/workMapService.js';
import { listActiveBoundaryRules } from '../boundary/boundaryStore.js';
import type { BoundaryRule } from '../boundary/BoundaryRule.js';
import {
  type AttentionInteraction,
  listRecentAttentionInteractions,
} from '../attention/attentionInteractions.js';
import { listRecentAgentProposalCards } from '../db.js';

export type GlobalSpaceInPacket = SpaceInPacket & {
  /** 关联到该 Space 的 active commitment 标题（去重，cap 5） */
  commitmentTitles: string[];
  /** 关联到该 Space 的 active goal 标题（cap 3） */
  goalTitles: string[];
};

export type GlobalBoundaryRuleInPacket = {
  id: string;
  description: string;       // condition_json 渲染成一行
  allowedAction: string;
  autonomy: string;
  scope: string;
};

/**
 * MVP14 Step3.5：专项 agent（commitment / prepareMeeting / recapActionItems / caring / dailyDigest / syncDraft）
 * 的卡片提案。attention engine 把它们当作高质量"候选信号"输入，由 LLM 全局综合：
 * - 已被其他信号覆盖的 → 忽略
 * - 跟 packet 内其他信号能合并的 → 综合成一条 attention item
 * - 独立且有价值的 → 直接采纳为 attention item
 */
export type AgentProposalInPacket = {
  id: string;
  agentType: string;             // e.g. 'prepare_meeting', 'track_commitment'
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  title: string;
  summary: string;
  suggestedAction?: string;
  createdAt: string;
};

/**
 * MVP15B §6.3：my top collaborators —— global 视角的协作圈摘要。
 * 来自 SelfCollaboratorRanking + entity_edges.collab_type 字段拼装。
 * 跟 stakeholders 区别：stakeholders 是 focal-related ad-hoc，my collaborators 是 weight-sorted global。
 */
export type MyTopCollaboratorInPacket = {
  name: string;
  weight: number;
  orgRole?: OrgRoleFromMe;
  business?: string;
  functionLabel?: string;
  sharedProjectCanonicalNames: string[];
  collabType?: 'collab' | 'reviewer_author' | 'cross_team' | 'mentor';
  decisionRoleHint?: 'co_owner' | 'reviewer' | 'contributor' | 'observer';
};

/**
 * MVP20 §3.1：commitment 在 GlobalContextPacket 里多挂一个派生字段 `selfRoleOnUnit`，
 * 回答"self 对这一条具体 commitment 是什么角色"。计算见 selfRoleOnUnit.ts。
 * 不污染核心 ContextUnit 类型，packet 层独立扩展。
 */
export type CommitmentInPacket = ContextUnit & {
  selfRoleOnUnit?: SelfRoleOnUnit | null;
};

export type GlobalContextPacket = {
  packetAssemblerVersion: number;
  generatedAt: string;
  bootstrapped: boolean;
  subject: SubjectInPacket | null;
  spaces: GlobalSpaceInPacket[];
  goals: ContextUnit[];
  commitments: CommitmentInPacket[];
  uncertainties: ContextUnit[];
  recentEvents: ContextUnit[];
  topActive: ContextUnit[];
  stakeholders: StakeholderInPacket[];
  // MVP15B §6.3：协作圈 top 12 by weight，含 collab_type / decisionRoleHint / business 等
  myTopCollaborators: MyTopCollaboratorInPacket[];
  preferences: string[];
  boundaryRules: GlobalBoundaryRuleInPacket[];
  attentionInteractions: AttentionInteraction[];
  agentProposals: AgentProposalInPacket[];     // MVP14 Step3.5
  tokenEstimate: number;
  /** 稳定的 input 摘要 hash，attentionEngine 用它做 idempotency cache */
  inputHash: string;
};

const GLOBAL_SLICE_CAPS = {
  spaces: 8,
  goals: 6,
  commitments: 10,
  uncertainties: 6,
  recentEvents: 20,
  topActive: 15,
  // MVP15 §4 (revision): 8 → 12。每行带 orgRole + biz + fn ~50 token，12 行 ~600 token，
  // 仍在 packet 整体预算内。给 attention 看到更多协作者，特别是 same_business_cross_function 的同事。
  stakeholders: 12,
  // MVP15B §6.3：每行 ~50 tokens，12 行 ~600 token。跟 stakeholders 平齐。
  myTopCollaborators: 12,
  preferences: 10,
  boundaryRules: 10,
  attentionInteractions: 20,
  agentProposals: 12,
} as const;

const GLOBAL_RECENT_EVENT_WINDOW_MS = 24 * 3600_000;
const AGENT_PROPOSAL_WINDOW_MS = 24 * 3600_000;
const ATTENTION_INTERACTION_WINDOW_MS = 7 * 24 * 3600_000;

export type AssembleGlobalInput = {
  now?: number;
  recentEventWindowMs?: number;
  budgetTokens?: number;
};

export function assembleGlobalContextPacket(
  opts: AssembleGlobalInput = {}
): GlobalContextPacket {
  const now = opts.now ?? Date.now();
  const recentWindow = opts.recentEventWindowMs ?? GLOBAL_RECENT_EVENT_WINDOW_MS;
  const bootstrapped = !!getSetting('bootstrap_completed_at');

  // -------- 1) 用 workMapService 拿结构化骨干 --------
  const wm = getCurrentWorkMap();
  const subject: SubjectInPacket | null = bootstrapped
    ? buildSubjectSlice()
    : null;

  // -------- 2) 拉一次活跃 units 做分桶 --------
  const allActive = listActiveContextUnits({ limit: 500 });

  // commitments：取全部 kind='commitment' 而非仅 workMap 内的，按 score+due 排
  const commitmentsRaw = allActive
    .filter((u) => u.kind === 'commitment')
    .map((u) => ({ u, s: scoreContextUnit(u, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, GLOBAL_SLICE_CAPS.commitments)
    .map((x) => x.u);

  // MVP20 §M3: 给每条 commitment 派生 selfRoleOnUnit（self 在这条 unit 上的角色）。
  // 复用 buildMyTopCollaboratorsSlice 的 self 解析模式。selfCanonical='' 时
  // computeSelfRolesOnUnits 仍可走 B 路（name='我'）兜底。
  const selfRow = db
    .prepare(`SELECT value FROM settings WHERE key='self_person_entity_id'`)
    .get() as { value: string } | undefined;
  const selfCanonicalForRoles = selfRow?.value
    ? resolveAliasedCanonical(selfRow.value)
    : '';
  const selfRoles = computeSelfRolesOnUnits(
    commitmentsRaw.map((u) => u.id),
    selfCanonicalForRoles
  );
  const commitments: CommitmentInPacket[] = commitmentsRaw.map((u) => ({
    ...u,
    selfRoleOnUnit: selfRoles.get(u.id) ?? null,
  }));

  const goals = allActive
    .filter((u) => u.kind === 'goal')
    .map((u) => ({ u, s: scoreContextUnit(u, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, GLOBAL_SLICE_CAPS.goals)
    .map((x) => x.u);

  const uncertainties = allActive
    .filter((u) => u.kind === 'uncertainty')
    .map((u) => ({ u, s: scoreContextUnit(u, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, GLOBAL_SLICE_CAPS.uncertainties)
    .map((x) => x.u);

  const recentEvents = allActive
    .filter((u) => u.kind === 'event')
    .filter((u) => {
      const t = new Date(u.updatedAt).getTime();
      return Number.isFinite(t) && now - t <= recentWindow;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, GLOBAL_SLICE_CAPS.recentEvents);

  // topActive：非以上 kind 的高分活跃 unit
  const PRIMARY_KINDS = new Set<ContextUnit['kind']>([
    'commitment',
    'goal',
    'uncertainty',
    'event',
  ]);
  const topActive = allActive
    .filter((u) => !PRIMARY_KINDS.has(u.kind))
    .map((u) => ({ u, s: scoreContextUnit(u, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, GLOBAL_SLICE_CAPS.topActive)
    .map((x) => x.u);

  // -------- 3) Spaces：复用 workMap 列出的项目 spaces + 优先级/承诺/目标 --------
  const spaces: GlobalSpaceInPacket[] = [];
  for (const s of wm.spaces.slice(0, GLOBAL_SLICE_CAPS.spaces)) {
    const links = listSpaceLinks(s.id);
    const priority = computeSpacePriority(links, now);
    const docs = collectSpaceDocs(links);
    const commitmentTitles: string[] = [];
    const goalTitles: string[] = [];
    for (const l of links) {
      if (l.target_type !== 'context_unit') continue;
      const u = getContextUnitById(l.target_id);
      if (!u || u.status !== 'active') continue;
      if (u.kind === 'commitment' && commitmentTitles.length < 5) {
        commitmentTitles.push(u.title);
      } else if (u.kind === 'goal' && goalTitles.length < 3) {
        goalTitles.push(u.title);
      }
    }
    spaces.push({
      id: s.id,
      name: s.name,
      type: 'project',
      priority,
      docs,
      commitmentTitles,
      goalTitles,
    });
  }
  spaces.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

  // -------- 4) Stakeholders（focal=null，纯走 work_map relationships） --------
  const stakeholders = collectStakeholders(null, GLOBAL_SLICE_CAPS.stakeholders);

  // -------- 4.5) myTopCollaborators (MVP15B §6.3) ------------------------
  // 跟 stakeholders 区别：stakeholders 来自 work_map:relationship: 单元（用户手动登记），
  // myTopCollaborators 来自 SelfCollaboratorRanking（cooccurrence + work_map 兜底，weight 排序）。
  // 两者都有用，attention prompt 分块消费。
  const myTopCollaborators = buildMyTopCollaboratorsSlice(
    GLOBAL_SLICE_CAPS.myTopCollaborators,
    now
  );

  // -------- 5) Preferences：直接拿 workMap 的 title --------
  const preferences = wm.preferences
    .map((u) => u.title)
    .slice(0, GLOBAL_SLICE_CAPS.preferences);

  // -------- 6) Boundary rules：取全部 active，渲染一行人话 --------
  const boundaryRules = listActiveBoundaryRules()
    .slice(0, GLOBAL_SLICE_CAPS.boundaryRules)
    .map((r): GlobalBoundaryRuleInPacket => ({
      id: r.id,
      description: describeBoundaryRule(r),
      allowedAction: r.allowedAction,
      autonomy: r.autonomy,
      scope: r.scope,
    }));

  // -------- 6.25) Attention interactions：用户刚刚如何处理过旧提醒 --------
  const attentionInteractions = listRecentAttentionInteractions({
    sinceIso: new Date(now - ATTENTION_INTERACTION_WINDOW_MS).toISOString(),
    limit: GLOBAL_SLICE_CAPS.attentionInteractions,
  });

  // -------- 6.5) Agent proposals：近 24h 专项 agent 写的待处理卡 --------
  const agentProposals: AgentProposalInPacket[] = listRecentAgentProposalCards(
    AGENT_PROPOSAL_WINDOW_MS,
    GLOBAL_SLICE_CAPS.agentProposals
  ).map((c) => ({
    id: c.id,
    // 旧 cards.source_kind 没拆 agentType 列；从 source_ref_id 或 reason 反推太弱，
    // 这里就用 c.source 来标识（专项 agent 写卡时 source='agent'，未来可扩展专门列）。
    agentType: c.source ?? 'agent',
    priority: c.priority as AgentProposalInPacket['priority'],
    title: c.title,
    summary: c.summary,
    suggestedAction: c.suggested_action ?? undefined,
    createdAt: c.created_at,
  }));

  // -------- 7) tokenEstimate 粗估（仅供调试，不参与 hash） --------
  const tokenEstimate = estimateGlobalPacketTokens({
    subject,
    spaces,
    goals,
    commitments,
    uncertainties,
    recentEvents,
    topActive,
    stakeholders,
    preferences,
    boundaryRules,
    attentionInteractions,
    agentProposals,
  });

  // -------- 8) inputHash --------
  // 设计：稳定地反映 "本次 input 与上次相比是否实质变化"。
  // 不放 generatedAt / tokenEstimate / score；放每个 unit 的 (id, updatedAt) 与
  // boundary 的 condition 描述、preferences 文本、stakeholders 名字。
  const hashSeed = {
    bootstrapped,
    subject: subject
      ? {
          role: subject.roleTitle ?? '',
          team: subject.teamName ?? '',
          resp: [...subject.responsibilities].sort(),
          pref: [...subject.preferences].sort(),
        }
      : null,
    spaces: spaces
      .map((s) => ({
        id: s.id,
        priority: s.priority,
        commitmentTitles: [...s.commitmentTitles].sort(),
        goalTitles: [...s.goalTitles].sort(),
        docs: [...s.docs.map((d) => d.id)].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    goals: unitFingerprints(goals),
    commitments: unitFingerprints(commitments),
    uncertainties: unitFingerprints(uncertainties),
    recentEvents: unitFingerprints(recentEvents),
    topActive: unitFingerprints(topActive),
    stakeholders: stakeholders.map((s) => s.name).sort(),
    preferences: [...preferences].sort(),
    boundaryRules: boundaryRules
      .map((r) => ({ id: r.id, d: r.description, a: r.allowedAction }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    attentionInteractions: attentionInteractions
      .map((i) => ({
        id: i.attentionId,
        action: i.action,
        title: i.title,
        signals: [...i.signalIds].sort(),
        createdAt: i.createdAt,
      }))
      .sort((a, b) => `${a.createdAt}:${a.id}`.localeCompare(`${b.createdAt}:${b.id}`)),
    agentProposals: agentProposals
      .map((p) => ({ id: p.id, p: p.priority, t: p.title }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const inputHash = createHash('sha1')
    .update(JSON.stringify(hashSeed))
    .digest('hex');

  return {
    packetAssemblerVersion: PACKET_ASSEMBLER_VERSION,
    generatedAt: new Date(now).toISOString(),
    bootstrapped,
    subject,
    spaces,
    goals,
    commitments,
    uncertainties,
    recentEvents,
    topActive,
    stakeholders,
    myTopCollaborators,
    preferences,
    boundaryRules,
    attentionInteractions,
    agentProposals,
    tokenEstimate,
    inputHash,
  };
}

// ---------------------------------------------------------------------------
// MVP15B §6.3：buildMyTopCollaboratorsSlice
// ---------------------------------------------------------------------------
// SelfCollaboratorRanking 已经把 weight / orgRole / business / fn / sharedProjects /
// decisionRoleHint 算好，这里只补 collab_type（M4 LLM 写的字段，在 entity_edges 上）。
function buildMyTopCollaboratorsSlice(
  cap: number,
  now: number
): MyTopCollaboratorInPacket[] {
  const ranking = buildSelfCollaboratorRanking({ limit: cap, now });
  if (ranking.length === 0) return [];

  // self id 用来匹配 entity_edges 的 from/to（person_person 表里 from < to）
  const selfRow = db
    .prepare(`SELECT value FROM settings WHERE key='self_person_entity_id'`)
    .get() as { value: string } | undefined;
  const selfId = selfRow?.value ? resolveAliasedCanonical(selfRow.value) : null;

  return ranking.map((entry): MyTopCollaboratorInPacket => {
    let collabType: MyTopCollaboratorInPacket['collabType'];
    if (selfId) {
      const from = selfId < entry.personEntityId ? selfId : entry.personEntityId;
      const to = selfId < entry.personEntityId ? entry.personEntityId : selfId;
      const edges = listEntityEdgesFromDb({
        kind: 'person_person',
        fromId: from,
        toId: to,
        limit: 1,
      });
      const ct = edges[0]?.collab_type;
      if (
        ct === 'collab' ||
        ct === 'reviewer_author' ||
        ct === 'cross_team' ||
        ct === 'mentor'
      ) {
        collabType = ct;
      }
    }
    return {
      name: entry.name,
      weight: entry.weight,
      orgRole: entry.orgRole,
      business: entry.business,
      functionLabel: entry.functionLabel,
      sharedProjectCanonicalNames: entry.sharedProjectCanonicalNames,
      collabType,
      decisionRoleHint: entry.decisionRoleHint ?? undefined,
    };
  });
}

// --------------------------------------------------------------------------
// helpers for global packet
// --------------------------------------------------------------------------

function unitFingerprints(
  us: ContextUnit[]
): Array<{ id: string; u: string }> {
  return us
    .map((u) => ({ id: u.id, u: u.updatedAt }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function estimateGlobalPacketTokens(input: {
  subject: SubjectInPacket | null;
  spaces: GlobalSpaceInPacket[];
  goals: ContextUnit[];
  commitments: ContextUnit[];
  uncertainties: ContextUnit[];
  recentEvents: ContextUnit[];
  topActive: ContextUnit[];
  stakeholders: StakeholderInPacket[];
  preferences: string[];
  boundaryRules: GlobalBoundaryRuleInPacket[];
  attentionInteractions: AttentionInteraction[];
  agentProposals: AgentProposalInPacket[];
}): number {
  let chars = 0;
  if (input.subject) {
    chars += (input.subject.roleTitle?.length ?? 0) +
      (input.subject.teamName?.length ?? 0) +
      input.subject.responsibilities.reduce((a, s) => a + s.length, 0) +
      input.subject.preferences.reduce((a, s) => a + s.length, 0);
  }
  for (const s of input.spaces) {
    chars += s.name.length +
      s.commitmentTitles.reduce((a, t) => a + t.length, 0) +
      s.goalTitles.reduce((a, t) => a + t.length, 0);
  }
  const unitChars = (u: ContextUnit) =>
    (u.title?.length ?? 0) + (u.content?.length ?? 0) / 2;
  for (const u of [
    ...input.goals,
    ...input.commitments,
    ...input.uncertainties,
    ...input.recentEvents,
    ...input.topActive,
  ]) {
    chars += unitChars(u);
  }
  chars += input.stakeholders.reduce((a, s) => a + s.name.length, 0);
  chars += input.preferences.reduce((a, s) => a + s.length, 0);
  chars += input.boundaryRules.reduce((a, r) => a + r.description.length, 0);
  chars += input.attentionInteractions.reduce(
    (a, i) => a + i.title.length + i.signalIds.reduce((sum, s) => sum + s.length, 0),
    0
  );
  chars += input.agentProposals.reduce(
    (a, p) => a + p.title.length + (p.summary?.length ?? 0) / 2,
    0
  );
  // 中文 ≈ 2 chars/token
  return Math.ceil(chars / 2);
}

/**
 * 把 BoundaryRule.condition 渲染成一行人话，给 LLM 当 hint。
 * Evaluator 真正过的还是结构化 condition，这里只是文本摘要。
 */
function describeBoundaryRule(r: BoundaryRule): string {
  const c = r.condition;
  const parts: string[] = [];
  if (c.source?.length) parts.push(`来源=${c.source.join('|')}`);
  if (c.triggerType?.length) parts.push(`触发=${c.triggerType.join('|')}`);
  if (c.priorityAtMost) parts.push(`P≤${c.priorityAtMost}`);
  if (c.scope?.length) parts.push(`scope=${c.scope.join('|')}`);
  if (c.kind?.length) parts.push(`kind=${c.kind.join('|')}`);
  if (c.entityRef) {
    parts.push(
      `entity=${c.entityRef.type}${c.entityRef.nameLike ? `:${c.entityRef.nameLike}` : ''}`
    );
  }
  const head = parts.length > 0 ? parts.join(' & ') : '<空条件>';
  return `${head} → ${r.allowedAction}（${r.autonomy}）`;
}
