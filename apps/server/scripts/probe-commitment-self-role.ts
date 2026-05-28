/**
 * MVP20 §M1 spike：扫所有 active (commitment|goal|uncertainty)，统计 self 在
 * context_unit_entities 里被打成什么 role。决定 PR1 派生函数是否够用、
 * 是否需要触发 spike 2 加强 triagePrompt。
 *
 * 用法：
 *   npx tsx apps/server/scripts/probe-commitment-self-role.ts
 *   npx tsx apps/server/scripts/probe-commitment-self-role.ts --json   # 只输出 JSON
 *
 * 只读，不改库。
 *
 * 报告四路命中数（见 docs/MVP20...md §7.1）：
 *   - hitA_only：仅 resolveAliased 命中（self 用 localizedName 或 alias 链路径）
 *   - hitB_only：仅 name='我' 兜底命中（triage LLM 字面输出，无 alias）
 *   - hitBoth：A + B 都命中（同一 unit 上既有 alias 版又有"我"字面版）
 *   - hitNone：当前 unit 上有 person entity 但都不是 self
 *
 * 判定标准：见 docs/MVP20-Commitment用户角色识别与差异化提醒技术方案.md §7.1
 */
import { db, getSetting } from '../src/db.js';
import { resolveAliased } from '../src/context/entityResolver.js';

// --- §3.2 角色归一表（跟 selfRoleOnUnit.ts 保持一致） -----------------------

type SelfRoleOnUnit = 'executor' | 'requester' | 'reviewer' | 'observer';

const EXECUTOR_ROLES = new Set([
  'actor', 'author', 'owner', 'assignee', 'handler', 'fixer',
  'developer', 'editor', 'tester', 'verifier', 'evaluator', 'responder',
  'organizer', 'coordinator', 'speaker',
]);
const REQUESTER_ROLES = new Set([
  'requester', 'reporter', 'proposer', 'initiator', 'source', 'target',
]);
const REVIEWER_ROLES = new Set([
  'reviewer', 'decision_maker', 'confirmer', 'gatekeeper',
]);
const OBSERVER_ROLES = new Set([
  'about', 'subject', 'mentioned', 'cc', 'observer', 'participant',
  'peer', 'forwarder', 'counterpart', 'concerned_party',
  'blocker_source', 'stakeholder', 'involved', 'explainer',
]);

function mapToSelfRole(rawRole: string): SelfRoleOnUnit | null {
  const r = rawRole.toLowerCase();
  if (EXECUTOR_ROLES.has(r)) return 'executor';
  if (REQUESTER_ROLES.has(r)) return 'requester';
  if (REVIEWER_ROLES.has(r)) return 'reviewer';
  if (OBSERVER_ROLES.has(r)) return 'observer';
  return null;
}

const ROLE_PRIORITY: Record<SelfRoleOnUnit, number> = {
  executor: 4, requester: 3, reviewer: 2, observer: 1,
};

// --- 主流程 -----------------------------------------------------------------

type Row = {
  uid: string;
  kind: string;
  title: string;
  role: string;
  eid: string;
  ename: string;
};

type UnitSummary = {
  uid: string;
  kind: string;
  title: string;
  /** self entity 在这条 unit 上的所有原始 role 标记（去重） */
  rawSelfRoles: string[];
  /** 归一后取最强 */
  bestSelfRole: SelfRoleOnUnit | null;
  /** 命中路径：用于诊断 alias 缺口 */
  matchPaths: Array<'A' | 'B'>;
};

