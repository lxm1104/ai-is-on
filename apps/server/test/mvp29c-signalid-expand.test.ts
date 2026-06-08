/**
 * MVP29C — signalId 截断还原：attention 的 LLM 偶尔把 signalId 缩成 8 位前缀落库，
 * 导致"查看原始信息"按 id 精确匹配查不到 → 显示"未解析的 signal / 无原文链接"。
 * 修复：expandTruncatedId 按唯一前缀还原成完整 id；resolver 读时兜底 + parse 写时还原。
 *
 * Run: npx tsx --test apps/server/test/mvp29c-signalid-expand.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp29c-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const proj = await import('../src/cards/contextProjection.js');
const prompt = await import('../src/attention/attentionPrompt.js');

const NOW = new Date('2026-06-05T09:00:00Z').toISOString();
const FULL = 'aaaaaaaa-1111-2222-3333-444444444444'; // prefix: aaaaaaaa

function insertUnit(id: string, title: string) {
  db.db
    .prepare(
      `INSERT INTO context_units
        (id, scope, origin_kind, origin_ref_id, kind, title, content, created_at, updated_at)
       VALUES (?, 'work', 'manual', ?, 'commitment', ?, ?, ?, ?)`
    )
    .run(id, `origin-${id}`, title, `content of ${title}`, NOW, NOW);
}

test('T1 expandTruncatedId：8 位前缀唯一命中 → 还原完整 id', () => {
  insertUnit(FULL, '查看评测集');
  assert.equal(db.expandTruncatedId('aaaaaaaa'), FULL);
});

test('T2 expandTruncatedId：完整 id / 非 uuid token / 查不到 → 原样返回', () => {
  assert.equal(db.expandTruncatedId(FULL), FULL, '完整 id 不动');
  assert.equal(db.expandTruncatedId('zzzzzzzz'), 'zzzzzzzz', '非十六进制不动');
  assert.equal(db.expandTruncatedId('deadbeef'), 'deadbeef', '查不到不动');
});

test('T3 expandTruncatedId：前缀歧义（命中多行）→ 不猜，原样返回', () => {
  insertUnit('bbbbbbbb-1111-2222-3333-444444444444', '歧义A');
  insertUnit('bbbbbbbb-9999-8888-7777-666666666666', '歧义B');
  assert.equal(db.expandTruncatedId('bbbbbbbb'), 'bbbbbbbb');
});

test('T4 resolveAttentionSignalDetails：截断前缀不再 unknown，回到 context_unit', () => {
  const [d] = proj.resolveAttentionSignalDetails(['aaaaaaaa']);
  assert.notEqual(d.kind, 'unknown', '截断前缀应被还原后解析');
  assert.equal(d.kind, 'context_unit');
  assert.equal(d.title, '查看评测集');
});

test('T5 resolveAttentionSignalDetails：真不存在的 id 仍优雅降级为 unknown', () => {
  const [d] = proj.resolveAttentionSignalDetails(['00000000']);
  assert.equal(d.kind, 'unknown');
});

test('T6 parseAttentionOutput：落库前把截断 signalId 还原成完整 id', () => {
  const out = prompt.parseAttentionOutput(
    JSON.stringify({ items: [{ priority: 'P1', title: 'T', why: 'w', signalIds: ['aaaaaaaa'] }] })
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].signalIds, [FULL]);
});
