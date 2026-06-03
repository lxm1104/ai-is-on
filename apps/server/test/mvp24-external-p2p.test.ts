/**
 * MVP24 unit tests: external-contact p2p ingestion pure helpers.
 *   - selectExternalP2pChats: filter (external && normal && p2p && has id) + hard cap
 *   - p2pChatDisplayName: external real name + （外部）marker, else derivePeerChatName fallback
 *   - mergeMessagesByMessageId: defensive dedup when internal + external share message_id
 *
 * spawn-lark-cli functions (listExternalP2pChats / collect) are NOT unit-tested —
 * covered by the end-to-end replay. Same test boundary as MVP16-A.
 *
 * Run: npx tsx --test apps/server/test/mvp24-external-p2p.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectExternalP2pChats,
  p2pChatDisplayName,
  mergeMessagesByMessageId,
  type ImMessage,
} from '../src/collectors/imCollector.js';

type ChatListChat = {
  chat_id?: string;
  name?: string;
  external?: boolean;
  chat_status?: string;
  chat_mode?: string;
};

function mkChat(over: Partial<ChatListChat> = {}): ChatListChat {
  return {
    chat_id: 'oc_x',
    name: 'someone',
    external: true,
    chat_status: 'normal',
    chat_mode: 'p2p',
    ...over,
  };
}

function mkMsg(id: string, senderId: string, name: string): ImMessage {
  return {
    message_id: id,
    chat_id: 'oc_chat',
    create_time: '2026-05-26 16:00',
    message_position: '100',
    msg_type: 'text',
    content: 'hi',
    sender: { id: senderId, id_type: 'open_id', name },
  };
}

// ---------- selectExternalP2pChats ----------

test('selectExternalP2pChats: keeps only normal external p2p chats with id', () => {
  const chats: ChatListChat[] = [
    mkChat({ chat_id: 'oc_ext1' }), // keep
    mkChat({ chat_id: 'oc_int', external: false }), // drop: internal
    mkChat({ chat_id: 'oc_dismissed', chat_status: 'dismissed' }), // drop: not normal
    mkChat({ chat_id: 'oc_group', chat_mode: 'group' }), // drop: not p2p
    mkChat({ chat_id: undefined }), // drop: no id
    mkChat({ chat_id: 'oc_ext2' }), // keep
  ];
  const out = selectExternalP2pChats(chats, 100);
  assert.deepEqual(
    out.map((c) => c.chat_id),
    ['oc_ext1', 'oc_ext2']
  );
});

test('selectExternalP2pChats: enforces hard cap, keeping the first N (ByActiveTimeDesc order)', () => {
  const chats: ChatListChat[] = Array.from({ length: 30 }, (_, i) =>
    mkChat({ chat_id: `oc_ext${i}` })
  );
  const out = selectExternalP2pChats(chats, 20);
  assert.equal(out.length, 20);
  assert.equal(out[0].chat_id, 'oc_ext0');
  assert.equal(out[19].chat_id, 'oc_ext19');
});

test('selectExternalP2pChats: chat_mode absent is allowed (only excluded when explicitly non-p2p)', () => {
  const out = selectExternalP2pChats([mkChat({ chat_id: 'oc_ext', chat_mode: undefined })], 10);
  assert.equal(out.length, 1);
});

// ---------- p2pChatDisplayName ----------

test('p2pChatDisplayName: external name hit → 「单聊 · X（外部）」', () => {
  const names = new Map<string, string>([['oc_ext', '昕明儿']]);
  const out = p2pChatDisplayName('oc_ext', [], names);
  assert.equal(out, '单聊 · 昕明儿（外部）');
});

test('p2pChatDisplayName: no external name → falls back to derivePeerChatName (sender name)', () => {
  const names = new Map<string, string>();
  const msgs = [mkMsg('m1', 'ou_peer', '王晨')];
  const out = p2pChatDisplayName('oc_int', msgs, names);
  assert.equal(out, '单聊 · 王晨');
  assert.ok(!out.includes('（外部）'));
});

// ---------- mergeMessagesByMessageId (defensive) ----------

test('mergeMessagesByMessageId: internal + external sharing a message_id keeps one (first wins)', () => {
  const internal = [mkMsg('shared', 'ou_a', 'A'), mkMsg('only_int', 'ou_a', 'A')];
  const external = [mkMsg('shared', 'ou_b', 'B'), mkMsg('only_ext', 'ou_b', 'B')];
  const merged = mergeMessagesByMessageId(internal, external);
  assert.deepEqual(
    merged.map((m) => m.message_id),
    ['shared', 'only_int', 'only_ext']
  );
  // first occurrence (internal) wins for the shared id
  assert.equal(merged.find((m) => m.message_id === 'shared')?.sender?.id, 'ou_a');
});