function main(): void {
  const jsonOnly = process.argv.includes('--json');

  const selfRawId = getSetting('self_person_entity_id') ?? '';
  const selfCanonical = selfRawId ? resolveAliased(selfRawId) : '';

  if (!selfCanonical && !jsonOnly) {
    console.error(
      '[probe] WARN settings.self_person_entity_id 没设；A 路全失效，只看 B 路兜底\n'
    );
  }

  // 取所有 active (commitment|goal|uncertainty) × person entity 的边
  const rows = db
    .prepare(
      `SELECT
         cu.id    AS uid,
         cu.kind  AS kind,
         cu.title AS title,
         cue.role AS role,
         cue.entity_id AS eid,
         e.name   AS ename
       FROM context_units cu
       JOIN context_unit_entities cue ON cue.context_unit_id = cu.id
       JOIN context_entities e ON e.id = cue.entity_id
       WHERE cu.kind IN ('commitment', 'goal', 'uncertainty')
         AND cu.status = 'active'
         AND e.type = 'person'`
    )
    .all() as Row[];

  // 四路计数器（按行计，一条 unit 多 entity 可能贡献多次）
  let hitA_only = 0,
    hitB_only = 0,
    hitBoth = 0,
    hitNone = 0;

  // 按 unit 聚合
  const unitMap = new Map<string, UnitSummary>();
  // 全部活跃 unit（即便没 person entity 也要算分母）—— 先列再补
  const allActiveUnits = db
    .prepare(
      `SELECT id AS uid, kind, title
       FROM context_units
       WHERE kind IN ('commitment', 'goal', 'uncertainty')
         AND status = 'active'`
    )
    .all() as Array<{ uid: string; kind: string; title: string }>;

  for (const u of allActiveUnits) {
    unitMap.set(u.uid, {
      uid: u.uid,
      kind: u.kind,
      title: u.title,
      rawSelfRoles: [],
      bestSelfRole: null,
      matchPaths: [],
    });
  }

  for (const r of rows) {
    const matchA =
      !!selfCanonical && resolveAliased(r.eid) === selfCanonical;
    const matchB = r.ename === '我';

    if (matchA && matchB) hitBoth++;
    else if (matchA) hitA_only++;
    else if (matchB) hitB_only++;
    else {
      hitNone++;
      continue;
    }

    const summary = unitMap.get(r.uid);
    if (!summary) continue; // 不应该发生

    if (matchA) summary.matchPaths.push('A');
    if (matchB) summary.matchPaths.push('B');
    if (!summary.rawSelfRoles.includes(r.role)) {
      summary.rawSelfRoles.push(r.role);
    }
    const mapped = mapToSelfRole(r.role);
    if (mapped) {
      const prev = summary.bestSelfRole;
      if (!prev || ROLE_PRIORITY[mapped] > ROLE_PRIORITY[prev]) {
        summary.bestSelfRole = mapped;
      }
    }
  }

  // --- 各项统计 ---
  const totalUnits = unitMap.size;
  const unitsWithSelfHit = [...unitMap.values()].filter(
    (s) => s.matchPaths.length > 0
  );
  const totalHit = hitA_only + hitB_only + hitBoth;

  // 按 kind 拆分
  const kindStats = new Map<
    string,
    {
      total: number;
      withSelf: number;
      bestRoleDist: Record<SelfRoleOnUnit | 'null', number>;
    }
  >();
  for (const kind of ['commitment', 'goal', 'uncertainty']) {
    kindStats.set(kind, {
      total: 0,
      withSelf: 0,
      bestRoleDist: { executor: 0, requester: 0, reviewer: 0, observer: 0, null: 0 },
    });
  }
  for (const s of unitMap.values()) {
    const k = kindStats.get(s.kind);
    if (!k) continue;
    k.total++;
    if (s.matchPaths.length > 0) k.withSelf++;
    const r = s.bestSelfRole ?? 'null';
    k.bestRoleDist[r]++;
  }

  // 原始 role 字符串分布（self 命中的）
  const rawRoleDist = new Map<string, number>();
  for (const r of rows) {
    const matchA =
      !!selfCanonical && resolveAliased(r.eid) === selfCanonical;
    const matchB = r.ename === '我';
    if (!matchA && !matchB) continue;
    rawRoleDist.set(r.role, (rawRoleDist.get(r.role) ?? 0) + 1);
  }

  // --- JSON 输出（机读） ---
  const report = {
    selfCanonical,
    totals: {
      active_units: totalUnits,
      person_entity_rows: rows.length,
      units_with_self_hit: unitsWithSelfHit.length,
      hit_ratio: totalUnits > 0 ? unitsWithSelfHit.length / totalUnits : 0,
    },
    fourPath: {
      hitA_only,
      hitB_only,
      hitBoth,
      hitNone,
      total_hit: totalHit,
      // 关键指标：B 路独占占比 —— ≥ 30% 触发独立工单（larkOrgCollector merge "我" alias）
      B_only_share:
        totalHit > 0 ? hitB_only / totalHit : 0,
    },
    byKind: Object.fromEntries(kindStats),
    rawRoleDist: Object.fromEntries(rawRoleDist),
  };

  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // --- 人类可读输出 ---
  console.log('═══ MVP20 §M1 spike: commitment/goal/uncertainty self role probe ═══\n');
  console.log(`self_canonical_id : ${selfCanonical || '(未设)'}`);
  console.log(`active units      : ${totalUnits}`);
  console.log(`  · commitment    : ${kindStats.get('commitment')!.total}`);
  console.log(`  · goal          : ${kindStats.get('goal')!.total}`);
  console.log(`  · uncertainty   : ${kindStats.get('uncertainty')!.total}`);
  console.log(`person entity 行   : ${rows.length}`);
  console.log();

  console.log('--- 四路命中（按行计） ---');
  console.log(`  A 路独占（resolveAliased 命中）     : ${hitA_only}`);
  console.log(`  B 路独占（name='我' 兜底）          : ${hitB_only}`);
  console.log(`  双路（A + B 都命中）                 : ${hitBoth}`);
  console.log(`  未命中                               : ${hitNone}`);
  console.log(`  总命中                               : ${totalHit}`);
  if (totalHit > 0) {
    const pct = (n: number) => ((n / totalHit) * 100).toFixed(1) + '%';
    console.log();
    console.log(`  A 占比                               : ${pct(hitA_only + hitBoth)}`);
    console.log(`  B 占比                               : ${pct(hitB_only + hitBoth)}`);
    console.log(`  ★ B 独占占比（治本工单触发线 ≥30%）  : ${pct(hitB_only)}`);
  }
  console.log();

  console.log('--- 命中率（按 unit 计） ---');
  console.log(
    `  units_with_self_hit / total_units = ${unitsWithSelfHit.length} / ${totalUnits} = ${
      totalUnits > 0
        ? ((unitsWithSelfHit.length / totalUnits) * 100).toFixed(1) + '%'
        : 'n/a'
    }`
  );
  console.log('  (§7.1 阈值: ≥ 70% 派生可用；< 70% 触发 spike 2)\n');

  console.log('--- 按 kind 分 SelfRoleOnUnit 分布 ---');
  for (const [kind, k] of kindStats) {
    if (k.total === 0) continue;
    console.log(`  ${kind} (total=${k.total}, with_self=${k.withSelf})`);
    for (const role of ['executor', 'requester', 'reviewer', 'observer', 'null'] as const) {
      const n = k.bestRoleDist[role];
      if (n === 0) continue;
      console.log(`    · ${role.padEnd(10)}: ${n}`);
    }
  }
  console.log();

  console.log('--- 原始 role 字符串分布（self 命中的行） ---');
  const sorted = [...rawRoleDist.entries()].sort((a, b) => b[1] - a[1]);
  for (const [role, n] of sorted) {
    const mapped = mapToSelfRole(role);
    const tag = mapped ?? '(unmapped)';
    console.log(`  ${role.padEnd(20)} ${String(n).padStart(4)}  → ${tag}`);
  }
  console.log();

  console.log('--- 抽样 20 条 commitment（人工对照原文校对用） ---');
  const sampledCommitments = [...unitMap.values()]
    .filter((s) => s.kind === 'commitment')
    .sort(() => Math.random() - 0.5)
    .slice(0, 20);
  for (const s of sampledCommitments) {
    const paths = s.matchPaths.length ? `[${[...new Set(s.matchPaths)].join('+')}]` : '(no hit)';
    const role = s.bestSelfRole ?? 'null';
    const rawRoles = s.rawSelfRoles.length ? `raw=${s.rawSelfRoles.join(',')}` : '';
    console.log(
      `  [${s.uid.slice(0, 8)}] ${paths.padEnd(8)} role=${role.padEnd(9)} ${rawRoles}`
    );
    console.log(`     "${s.title}"`);
  }
  console.log();

  console.log('═══ 完成 ═══');
  console.log('JSON 完整报告: 加 --json 重跑');
}

main();
