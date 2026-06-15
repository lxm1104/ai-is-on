/**
 * MVP37 — 流程蒸馏：阈值判定 + 解析 + maybeDistill（注入 judge，不真打 LLM）。
 * 不 import 排查链（readTools），独立验证蒸馏逻辑。
 *
 * Run: npx tsx --test apps/server/test/mvp37-playbook-distill.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp37-distill-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

await import('../src/db.js');
const store = await import('../src/playbook/playbookStore.js');
const { shouldDistill, maybeDistillPlaybook } = await import('../src/playbook/playbookDistillService.js');
const { parseDistillOutput } = await import('../src/playbook/playbookDistillPrompt.js');

function seedTraces(key: string, n: number) {
  for (let i = 0; i < n; i++) {
    store.insertTaskTrace({
      taskTypeKey: key, source: 'investigation', title: `T${i}`,
      steps: [
        { order: 1, kind: 'read', tool: 'search_im_messages', summary: `搜 IM ${i}` },
        { order: 2, kind: 'read', tool: 'read_doc', summary: `读文档 ${i}` },
      ],
      outcome: 'progressed',
    });
  }
}

test('shouldDistill：<3 不蒸；==3 头一次蒸；有权威版不蒸；再攒 3 条才重蒸', () => {
  assert.equal(shouldDistill(2, null), false);
  assert.equal(shouldDistill(3, null), true);
  assert.equal(shouldDistill(5, { origin: 'user', approved: true, traceCount: 0 }), false); // 人写权威
  assert.equal(shouldDistill(5, { origin: 'distilled', approved: true, traceCount: 0 }), false); // 已批准=权威
  assert.equal(shouldDistill(4, { origin: 'distilled', approved: false, traceCount: 3 }), false); // 只多1条
  assert.equal(shouldDistill(6, { origin: 'distilled', approved: false, traceCount: 3 }), true); // 多3条 → 重蒸
});

test('parseDistillOutput：合法/包裹/非法', () => {
  const ok = parseDistillOutput('{"title":"查证类标准做法","steps":[{"order":1,"intent":"搜相关 IM 确认"},{"order":2,"intent":"读关联文档"}]}');
  assert.ok(ok);
  assert.equal(ok!.steps.length, 2);
  assert.equal(parseDistillOutput('没有 JSON'), null);
  assert.equal(parseDistillOutput('{"title":"x","steps":[]}'), null); // 空步骤
});

test('maybeDistill：攒够 3 条 → 调 judge → 落 distilled 草稿(origin=distilled,approved=0)', async () => {
  const key = 'follow_up:verify';
  seedTraces(key, 3);
  const judge = async () => '{"title":"查证：先 IM 再文档","steps":[{"order":1,"intent":"搜相关 IM"},{"order":2,"intent":"读关联文档确认状态"}]}';
  const did = await maybeDistillPlaybook(key, { judge });
  assert.equal(did, true);
  const pb = store.getPlaybookByType(key)!;
  assert.equal(pb.origin, 'distilled');
  assert.equal(pb.approved, false);
  assert.equal(pb.tier, 'suggest');
  assert.equal(pb.steps.length, 2);
});

test('maybeDistill：有用户权威版 → 不蒸(judge 不被调)', async () => {
  const key = 'delivery:deliver';
  seedTraces(key, 5);
  store.userUpsertPlaybook({ taskTypeKey: key, title: '我的做法', steps: [{ order: 1, intent: '先发草稿' }] });
  let called = false;
  const judge = async () => { called = true; return '{}'; };
  const did = await maybeDistillPlaybook(key, { judge });
  assert.equal(did, false);
  assert.equal(called, false, '有权威版不该调 LLM');
  assert.equal(store.getPlaybookByType(key)!.steps[0].intent, '先发草稿');
});
