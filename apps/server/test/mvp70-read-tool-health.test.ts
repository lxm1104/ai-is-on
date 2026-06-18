/**
 * MVP70 — AI 感官健康自检 tripwire：近期飞书读取几乎全空 → 升去重系统提醒。
 * Run: npx tsx --test apps/server/test/mvp70-read-tool-health.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp70h-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const h = await import('../src/investigation/readToolHealth.js');

test('MVP70 isSensingLikelyBroken：样本够多+坏比例高才报警', () => {
  assert.equal(h.isSensingLikelyBroken({ total: 5, badRate: 1 }), false, '样本太少不报');
  assert.equal(h.isSensingLikelyBroken({ total: 20, badRate: 0.5 }), false, '一半命中不报');
  assert.equal(h.isSensingLikelyBroken({ total: 20, badRate: 0.95 }), true, '够多+几乎全空→报');
});

test('MVP70 EMPTY_RE：命中 0 条算空，10 条不算', () => {
  // 通过 record + getReadToolHealth 间接验证
  for (let i = 0; i < 13; i++) h.recordReadOutcome('search_im_messages', true, '命中 0 条');
  h.recordReadOutcome('search_im_messages', true, '命中 10 条'); // 不应算空
  const st = h.getReadToolHealth();
  assert.equal(st.bad, 13, '"命中 0 条"×13 算坏，"命中 10 条"不算');
  assert.ok(st.total >= 14);
});

test('MVP70 maybeAlertReadToolHealth：坏到阈值→升卡；去重不叠', () => {
  // 此时窗口里已有 13 空 + 1 命中（上一个测试）。badRate=13/14≈0.93 ≥0.9，total≥12 → 应报警
  const raised = h.maybeAlertReadToolHealth();
  assert.equal(raised, true, '应升健康提醒卡');
  const card = db.db.prepare(`SELECT title, why FROM attention_items WHERE input_hash=?`).get(h.READ_TOOL_HEALTH_HASH) as any;
  assert.ok(card);
  assert.match(card.title, /飞书读取疑似失效/);
  assert.match(card.why, /lark-cli/);
  // 去重：再调一次不叠
  assert.equal(h.maybeAlertReadToolHealth(), false, '已有 live 提醒→不叠');
});

test('MVP70 recordReadOutcome：run_command 等非感官工具不计入', () => {
  const before = h.getReadToolHealth().total;
  h.recordReadOutcome('run_command', true, 'whatever');
  assert.equal(h.getReadToolHealth().total, before, 'run_command 不进感官窗口');
});
