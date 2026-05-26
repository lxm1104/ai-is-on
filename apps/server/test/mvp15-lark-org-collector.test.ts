/**
 * MVP15 §4.3 — larkOrgCollector 集成测试。
 *
 * 用 lookupUsersHook 注入假 lookupUsers，不依赖真实 lark-cli。临时 SQLite 路径，
 * COLLECTOR_ENABLED=false 防止 scheduler 自启。
 *
 * 覆盖 T1-T5：
 *   T1  self lookup → self entity 创建 + attributes_json 含 larkLocalizedName + larkSyncedAt
 *   T2  批量 5 个用户，3 个已存在 entity、2 个不存在 → 只更新 3 个、**不新建**
 *   T3  permission_denied → collector 不崩、syncedAt 不刷、下次 retry
 *   T4  单 entity 在 23h59m 之内重复跑 → 被 24h TTL 跳过（不调 lookup）
 *   T5  25 个全过期 entity → 单 run 最多刷 20 个
 *
 * 运行：npx tsx --test apps/server/test/mvp15-lark-org-collector.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp15-collector-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { db, getSetting, insertContextEntity, updateContextEntityAttributes } = await import(
  '../src/db.js'
);
const { runLarkOrgSync, __internal } = await import('../src/collectors/larkOrgCollector.js');
const { LarkOrgError } = await import('../src/util/larkOrg.js');
const { parsePersonAttributes, serializePersonAttributes } = await import(
  '../src/context/personAttributes.js'
);

type LarkUserInfo = {
  openId: string;
  localizedName?: string;
  email?: string;
  enterpriseEmail?: string;
  department?: string;
  isCrossTenant?: boolean;
  isActivated?: boolean;
  hasChatted?: boolean;
  p2pChatId?: string;
};

const SELF_OPEN_ID = 'ou_self_test_0001';
const SELF_INFO: LarkUserInfo = {
  openId: SELF_OPEN_ID,
  localizedName: 'TestSelf',
  email: 'self@example.com',
  enterpriseEmail: 'self@enterprise.com',
  department: 'Test Dept A',
  isCrossTenant: false,
  isActivated: true,
  hasChatted: false,
};

function resetDb() {
  db.exec('DELETE FROM context_entities');
  db.exec("DELETE FROM settings WHERE key='self_person_entity_id'");
}

function makePersonEntity(opts: {
  openId: string;
  name: string;
  attributesJson?: string | null;
}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertContextEntity({
    id,
    type: 'person',
    name: opts.name,
    aliases_json: JSON.stringify([opts.openId]),
    source: 'test',
    confidence: 0.7,
    created_at: now,
    updated_at: now,
    attributes_json: opts.attributesJson ?? null,
  });
  return id;
}

test('T1 self lookup → self entity 创建 + attributes_json 含 larkLocalizedName / larkSyncedAt', async () => {
  resetDb();
  const now = Date.parse('2026-05-26T10:00:00Z');
  const hook = async (ids: string[]) => (ids.includes('me') ? [SELF_INFO] : []);

  const summary = await runLarkOrgSync({ now, lookupUsersHook: hook });

  assert.equal(summary.selfSynced, true);
  const selfId = getSetting(__internal.SELF_ENTITY_SETTING_KEY);
  assert.ok(selfId, 'selfId persisted in settings');
  const row = db
    .prepare(`SELECT * FROM context_entities WHERE id = ?`)
    .get(selfId) as { attributes_json: string | null };
  const attrs = parsePersonAttributes(row.attributes_json);
  assert.ok(attrs);
  assert.equal(attrs!.larkLocalizedName, 'TestSelf');
  assert.equal(attrs!.larkDepartmentName, 'Test Dept A');
  assert.equal(attrs!.larkIsCrossTenant, false);
  assert.ok(attrs!.larkSyncedAt);
  // self 不应该有 orgRoleFromMe（自己跟自己比无意义）
  assert.equal(attrs!.orgRoleFromMe, undefined);
});

test('T2 批量 5 个用户，3 个已存在、2 个不存在 → 只更新 3 个、不新建', async () => {
  resetDb();
  const now = Date.parse('2026-05-26T10:00:00Z');

  // 先准备 self
  const setupHook = async (ids: string[]) => (ids.includes('me') ? [SELF_INFO] : []);
  await runLarkOrgSync({ now, lookupUsersHook: setupHook });

  // 创建 3 个已存在的 person entity（aliases_json 含 ou_）
  const e1 = makePersonEntity({ openId: 'ou_known_001', name: 'Known A' });
  const e2 = makePersonEntity({ openId: 'ou_known_002', name: 'Known B' });
  const e3 = makePersonEntity({ openId: 'ou_known_003', name: 'Known C' });

  // 注入：lookup 时返回 5 个用户，其中 ou_unknown_004 / ou_unknown_005 不对应任何 entity
  const fetchHook = async (ids: string[]): Promise<LarkUserInfo[]> => {
    if (ids.includes('me')) return [SELF_INFO];
    return [
      { openId: 'ou_known_001', localizedName: 'Known A', department: 'Test Dept A' },
      { openId: 'ou_known_002', localizedName: 'Known B', department: 'Other Dept' },
      { openId: 'ou_known_003', localizedName: 'Known C', isCrossTenant: true },
      { openId: 'ou_unknown_004', localizedName: 'Unknown', department: 'Other' },
      { openId: 'ou_unknown_005', localizedName: 'AlsoUnknown', department: 'Other' },
    ];
  };

  // 推 25h 让 TTL 失效（self 在初始化时刚 sync 过）
  const summary = await runLarkOrgSync({
    now: now + 25 * 3600 * 1000,
    lookupUsersHook: fetchHook,
  });

  assert.equal(summary.refreshed, 3, '只更新 3 个已存在 entity');
  const totalPersons = db
    .prepare(`SELECT COUNT(*) as c FROM context_entities WHERE type='person'`)
    .get() as { c: number };
  // self + e1 + e2 + e3 = 4，**没有为 unknown_004 / unknown_005 新建**
  assert.equal(totalPersons.c, 4, '不新建未知 open_id 的 entity');

  // 验证 orgRoleFromMe 推断正确
  const e1Attrs = parsePersonAttributes(
    (db.prepare(`SELECT attributes_json FROM context_entities WHERE id=?`).get(e1) as any)
      .attributes_json
  );
  const e2Attrs = parsePersonAttributes(
    (db.prepare(`SELECT attributes_json FROM context_entities WHERE id=?`).get(e2) as any)
      .attributes_json
  );
  const e3Attrs = parsePersonAttributes(
    (db.prepare(`SELECT attributes_json FROM context_entities WHERE id=?`).get(e3) as any)
      .attributes_json
  );
  assert.equal(e1Attrs?.orgRoleFromMe, 'peer_same_dept', 'e1 同部门');
  assert.equal(e2Attrs?.orgRoleFromMe, 'cross_dept', 'e2 跨部门');
  assert.equal(e3Attrs?.orgRoleFromMe, 'external', 'e3 跨租户');
});

test('T3 permission_denied → collector 不崩、syncedAt 不刷、下次 retry', async () => {
  resetDb();
  const now = Date.parse('2026-05-26T10:00:00Z');
  // 先正常 sync self
  const setupHook = async (ids: string[]) => (ids.includes('me') ? [SELF_INFO] : []);
  const r0 = await runLarkOrgSync({ now, lookupUsersHook: setupHook });
  assert.equal(r0.selfSynced, true);
  const selfId = getSetting(__internal.SELF_ENTITY_SETTING_KEY)!;
  const attrsBefore = parsePersonAttributes(
    (db.prepare(`SELECT attributes_json FROM context_entities WHERE id=?`).get(selfId) as any)
      .attributes_json
  );

  // 25h 之后，hook 永远抛 permission_denied
  const denyHook = async () => {
    throw new LarkOrgError('permission_denied', 'mocked permission deny');
  };
  const summary = await runLarkOrgSync({
    now: now + 25 * 3600 * 1000,
    lookupUsersHook: denyHook,
  });

  assert.equal(summary.permissionDenied, true);
  assert.equal(summary.selfSynced, false, 'self 没刷');
  // attributes 还在（不会被清掉）；只是 syncedAt 没更新
  const attrsAfter = parsePersonAttributes(
    (db.prepare(`SELECT attributes_json FROM context_entities WHERE id=?`).get(selfId) as any)
      .attributes_json
  );
  assert.equal(attrsAfter?.larkSyncedAt, attrsBefore?.larkSyncedAt, 'syncedAt 不变');
});

test('T4 单 entity 在 23h59m 之内重复跑 → 被 24h TTL 跳过', async () => {
  resetDb();
  const now = Date.parse('2026-05-26T10:00:00Z');

  // self 先初始化
  const setupHook = async (ids: string[]) => (ids.includes('me') ? [SELF_INFO] : []);
  await runLarkOrgSync({ now, lookupUsersHook: setupHook });

  // 创建一个 person entity 并手动写入 attributes_json with larkSyncedAt = now
  const e1 = makePersonEntity({
    openId: 'ou_fresh_001',
    name: 'Fresh',
    attributesJson: serializePersonAttributes({
      larkOpenId: 'ou_fresh_001',
      larkLocalizedName: 'Fresh',
      larkSyncedAt: new Date(now).toISOString(),
    }),
  });

  // 计数：hook 被调用多少次（用于检测 e1 是否被 lookup）
  let calls = 0;
  const trackingHook = async (ids: string[]): Promise<LarkUserInfo[]> => {
    calls++;
    return ids.includes('me') ? [SELF_INFO] : [];
  };

  // 23h59m 后再跑
  const summary = await runLarkOrgSync({
    now: now + 23 * 3600 * 1000 + 59 * 60 * 1000,
    lookupUsersHook: trackingHook,
  });

  assert.equal(summary.skippedFresh, 1, 'e1 被 TTL 跳过');
  assert.equal(summary.refreshed, 0);
  // hook 应该只为 self 调用了 1 次（me），没有为 e1 单独调用
  assert.equal(calls, 1, 'hook 只被调用了 1 次（self）');
});

test('T5 maxPerRun 上限：25 个全过期，opts.maxPerRun=20 → 只刷 20 个', async () => {
  resetDb();
  const now = Date.parse('2026-05-26T10:00:00Z');

  // self 先初始化
  const setupHook = async (ids: string[]) => (ids.includes('me') ? [SELF_INFO] : []);
  await runLarkOrgSync({ now, lookupUsersHook: setupHook });

  // 创建 25 个 person entity，全部 attributes_json=null（即过期）
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    const openId = `ou_stale_${String(i).padStart(3, '0')}`;
    ids.push(openId);
    makePersonEntity({ openId, name: `Stale ${i}` });
  }

  const fetchHook = async (askedIds: string[]): Promise<LarkUserInfo[]> => {
    if (askedIds.includes('me')) return [SELF_INFO];
    // 返回每个被询问的 openId 的对应假信息
    return askedIds.map((openId) => ({
      openId,
      localizedName: `Stale ${openId}`,
      department: 'Other',
    }));
  };

  const summary = await runLarkOrgSync({
    now: now + 25 * 3600 * 1000,
    lookupUsersHook: fetchHook,
    maxPerRun: 20, // 显式压低，验证 cap 行为
  });

  assert.equal(summary.refreshed, 20, '应该恰好刷 opts.maxPerRun=20 个');
});

test('T5.bis 默认 MAX_PER_RUN=200，25 个全过期应全部刷完', async () => {
  resetDb();
  const now = Date.parse('2026-05-26T10:00:00Z');

  const setupHook = async (ids: string[]) => (ids.includes('me') ? [SELF_INFO] : []);
  await runLarkOrgSync({ now, lookupUsersHook: setupHook });

  for (let i = 0; i < 25; i++) {
    const openId = `ou_default_${String(i).padStart(3, '0')}`;
    makePersonEntity({ openId, name: `Default ${i}` });
  }

  const fetchHook = async (askedIds: string[]): Promise<LarkUserInfo[]> => {
    if (askedIds.includes('me')) return [SELF_INFO];
    return askedIds.map((openId) => ({
      openId,
      localizedName: `Default ${openId}`,
      department: 'Other',
    }));
  };

  const summary = await runLarkOrgSync({
    now: now + 25 * 3600 * 1000,
    lookupUsersHook: fetchHook,
    // 不传 maxPerRun，用默认 200
  });

  assert.equal(summary.refreshed, 25, '默认 cap 是 200，25 < 200，全部应刷新');
  assert.ok(__internal.MAX_PER_RUN >= 100, `MAX_PER_RUN default should be >= 100, got ${__internal.MAX_PER_RUN}`);
});

test('附加 self 通过已存 alias 反查复用 entity（不创建新 self）', async () => {
  resetDb();
  const now = Date.parse('2026-05-26T10:00:00Z');

  // 模拟另一个 collector 已经把 self 存为 entity（aliases 含 self.open_id）
  const preexistingSelfId = makePersonEntity({
    openId: SELF_OPEN_ID,
    name: '预先存在的 Self',
  });

  const hook = async (ids: string[]) => (ids.includes('me') ? [SELF_INFO] : []);
  await runLarkOrgSync({ now, lookupUsersHook: hook });

  const selfId = getSetting(__internal.SELF_ENTITY_SETTING_KEY);
  assert.equal(selfId, preexistingSelfId, '应该复用已存 entity 而非新建');
});
