/**
 * MVP15 §4.1 larkOrgCollector.
 *
 * 每 24h 跑一次。它的"产物"不是 RawSignal/事件，而是直接写到 context_entities.attributes_json
 * （仅 type='person'），让 attention / agent 后续能拿到 orgRole + lark profile。
 * 因此 collect() 永远返回空 RawSignal[]——告诉 scheduler "没有新事件，正常退出"。
 *
 * Phase A' 走的端点：
 *   - lark-cli contact +search-user --user-ids me        → 取 self
 *   - lark-cli contact +search-user --user-ids <ids,...>  → 批量刷新已存 person entity
 *
 * 同步策略：
 *   1. 每次 tick 必刷 self（数据量小、对应 entity 是 attention 的"我是谁"基线）
 *   2. 然后枚举 aliases_json 含 ou_ 前缀的 person entity
 *      → 过滤 isAttributesStale 真为 true 的
 *      → 一次 run 最多刷 MAX_PER_RUN=20 个，避免 hammer
 *      → 失败 entity 不刷 syncedAt 下次 retry
 *   3. permission_denied 时整轮停（说明授权挂了），其他错单条跳过。
 *
 * 不在本 collector 范围：
 *   - 新建 entity（避免内网通讯录拷贝；新人只通过其他 collector 看到才会落 entity）
 *   - leader_user_id / department_ids / job_title（等 contact:user.employee 审批，
 *     落到 §4.bis Phase A.5）
 */

import {
  db,
  getContextEntityByTypeName,
  getSetting,
  insertContextEntity,
  listPersonEntitiesWithOpenIdAlias,
  setSetting,
  updateContextEntityAttributes,
  type ContextEntityRow,
} from '../db.js';
import {
  LarkOrgError,
  lookupUsers,
  searchUserByName,
  type LarkUserInfo,
} from '../util/larkOrg.js';
import {
  ATTRIBUTES_TTL_MS,
  isAttributesStale,
  parsePersonAttributes,
  parsePersonAttributesFromRow,
  serializePersonAttributes,
  type PersonAttributes,
} from '../context/personAttributes.js';
import { computeOrgRoleFromMe } from '../context/personOrgRole.js';
import {
  parseDepartments,
  type DeptTaxonomyResult,
} from '../util/departmentTaxonomy.js';
import type { Collector, RawSignal } from './types.js';
import { randomUUID } from 'node:crypto';

const COLLECTOR_NAME = 'larkOrg';
const SELF_ENTITY_SETTING_KEY = 'self_person_entity_id';
// 2026-05-26：从 20 提到 200。lookupUsers 内部按 80 个 chunk 调 lark-cli，单 run 最多 3 次
// 调用，每次 ~1s——这是本地 CLI + 飞书内网调用，不是付费云 API 限速场景，没必要保守。
// 仍保留上限的目的：unit table 大爆炸（理论 1000+ ou_aliased entity）时不一次性灌爆。
const MAX_PER_RUN = 200;
const INTERVAL_MS = 60 * 60 * 1000; // 1h scheduler 频率，单 entity 24h TTL 仍然门控

export type LarkOrgCollectorRunSummary = {
  selfSynced: boolean;
  refreshed: number;
  skippedFresh: number;
  failed: number;
  permissionDenied: boolean;
};

/**
 * 暴露的 Collector 实现。collect() 返回空数组—— scheduler 不会因此报错；
 * 真实工作通过 `runLarkOrgSync` 完成。
 */
