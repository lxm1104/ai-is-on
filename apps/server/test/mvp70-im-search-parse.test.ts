/**
 * MVP70 — 修复 IM 搜索结果解析：lark-cli 把结果包在 { ok, data: { messages|items } } 信封里，
 * 旧 countItems 只看顶层 + 把 data 当数组 → 对每次搜索都数成 0 条（55% unknown 主因）。
 *
 * Run: npx tsx --test apps/server/test/mvp70-im-search-parse.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReadTool, compactToolData } from '../src/investigation/readTools.js';

// 真实 lark-cli im +messages-search 的返回形状（信封 + 嵌套 messages）
const envelope = {
  ok: true,
  identity: 'user',
  data: {
    has_more: false,
    messages: [
      { chat_id: 'oc_1', chat_name: '华图共创群', content: '@高虎伟 我们把状态设置为 resolve 了', create_time: '2026-06-11 18:14', sender: { name: '刘昕明' } },
      { chat_id: 'oc_1', chat_name: '华图共创群', content: '收到', create_time: '2026-06-11 18:15', sender: { name: '高虎伟' } },
    ],
  },
};

test('MVP70：countItems 下钻 lark-cli data 信封 → 数到真实条数（不再 0）', async () => {
  const res = await runReadTool('search_im_messages', { query: '高虎伟' }, { runJson: async () => envelope });
  assert.equal(res.ok, true);
  assert.match(res.summary, /命中 2 条/, '修复前总是"命中 0 条"');
});

test('MVP70：空结果仍正确报 0', async () => {
  const res = await runReadTool('search_im_messages', { query: 'x' }, { runJson: async () => ({ ok: true, data: { has_more: false, messages: [] } }) });
  assert.match(res.summary, /命中 0 条/);
});

test('MVP70：task 信封 items → 正确计数', async () => {
  const res = await runReadTool('list_my_tasks', {}, { runJson: async () => ({ ok: true, data: { items: [{ summary: 't1' }, { summary: 't2' }, { summary: 't3' }] } }) });
  assert.match(res.summary, /未完成任务 3 条/);
});

test('MVP70：compactToolData 抽出可读正文（含发件人/正文/群名），不是 chat_id 元数据', () => {
  const out = compactToolData(envelope);
  assert.match(out, /刘昕明/);
  assert.match(out, /我们把状态设置为 resolve/);
  assert.match(out, /华图共创群/);
  assert.ok(!out.includes('chat_id'), '不暴露 chat_id 等元数据');
});

test('MVP70：compactToolData 非列表结果 → 空串（调用方回落原 JSON）', () => {
  assert.equal(compactToolData({ ok: true, data: { token: 'doc', body: 'x' } }), '');
});
