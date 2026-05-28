/**
 * sanitizeImTextForDisplay：把 imCollector 的 LLM-structured text 转成
 * "查看原始信息" 抽屉用的精简文本。覆盖 summarizeOne / summarizeOneWithContext /
 * summarizeAggregate 三种产出模板。
 *
 * 运行：npx tsx --test apps/server/test/sanitize-im-display.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeImTextForDisplay } from '../src/cards/contextProjection.js';

test('null / empty → empty string', () => {
  assert.equal(sanitizeImTextForDisplay(''), '');
});

test('summarizeOneWithContext 单聊单消息：去 metadata，保留 ★ 行', () => {
  const raw = [
    '会话：单聊 · 詹育帆',
    '焦点消息：詹育帆 @ 2026-05-27 21:07',
    '---',
    '★ [2026-05-27 21:07] 詹育帆: 这里肯定有问题',
  ].join('\n');
  assert.equal(sanitizeImTextForDisplay(raw), '★ 詹育帆: 这里肯定有问题');
});

test('summarizeOneWithContext 多轮对话：保留每行 sender:content，去时间', () => {
  const raw = [
    '会话：单聊 · 詹育帆',
    '焦点消息：詹育帆 @ 2026-05-27 21:12',
    '---',
    '- [2026-05-27 21:06] 詹育帆: 你好',
    '- [2026-05-27 21:07] 詹育帆: 这里肯定有问题',
    '- [2026-05-27 21:12] 刘昕明: 嗯',
    '★ [2026-05-27 21:12] 詹育帆: 急',
  ].join('\n');
  const cleaned = sanitizeImTextForDisplay(raw);
  assert.equal(
    cleaned,
    [
      '詹育帆: 你好',
      '詹育帆: 这里肯定有问题',
      '刘昕明: 嗯',
      '★ 詹育帆: 急',
    ].join('\n')
  );
});

test('summarizeAggregate 群聊聚合：去顶部 banner，保留每行内容', () => {
  const raw = [
    '会话：单聊 · 詹育帆',
    '自 2026-05-27 20:00 以来新增 3 条消息',
    '---',
    '- [2026-05-27 21:06] 詹育帆: 第一条',
    '- ……（中间省略 5 条）……',
    '- [2026-05-27 21:12] 詹育帆: 最后一条',
  ].join('\n');
  const cleaned = sanitizeImTextForDisplay(raw);
  assert.equal(
    cleaned,
    [
      '詹育帆: 第一条',
      '……（中间省略 5 条）……',
      '詹育帆: 最后一条',
    ].join('\n')
  );
});

test('summarizeOne 单条快照：去 metadata，保留正文', () => {
  const raw = [
    '会话：单聊 · 詹育帆',
    '发送者：詹育帆（user）',
    '时间：2026-05-27 21:07',
    '内容：这里肯定有问题',
  ].join('\n');
  assert.equal(sanitizeImTextForDisplay(raw), '这里肯定有问题');
});
