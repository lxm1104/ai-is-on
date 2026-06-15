/**
 * MVP37 能力二「流程记忆」地基测试：任务归类键 + 轨迹存取 + playbook upsert + 排查→轨迹采集。
 *
 * Run: npx tsx --test apps/server/test/mvp37-playbook.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp37-pb-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

await import('../src/db.js'); // 触发建表
const { coarseIntent, deriveTaskTypeKey } = await import('../src/playbook/PlaybookTypes.js');
const store = await import('../src/playbook/playbookStore.js');
const { captureInvestigationTrace, investigationToSteps } = await import('../src/playbook/playbookCapture.js');

test('coarseIntent / deriveTaskTypeKey：中粒度，跨人累积', () => {
  assert.equal(coarseIntent('确认评测集是否已发给鲁升纲'), 'verify');
  assert.equal(coarseIntent('回复陈一柯模板问题'), 'reply');
  assert.equal(coarseIntent('本周交付 API 给李四'), 'deliver');
  // 同类任务（不同人）→ 相同 key，样本可累积
  const k1 = deriveTaskTypeKey({ type: 'follow_up', nextAction: '确认评测集是否已发给鲁升纲' });
  const k2 = deriveTaskTypeKey({ type: 'follow_up', nextAction: '确认方案是否已发给张三' });
  assert.equal(k1, k2);
  assert.equal(k1, 'follow_up:verify');
});

test('insertTaskTrace + list/count', () => {
  const key = 'follow_up:verify';
  store.insertTaskTrace({ taskTypeKey: key, source: 'investigation', title: 'T1', steps: [{ order: 1, kind: 'read', tool: 'search_im_messages', summary: '命中3条' }], outcome: 'progressed' });
  store.insertTaskTrace({ taskTypeKey: key, source: 'investigation', title: 'T2', steps: [{ order: 1, kind: 'read', tool: 'read_doc', summary: '读了文档' }] });
  assert.equal(store.countTracesByType(key), 2);
  const traces = store.listTracesByType(key);
  assert.equal(traces.length, 2);
  assert.equal(traces[0].steps[0].tool, 'read_doc'); // 最新在前
  assert.equal(store.countTracesByType('delivery:deliver'), 0);
});

test('upsertPlaybook：首次插入 → 二次覆盖 steps + 刷新 traceCount，tier 默认 suggest', () => {
  const key = 'follow_up:verify';
  const p1 = store.upsertPlaybook({ taskTypeKey: key, title: '查证类标准流程', steps: [{ order: 1, intent: '搜相关 IM' }], traceCount: 2, confidence: 0.6 });
  assert.equal(p1.tier, 'suggest');
  assert.equal(p1.steps.length, 1);
  const p2 = store.upsertPlaybook({ taskTypeKey: key, title: '查证类标准流程v2', steps: [{ order: 1, intent: '搜相关 IM' }, { order: 2, intent: '读关联文档确认状态' }], traceCount: 5, confidence: 0.8 });
  assert.equal(p2.id, p1.id, '同 key upsert 不新建');
  assert.equal(p2.steps.length, 2);
  assert.equal(p2.traceCount, 5);
  assert.equal(store.listPlaybooks().length, 1);
});

test('captureInvestigationTrace：toolLog → 有序 read 步骤；空 toolLog → null', () => {
  const matter = { id: 'm1', type: 'follow_up', title: '确认评测集发送', nextAction: '确认评测集是否已发给鲁升纲' };
  const result = {
    conclusion: { verdict: 'progressed' as const, confidence: 0.7, factSummary: '已发初版未见确认', evidence: [] },
    rounds: 1,
    toolLog: [
      { round: 1, tool: 'search_im_messages', params: { query: '评测集 鲁升纲' }, ok: true, summary: 'IM 搜索命中 3 条' },
      { round: 1, tool: 'read_doc', params: { token: 'dox1' }, ok: true, summary: '已读取文档' },
    ],
  };
  const trace = captureInvestigationTrace(matter, result as never);
  assert.ok(trace);
  assert.equal(trace!.taskTypeKey, 'follow_up:verify');
  assert.equal(trace!.steps.length, 2);
  assert.equal(trace!.steps[0].kind, 'read');
  assert.equal(trace!.steps[0].tool, 'search_im_messages');
  assert.match(trace!.outcome || '', /progressed/);

  // 直接 conclude（无 toolLog）→ 不记（没有流程可学）
  const none = captureInvestigationTrace(matter, { conclusion: result.conclusion, rounds: 1, toolLog: [] } as never);
  assert.equal(none, null);
});
