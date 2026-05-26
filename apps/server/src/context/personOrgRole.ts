/**
 * MVP15 §4.2.5 — 从 PersonAttributes 推断 orgRoleFromMe（"TA 相对于我"）。
 *
 * Phase A'（含 2026-05-26 部门解析扩展）下覆盖 4 档：
 *   - 'external'                       target.larkIsCrossTenant === true
 *   - 'peer_same_dept'                 self/target 部门字符串完全相等
 *   - 'same_business_cross_function'   部门串不等，但 larkDeptBusiness 相等
 *   - 'cross_dept'                     都是内部，但 business 不同 / 任一缺 business
 *
 * 优先级（自上而下）：external > peer_same_dept > same_business_cross_function > cross_dept > undefined
 *
 * 数据不全时返回 undefined（不冒充判断）：
 *   - self === null 或没 larkSyncedAt
 *   - target.larkDepartmentName 缺失
 *   - self.larkDepartmentName 缺失
 *
 * Phase A.5（待审批）会引入 'manager_of_me' / 'report_of_me'，优先级在 external 之后、
 * 部门比较之前。
 */

import type { OrgRoleFromMe, PersonAttributes } from './personAttributes.js';

export function computeOrgRoleFromMe(
  self: PersonAttributes | null,
  target: PersonAttributes
): OrgRoleFromMe | undefined {
  // 跨租户判定第一优先：即便 self 还没数据也能给出这条
  if (target.larkIsCrossTenant === true) return 'external';

  // self 未连接 → undefined（不是 external，避免冒充判断）
  if (self === null || !self.larkSyncedAt) return undefined;

  const selfDept = (self.larkDepartmentName ?? '').trim();
  const targetDept = (target.larkDepartmentName ?? '').trim();
  if (!selfDept || !targetDept) return undefined;

  // 飞书部门名是 case-sensitive 的（"Lark Base" ≠ "lark base"）
  if (selfDept === targetDept) return 'peer_same_dept';

  // MVP15 §4 (revision): 同 BU 不同职能 —— 两边都有 larkDeptBusiness 且相等
  const selfBiz = (self.larkDeptBusiness ?? '').trim();
  const targetBiz = (target.larkDeptBusiness ?? '').trim();
  if (selfBiz && targetBiz && selfBiz === targetBiz) {
    return 'same_business_cross_function';
  }

  return 'cross_dept';
}
