/**
 * MVP26 §11.1 — 从 active commitment ContextUnit seed 初始 Matter。
 *
 * 行为：每条 active `ContextUnit(kind='commitment')`，若还没 seed 过 Matter
 * （按 matters.created_from_context_unit_id 幂等），就创建一个 status='open' 的 Matter，
 * 关联 created_by 证据 + 继承 entities + 推断 type/priority/dueAt/primary_space。
 *
 * 只新增可观察状态，不改 attention / trigger / triage 行为（MVP26 验收）。
 *
 * 默认 dry-run：只打印将创建的 Matter，不写库。必须显式传 --confirm 才执行。
 *
 * 用法：
 *   # 1) 先看影响范围
 *   $ npx tsx apps/server/scripts/mvp26-backfill-matters.ts
 *
 *   # 2) 确认无误后执行
 *   $ npx tsx apps/server/scripts/mvp26-backfill-matters.ts --confirm
 *
 *   # 回滚（手工 SQL；删除本次 seed 的 Matter 及其关联）
 *   $ sqlite3 data/ai-is-on.sqlite "DELETE FROM matter_transitions WHERE matter_id IN \
 *       (SELECT id FROM matters WHERE current_summary LIKE '%' );"  -- 谨慎，建议先 SELECT 核对
 *
 * 幂等：重跑只处理「尚未 seed Matter」的 commitment；已有 created_from 链接的不重复创建。
 */
import {
  type ContextUnitEntityRow,
  getContextEntityById,
  getSetting,
  listContextUnits,
  listEntitiesForUnit,
  listSpacesForTarget,
} from '../src/db.js';
import { getContextUnitById } from '../src/context/contextStore.js';
import { classifyContextUnit } from '../src/context/layerClassifier.js';
import { computeSelfRoleOnUnit, type SelfRoleOnUnit } from '../src/context/selfRoleOnUnit.js';
import { resolveAliased } from '../src/context/entityResolver.js';
import {
  createMatter,
  getMatterByCreatedFromContextUnit,
  type CreateMatterEntityInput,
} from '../src/matter/matterStore.js';
import {
  type MatterPriority,
  type MatterScope,
  type MatterType,
  canonicalizeMatterTitle,
  classifyMatterType,
  computeMatterCanonicalKey,
  inferMatterPriority,
  mapContextRoleToMatterRole,
} from '../src/matter/matterTypes.js';

const SELF_ENTITY_SETTING_KEY = 'self_person_entity_id';
// 进入 canonical_key 的"主对象" entity 类型（排除 chat/app 这类 routing 容器）。
const PRIMARY_ENTITY_TYPES = new Set(['person', 'project', 'doc', 'task', 'org']);
const SUMMARY_MAX = 200;

type Plan = {
  unitId: string;
  title: string;
  type: MatterType;
  status: 'open';
  priority: MatterPriority;
  scope: MatterScope;
  dueAt: string | null;
  canonicalKey: string;
  ownerEntityId: string | null;
  primarySpaceId: string | null;
  currentSummary: string;
  confidence: number;
  selfRole: SelfRoleOnUnit | null;
  isWorkMapSeed: boolean;
  entities: CreateMatterEntityInput[];
  primaryEntityIds: string[];
};

function loadSelfCanonicalId(): string {
  const raw = getSetting(SELF_ENTITY_SETTING_KEY);
  if (!raw || !raw.trim()) return '';
  try {
    return resolveAliased(raw.trim());
  } catch {
    return raw.trim();
  }
}

function pickPrimarySpaceId(unitId: string): string | null {
  const links = listSpacesForTarget('context_unit', unitId);
  if (links.length === 0) return null;
  links.sort((a, b) => b.confidence - a.confidence);
  return links[0].space_id;
}

function summarize(content: string, meaning?: string): string {
  const base = (meaning && meaning.trim()) || content || '';
  const oneLine = base.replace(/\s+/g, ' ').trim();
  return oneLine.length > SUMMARY_MAX ? oneLine.slice(0, SUMMARY_MAX - 1) + '…' : oneLine;
}

