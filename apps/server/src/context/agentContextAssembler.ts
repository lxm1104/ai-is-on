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
  type ContextSpaceLinkRow,
  type ContextSpaceRow,
  type TriggerRow,
  getSetting,
  listSpaceLinks,
  listSpacesForTarget,
} from '../db.js';
import { evaluateCard } from '../boundary/boundaryEvaluator.js';
import type { Priority } from '../boundary/BoundaryRule.js';
import { resolveOrCreateEntity } from './entityResolver.js';

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
  | 'missingInfo';

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

function collectStakeholders(
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
    if (out.length >= cap) return out;
  }
  // 2) focal unit 的 person entities 兜底
  if (focal) {
    for (const e of focal.entities) {
      if (e.type !== 'person') continue;
      if (STAKEHOLDER_NAME_DENY.has(e.name)) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({ name: e.name });
      if (out.length >= cap) return out;
    }
  }
  return out;
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
