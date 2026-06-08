/**
 * MVP30: render-context lookback decoupled from the trigger window.
 *
 * The collector now fetches p2p over a wider [now-lookback, now] window so the user's
 * OWN earlier turns are visible as context, but gates "新增" on the [since, now] trigger
 * window. This test pins the rendering contract that makes that safe:
 *   - summarizeAggregate(.., opts) counts ONLY messages newer than the novelty boundary,
 *     yet still renders the older 「我」 context line (so triage can see I already engaged).
 *   - Without opts the old behavior is byte-for-byte unchanged (group path + history).
 *
 * This is the exact 展弘 shape: I ask earlier, peer answers 3× in the next window. Before
 * the fix the burst rendered peer-only ("新增 3 条", no 「我」) → false "查看并回复" card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeAggregate,
  sliceContextAndNovelty,
  type ImMessage,
} from '../src/collectors/imCollector.js';

function mk(
  id: string,
  isMe: boolean,
  time: string,
  content: string,
  name: string
): ImMessage {
  return {
    message_id: id,
    create_time: time,
    content,
    is_me: isMe,
    sender: { id: isMe ? 'me' : name, id_type: 'open_id', name },
    message_position: id,
  };
}

// 「我」asks at 11:30 (prior window), peer answers 3× at 11:47 (this window).
const CONVO: ImMessage[] = [
  mk('a', true, '2026-06-08 11:30', 'chatbot 的 agent loop 有文档吗', '刘昕明'),
  mk('b', false, '2026-06-08 11:47', '俺不知道', '宋展泓'),
  mk('c', false, '2026-06-08 11:47', '这个让 rd 同学自己搞的', '宋展泓'),
  mk('d', false, '2026-06-08 11:47', '可以直接问@王奕迪', '宋展泓'),
];
// novelty boundary between the two windows (11:45). Built the same way parseCreateTime
// builds its values (local Date → toISOString), so the comparison is TZ-stable.
const SINCE = new Date(2026, 5, 8, 11, 45, 0).toISOString();

test('summarizeAggregate(opts): 新增 counts only post-boundary msgs, not the carried-over 我 turn', () => {
  const out = summarizeAggregate('单聊 · 宋展泓', CONVO, '2026-06-08 11:45', {
    sinceIsoUtc: SINCE,
  });
  // 3 peer messages are new — NOT 4 (my earlier question must not inflate the count).
  assert.ok(out.includes('新增 3 条'), `expected 新增 3 条, got:\n${out}`);
  assert.equal(out.includes('新增 4 条'), false);
});

test('summarizeAggregate(opts): the older 「我」 context line is still rendered for triage', () => {
  const out = summarizeAggregate('单聊 · 宋展泓', CONVO, '2026-06-08 11:45', {
    sinceIsoUtc: SINCE,
  });
  // The whole point: my earlier turn is visible, so triage can tell I initiated/engaged.
  assert.ok(out.includes('我: chatbot 的 agent loop 有文档吗'), `missing 我 line:\n${out}`);
  assert.ok(out.includes('宋展泓: 俺不知道'));
  assert.ok(out.includes('宋展泓: 可以直接问@王奕迪'));
});

test('summarizeAggregate(): no-opts path unchanged — counts all msgs (group/back-compat)', () => {
  const out = summarizeAggregate('单聊 · 宋展泓', CONVO, '2026-06-08 11:00');
  assert.ok(out.includes('新增 4 条'));
  assert.equal(out.includes('供判断我是否已参与'), false); // no MVP30 banner without opts
});

test('summarizeAggregate(opts): all-new conversation counts every message', () => {
  const allNew = CONVO.map((m) => ({ ...m, create_time: '2026-06-08 11:47' }));
  const out = summarizeAggregate('单聊 · 宋展泓', allNew, '2026-06-08 11:45', {
    sinceIsoUtc: SINCE,
  });
  assert.ok(out.includes('新增 4 条'));
});

// ---------- sliceContextAndNovelty: by-COUNT context, not by-time ----------

function seq(n: number, isMeAt: (i: number) => boolean, baseMin = 0): ImMessage[] {
  // i-th message at 10:(baseMin+i); all well before SINCE (11:45) unless baseMin pushes past it.
  return Array.from({ length: n }, (_, i) =>
    mk(`m${i}`, isMeAt(i), `2026-06-08 10:${String(baseMin + i).padStart(2, '0')}`, `c${i}`, 'x')
  );
}

test('sliceContextAndNovelty: trims context to the last N messages (by count, not time)', () => {
  const msgs = seq(30, () => false); // 30 old peer msgs, none novel vs SINCE
  const { ctx, novelMsgs } = sliceContextAndNovelty(msgs, SINCE, 20);
  assert.equal(ctx.length, 20, 'context capped at N=20');
  assert.equal(ctx[0].message_id, 'm10', 'keeps the most-recent 20 (m10..m29)');
  assert.equal(ctx[ctx.length - 1].message_id, 'm29');
  assert.equal(novelMsgs.length, 0, 'all older than boundary → nothing novel → caller skips');
});

test('sliceContextAndNovelty: novel ⊆ ctx even when a burst exceeds N (no triggering msg dropped)', () => {
  // 5 old context msgs + 25 brand-new ones (after boundary). N=20 < 25 novel.
  const old = seq(5, () => false); // 10:00..10:04, pre-boundary
  const fresh = Array.from({ length: 25 }, (_, i) =>
    mk(`n${i}`, false, '2026-06-08 11:50', `f${i}`, 'x')
  );
  const { ctx, novelMsgs } = sliceContextAndNovelty([...old, ...fresh], SINCE, 20);
  // ctx must expand to max(N, novelCount)=25 so all 25 novel survive the trim.
  assert.equal(novelMsgs.length, 25, 'every novel message retained for triggering');
  assert.ok(ctx.length >= 25);
  assert.equal(novelMsgs.every((m) => ctx.includes(m)), true, 'novel ⊆ ctx');
});

test('sliceContextAndNovelty: short conversation passes through untouched', () => {
  const { ctx, novelMsgs } = sliceContextAndNovelty(CONVO, SINCE, 20);
  assert.equal(ctx.length, 4);
  assert.deepEqual(
    novelMsgs.map((m) => m.message_id),
    ['b', 'c', 'd'],
    'the 3 post-boundary peer replies are novel; my earlier 11:30 turn is context-only'
  );
});