function buildPlanForUnit(
  unitId: string,
  selfCanonicalId: string,
  nowMs: number
): Plan | null {
  const unit = getContextUnitById(unitId);
  if (!unit) return null;

  const entityRows: ContextUnitEntityRow[] = listEntitiesForUnit(unitId);
  const entities: CreateMatterEntityInput[] = [];
  const primaryEntityIds: string[] = [];
  for (const er of entityRows) {
    const ent = getContextEntityById(er.entity_id);
    const type = ent?.type ?? 'person';
    const canonicalId = resolveAliased(er.entity_id);
    entities.push({
      entityId: canonicalId,
      role: mapContextRoleToMatterRole(type, er.role),
      confidence: er.confidence,
    });
    if (PRIMARY_ENTITY_TYPES.has(type)) primaryEntityIds.push(canonicalId);
  }

  const selfRole = computeSelfRoleOnUnit(unitId, selfCanonicalId);
  const isWorkMapSeed = classifyContextUnit(unit).source === 'work_map_seed';
  const canonicalTitle = canonicalizeMatterTitle(unit.title);

  return {
    unitId,
    title: canonicalTitle,
    type: classifyMatterType({ title: unit.title, content: unit.content }),
    status: 'open',
    priority: inferMatterPriority({
      dueAt: unit.time?.dueAt ?? null,
      actionability: unit.actionability,
      selfRole,
      isWorkMapSeed,
      now: nowMs,
    }),
    scope: unit.scope,
    dueAt: unit.time?.dueAt ?? null,
    canonicalKey: computeMatterCanonicalKey({
      subjectId: unit.subjectId,
      primaryEntityIds,
      actionPhrase: canonicalTitle,
    }),
    ownerEntityId:
      selfRole === 'executor' && selfCanonicalId ? selfCanonicalId : null,
    primarySpaceId: pickPrimarySpaceId(unitId),
    currentSummary: summarize(unit.content, unit.meaning),
    confidence: unit.confidence,
    selfRole,
    isWorkMapSeed,
    entities,
    primaryEntityIds,
  };
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const confirm = args.has('--confirm');
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const selfCanonicalId = loadSelfCanonicalId();

  // active commitments（含已过 TTL 但 status 仍 active 的；status 才是生命周期信号）
  const rows = listContextUnits({
    kind: 'commitment',
    status: 'active',
    includeExpired: true,
    limit: 5000,
  });

  console.log('== MVP26 backfill: seed Matter from active commitments ==');
  console.log(`self entity id: ${selfCanonicalId || '(unset)'}`);
  console.log(`Found ${rows.length} active commitment context unit(s).`);

  const plans: Plan[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (getMatterByCreatedFromContextUnit(row.id)) {
      skipped += 1;
      continue;
    }
    const plan = buildPlanForUnit(row.id, selfCanonicalId, nowMs);
    if (plan) plans.push(plan);
  }

  console.log(`Already seeded (skipped): ${skipped}`);
  console.log(`To create: ${plans.length}`);

  if (plans.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const preview = plans.slice(0, 12);
  console.log(`\nPreview (showing ${preview.length} of ${plans.length}):`);
  for (const p of preview) {
    const due = p.dueAt ? ` due=${p.dueAt}` : '';
    const role = p.selfRole ? ` self=${p.selfRole}` : '';
    const seed = p.isWorkMapSeed ? ' [work_map_seed]' : '';
    console.log(
      `  [${p.type}/${p.priority}]${role}${due}${seed} ${p.title.slice(0, 50)} ` +
        `(entities=${p.entities.length}, space=${p.primarySpaceId ? 'y' : 'n'})`
    );
  }
  if (plans.length > preview.length) {
    console.log(`  ... and ${plans.length - preview.length} more`);
  }

  if (!confirm) {
    console.log('\nDRY RUN. No changes written. Re-run with --confirm to create Matters.');
    return;
  }

  let created = 0;
  for (const p of plans) {
    createMatter({
      subjectId: 'me',
      scope: p.scope,
      type: p.type,
      title: p.title,
      canonicalKey: p.canonicalKey,
      status: p.status,
      priority: p.priority,
      ownerEntityId: p.ownerEntityId,
      primarySpaceId: p.primarySpaceId,
      dueAt: p.dueAt,
      currentSummary: p.currentSummary,
      createdFromContextUnitId: p.unitId,
      confidence: p.confidence,
      entities: p.entities,
      createdReason: `MVP26 backfill: seeded from commitment ${p.unitId}`,
      now: nowIso,
    });
    created += 1;
  }
  console.log(`\nCreated ${created} Matter(s) at ${nowIso}.`);
}

main();