export const larkOrgCollector: Collector = {
  name: COLLECTOR_NAME,
  intervalMs: INTERVAL_MS,
  async collect(_since: Date | null): Promise<RawSignal[]> {
    try {
      const summary = await runLarkOrgSync({ now: Date.now() });
      console.log(
        `[larkOrg] tick: self=${summary.selfSynced ? 'yes' : 'no'} refreshed=${summary.refreshed} skippedFresh=${summary.skippedFresh} failed=${summary.failed}${summary.permissionDenied ? ' (PERMISSION_DENIED)' : ''}`
      );
    } catch (err) {
      console.warn(
        `[larkOrg] tick failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return [];
  },
};

// ----------------------------------------------------------------------------
// 核心逻辑：导出便于测试与 runOnce 手动触发
// ----------------------------------------------------------------------------

/**
 * 同步入口。
 *
 * @param opts.now             用于 24h TTL 比较；测试可注入冻结时间。
 * @param opts.lookupUsersHook 测试钩子：传入则跳过真实 lark-cli，由 hook 返回 LarkUserInfo[]。
 *                             生产路径下不传，走 `lookupUsers()`。
 * @param opts.maxPerRun       单次 run 刷新上限（默认 MAX_PER_RUN=200）。测试用低数字。
 */
export async function runLarkOrgSync(opts: {
  now: number;
  lookupUsersHook?: (openIds: string[]) => Promise<LarkUserInfo[]>;
  /** 测试钩子：传入则跳过真实 searchUserByName。 */
  searchUserByNameHook?: (name: string) => Promise<LarkUserInfo[]>;
  maxPerRun?: number;
}): Promise<LarkOrgCollectorRunSummary> {
  const lookup = opts.lookupUsersHook ?? lookupUsers;
  const maxPerRun = opts.maxPerRun ?? MAX_PER_RUN;
  const summary: LarkOrgCollectorRunSummary = {
    selfSynced: false,
    refreshed: 0,
    skippedFresh: 0,
    failed: 0,
    permissionDenied: false,
  };

  // -------- 1) self lookup（不要立刻写入，等 taxonomy 一起算完再写）--------
  let selfInfo: LarkUserInfo | null = null;
  let selfEntityId: string | null = null;
  const selfLookupMaxAttempts = 2;
  for (let attempt = 1; attempt <= selfLookupMaxAttempts; attempt++) {
    try {
      const meList = await lookup(['me']);
      const me = meList[0];
      if (!me) break;
      selfInfo = me;
      selfEntityId = ensureSelfEntity(me, opts.now);
      break;
    } catch (err) {
      if (err instanceof LarkOrgError && err.kind === 'permission_denied') {
        summary.permissionDenied = true;
        console.warn(`[larkOrg] self lookup permission_denied: ${err.message}`);
        return summary;
      }
      if (attempt === selfLookupMaxAttempts) {
        summary.failed++;
        console.warn(
          `[larkOrg] self lookup failed after ${selfLookupMaxAttempts} attempts: ${err instanceof Error ? err.message : String(err)}`
        );
      } else {
        console.warn(
          `[larkOrg] self lookup attempt ${attempt} failed (will retry): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // -------- 1.5) Work Map 里有 person 但 aliases 缺 ou_ → 按名字反查飞书，补 alias --------
  // 这一步成本可控：通常 Work Map relationship 才几个到十几个人，且每个 entity 只查一次。
  // 查完写入 aliases_json 后，下面 step 2 自然把它们 pick up 进 stale 队列。
  await resolveMissingAliasesForWorkMapPeople({
    searchUserByNameHook: opts.searchUserByNameHook,
  });

  // -------- 2) 收集需要刷新的其他 person entity --------
  // **优先级排序**：Work Map 里已确认相关人的 entity 排最前 —— 这些是用户显式标过的关键人物，
  // 比通讯录里偶尔出现一次的人重要。否则 200+ candidates 会把配额耗在过期 open_id 上。
  const candidates = listPersonEntitiesWithOpenIdAlias(500);
  const selfId = getSetting(SELF_ENTITY_SETTING_KEY);
  const priorityIds = getWorkMapStakeholderEntityIds();
  const sortedCandidates = [...candidates].sort((a, b) => {
    const aPri = priorityIds.has(a.id) ? 0 : 1;
    const bPri = priorityIds.has(b.id) ? 0 : 1;
    if (aPri !== bPri) return aPri - bPri;
    // 同优先级：保持 updated_at DESC（candidates 已经是这个序）
    return 0;
  });
  const stale: Array<{ row: ContextEntityRow; openId: string }> = [];
  for (const row of sortedCandidates) {
    if (row.id === selfId) continue;
    const attrs = parsePersonAttributesFromRow(row);
    // MVP15 §4 (revision): 24h TTL 过期 **或** 有 dept 但无 business（旧 entity 未解析过 taxonomy）→ 视为 stale
    const needsRefresh = isAttributesStale(attrs, opts.now) || isMissingTaxonomy(attrs);
    if (!needsRefresh) {
      summary.skippedFresh++;
      continue;
    }
    const openId = pickOpenIdFromAliases(row.aliases_json);
    if (!openId) continue;
    stale.push({ row, openId });
    if (stale.length >= maxPerRun) break;
  }

  // -------- 3) 批量拉其他 person 的 Lark 信息 --------
  let fetched: LarkUserInfo[] = [];
  if (stale.length > 0) {
    try {
      fetched = await lookup(stale.map((s) => s.openId));
    } catch (err) {
      if (err instanceof LarkOrgError && err.kind === 'permission_denied') {
        summary.permissionDenied = true;
        console.warn(`[larkOrg] batch lookup permission_denied: ${err.message}`);
        return summary;
      }
      summary.failed += stale.length;
      console.warn(
        `[larkOrg] batch lookup failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return summary;
    }
  }

  // -------- 4) 收集本轮所有 unique 部门字符串，批量解析 taxonomy --------
  const allDeptNames: string[] = [];
  if (selfInfo?.department) allDeptNames.push(selfInfo.department);
  for (const u of fetched) {
    if (u.department) allDeptNames.push(u.department);
  }
  const taxonomyMap = await parseDepartments(allDeptNames);

  // -------- 5) 写 self 的 attrs（带 taxonomy）--------
  let selfAttrs: PersonAttributes | null = null;
  if (selfInfo && selfEntityId) {
    selfAttrs = buildAttributes(selfInfo, opts.now, /* selfAttrsForRole */ null, taxonomyMap);
    // self 的 orgRoleFromMe 没意义
    delete selfAttrs.orgRoleFromMe;
    updateContextEntityAttributes(
      selfEntityId,
      serializePersonAttributes(selfAttrs),
      new Date(opts.now).toISOString()
    );
    summary.selfSynced = true;
  }

  // -------- 6) 写其他 person 的 attrs --------
  const byOpenId = new Map(fetched.map((u) => [u.openId, u]));
  for (const { row, openId } of stale) {
    const u = byOpenId.get(openId);
    if (!u) {
      summary.failed++;
      continue;
    }
    const attrs = buildAttributes(u, opts.now, selfAttrs, taxonomyMap);
    try {
      updateContextEntityAttributes(
        row.id,
        serializePersonAttributes(attrs),
        new Date(opts.now).toISOString()
      );
      summary.refreshed++;
    } catch (err) {
      summary.failed++;
      console.warn(
        `[larkOrg] update entity ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return summary;
}

/**
 * "有部门名但没解析过 taxonomy" → 视为 stale。让旧 entity 在 collector 下一轮自动补齐
 * business/functionPath，不需要手动 invalidate TTL。
 */
function isMissingTaxonomy(attrs: PersonAttributes | null): boolean {
  if (!attrs) return false;
  if (!attrs.larkDepartmentName) return false;
  return !attrs.larkDeptBusiness && !attrs.larkDeptFunctionPath;
}

/**
 * 取所有 Work Map 已确认相关人的 person entity id。collector 用这个集合给同步排队优先级。
 *
 * 走 work_map:relationship:* unit + context_unit_entities 反查；只取 type=person。
 */
function getWorkMapStakeholderEntityIds(): Set<string> {
  type Row = { entity_id: string };
  const rows = db
    .prepare(
      `SELECT DISTINCT cue.entity_id
       FROM context_units cu
       JOIN context_unit_entities cue ON cue.context_unit_id = cu.id
       JOIN context_entities ce ON ce.id = cue.entity_id
       WHERE cu.status = 'active'
         AND cu.merge_key LIKE 'work_map:relationship:%'
         AND ce.type = 'person'`
    )
    .all() as Row[];
  return new Set(rows.map((r) => r.entity_id));
}

/**
 * 给 Work Map relationship 里的 person entity 但 aliases_json 没 ou_ 的，按名字搜飞书
 * 反查 open_id 写回 alias。这一步是 collector 主同步的前置：补完 alias 之后，主同步
 * 的 listPersonEntitiesWithOpenIdAlias 才能 pick 到这些人。
 *
 * 去歧义策略（has_chatted 已默认开）：
 *   - 0 个候选 → 跳过、warning 日志
 *   - 1 个 → 直接用
 *   - 多个 → 找名字完全相等的子集；恰好 1 个 → 用；否则跳过（不冒充）
 */
async function resolveMissingAliasesForWorkMapPeople(opts: {
  searchUserByNameHook?: (name: string) => Promise<LarkUserInfo[]>;
}): Promise<void> {
  const search = opts.searchUserByNameHook ?? searchUserByName;
  const wmIds = getWorkMapStakeholderEntityIds();
  if (wmIds.size === 0) return;

  for (const entityId of wmIds) {
    const row = db
      .prepare(`SELECT * FROM context_entities WHERE id = ?`)
      .get(entityId) as ContextEntityRow | undefined;
    if (!row) continue;
    // 已经有 ou_ alias → 跳过
    if (row.aliases_json && row.aliases_json.includes('ou_')) continue;
    let candidates: LarkUserInfo[];
    try {
      candidates = await search(row.name);
    } catch (err) {
      if (err instanceof LarkOrgError && err.kind === 'permission_denied') {
        console.warn(`[larkOrg] resolveAliases: permission denied (stop)`);
        return;
      }
      console.warn(
        `[larkOrg] resolveAliases: search '${row.name}' failed: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    let pick: LarkUserInfo | undefined;
    if (candidates.length === 1) {
      pick = candidates[0];
    } else if (candidates.length > 1) {
      // 多个候选：要求名字完全相等（localized_name === entity.name）且只有 1 个这样的
      const exact = candidates.filter((u) => (u.localizedName ?? '').trim() === row.name.trim());
      if (exact.length === 1) pick = exact[0];
    }
    if (!pick) {
      console.warn(
        `[larkOrg] resolveAliases: '${row.name}' got ${candidates.length} candidates, skipping (cannot disambiguate)`
      );
      continue;
    }
    // 写 alias 回 entity
    const merged = mergeAlias(row.aliases_json, pick.openId);
    db.prepare(
      `UPDATE context_entities SET aliases_json = ?, updated_at = ? WHERE id = ?`
    ).run(merged, new Date(Date.now()).toISOString(), entityId);
    console.log(`[larkOrg] resolveAliases: '${row.name}' → ${pick.openId}`);
  }
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function buildAttributes(
  u: LarkUserInfo,
  now: number,
  selfForRole: PersonAttributes | null,
  taxonomyMap?: Map<string, DeptTaxonomyResult>
): PersonAttributes {
  const attrs: PersonAttributes = {
    larkOpenId: u.openId,
    larkLocalizedName: u.localizedName,
    larkEmail: u.email,
    larkEnterpriseEmail: u.enterpriseEmail,
    larkDepartmentName: u.department,
    larkIsCrossTenant: u.isCrossTenant,
    larkIsActivated: u.isActivated,
    larkHasChatted: u.hasChatted,
    larkP2pChatId: u.p2pChatId,
    larkSyncedAt: new Date(now).toISOString(),
  };
  // taxonomy: 把解析过的 business / functionPath 摘出来
  if (u.department && taxonomyMap) {
    const tax = taxonomyMap.get(u.department);
    if (tax) {
      if (tax.business) attrs.larkDeptBusiness = tax.business;
      if (tax.functionLabel) attrs.larkDeptFunctionLabel = tax.functionLabel;
      if (tax.functionPath && tax.functionPath.length > 0) {
        attrs.larkDeptFunctionPath = tax.functionPath;
      }
    }
  }
  // orgRoleFromMe 推断（需要在 taxonomy 写入之后，让 same_business_cross_function 能用上）
  const role = computeOrgRoleFromMe(selfForRole, attrs);
  if (role) attrs.orgRoleFromMe = role;
  return attrs;
}

/**
 * 从 aliases_json 里抠出第一个 ou_ 前缀的 open_id。aliases_json 可能是 JSON 字符串数组。
 */
function pickOpenIdFromAliases(aliasesJson: string | null): string | null {
  if (!aliasesJson) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(aliasesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  for (const a of arr) {
    if (typeof a === 'string' && a.startsWith('ou_')) return a;
  }
  return null;
}

/**
 * 找/建 self 对应的 person entity 并把 id 缓存到 settings。
 * 优先级：
 *   1. settings.self_person_entity_id 命中 → 直接复用
 *   2. 通过 aliases_json 反查（其他 collector 已把 self.open_id 存过 alias）→ 复用
 *   3. **通过 (type='person', name=localized_name) 反查 → 复用并把 open_id 补进 alias**
 *   4. 都不命中 → 新建 entity，name = self.localizedName，aliases = [self.openId]
 *
 * 步骤 3 是 2026-05-26 dogfood 发现的修复点：早期 collector 可能只用 person.name 落
 * entity（不带 open_id alias），后来 larkOrgCollector 一插就被 UNIQUE(type, name) 拦住。
 */
function ensureSelfEntity(self: LarkUserInfo, now: number): string {
  const existingId = getSetting(SELF_ENTITY_SETTING_KEY);
  if (existingId) {
    return existingId;
  }
  // 2) 通过 alias 反查
  const candidates = listPersonEntitiesWithOpenIdAlias(500);
  for (const row of candidates) {
    const openId = pickOpenIdFromAliases(row.aliases_json);
    if (openId === self.openId) {
      setSetting(SELF_ENTITY_SETTING_KEY, row.id);
      return row.id;
    }
  }
  // 3) 通过 (type, name) 反查 —— 复用现有 entity，并把 open_id 补进 alias
  const localizedName = self.localizedName ?? 'me';
  const byName = getContextEntityByTypeName('person', localizedName);
  if (byName) {
    const aliases = mergeAlias(byName.aliases_json, self.openId);
    db.prepare(
      `UPDATE context_entities SET aliases_json = ?, updated_at = ? WHERE id = ?`
    ).run(aliases, new Date(now).toISOString(), byName.id);
    setSetting(SELF_ENTITY_SETTING_KEY, byName.id);
    return byName.id;
  }
  // 4) 新建
  const id = randomUUID();
  const nowIso = new Date(now).toISOString();
  insertContextEntity({
    id,
    type: 'person',
    name: localizedName,
    aliases_json: JSON.stringify([self.openId]),
    source: 'lark_org_collector',
    confidence: 0.95,
    created_at: nowIso,
    updated_at: nowIso,
    attributes_json: null, // 上层 runLarkOrgSync 紧接着会 update 写入 attrs
  });
  setSetting(SELF_ENTITY_SETTING_KEY, id);
  return id;
}

/**
 * 把新 alias 合并进 aliases_json（去重）。原值是 null / 空 / 非 JSON 时容错。
 */
function mergeAlias(existing: string | null, newAlias: string): string {
  let arr: string[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) {
        arr = parsed.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      /* ignore malformed */
    }
  }
  if (!arr.includes(newAlias)) arr.push(newAlias);
  return JSON.stringify(arr);
}

// 暴露给测试用
export const __internal = {
  COLLECTOR_NAME,
  SELF_ENTITY_SETTING_KEY,
  MAX_PER_RUN,
  INTERVAL_MS,
  ATTRIBUTES_TTL_MS,
  pickOpenIdFromAliases,
  buildAttributes,
  ensureSelfEntity,
};

// 兼容直接 `import { lookupUsers } from larkOrg` 的测试 mock 路径
export { lookupUsers };

// 兼容 personAttributes 工具复用（测试常需要解析）
export { parsePersonAttributes };
