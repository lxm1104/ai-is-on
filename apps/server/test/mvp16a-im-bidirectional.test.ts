/**
 * MVP16-A unit tests: bidirectional IM message ingestion helpers.
 *   - flattenThreadReplies: inline thread reply structure → flat sequence
 *   - tagSelf: is_me derived from sender.id match
 *   - sortMessagesStably: same create_time → message_position breaks tie
 *   - prepareMessages: full pipeline + IM_INCLUDE_MY_MESSAGES kill switch
 *   - summarizeAggregate: <=12 msgs show all; >12 → first + ellipsis + last 11
 *
 * Run: npx tsx --test apps/server/test/mvp16a-im-bidirectional.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenThreadReplies,
  tagSelf,
  sortMessagesStably,
  prepareMessages,
  summarizeAggregate,
  summarizeOneWithContext,
  mergeMessagesByMessageId,
  SUMMARY_TAIL_MAX,
  type ImMessage,
} from '../src/collectors/imCollector.js';

const ME = 'ou_me0000000000000000000000000000';
const PEER = 'ou_peer000000000000000000000000000';
const PEER2 = 'ou_peer2222222222222222222222222222';

function mk(
  id: string,
  senderId: string,
  createTime: string,
  position: string,
  content = 'hi',
  extras: Partial<ImMessage> = {}
): ImMessage {
  return {
    message_id: id,
    chat_id: extras.chat_id ?? 'oc_chat',
    create_time: createTime,
    message_position: position,
    msg_type: 'text',
    content,
    sender: { id: senderId, id_type: 'open_id', name: senderId === ME ? '刘昕明' : '对方' },
    ...extras,
  };
}

// ---------- flattenThreadReplies ----------

test('flattenThreadReplies: parent with 2 replies → 3 items in parent-first order', () => {
  const parent = mk('m1', PEER, '2026-05-26 16:00', '100', 'parent');
  parent.thread_id = 't1';
  parent.thread_replies = [
    mk('r1', ME, '2026-05-26 16:01', '101', 'reply 1'),
    mk('r2', PEER, '2026-05-26 16:02', '102', 'reply 2'),
  ];
  const out = flattenThreadReplies([parent]);
  assert.equal(out.length, 3);
  assert.equal(out[0].message_id, 'm1');
  assert.equal(out[1].message_id, 'r1');
  assert.equal(out[2].message_id, 'r2');
});

test('flattenThreadReplies: reply inherits chat_id and thread_id from parent', () => {
  const parent = mk('m1', PEER, '2026-05-26 16:00', '100', 'p', { chat_id: 'oc_x' });
  parent.thread_id = 't1';
  parent.thread_replies = [
    {
      message_id: 'r1',
      sender: { id: ME },
      content: 'r',
      // intentionally no chat_id / thread_id — should be inherited
    },
  ];
  const out = flattenThreadReplies([parent]);
  assert.equal(out[1].chat_id, 'oc_x');
  assert.equal(out[1].thread_id, 't1');
});

test('flattenThreadReplies: no thread_replies → unchanged', () => {
  const m1 = mk('m1', PEER, '2026-05-26 16:00', '100');
  const m2 = mk('m2', PEER, '2026-05-26 16:01', '101');
  const out = flattenThreadReplies([m1, m2]);
  assert.equal(out.length, 2);
  assert.equal(out[0].message_id, 'm1');
});

// ---------- tagSelf ----------

test('tagSelf: marks is_me when sender.id matches myOpenId', () => {
  const msgs = [
    mk('m1', ME, '2026-05-26 16:00', '100'),
    mk('m2', PEER, '2026-05-26 16:01', '101'),
    mk('m3', ME, '2026-05-26 16:02', '102'),
  ];
  tagSelf(msgs, ME);
  assert.equal(msgs[0].is_me, true);
  assert.equal(msgs[1].is_me, false);
  assert.equal(msgs[2].is_me, true);
});

test('tagSelf: missing sender treated as not-me', () => {
  const msgs: ImMessage[] = [{ message_id: 'm1', sender: undefined }];
  tagSelf(msgs, ME);
  assert.equal(msgs[0].is_me, false);
});

// ---------- sortMessagesStably ----------

test('sortMessagesStably: equal create_time sorted by message_position asc', () => {
  // Reproduce the exact 5/26 程圣淳 case: 16:14 messages with positions
  // 156, 157, 158, 162, 159 (out of order in raw_json).
  const raw = [
    mk('a', PEER, '2026-05-26 16:14', '158'),
    mk('b', PEER, '2026-05-26 16:14', '156'),
    mk('c', PEER, '2026-05-26 16:14', '162'),
    mk('d', PEER, '2026-05-26 16:14', '157'),
    mk('e', PEER, '2026-05-26 16:14', '159'),
  ];
  const sorted = sortMessagesStably(raw);
  assert.deepEqual(
    sorted.map((m) => m.message_position),
    ['156', '157', '158', '159', '162']
  );
});

test('sortMessagesStably: different create_time wins over message_position', () => {
  const raw = [
    mk('a', PEER, '2026-05-26 16:15', '50'),
    mk('b', PEER, '2026-05-26 16:14', '99'),
  ];
  const sorted = sortMessagesStably(raw);
  assert.deepEqual(
    sorted.map((m) => m.message_id),
    ['b', 'a']
  );
});

test('sortMessagesStably: missing message_position treated as 0', () => {
  const raw: ImMessage[] = [
    { message_id: 'a', create_time: '2026-05-26 16:14', sender: { id: PEER } },
    { message_id: 'b', create_time: '2026-05-26 16:14', message_position: '5', sender: { id: PEER } },
  ];
  const sorted = sortMessagesStably(raw);
  // a has implicit 0, comes before b's 5
  assert.equal(sorted[0].message_id, 'a');
});

// ---------- prepareMessages: full pipeline ----------

test('prepareMessages: flattens + tags + sorts + filters', () => {
  const parent = mk('m1', PEER, '2026-05-26 16:00', '100');
  parent.thread_replies = [mk('r1', ME, '2026-05-26 16:00', '101')];
  const raw = [
    mk('m2', ME, '2026-05-26 15:59', '99'),
    parent,
    { message_id: undefined, sender: { id: PEER } } as ImMessage, // dropped by isWanted
    mk('m3', PEER, '2026-05-26 16:01', '102'),
  ];
  const out = prepareMessages(raw, ME);
  assert.equal(out.length, 4);
  assert.deepEqual(
    out.map((m) => m.message_id),
    ['m2', 'm1', 'r1', 'm3']
  );
  // is_me correctly tagged across flattened replies
  assert.equal(out[0].is_me, true); // m2
  assert.equal(out[1].is_me, false); // m1
  assert.equal(out[2].is_me, true); // r1 (reply was from me)
  assert.equal(out[3].is_me, false); // m3
});

test('prepareMessages: deleted / system msgs dropped', () => {
  const raw = [
    mk('m1', PEER, '2026-05-26 16:00', '100'),
    { ...mk('m2', PEER, '2026-05-26 16:01', '101'), deleted: true },
    { ...mk('m3', PEER, '2026-05-26 16:02', '102'), msg_type: 'system' },
  ];
  const out = prepareMessages(raw, ME);
  assert.deepEqual(
    out.map((m) => m.message_id),
    ['m1']
  );
});

test('prepareMessages: IM_INCLUDE_MY_MESSAGES=false drops all me-side', async () => {
  // Override config via env before reimport. Vitest-style isolation isn't
  // available with node:test, so we mutate the imported config object.
  const cfgModule = await import('../src/config.js');
  const original = cfgModule.config.imIncludeMyMessages;
  (cfgModule.config as any).imIncludeMyMessages = false;
  try {
    const raw = [
      mk('m1', PEER, '2026-05-26 16:00', '100'),
      mk('m2', ME, '2026-05-26 16:01', '101'),
      mk('m3', PEER, '2026-05-26 16:02', '102'),
    ];
    const out = prepareMessages(raw, ME);
    assert.deepEqual(
      out.map((m) => m.message_id),
      ['m1', 'm3']
    );
  } finally {
    (cfgModule.config as any).imIncludeMyMessages = original;
  }
});

// ---------- summarizeAggregate ----------

test('summarizeAggregate: short conversation (<= TAIL_MAX) → all msgs shown', () => {
  const msgs = [
    { ...mk('a', PEER, '2026-05-26 16:00', '100', '你好'), is_me: false },
    { ...mk('b', ME, '2026-05-26 16:01', '101', '在'), is_me: true },
    { ...mk('c', PEER, '2026-05-26 16:02', '102', '查下这个'), is_me: false },
  ];
  const out = summarizeAggregate('单聊 · 程圣淳', msgs, '2026-05-26 15:59');
  assert.ok(out.includes('单聊 · 程圣淳'));
  assert.ok(out.includes('新增 3 条'));
  // Each msg present with role prefix
  assert.ok(out.includes('对方: 你好'));
  assert.ok(out.includes('我: 在'));
  assert.ok(out.includes('对方: 查下这个'));
  // No ellipsis for short transcripts
  assert.equal(out.includes('中间省略'), false);
});

test('summarizeAggregate: long conversation (> TAIL_MAX) → first + ellipsis + last (TAIL_MAX-1)', () => {
  const N = SUMMARY_TAIL_MAX + 5; // 17 messages, 5 will be elided
  const msgs: ImMessage[] = [];
  for (let i = 0; i < N; i++) {
    msgs.push({
      ...mk(`m${i}`, i % 2 === 0 ? PEER : ME, `2026-05-26 16:${String(i).padStart(2, '0')}`, String(100 + i), `c${i}`),
      is_me: i % 2 === 1,
    });
  }
  const out = summarizeAggregate('chat', msgs, '2026-05-26 15:00');
  // First message present
  assert.ok(out.includes('c0'));
  // Last message present
  assert.ok(out.includes(`c${N - 1}`));
  // Ellipsis with skipped count = N - TAIL_MAX = 5
  assert.ok(out.includes('中间省略 5 条'));
  // Elided range NOT present
  assert.equal(out.includes('c3'), false);
  assert.equal(out.includes('c4'), false);
});

// ---------- mergeMessagesByMessageId ----------

test('mergeMessagesByMessageId: dedup by message_id keeps first occurrence', () => {
  const peer = [
    mk('a', PEER, '2026-05-26 16:00', '100'),
    mk('shared', PEER, '2026-05-26 16:01', '101'),
  ];
  const mine = [
    mk('shared', ME, '2026-05-26 16:01', '101'),  // same id, would clobber
    mk('b', ME, '2026-05-26 16:02', '102'),
  ];
  const out = mergeMessagesByMessageId(peer, mine);
  assert.deepEqual(
    out.map((m) => m.message_id),
    ['a', 'shared', 'b']
  );
  // First occurrence wins — the 'shared' kept is from `peer`
  assert.equal(out[1].sender?.id, PEER);
});

test('mergeMessagesByMessageId: drops msgs without message_id', () => {
  const out = mergeMessagesByMessageId(
    [mk('a', PEER, '2026-05-26 16:00', '100'), { sender: { id: PEER } } as ImMessage],
    [mk('b', ME, '2026-05-26 16:01', '101')]
  );
  assert.equal(out.length, 2);
});

test('mergeMessagesByMessageId: empty streams → empty output', () => {
  assert.deepEqual(mergeMessagesByMessageId([], []), []);
  assert.deepEqual(mergeMessagesByMessageId(), []);
});

// ---------- summarizeOneWithContext ----------

test('summarizeOneWithContext: focused msg marked with ★, surrounding both sides', () => {
  // Reproduce the exact 程圣淳 scenario: 2 peer msgs, 3 me replies, in between.
  const chat: ImMessage[] = [
    { ...mk('m173', PEER, '2026-05-26 18:17', '173', '[Image: ...]'), is_me: false },
    { ...mk('m174', PEER, '2026-05-26 18:18', '174', 'skill 用不了'), is_me: false },
    { ...mk('m175', ME, '2026-05-26 18:19', '175', '你的 user id 是多少'), is_me: true },
    { ...mk('m176', ME, '2026-05-26 18:19', '176', '沙箱不能访问公司内网'), is_me: true },
    { ...mk('m177', ME, '2026-05-26 18:19', '177', '这个很无语..'), is_me: true },
  ];
  const focused = chat[1]; // m174 是触发信号的那条
  const out = summarizeOneWithContext(focused, chat, '单聊 · 程圣淳');
  // Focus marker on m174
  const focusLine = out.split('\n').find((l) => l.startsWith('★'))!;
  assert.ok(focusLine.includes('skill 用不了'));
  assert.ok(focusLine.includes('对方'));
  // Both sides represented in the rendered window
  assert.ok(out.includes('我: 你的 user id 是多少'));
  assert.ok(out.includes('我: 沙箱不能访问公司内网'));
  assert.ok(out.includes('焦点消息：对方'));
});

test('summarizeOneWithContext: long chat centers window on focus', () => {
  const N = 30;
  const chat: ImMessage[] = [];
  for (let i = 0; i < N; i++) {
    chat.push({
      ...mk(`m${i}`, i % 2 === 0 ? PEER : ME, `2026-05-26 16:${String(i).padStart(2, '0')}`, String(100 + i), `c${i}`),
      is_me: i % 2 === 1,
    });
  }
  // Focus on middle message
  const focused = chat[15];
  const out = summarizeOneWithContext(focused, chat, 'x');
  // c15 should be in output
  assert.ok(out.includes('c15'));
  // Edge messages c0 and c29 should NOT be in output (window is centered)
  assert.equal(out.includes('c0:'), false);
  assert.equal(out.includes('c29'), false);
});

test('summarizeOneWithContext: short chat shows everything', () => {
  const chat: ImMessage[] = [
    { ...mk('a', PEER, '2026-05-26 16:00', '100', 'hi'), is_me: false },
    { ...mk('b', ME, '2026-05-26 16:01', '101', 'hello'), is_me: true },
  ];
  const out = summarizeOneWithContext(chat[0], chat, 'x');
  assert.ok(out.includes('hi'));
  assert.ok(out.includes('hello'));
});

test('summarizeAggregate: line length capped at 120 + ellipsis suffix', () => {
  const longContent = 'x'.repeat(200);
  const msgs = [
    { ...mk('a', PEER, '2026-05-26 16:00', '100', longContent), is_me: false },
  ];
  const out = summarizeAggregate('chat', msgs, '2026-05-26 15:00');
  // Look for the truncation marker
  const lineWithMsg = out.split('\n').find((l) => l.startsWith('- ['))!;
  assert.ok(lineWithMsg.endsWith('…'));
  // Length sanity: prefix + 120 chars + '…' << 200
  assert.ok(lineWithMsg.length < 200);
});
