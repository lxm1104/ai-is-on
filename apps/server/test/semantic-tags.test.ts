/**
 * MVP11.0-a：encodeSemanticTags / decodeSemanticTags 往返 + 容错。
 * 运行：npx tsx --test apps/server/test/semantic-tags.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSemanticTags,
  encodeSemanticTags,
} from '../src/context/semanticTags.js';

test('encode → decode 往返', () => {
  const tags = {
    signal_kind: 'doc_comment',
    is_at_me: true,
    author_is_self: false,
    content_hash_bucket: 'a1b2c3d4e5f60718',
  };
  const enc = encodeSemanticTags(tags, '别人在你的权威文档评论了');
  const { tags: dec, plainMeaning } = decodeSemanticTags(enc);
  assert.deepEqual(dec, tags);
  assert.equal(plainMeaning, '别人在你的权威文档评论了');
});

test('encode 不带 plainMeaning', () => {
  const tags = { signal_kind: 'doc_comment' };
  const enc = encodeSemanticTags(tags);
  assert.match(enc, /^\[tags:[A-Za-z0-9_-]+\]$/);
  const { tags: dec, plainMeaning } = decodeSemanticTags(enc);
  assert.deepEqual(dec, tags);
  assert.equal(plainMeaning, '');
});

test('decode 无前缀 → tags={} + plainMeaning=原串', () => {
  const r = decodeSemanticTags('普通 meaning 文本');
  assert.deepEqual(r.tags, {});
  assert.equal(r.plainMeaning, '普通 meaning 文本');
});

test('decode 空 / null / undefined → 全空', () => {
  for (const s of [null, undefined, '']) {
    const r = decodeSemanticTags(s);
    assert.deepEqual(r.tags, {});
    assert.equal(r.plainMeaning, '');
  }
});

test('decode 前缀格式坏掉 → 整串当 plainMeaning', () => {
  // base64url 解出来不是 JSON
  const r = decodeSemanticTags('[tags:!!!notb64!!!] hi');
  assert.deepEqual(r.tags, {});
  // 解析失败 → 整串返回
  assert.equal(r.plainMeaning, '[tags:!!!notb64!!!] hi');
});

test('decode 前缀解出来是数组 → 整串当 plainMeaning', () => {
  const enc = Buffer.from(JSON.stringify(['x', 'y']), 'utf8').toString('base64url');
  const r = decodeSemanticTags(`[tags:${enc}] hi`);
  assert.deepEqual(r.tags, {});
  assert.equal(r.plainMeaning, `[tags:${enc}] hi`);
});

test('encode 包含 unicode 不丢失', () => {
  const tags = { signal_kind: 'doc_comment', author_name: '张三李四' };
  const enc = encodeSemanticTags(tags, '权威文档：项目 X');
  const { tags: dec, plainMeaning } = decodeSemanticTags(enc);
  assert.deepEqual(dec, tags);
  assert.equal(plainMeaning, '权威文档：项目 X');
});
