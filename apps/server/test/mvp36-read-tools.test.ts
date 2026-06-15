/**
 * MVP36 — 自主排查只读工具层「硬只读边界」测试。
 * 重点：写命令绝不可能被执行；工具构造的命令一律是读命令；执行走注入 stub（不真打 lark-cli）。
 *
 * Run: npx tsx --test apps/server/test/mvp36-read-tools.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReadOnly,
  listReadTools,
  runReadTool,
} from '../src/investigation/readTools.js';

test('T1 assertReadOnly：写动词一律抛错', () => {
  assert.throws(() => assertReadOnly(['im', '+messages-send', '--chat-id', 'oc_x', '--text', 'hi']), /read-only violation/);
  assert.throws(() => assertReadOnly(['im', '+messages-reply', '--message-id', 'om_x']), /read-only violation/);
  assert.throws(() => assertReadOnly(['docs', '+create', '--content', 'x']), /read-only violation/);
  assert.throws(() => assertReadOnly(['task', '+update', '--guid', 'g']), /read-only violation/);
  assert.throws(() => assertReadOnly(['im', '+chat-create', '--name', 'g']), /read-only violation/);
});

test('T2 assertReadOnly：白名单内读命令放行', () => {
  assert.doesNotThrow(() => assertReadOnly(['im', '+messages-search', '--query', 'x']));
  assert.doesNotThrow(() => assertReadOnly(['docs', '+fetch', '--doc', 'doxcn1']));
  assert.doesNotThrow(() => assertReadOnly(['task', '+get-my-tasks', '--as', 'user']));
  assert.doesNotThrow(() => assertReadOnly(['calendar', '+agenda']));
});

test('T3 assertReadOnly：白名单外读命令也拒绝（默认拒绝）', () => {
  assert.throws(() => assertReadOnly(['im', '+feed-group-list']), /不在只读白名单/);
  assert.throws(() => assertReadOnly(['im']), /no lark-cli subcommand/);
});

test('T4 search_im_messages 构造正确读命令 + 调用注入 runner', async () => {
  const calls: string[][] = [];
  const runJson = async (args: string[]) => {
    calls.push(args);
    return { items: [{ id: 'om_1' }, { id: 'om_2' }] };
  };
  const r = await runReadTool('search_im_messages', { query: '评测集', sender: 'ou_abc', limit: 5 }, { runJson });
  assert.equal(r.ok, true);
  assert.equal(r.summary, 'IM 搜索命中 2 条');
  const args = calls[0];
  assert.deepEqual(args.slice(0, 2), ['im', '+messages-search']);
  assert.ok(args.includes('--query') && args[args.indexOf('--query') + 1] === '评测集');
  assert.ok(args.includes('--sender') && args[args.indexOf('--sender') + 1] === 'ou_abc');
  // limit clamp 进 --page-limit
  assert.ok(args.includes('--page-limit') && args[args.indexOf('--page-limit') + 1] === '5');
});

test('T5 缺必要参数 → ok:false 不调用 runner', async () => {
  const calls: string[][] = [];
  const runJson = async (args: string[]) => { calls.push(args); return {}; };
  const r = await runReadTool('search_im_messages', {}, { runJson });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /需要 query 或 chatId/);
  assert.equal(calls.length, 0);
});

test('T6 list_my_tasks 固定读命令', async () => {
  const calls: string[][] = [];
  const runJson = async (args: string[]) => { calls.push(args); return { items: [] }; };
  await runReadTool('list_my_tasks', {}, { runJson });
  assert.deepEqual(calls[0].slice(0, 2), ['task', '+get-my-tasks']);
  assert.ok(calls[0].includes('--complete=false'));
});

test('T7 列出的工具都不含写能力（注册表只读）', () => {
  const tools = listReadTools();
  assert.ok(tools.length >= 4);
  for (const t of tools) {
    assert.ok(!/send|reply|create|update|delete/i.test(t.name), `工具名不应含写动词: ${t.name}`);
  }
});
