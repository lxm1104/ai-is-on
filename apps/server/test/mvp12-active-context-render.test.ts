/**
 * MVP12 Step 4 — Active Context renderSummary 渲染过滤。
 *
 * 运行：npx tsx --test apps/server/test/mvp12-active-context-render.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp12-ac-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { insertMinimalEventContextUnit } = await import(
  '../src/context/contextStore.js'
);
const { tryInsertEvent } = await import('../src/db.js');
const { buildActiveContext } = await import('../src/context/activeContext.js');
import { randomUUID } from 'node:crypto';

const now = new Date().toISOString();
const evId = randomUUID();
tryInsertEvent({
  id: evId,
  source: 'im',
  source_id: 'test:' + evId,
  kind: 'group_message',
  occurred_at: now,
  title: '群里有人 @ 你',
  text: 'body',
  actor: null,
  url: null,
  raw_json: '{}',
  content_hash: evId,
  processed_at: null,
  created_at: now,
});
insertMinimalEventContextUnit({
  eventId: evId,
  scope: 'work',
  title: '群里有人 @ 你',
  content: 'body',
  occurredAt: now,
  source: 'im',
  entities: [
    { type: 'chat', name: 'lark_chat:oc_render', role: 'container', aliases: ['项目 PRD 群'] },
    { type: 'person', name: 'Alice', role: 'actor' },
    { type: 'app', name: '飞书机器人', role: 'actor' },
  ],
});

const snap = buildActiveContext({ limit: 10, budgetTokens: 5000 });

test('renderSummary does not leak lark_chat:<id>', () => {
  assert.ok(!snap.summary.includes('lark_chat:'), 'no raw chat id leaks');
});

test('renderSummary shows chat alias as group name', () => {
  assert.ok(snap.summary.includes('项目 PRD 群'), 'shows chat alias');
});

test('renderSummary does not leak app entity name (drops actor=app)', () => {
  assert.ok(
    !snap.summary.includes('飞书机器人'),
    'app entity filtered from render'
  );
});

test('renderSummary keeps person entities', () => {
  assert.ok(snap.summary.includes('Alice'));
});
