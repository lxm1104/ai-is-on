/**
 * MVP34 — AI 代发飞书 IM 回复（执行腿首个对外动作）。
 * 重点：目标会话/消息的确定性解析、歧义/空值拒绝、confirm 门控、lark-cli 参数正确、回写+挂链。
 * lark-cli 全程用注入 stub —— 绝不真实发送。
 *
 * Run: npx tsx --test apps/server/test/mvp34-im-reply.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp34-imreply-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const dbmod = await import('../src/db.js');
const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { insertAttentionItem, getAttentionItem } = await import('../src/attention/attentionStore.js');
const { sendImReplyFromCard, previewImReply } = await import(
  '../src/lark/larkImReplyService.js'
);

let n = 0;

function mkImEvent(opts: { chatId: string; chatName: string; messageId: string; isMe?: boolean; actor?: string; text?: string }): string {
  n += 1;
  const id = `ev-${randomUUID()}`;
  const raw = {
    chat: { chat_id: opts.chatId, name: opts.chatName },
    msg: { chat_id: opts.chatId, message_id: opts.messageId, is_me: opts.isMe ?? false },
  };
  dbmod.tryInsertEvent({
    id,
    source: 'im',
    source_id: opts.messageId,
    kind: 'group_message',
    occurred_at: new Date(Date.now() + n * 1000).toISOString(),
    title: opts.chatName,
    text: opts.text ?? `对方消息 ${n}`,
    actor: opts.actor ?? '对方',
    url: null,
    raw_json: JSON.stringify(raw),
    content_hash: `h-${id}`,
    processed_at: null,
    created_at: new Date().toISOString(),
  });
  return id;
}

// 造一条 origin.kind='event' 的 context unit 指向某 im event
function mkUnitForEvent(eventId: string): string {
  n += 1;
  return cs.upsertContextUnit({
    kind: 'commitment',
    title: `信号${n}`,
    content: `来自 IM 的信号 ${n}`,
    scope: 'work',
    origin: { kind: 'event', refId: eventId },
    silent: true,
  }).unit.id;
}

function mkAttn(opts: { signalIds: string[]; matterId?: string }): string {
  return insertAttentionItem({
    id: randomUUID(),
    generation: 1,
    llmRunId: null,
    inputHash: `hash-${randomUUID()}`,
    now: new Date().toISOString(),
    llmItem: {
      priority: 'P1',
      title: '催办：回复对方',
      why: '对方在等回复',
      signalIds: opts.signalIds,
      relatedEntityIds: [],
      relatedSpaceIds: [],
      matterId: opts.matterId,
    },
  }).id;
}

function stubCli() {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ message_id: 'om_sent_123' }), stderr: '' };
  };
  return { run, calls };
}

test('T1 解析目标：单会话 + 锚定对方消息（om_）', () => {
  const ev = mkImEvent({ chatId: 'oc_aaa', chatName: '项目群', messageId: 'om_111', actor: '李四', text: '方案啥时候给我？' });
  const unit = mkUnitForEvent(ev);
  const attnId = mkAttn({ signalIds: [unit] });
  const { target, suggestedText } = previewImReply(attnId);
  assert.equal(target.chatId, 'oc_aaa');
  assert.equal(target.chatName, '项目群');
  assert.equal(target.messageId, 'om_111');
  assert.equal(target.replyToActor, '李四');
  assert.ok(target.replyToText?.includes('方案'));
  assert.equal(typeof suggestedText, 'string');
});

test('T2 歧义拒绝：两条信号指向不同会话 → 抛错，绝不猜', () => {
  const e1 = mkImEvent({ chatId: 'oc_x', chatName: 'A群', messageId: 'om_x1' });
  const e2 = mkImEvent({ chatId: 'oc_y', chatName: 'B群', messageId: 'om_y1' });
  const attnId = mkAttn({ signalIds: [mkUnitForEvent(e1), mkUnitForEvent(e2)] });
  assert.throws(() => previewImReply(attnId), /会话不唯一/);
});

test('T3 无可回复 IM 消息 → 抛错', () => {
  const u = cs.upsertContextUnit({ kind: 'commitment', title: '无来源', content: 'x', scope: 'work', origin: { kind: 'manual', refId: `m-${randomUUID()}` }, silent: true }).unit;
  const attnId = mkAttn({ signalIds: [u.id] });
  assert.throws(() => previewImReply(attnId), /无法定位飞书会话/);
});

test('T4 公司策略：sendImReplyFromCard 一律硬禁、绝不真发（起草走 preview，用户手动发）', async () => {
  const ev = mkImEvent({ chatId: 'oc_e', chatName: 'E群', messageId: 'om_e1' });
  const attnId = mkAttn({ signalIds: [mkUnitForEvent(ev)] });
  const { run, calls } = stubCli();
  await assert.rejects(
    () => sendImReplyFromCard({ cardId: attnId, text: '收到', confirm: true }, { runLarkCli: run }),
    /公司策略不允许 AI 代发飞书消息/
  );
  assert.equal(calls.length, 0, '绝不调 lark-cli 发送');
  // 起草通道（preview，解析"回复给谁"+草稿）仍可用——这是 IM 这块保留的价值
  const { target } = previewImReply(attnId);
  assert.equal(target.chatId, 'oc_e');
});
