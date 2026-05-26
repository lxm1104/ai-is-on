/**
 * MVP15 §4.2.5 / §4.3 — computeOrgRoleFromMe 纯函数测试。
 *
 * 覆盖 T6-T10：
 *   T6  target.isCrossTenant=true                       → 'external'
 *   T7  self/target 同部门字符串                         → 'peer_same_dept'
 *   T8  不同部门字符串                                   → 'cross_dept'
 *   T9  target.department 缺失                           → undefined
 *   T10 self=null（未连接飞书）                          → undefined（不是 'external'）
 *   附加：self.larkSyncedAt 缺失                         → undefined
 *   附加：部门名 trim + case-sensitive 行为              → 'peer_same_dept' / 'cross_dept'
 *
 * 运行：npx tsx --test apps/server/test/mvp15-org-role.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrgRoleFromMe } from '../src/context/personOrgRole.js';
import type { PersonAttributes } from '../src/context/personAttributes.js';

const selfReady: PersonAttributes = {
  larkOpenId: 'ou_self',
  larkDepartmentName: 'Lark Base Automation',
  larkSyncedAt: '2026-05-26T08:00:00Z',
};

test('T6 target.isCrossTenant=true → external', () => {
  const target: PersonAttributes = { larkIsCrossTenant: true, larkSyncedAt: '2026-05-26T08:00:00Z' };
  assert.equal(computeOrgRoleFromMe(selfReady, target), 'external');
});

test('T6.bis isCrossTenant=true 即便 self=null 也返回 external（跨租户无需 self 比对）', () => {
  const target: PersonAttributes = { larkIsCrossTenant: true };
  assert.equal(computeOrgRoleFromMe(null, target), 'external');
});

test('T7 self/target 同部门 → peer_same_dept', () => {
  const target: PersonAttributes = {
    larkDepartmentName: 'Lark Base Automation',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfReady, target), 'peer_same_dept');
});

test('T8 不同部门字符串 → cross_dept', () => {
  const target: PersonAttributes = {
    larkDepartmentName: 'IES Growth',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfReady, target), 'cross_dept');
});

test('T9 target.department 缺失 → undefined', () => {
  const target: PersonAttributes = { larkSyncedAt: '2026-05-26T08:00:00Z' };
  assert.equal(computeOrgRoleFromMe(selfReady, target), undefined);
});

test('T10 self=null（未连接飞书）→ undefined（不是 external）', () => {
  const target: PersonAttributes = {
    larkDepartmentName: 'Lark Base Automation',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(null, target), undefined);
});

test('附加 self.larkSyncedAt 缺失 → undefined', () => {
  const selfUnsynced: PersonAttributes = { larkDepartmentName: 'Lark Base Automation' };
  const target: PersonAttributes = {
    larkDepartmentName: 'Lark Base Automation',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfUnsynced, target), undefined);
});

test('附加 self.larkDepartmentName 缺失 → undefined', () => {
  const selfNoDept: PersonAttributes = { larkSyncedAt: '2026-05-26T08:00:00Z' };
  const target: PersonAttributes = {
    larkDepartmentName: 'Lark Base Automation',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfNoDept, target), undefined);
});

test('附加 部门名前后空白 trim 后比较', () => {
  const target: PersonAttributes = {
    larkDepartmentName: '  Lark Base Automation  ',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfReady, target), 'peer_same_dept');
});

test('附加 部门名大小写敏感（飞书 dept 名 case-sensitive）', () => {
  const target: PersonAttributes = {
    larkDepartmentName: 'lark base automation',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  // 大小写不同视为不同部门
  assert.equal(computeOrgRoleFromMe(selfReady, target), 'cross_dept');
});

test('附加 external 优先于 cross_dept（即便部门字段都存在但 isCrossTenant=true）', () => {
  const target: PersonAttributes = {
    larkDepartmentName: 'Some External Vendor',
    larkIsCrossTenant: true,
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfReady, target), 'external');
});

// MVP15 §4 (revision) — same_business_cross_function 档位
const selfWithBiz: PersonAttributes = {
  larkOpenId: 'ou_self',
  larkDepartmentName: 'Lark Base Automation and Integrations',
  larkDeptBusiness: 'Lark Base',
  larkSyncedAt: '2026-05-26T08:00:00Z',
};

test('T11 部门串不等但 business 相等 → same_business_cross_function', () => {
  const target: PersonAttributes = {
    larkDepartmentName: 'Lark Base Engineering-Infra-Performance',
    larkDeptBusiness: 'Lark Base',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(
    computeOrgRoleFromMe(selfWithBiz, target),
    'same_business_cross_function'
  );
});

test('T12 部门串相等仍是 peer_same_dept（business 比较仅在串不等时启用）', () => {
  const target: PersonAttributes = {
    larkDepartmentName: 'Lark Base Automation and Integrations',
    larkDeptBusiness: 'Lark Base',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfWithBiz, target), 'peer_same_dept');
});

test('T13 business 不等 → cross_dept', () => {
  const target: PersonAttributes = {
    larkDepartmentName: 'TikTok-Product-Data Science-Research',
    larkDeptBusiness: 'TikTok',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfWithBiz, target), 'cross_dept');
});

test('T14 target 缺 business → cross_dept（business 比较跳过）', () => {
  const target: PersonAttributes = {
    larkDepartmentName: 'Lark Design-Base',
    // larkDeptBusiness 缺
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfWithBiz, target), 'cross_dept');
});

test('T15 self 缺 business → cross_dept（不能误判同 BU）', () => {
  const selfNoBiz: PersonAttributes = {
    larkOpenId: 'ou_self',
    larkDepartmentName: 'Lark Base Automation',
    // larkDeptBusiness 缺
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  const target: PersonAttributes = {
    larkDepartmentName: 'Lark Base Engineering',
    larkDeptBusiness: 'Lark Base',
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfNoBiz, target), 'cross_dept');
});

test('T16 优先级：external > peer_same_dept > same_business_cross_function > cross_dept', () => {
  // external 最高（即便部门串相等 + biz 相等也照样判 external）
  const targetExtSameDept: PersonAttributes = {
    larkDepartmentName: 'Lark Base Automation and Integrations',
    larkDeptBusiness: 'Lark Base',
    larkIsCrossTenant: true,
    larkSyncedAt: '2026-05-26T08:00:00Z',
  };
  assert.equal(computeOrgRoleFromMe(selfWithBiz, targetExtSameDept), 'external');
});
