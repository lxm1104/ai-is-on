/**
 * MVP14 Phase 1b · Entity co-occurrence 测试。
 *
 * 覆盖边界（与 Codex coreview B6 + A'4 共识）：
 *   - 同 unit 内 (person, person) 共现 → 出现
 *   - chat / app entity 不出现（不在 type 白名单）
 *   - role 不在 actor/about 白名单的不参与
 *   - e1.id < e2.id 排除直接 self-pair（SQL 层）
 *   - alias 化后 canonical id 相同的 self-pair 过滤（TS 层）
 *   - 同一 canonical pair 被 alias 拆分时正确聚合 count
 *   - minCount filter：count < minCount 的 pair 不返回
 *   - top N by count desc
 *
 * 运行：npx tsx --test apps/server/test/mvp14-cooccurrences.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp14-cooccur-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { insertEntityAlias } = await import('../src/db.js');
const { upsertContextUnit } = await import('../src/context/contextStore.js');
const { resolveOrCreateEntity } = await import('../src/context/entityResolver.js');
const { listCooccurrences } = await import('../src/context/cooccurrenceService.js');

function writeUnit(
  refId: string,
  entities: Array<{ type: string; name: string; role?: string }>,
  scope: 'work' | 'personal' = 'work'
) {
  upsertContextUnit({
    kind: 'event',
    title: `evt ${refId}`,
    content: `content ${refId}`,
    entities,
    scope,
    origin: { kind: 'event', refId },
    actionability: 'record',
    confidence: 0.7,
  });
}

test('空 db 返回 []', () => {
  const items = listCooccurrences();
  assert.deepEqual(items, []);
});

test('同 unit (person, person) 共现 → 出现', () => {
  writeUnit('u1', [
    { type: 'person', name: 'Alice', role: 'actor' },
    { type: 'person', name: 'Bob', role: 'about' },
  ]);
  writeUnit('u2', [
    { type: 'person', name: 'Alice', role: 'about' },
    { type: 'person', name: 'Bob', role: 'about' },
  ]);
  const items = listCooccurrences({ minCount: 2 });
  const pair = items.find(
    (i) =>
      (i.left.name === 'Alice' && i.right.name === 'Bob') ||
      (i.left.name === 'Bob' && i.right.name === 'Alice')
  );
  assert.ok(pair, '应找到 Alice ↔ Bob');
  assert.equal(pair!.count, 2);
});

test('chat / app entity 不出现（不在 type 白名单）', () => {
  writeUnit('u3', [
    { type: 'chat', name: 'group-chat-1', role: 'about' },
    { type: 'person', name: 'Alice', role: 'about' },
  ]);
  writeUnit('u4', [
    { type: 'app', name: 'lark-bot', role: 'actor' },
    { type: 'person', name: 'Alice', role: 'about' },
  ]);
  const items = listCooccurrences({ minCount: 1 });
  for (const i of items) {
    assert.notEqual(i.left.type, 'chat');
    assert.notEqual(i.right.type, 'chat');
    assert.notEqual(i.left.type, 'app');
    assert.notEqual(i.right.type, 'app');
  }
});

test('role 不在 actor/about 白名单的 不参与（subject role）', () => {
  writeUnit('u5', [
    { type: 'person', name: 'Carol', role: 'subject' }, // subject 不算
    { type: 'person', name: 'Dave', role: 'about' },
  ]);
  const items = listCooccurrences({ minCount: 1 });
  // Carol↔Dave 不应出现，因为 Carol 角色 subject 被过滤
  const pair = items.find(
    (i) =>
      (i.left.name === 'Carol' && i.right.name === 'Dave') ||
      (i.left.name === 'Dave' && i.right.name === 'Carol')
  );
  assert.equal(pair, undefined);
});

test('alias 化后 canonical id 相同的 self-pair 过滤', () => {
  // 创建两个 person，再 alias
  const primary = resolveOrCreateEntity('person', 'Frank');
  const alias = resolveOrCreateEntity('person', 'Frank (PM)');
  const now = new Date().toISOString();
  insertEntityAlias({ id: alias.id, alias_of: primary.id, created_at: now });

  // 同一 unit 同时挂两个 entity name 但实际 canonical 是同一人
  writeUnit('u6', [
    { type: 'person', name: 'Frank', role: 'about' },
    { type: 'person', name: 'Frank (PM)', role: 'about' },
  ]);
  // 单独一对让其他真共现也出现，用于验证不是空集
  writeUnit('u7', [
    { type: 'person', name: 'Frank', role: 'about' },
    { type: 'person', name: 'Bob', role: 'about' },
  ]);
  const items = listCooccurrences({ minCount: 1 });
  // 不应该出现 Frank↔Frank
  for (const i of items) {
    assert.notEqual(
      i.left.id,
      i.right.id,
      `不应有 self-pair: ${i.left.name} ↔ ${i.right.name}`
    );
  }
});

test('同一 canonical pair 被 alias 拆分时正确聚合', () => {
  // Alice 已存在，新建 Alice 的 alias
  const aliceCanonical = resolveOrCreateEntity('person', 'Alice');
  const aliceAlias = resolveOrCreateEntity('person', 'Alice Wang');
  const now = new Date().toISOString();
  insertEntityAlias({ id: aliceAlias.id, alias_of: aliceCanonical.id, created_at: now });

  // 一条 unit 挂 Alice 一条挂 Alice Wang，都和 Bob 共现
  writeUnit('u8', [
    { type: 'person', name: 'Alice Wang', role: 'about' },
    { type: 'person', name: 'Bob', role: 'about' },
  ]);
  // Alice↔Bob 已有 u1/u2 共 2 条 + u7 1 条 + u8 应被聚合为 +1 = 4
  const items = listCooccurrences({ minCount: 1 });
  const pair = items.find(
    (i) =>
      (i.left.name === 'Alice' && i.right.name === 'Bob') ||
      (i.left.name === 'Bob' && i.right.name === 'Alice')
  );
  assert.ok(pair);
  // u1 + u2 + u8 (alias 聚合到 Alice↔Bob) = 3
  // u7 是 Frank↔Bob，不算 Alice↔Bob
  assert.equal(pair!.count, 3, `期望 3 次共现（u1+u2+u8 alias 聚合），实际 ${pair!.count}`);
});

test('minCount filter：count < minCount 的 pair 不返回', () => {
  writeUnit('u9', [
    { type: 'person', name: 'Lonely1', role: 'about' },
    { type: 'person', name: 'Lonely2', role: 'about' },
  ]);
  // Lonely1↔Lonely2 只出现 1 次
  const allWithMin1 = listCooccurrences({ minCount: 1 });
  assert.ok(
    allWithMin1.some(
      (i) =>
        (i.left.name === 'Lonely1' && i.right.name === 'Lonely2') ||
        (i.left.name === 'Lonely2' && i.right.name === 'Lonely1')
    )
  );

  const minCount3 = listCooccurrences({ minCount: 3 });
  assert.equal(
    minCount3.find(
      (i) =>
        (i.left.name === 'Lonely1' && i.right.name === 'Lonely2') ||
        (i.left.name === 'Lonely2' && i.right.name === 'Lonely1')
    ),
    undefined
  );
});

test('top N by count desc', () => {
  const items = listCooccurrences({ limit: 3, minCount: 1 });
  // 验证按 count desc 排序
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i - 1].count >= items[i].count);
  }
});

test('canonical entity 也必须在 type 白名单（防御性）', () => {
  // 创建一个 org entity，alias 到 person — 模拟极端情况
  // 但 SQL 层已用 e1.type/e2.type 白名单，alias 化后仍走 getContextEntityById
  // 取 canonical entity 的 type 检查
  // 此处只 smoke：所有返回的 item 类型必须在白名单
  const items = listCooccurrences({ minCount: 1 });
  const whitelist = new Set(['person', 'doc', 'project', 'topic']);
  for (const i of items) {
    assert.ok(whitelist.has(i.left.type), `left type ${i.left.type} not in whitelist`);
    assert.ok(whitelist.has(i.right.type), `right type ${i.right.type} not in whitelist`);
  }
});
