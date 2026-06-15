/**
 * MVP36 — 自主排查执行循环 + 解析。judge/runTool 全注入，不打真 LLM/lark-cli。
 *
 * Run: npx tsx --test apps/server/test/mvp36-investigation-loop.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvestigationStep } from '../src/investigation/investigationPrompt.js';
import { runInvestigation } from '../src/investigation/investigationLoop.js';
import type { ReadToolResult } from '../src/investigation/readTools.js';

const baseInput = {
  matterTitle: '确认评测集是否已发给鲁升纲',
  matterType: 'follow_up',
  currentSummary: '答应给鲁升纲发评测集',
  nextAction: '确认评测集是否已实际发送给鲁升纲',
  entities: [{ type: 'person', name: '鲁升纲', role: 'counterparty' }],
};

// ---- parseInvestigationStep ----

test('parse: conclude 正常', () => {
  const s = parseInvestigationStep(JSON.stringify({
    action: 'conclude',
    conclusion: { verdict: 'resolved', confidence: 0.9, factSummary: '已发', evidence: ['6/13 群里发了'] },
  }));
  assert.equal(s.action, 'conclude');
  if (s.action === 'conclude') {
    assert.equal(s.conclusion.verdict, 'resolved');
    assert.equal(s.conclusion.confidence, 0.9);
  }
});

test('parse: investigate 带 toolCalls（截到 3 个）', () => {
  const s = parseInvestigationStep(JSON.stringify({
    action: 'investigate',
    toolCalls: [
      { tool: 'search_im_messages', params: { query: '评测集' } },
      { tool: 'list_my_tasks', params: {} },
      { tool: 'read_doc', params: { token: 'doxcn1' } },
      { tool: 'read_chat_messages', params: { chatId: 'oc_x' } },
    ],
  }));
  assert.equal(s.action, 'investigate');
  if (s.action === 'investigate') assert.equal(s.toolCalls.length, 3);
});

test('parse: 非法 verdict → unknown；空 toolCalls → 降级 conclude unknown', () => {
  const s1 = parseInvestigationStep(JSON.stringify({ action: 'conclude', conclusion: { verdict: 'xx', confidence: 2 } }));
  assert.equal(s1.action === 'conclude' && s1.conclusion.verdict, 'unknown');
  assert.equal(s1.action === 'conclude' && s1.conclusion.confidence, 1); // clamp
  const s2 = parseInvestigationStep(JSON.stringify({ action: 'investigate', toolCalls: [] }));
  assert.equal(s2.action, 'conclude'); // 空动作降级
});

test('parse: 垃圾文本 → 抛错(由循环兜底)', () => {
  assert.throws(() => parseInvestigationStep('这不是 JSON'), /非合法 JSON/);
});

// ---- runInvestigation ----

function scriptedJudge(steps: string[]) {
  let i = 0;
  const seen: string[] = [];
  const judge = async (msg: string) => {
    seen.push(msg);
    return steps[Math.min(i++, steps.length - 1)];
  };
  return { judge, seen };
}

test('T1 投查→结论：执行只读工具、累计 findings、回结论', async () => {
  const { judge } = scriptedJudge([
    JSON.stringify({ action: 'investigate', toolCalls: [{ tool: 'search_im_messages', params: { query: '评测集', sender: 'ou_lu' } }] }),
    JSON.stringify({ action: 'conclude', conclusion: { verdict: 'resolved', confidence: 0.85, factSummary: '6/13 已在群里发给鲁升纲', evidence: ['om_123'] } }),
  ]);
  const toolCalls: Array<[string, unknown]> = [];
  const runTool = async (name: string, params: Record<string, unknown>): Promise<ReadToolResult> => {
    toolCalls.push([name, params]);
    return { tool: name as never, ok: true, data: { items: [{ id: 'om_123' }] }, summary: 'IM 搜索命中 1 条' };
  };
  const r = await runInvestigation(baseInput, { judge, runTool: runTool as never });
  assert.equal(r.conclusion.verdict, 'resolved');
  assert.equal(r.rounds, 2);
  assert.equal(r.toolLog.length, 1);
  assert.equal(r.toolLog[0].tool, 'search_im_messages');
  assert.equal(toolCalls.length, 1);
});

test('T2 用满轮数不 conclude → 保守 unknown，LLM 调用数 ≤ maxRounds', async () => {
  let calls = 0;
  const judge = async () => {
    calls++;
    return JSON.stringify({ action: 'investigate', toolCalls: [{ tool: 'list_my_tasks', params: {} }] });
  };
  const runTool = async (name: string): Promise<ReadToolResult> =>
    ({ tool: name as never, ok: true, data: { items: [] }, summary: '未完成任务 0 条' });
  const r = await runInvestigation({ ...baseInput, maxRounds: 2 }, { judge, runTool: runTool as never });
  assert.equal(r.conclusion.verdict, 'unknown');
  assert.equal(calls, 2, 'LLM 调用数必须 ≤ maxRounds');
  assert.equal(r.rounds, 2);
});

test('T3 模型请求未知/写工具 → 不执行，记失败（硬只读：写到不了 runTool）', async () => {
  const { judge } = scriptedJudge([
    JSON.stringify({ action: 'investigate', toolCalls: [{ tool: 'send_im', params: { text: '坏' } }, { tool: 'messages-send', params: {} }] }),
    JSON.stringify({ action: 'conclude', conclusion: { verdict: 'unknown', confidence: 0.2, factSummary: 'x', evidence: [] } }),
  ]);
  let realToolCalls = 0;
  const runTool = async (name: string): Promise<ReadToolResult> => {
    realToolCalls++;
    return { tool: name as never, ok: true, data: {}, summary: '' };
  };
  const r = await runInvestigation(baseInput, { judge, runTool: runTool as never });
  assert.equal(realToolCalls, 0, '未知/写工具名绝不进 runTool');
  assert.ok(r.toolLog.every((l) => !l.ok), '都记为失败');
});

test('T4 解析失败那轮 → 收尾 unknown，不空转', async () => {
  const judge = async () => '我不会输出 JSON';
  const r = await runInvestigation(baseInput, { judge });
  assert.equal(r.conclusion.verdict, 'unknown');
  assert.equal(r.rounds, 1);
});
