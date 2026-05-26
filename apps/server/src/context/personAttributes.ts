/**
 * MVP15 §3.1 Person entity attributes schema.
 *
 * 仅在 context_entities.type='person' 时使用；其他 type 的 entity attributes_json 留 NULL。
 *
 * 数据源：
 *   - lark-cli contact +search-user（无需管理员审批 scope）— 见 ../util/larkOrg.ts
 *   - Phase A.5（等 contact:user.employee 审批）才会追加 leader / dept id / job_title
 *
 * 写入：larkOrgCollector 调 updateContextEntityAttributes(entityId, serialize(attrs))
 * 读取：parseFromRow(row) / parsePersonAttributes(json)
 *
 * 容错原则：JSON.parse 失败时返回 null，不抛——上层 (computeOrgRoleFromMe / packet 装配)
 * 看到 null 当 "未连接" 处理。
 */

import type { ContextEntityRow } from '../db.js';

export type OrgRoleFromMe =
  | 'peer_same_dept'
  // 同 BU 不同职能（部门字符串不等但 larkDeptBusiness 相等）—— 2026-05-26 加入。
  | 'same_business_cross_function'
  | 'cross_dept'
  | 'external'
  // 预留 Phase A.5 引入（等 contact:user.employee 审批通过后启用）：
  | 'manager_of_me'
  | 'report_of_me';

export type PersonAttributes = {
  // ====== 来自 lark-cli `contact +search-user`（现有 scope 即可） ======
  larkOpenId?: string;
  larkLocalizedName?: string;
  larkEmail?: string;
  larkEnterpriseEmail?: string;
  larkDepartmentName?: string; // 字符串部门名；非 id
  // 由 util/departmentTaxonomy 解析后写入。例：larkDepartmentName='Lark Base Engineering-Infra-Performance' →
  //   larkDeptBusiness='Lark Base'
  //   larkDeptFunctionLabel='Engineering'
  //   larkDeptFunctionPath=['Engineering','Infra','Performance']
  // 解析失败 / 未解析 → 三个都为 undefined。
  larkDeptBusiness?: string;
  larkDeptFunctionLabel?: string;
  larkDeptFunctionPath?: string[];
  larkIsCrossTenant?: boolean;
  larkIsActivated?: boolean;
  larkHasChatted?: boolean;
  larkP2pChatId?: string;
  larkSyncedAt?: string; // ISO

  // ====== Phase A.5 预留（等审批；当前 collector 不会写入） ======
  larkLeaderOpenId?: string;
  larkDeptId?: string;
  larkDeptPathIds?: string[];
  larkTitle?: string;

  // ====== 由 personOrgRole.computeOrgRoleFromMe 写入 ======
  orgRoleFromMe?: OrgRoleFromMe;
};

/**
 * 解析 entity.attributes_json。失败返回 null；schema 不识别的字段忽略。
 */
export function parsePersonAttributes(json: string | null): PersonAttributes | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    return narrow(parsed);
  } catch {
    return null;
  }
}

/**
 * 等价的 row → attrs 快捷。type !== 'person' 直接返回 null。
 */
export function parsePersonAttributesFromRow(row: ContextEntityRow): PersonAttributes | null {
  if (row.type !== 'person') return null;
  return parsePersonAttributes(row.attributes_json);
}

/**
 * 序列化为 attributes_json 写入。undefined 字段会被 JSON.stringify 丢掉，正合所需。
 */
export function serializePersonAttributes(attrs: PersonAttributes): string {
  return JSON.stringify(attrs);
}

// ----------------------------------------------------------------------------
// 内部：浅层 narrowing。不做严格 schema 校验，但每个字段都核对类型，避免脏数据传出去。
// ----------------------------------------------------------------------------
function narrow(o: Record<string, unknown>): PersonAttributes {
  const out: PersonAttributes = {};
  if (typeof o.larkOpenId === 'string') out.larkOpenId = o.larkOpenId;
  if (typeof o.larkLocalizedName === 'string') out.larkLocalizedName = o.larkLocalizedName;
  if (typeof o.larkEmail === 'string') out.larkEmail = o.larkEmail;
  if (typeof o.larkEnterpriseEmail === 'string')
    out.larkEnterpriseEmail = o.larkEnterpriseEmail;
  if (typeof o.larkDepartmentName === 'string')
    out.larkDepartmentName = o.larkDepartmentName;
  if (typeof o.larkDeptBusiness === 'string') out.larkDeptBusiness = o.larkDeptBusiness;
  if (typeof o.larkDeptFunctionLabel === 'string')
    out.larkDeptFunctionLabel = o.larkDeptFunctionLabel;
  if (Array.isArray(o.larkDeptFunctionPath)) {
    const path = (o.larkDeptFunctionPath as unknown[]).filter(
      (x): x is string => typeof x === 'string'
    );
    if (path.length) out.larkDeptFunctionPath = path;
  }
  if (typeof o.larkIsCrossTenant === 'boolean')
    out.larkIsCrossTenant = o.larkIsCrossTenant;
  if (typeof o.larkIsActivated === 'boolean') out.larkIsActivated = o.larkIsActivated;
  if (typeof o.larkHasChatted === 'boolean') out.larkHasChatted = o.larkHasChatted;
  if (typeof o.larkP2pChatId === 'string') out.larkP2pChatId = o.larkP2pChatId;
  if (typeof o.larkSyncedAt === 'string') out.larkSyncedAt = o.larkSyncedAt;
  if (typeof o.larkLeaderOpenId === 'string') out.larkLeaderOpenId = o.larkLeaderOpenId;
  if (typeof o.larkDeptId === 'string') out.larkDeptId = o.larkDeptId;
  if (Array.isArray(o.larkDeptPathIds)) {
    const ids = (o.larkDeptPathIds as unknown[]).filter(
      (x): x is string => typeof x === 'string'
    );
    if (ids.length) out.larkDeptPathIds = ids;
  }
  if (typeof o.larkTitle === 'string') out.larkTitle = o.larkTitle;
  if (typeof o.orgRoleFromMe === 'string' && isOrgRole(o.orgRoleFromMe)) {
    out.orgRoleFromMe = o.orgRoleFromMe;
  }
  return out;
}

const ALL_ORG_ROLES: ReadonlySet<string> = new Set<OrgRoleFromMe>([
  'peer_same_dept',
  'cross_dept',
  'external',
  'manager_of_me',
  'report_of_me',
]);
function isOrgRole(s: string): s is OrgRoleFromMe {
  return ALL_ORG_ROLES.has(s);
}

/**
 * 判断 attributes 是否到了 24h TTL —— larkOrgCollector 用。
 */
export const ATTRIBUTES_TTL_MS = 24 * 3600 * 1000;
export function isAttributesStale(
  attrs: PersonAttributes | null,
  now: number = Date.now()
): boolean {
  if (!attrs || !attrs.larkSyncedAt) return true;
  const t = new Date(attrs.larkSyncedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t >= ATTRIBUTES_TTL_MS;
}
