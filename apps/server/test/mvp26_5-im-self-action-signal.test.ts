/**
 * MVP26.5 unit tests: self-initiated action signal detection.
 *   - detectSelfAction: 强动作 / 工作对象链接 / mention+工作语义 / weak+disambiguator /
 *     peer-work-context 命中；casual ack、weak 单独、纯结构无文本、对方消息 不命中。
 *   - kind 变体：有对侧工作上下文 → im_self_action_with_context，否则 im_self_action。
 *   - buildSelfActionSignal: 保留 chat routing entity、skipTriage=false、actionability=record、
 *     semanticTags 标记。
 *   - 静态约束（§验收）：imCollector 不 import Matter store/matcher/reducer。
 *
 * Run: npx tsx --test apps/server/test/mvp26_5-im-self-action-signal.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  detectSelfAction,
  __selfActionInternal,
  type ImMessage,
  type SelfActionDetection,
} from '../src/collectors/imCollector.js';

const ME = 'ou_me0000000000000000000000000000';
const PEER = 'ou_peer000000000000000000000000000';

function me(content: string, extras: Partial<ImMessage> = {}): ImMessage {
  return {
    message_id: extras.message_id ?? 'mid_me',
    chat_id: 'oc_chat',
    create_time: '2026-06-01 10:00',
    message_position: '1',
    msg_type: 'text',
    content,
    is_me: true,
    sender: { id: ME, id_type: 'open_id', name: '刘昕明' },
    ...extras,
  };
}
function peer(content: string): ImMessage {
  return {
    message_id: 'mid_peer',
    chat_id: 'oc_chat',
    create_time: '2026-06-01 09:00',
    message_position: '0',
    msg_type: 'text',
    content,
    is_me: false,
    sender: { id: PEER, id_type: 'open_id', name: '对方' },
  };
}

function fire(content: string, ctx: ImMessage[] = []): SelfActionDetection {
  const m = me(content);
  const det = detectSelfAction(m, [...ctx, m], ME);
  assert.ok(det, `应命中 self-action: ${content}`);
  return det!;
}
function noFire(content: string, ctx: ImMessage[] = []): void {
  const m = me(content);
  assert.equal(detectSelfAction(m, [...ctx, m], ME), null, `不应命中: ${content}`);
}

test('T1 strong 完成态动作单独成信号', () => {
  assert.equal(fire('记忆召回的方案发你了').reason, 'strong_action_verb');
  // 正则兜底："已经…<动作>"不相邻
  assert.equal(fire('已经在群里同步了记忆召回的最新进展').reason, 'strong_action_verb');
  assert.equal(fire('已拉群，把相关同学都拉进来了').reason, 'strong_action_verb');
});

test('T2 工作对象链接（飞书 doc/任务）成信号', () => {
  const det = fire('记忆召回设计 https://x.feishu.cn/docx/abcdEFGH1234 你看下');
  assert.equal(det.reason, 'work_object_link');
});

test('T3 mention + 工作语义成信号', () => {
  const det = fire('@_user_1 看一下记忆召回的方案排期');
  assert.equal(det.reason, 'mention_with_work_semantic');
  assert.equal(det.kind, 'im_self_action', '自言自语群无对侧工作上下文 → base kind');
});

test('T4 高频口语动词需 disambiguator', () => {
  // 有工作语义对象 → 命中
  assert.equal(fire('我来处理一下记忆召回的排期').reason, 'weak_action_verb_with_disambiguator');
  // 单独"我来" → 不命中
  noFire('我来');
  noFire('我处理');
});

test('T5 peer-work-context 触发 with_context 变体', () => {
  const ctx = [peer('记忆召回的排期确认一下')];
  const det = fire('验收标准这块我梳理一下', ctx);
  assert.equal(det.reason, 'peer_work_context');
  assert.equal(det.kind, 'im_self_action_with_context');
});

test('T6 casual / 空 / 纯结构 不成信号', () => {
  noFire('好的，收到 👌');
  noFire('哈哈哈');
  noFire('');
  noFire('   ');
});

test('T7 对方消息永不成 self-action', () => {
  const p = peer('已发你了方案');
  assert.equal(detectSelfAction(p, [p], ME), null);
});

test('T8 buildSelfActionSignal 字段：chat entity 保留 / skipTriage=false / semanticTags', () => {
  const det: SelfActionDetection = { kind: 'im_self_action_with_context', reason: 'strong_action_verb' };
  const m = me('已发你了方案', { message_id: 'mid_build', message_app_link: 'https://l/x' });
  const chatEnt = { type: 'chat', name: 'lark_chat:oc_chat', role: 'container' };
  const sig = __selfActionInternal.buildSelfActionSignal(det, m, [m], '测试群', chatEnt, {
    chatId: 'oc_chat',
    msg: m,
    contextMsgs: [m],
  });

  assert.equal(sig.kind, 'im_self_action_with_context');
  assert.equal(sig.source, 'im');
  assert.equal(sig.sourceId, 'mid_build');
  assert.equal(sig.skipTriage, false, '必须过 triage 抽 action_result');
  assert.equal(sig.actionability, 'record');
  assert.equal(sig.actor, '我');
  assert.ok(sig.entities?.some((e) => e.type === 'chat'), 'chat routing entity 必须保留');
  assert.equal(sig.semanticTags?.signal_kind, 'im_self_action_with_context');
  assert.equal(sig.semanticTags?.is_me, true);
  assert.equal(sig.semanticTags?.self_action_reason, 'strong_action_verb');
  assert.equal(typeof sig.contentHash, 'string');
  assert.equal(sig.contentHash.length, 32);
});

test('T9 §验收：imCollector 不 import Matter 模块', () => {
  const src = fs.readFileSync(
    new URL('../src/collectors/imCollector.ts', import.meta.url),
    'utf8'
  );
  assert.ok(
    !/from\s+['"][^'"]*\/matter\//.test(src),
    'imCollector 不得 import ../matter/* （collector 只产事件，不依赖 Matter）'
  );
});
