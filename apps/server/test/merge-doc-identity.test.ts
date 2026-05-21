/**
 * MVP11.0-a：mergeDocIdentity 幂等性 + 边界。
 * 运行：npx tsx --test apps/server/test/merge-doc-identity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mergeDocIdentity,
  resolveAliased,
  resolveOrCreateEntity,
} from '../src/context/entityResolver.js';

// 用随机 token 避免重复跑时共用 sqlite 文件的状态泄露
const TOKEN = `tokTEST${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const URL = `https://example.feishu.cn/docx/${TOKEN}`;

test('mergeDocIdentity：合并后 token entity 解析到 url entity', () => {
  const tokenEnt = resolveOrCreateEntity('doc', `doc:${TOKEN}`);
  const urlEnt = resolveOrCreateEntity('doc', URL);
  // 还没合并：两边 alias 解析互不相等
  assert.notEqual(resolveAliased(tokenEnt.id), resolveAliased(urlEnt.id));

  mergeDocIdentity(TOKEN, URL);

  assert.equal(resolveAliased(tokenEnt.id), urlEnt.id);
});

test('mergeDocIdentity：再调一次幂等不抛', () => {
  mergeDocIdentity(TOKEN, URL);
  mergeDocIdentity(TOKEN, URL);
  const tokenEnt = resolveOrCreateEntity('doc', `doc:${TOKEN}`);
  const urlEnt = resolveOrCreateEntity('doc', URL);
  assert.equal(resolveAliased(tokenEnt.id), urlEnt.id);
});

test('mergeDocIdentity：空参数 no-op', () => {
  assert.doesNotThrow(() => mergeDocIdentity('', URL));
  assert.doesNotThrow(() => mergeDocIdentity(TOKEN, ''));
  assert.doesNotThrow(() => mergeDocIdentity('  ', '  '));
});

test('mergeDocIdentity：循环不爆炸（先 A→B，再 B→A 应被吞掉）', () => {
  const token2 = `tokCYC${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const url2 = `https://example.feishu.cn/docx/${token2}`;
  mergeDocIdentity(token2, url2);
  // 反过来调（语义上是循环）——helper 不应抛
  assert.doesNotThrow(() => mergeDocIdentity(`alt${token2}`, `doc:${token2}`));
});
