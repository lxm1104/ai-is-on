/**
 * 对话合并的纯函数测试：parseImTextLines / mergeMessages / extractChatId /
 * extractChatName。覆盖跨 event 重叠窗口的去重 + 焦点保留 + 时间排序。
 *
 * 运行：npx tsx --test apps/server/test/origin-conversation-merge.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImTextLines,
  mergeMessages,
  extractChatId,
  extractChatIdFromRaw,
  extractChatName,
  pickPeerChatName,
} from '../src/cards/contextProjection.js';

test('parseImTextLines 跳过 metadata 行，提取 dialog 行的 time/sender/content/focus', () => {
  const raw = [
    '会话：单聊 · 詹育帆',
    '焦点消息：詹育帆 @ 2026-05-27 21:07',
    '---',
    '- [2026-05-27 21:06] 詹育帆: 你好',
    '★ [2026-05-27 21:07] 詹育帆: 这里肯定有问题',
    '- [2026-05-27 21:12] 刘昕明: 嗯',
  ].join('\n');
  const msgs = parseImTextLines(raw);
  assert.deepEqual(msgs, [
    { time: '2026-05-27 21:06', sender: '詹育帆', content: '你好', isFocus: false },
    { time: '2026-05-27 21:07', sender: '詹育帆', content: '这里肯定有问题', isFocus: true },
    { time: '2026-05-27 21:12', sender: '刘昕明', content: '嗯', isFocus: false },
  ]);
});

test('mergeMessages 跨 event 重叠窗口去重 + 时间升序', () => {
  // 模拟两个 event：21:07 焦点的窗口、21:12 焦点的窗口，重叠 21:07 这一条
  const ev1 = parseImTextLines(
    [
      '- [2026-05-27 21:06] 詹育帆: 你好',
      '★ [2026-05-27 21:07] 詹育帆: 这里肯定有问题',
      '- [2026-05-27 21:12] 刘昕明: 嗯',
    ].join('\n')
  );
  const ev2 = parseImTextLines(
    [
      '- [2026-05-27 21:07] 詹育帆: 这里肯定有问题',
      '- [2026-05-27 21:12] 刘昕明: 嗯',
      '★ [2026-05-27 21:12] 刘昕明: 我看看',
    ].join('\n')
  );
  const merged = mergeMessages([...ev1, ...ev2]);
  assert.deepEqual(merged, [
    { time: '2026-05-27 21:06', sender: '詹育帆', content: '你好', isFocus: false },
    // 21:07 这条在 ev1 是 ★，在 ev2 是 -，合并后保留 ★
    { time: '2026-05-27 21:07', sender: '詹育帆', content: '这里肯定有问题', isFocus: true },
    { time: '2026-05-27 21:12', sender: '刘昕明', content: '嗯', isFocus: false },
    { time: '2026-05-27 21:12', sender: '刘昕明', content: '我看看', isFocus: true },
  ]);
});

test('extractChatId 处理 msg / agg / 缺失三种 source_id', () => {
  assert.equal(extractChatId('chat:oc_abc123:msg:om_xyz'), 'oc_abc123');
  assert.equal(extractChatId('chat:oc_abc123:agg:2026-05-27T20:00:00Z'), 'oc_abc123');
  assert.equal(extractChatId('mail:thread:xxx'), null);
  assert.equal(extractChatId(''), null);
  assert.equal(extractChatId(null), null);
});

test('extractChatIdFromRaw 兜底解析 raw_json 四种 collector 形状', () => {
  // p2p burst / p2p single
  assert.equal(extractChatIdFromRaw(JSON.stringify({ chatId: 'oc_p2p' })), 'oc_p2p');
  assert.equal(
    extractChatIdFromRaw(JSON.stringify({ chatId: 'oc_p2p', msg: { content: 'x' } })),
    'oc_p2p'
  );
  // group burst / group single
  assert.equal(
    extractChatIdFromRaw(JSON.stringify({ chat: { chat_id: 'oc_grp' } })),
    'oc_grp'
  );
  assert.equal(
    extractChatIdFromRaw(JSON.stringify({ chat: { chat_id: 'oc_grp' }, msg: {} })),
    'oc_grp'
  );
  // msg-only 兜底（极端）
  assert.equal(
    extractChatIdFromRaw(JSON.stringify({ msg: { chat_id: 'oc_msg' } })),
    'oc_msg'
  );
  // 异常输入
  assert.equal(extractChatIdFromRaw('not-json'), null);
  assert.equal(extractChatIdFromRaw(null), null);
  assert.equal(extractChatIdFromRaw(JSON.stringify({})), null);
});

test('pickPeerChatName 单聊场景：focus sender 当 peer 名，避开"单聊·me"', () => {
  // 现场 bug 复现：4 个 event，两个 title 是 "单聊 · 詹育帆"（窗口起点是 peer），
  // 两个是 "单聊 · 刘昕明"（窗口起点是 me）；所有 ★ 焦点都是 詹育帆 发的
  const titles = ['单聊 · 刘昕明', '单聊 · 刘昕明', '单聊 · 詹育帆', '单聊 · 詹育帆'];
  const msgs = [
    { time: '21:06', sender: '詹育帆', content: 'a', isFocus: true },
    { time: '21:07', sender: '詹育帆', content: 'b', isFocus: true },
    { time: '21:12', sender: '詹育帆', content: 'c', isFocus: true },
    { time: '21:12', sender: '刘昕明', content: 'd', isFocus: false },
  ];
  assert.equal(pickPeerChatName(titles, msgs), '单聊 · 詹育帆');
});

test('pickPeerChatName 群聊：直接取最常见 title，不重新拼', () => {
  const titles = ['MVP 项目讨论组', 'MVP 项目讨论组', 'MVP 项目讨论组'];
  assert.equal(pickPeerChatName(titles, []), 'MVP 项目讨论组');
});

test('pickPeerChatName 候选为空 → undefined', () => {
  assert.equal(pickPeerChatName([], []), undefined);
});

test('extractChatName 去掉 imCollector 写入的 " · 新增 N 条消息" 尾巴', () => {
  assert.equal(extractChatName('单聊 · 詹育帆'), '单聊 · 詹育帆');
  assert.equal(extractChatName('单聊 · 詹育帆 · 新增 3 条消息'), '单聊 · 詹育帆');
  assert.equal(extractChatName('群 X · 新增 12 条消息'), '群 X');
  assert.equal(extractChatName(null), '(未命名会话)');
});
