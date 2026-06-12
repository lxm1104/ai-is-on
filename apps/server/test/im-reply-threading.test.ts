/**
 * 引用回复还原（reply_to → 引用标注）。
 *
 * 真实误判案例（2026-06-12 丘晓骁单聊）：
 *   6-11 20:14  我：还得考虑图和其他文件混合出现的情况   ← 图片预览需求的收尾
 *   6-12 17:35  我：我们平时用字体有中文免费可用的么？
 *   6-12 17:36  丘晓骁：<字体清单表格链接>
 *   6-12 17:40  丘晓骁：这个有需求文档不 下周启动        ← reply_to 指向 6-11 那条
 *
 * 旧渲染按时间平铺，LLM 把"这个"读成紧邻的字体清单。修复后对话行内嵌
 * `（回复 我 2026-06-11 20:14「还得考虑图和其他文件混合出现的情况」）`，
 * 对话指向在结构上还原。被回复消息常在 2h fetch horizon 之外 → resolveReplyIndex
 * 用 messages-mget 反查（本测试注入 fetcher）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReplyIndex,
  collectUnresolvedReplyTargets,
  resolveReplyIndex,
  renderMsgContent,
  summarizeOneWithContext,
  summarizeAggregate,
  type ImMessage,
  type ReplyIndex,
} from '../src/collectors/imCollector.js';
import { parseImTextLines } from '../src/cards/contextProjection.js';

function mk(
  id: string,
  isMe: boolean,
  time: string,
  content: string,
  name: string,
  replyTo?: string | null
): ImMessage {
  return {
    message_id: id,
    create_time: time,
    content,
    is_me: isMe,
    reply_to: replyTo ?? null,
    sender: { id: isMe ? 'me' : `ou_${name}`, id_type: 'open_id', name },
    message_position: id,
  };
}

// 真实案例形状：被回复消息 (parent) 在 fetch horizon 之外，不在本地消息里。
const PARENT = mk('p1104', true, '2026-06-11 20:14', '还得考虑图和其他文件混合出现的情况', '刘昕明');
const CONVO: ImMessage[] = [
  mk('m1105', true, '2026-06-12 17:35', '我们平时用字体有中文免费可用的么？', '刘昕明'),
  mk('m1106', false, '2026-06-12 17:36', 'https://example.com/sheets/font-list', '丘晓骁'),
  mk('m1107', false, '2026-06-12 17:40', '这个有需求文档不 下周启动', '丘晓骁', 'p1104'),
];

test('renderMsgContent: 回复目标在索引中 → 内嵌引用标注（sender + 时间 + 原文片段）', () => {
  const index: ReplyIndex = new Map([['p1104', PARENT]]);
  const out = renderMsgContent(CONVO[2], index);
  assert.equal(
    out,
    '（回复 我 2026-06-11 20:14「还得考虑图和其他文件混合出现的情况」）这个有需求文档不 下周启动'
  );
});

test('renderMsgContent: 回复目标缺失 → 退化标注，仍提示「不是接着上一条说的」', () => {
  const out = renderMsgContent(CONVO[2], new Map());
  assert.equal(out, '（回复更早的一条消息）这个有需求文档不 下周启动');
});

test('renderMsgContent: 非回复消息渲染逐字节不变（无回归）', () => {
  const index: ReplyIndex = new Map([['p1104', PARENT]]);
  assert.equal(renderMsgContent(CONVO[1], index), 'https://example.com/sheets/font-list');
  const long = mk('x', false, '2026-06-12 10:00', 'a'.repeat(130), '某人');
  assert.equal(renderMsgContent(long, index), 'a'.repeat(120) + '…');
});

test('renderMsgContent: 被回复原文超长截断到 60 字', () => {
  const bigParent = mk('pp', false, '2026-06-10 09:00', 'x'.repeat(80), '张三');
  const reply = mk('rr', true, '2026-06-12 09:00', '好', '我', 'pp');
  const out = renderMsgContent(reply, new Map([['pp', bigParent]]));
  assert.ok(out.startsWith(`（回复 张三 2026-06-10 09:00「${'x'.repeat(60)}…」）好`));
});

test('collectUnresolvedReplyTargets: 去重、跳过本地已有的目标', () => {
  const msgs = [
    mk('a', false, '2026-06-12 10:00', '1', 'A'),
    mk('b', false, '2026-06-12 10:01', '2', 'B', 'a'), // 本地可解析
    mk('c', false, '2026-06-12 10:02', '3', 'C', 'p_old'), // 缺失
    mk('d', false, '2026-06-12 10:03', '4', 'D', 'p_old'), // 同一缺失目标 → 去重
  ];
  const missing = collectUnresolvedReplyTargets(msgs, buildReplyIndex(msgs));
  assert.deepEqual(missing, ['p_old']);
});

test('resolveReplyIndex: 缺失目标走 fetcher 反查并打 is_me 标', async () => {
  const fetchedRaw: ImMessage = {
    message_id: 'p1104',
    create_time: '2026-06-11 20:14',
    content: '还得考虑图和其他文件混合出现的情况',
    sender: { id: 'ou_me_open_id', id_type: 'open_id', name: '刘昕明', sender_type: 'user' },
  };
  let asked: string[] = [];
  const index = await resolveReplyIndex(CONVO, 'ou_me_open_id', async (ids) => {
    asked = ids;
    return [fetchedRaw];
  });
  assert.deepEqual(asked, ['p1104']);
  assert.equal(index.get('p1104')?.is_me, true); // tagSelf 生效 → 渲染成「我」
  assert.equal(index.get('m1106')?.message_id, 'm1106'); // 本地消息也在索引里
});

test('resolveReplyIndex: fetcher 抛错 soft-fail，本地索引照常返回', async () => {
  const index = await resolveReplyIndex(CONVO, 'ou_me_open_id', async () => {
    throw new Error('mget down');
  });
  assert.equal(index.has('p1104'), false);
  assert.equal(index.has('m1107'), true);
});

test('真实案例端到端：summarizeOneWithContext 让「这个」指向昨天的需求而非字体清单', () => {
  const index: ReplyIndex = new Map([['p1104', PARENT]]);
  const out = summarizeOneWithContext(CONVO[2], CONVO, '单聊 · 丘晓骁', index);
  assert.ok(
    out.includes(
      '★ [2026-06-12 17:40] 丘晓骁: （回复 我 2026-06-11 20:14「还得考虑图和其他文件混合出现的情况」）这个有需求文档不 下周启动'
    ),
    `focus line missing reply annotation:\n${out}`
  );
});

test('summarizeAggregate: opts.replyIndex 对预览行同样生效，novelty 计数不受影响', () => {
  const index: ReplyIndex = new Map([['p1104', PARENT]]);
  const SINCE = new Date(2026, 5, 12, 17, 30, 0).toISOString();
  const out = summarizeAggregate('单聊 · 丘晓骁', CONVO, '2026-06-12 17:30', {
    sinceIsoUtc: SINCE,
    replyIndex: index,
  });
  assert.ok(out.includes('新增 3 条'));
  assert.ok(out.includes('（回复 我 2026-06-11 20:14「还得考虑图和其他文件混合出现的情况」）'));
});

test('summarizeAggregate: 不传 opts 行为逐字节不变（历史契约）', () => {
  const plain = CONVO.map((m) => ({ ...m, reply_to: null }));
  const out = summarizeAggregate('单聊 · 丘晓骁', plain, '2026-06-12 17:30');
  assert.ok(out.includes('自 2026-06-12 17:30 以来新增 3 条消息'));
  assert.equal(out.includes('回复'), false);
});

test('UI 投影兼容：parseImTextLines 仍能解析带引用标注的对话行', () => {
  const index: ReplyIndex = new Map([['p1104', PARENT]]);
  const text = summarizeOneWithContext(CONVO[2], CONVO, '单聊 · 丘晓骁', index);
  const parsed = parseImTextLines(text);
  assert.equal(parsed.length, 3);
  const focus = parsed.find((p) => p.isFocus);
  assert.ok(focus);
  assert.equal(focus.sender, '丘晓骁');
  assert.ok(focus.content.startsWith('（回复 我 2026-06-11 20:14「'));
});
