/**
 * MVP23 — Attention 卡片「多处理角度」。覆盖：
 *  1. parse 的 coerceProcessingOptions 逐字段降级（坏数据不炸 item、S# 丢弃、上限 2、空→无字段）
 *  2. defaultAttentionActions 投影：有角度→opt:* 多按钮；无角度→单个 ask_agent
 *  3. store 往返：processingOptions 落库→ actionOptions 读回；空→null
 *  4. execution：applyAttentionAction 对 opt:<id> 取回 directive（间接：动作存在性 + 标 acted）
 *
 * 运行：npx tsx --test apps/server/test/mvp23-attention-processing-options.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp23-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { parseAttentionOutput } = await import('../src/attention/attentionPrompt.js');
const { insertAttentionItem, getAttentionItem } = await import(
  '../src/attention/attentionStore.js'
);
const { defaultAttentionActions } = await import('../src/attention/attentionProjection.js');

function wrap(item: Record<string, unknown>): string {
  return JSON.stringify({ items: [item] });
}

const BASE = {
  priority: 'P0',
  title: 'T',
  why: '[S1] 测试 why',
  signalIds: ['S1'],
};

// ---------------------------------------------------------------------------
// 1. 解析降级
// ---------------------------------------------------------------------------

test('合法的 2 个角度被解析保留', () => {
  const [it] = parseAttentionOutput(
    wrap({
      ...BASE,
      processingOptions: [
        { id: 'draft_reply', label: '起草回复', directive: '起草一条可发出的回复，仅草稿。' },
        { id: 'summarize', label: '梳理要点', directive: '浓缩成 3 条要点供决策。' },
      ],
    })
  );
  assert.equal(it.processingOptions?.length, 2);
  assert.equal(it.processingOptions?.[0].id, 'draft_reply');
  assert.equal(it.processingOptions?.[0].label, '起草回复');
});

test('directive 含 S# 的角度被丢弃（防引用编号泄漏）', () => {
  const [it] = parseAttentionOutput(
    wrap({
      ...BASE,
      processingOptions: [
        { id: 'bad', label: '坏角度', directive: '参考 S3 的内容来处理。' },
        { id: 'ok', label: '好角度', directive: '正常的自然语言指令。' },
      ],
    })
  );
  assert.equal(it.processingOptions?.length, 1);
  assert.equal(it.processingOptions?.[0].id, 'ok');
});

test('缺字段 / 空数组 → processingOptions 为 undefined，但 item 本身正常解析', () => {
  const [missing] = parseAttentionOutput(
    wrap({ ...BASE, processingOptions: [{ id: 'x', label: '只有label' }] })
  );
  assert.equal(missing.processingOptions, undefined);
  assert.equal(missing.title, 'T'); // item 没被解析失败

  const [empty] = parseAttentionOutput(wrap({ ...BASE, processingOptions: [] }));
  assert.equal(empty.processingOptions, undefined);

  const [garbage] = parseAttentionOutput(wrap({ ...BASE, processingOptions: 'not-array' }));
  assert.equal(garbage.processingOptions, undefined);
  assert.equal(garbage.why, '[S1] 测试 why');
});

test('超过 3 个角度被截断到 3；重复 id 去重', () => {
  const [it] = parseAttentionOutput(
    wrap({
      ...BASE,
      processingOptions: [
        { id: 'a', label: 'A', directive: 'do a' },
        { id: 'a', label: 'A2', directive: 'dup id' },
        { id: 'b', label: 'B', directive: 'do b' },
        { id: 'c', label: 'C', directive: 'do c' },
        { id: 'd', label: 'D', directive: 'do d' },
      ],
    })
  );
  assert.equal(it.processingOptions?.length, 3);
  assert.deepEqual(
    it.processingOptions?.map((o) => o.id),
    ['a', 'b', 'c']
  );
});

// ----- M2：executor -----

test('executor=create_task 被保留；最多 1 个（第 2 个降级为默认 claude_topic）', () => {
  const [it] = parseAttentionOutput(
    wrap({
      ...BASE,
      processingOptions: [
        { id: 'reply', label: '起草回复', directive: 'd0' },
        { id: 'to_task', label: '拟成待办', directive: 'd1', executor: 'create_task' },
        { id: 'to_task2', label: '再建任务', directive: 'd2', executor: 'create_task' },
      ],
    })
  );
  assert.equal(it.processingOptions?.length, 3);
  assert.equal(it.processingOptions?.[0].executor, undefined); // 默认
  assert.equal(it.processingOptions?.[1].executor, 'create_task');
  assert.equal(it.processingOptions?.[2].executor, undefined); // 第 2 个 create_task 被降级
});

test('非法 executor 值被忽略（落为默认）', () => {
  const [it] = parseAttentionOutput(
    wrap({
      ...BASE,
      processingOptions: [{ id: 'x', label: 'X', directive: 'dx', executor: 'rm -rf' }],
    })
  );
  assert.equal(it.processingOptions?.[0].executor, undefined);
});

test('projection：create_task 角度 → kind=create_task；其余 → ask_agent', () => {
  insert('attn_m2', [
    { id: 'reply', label: '起草回复', directive: 'd0' },
    { id: 'to_task', label: '拟成待办', directive: 'd1', executor: 'create_task' },
  ]);
  const item = getAttentionItem('attn_m2')!;
  const actions = defaultAttentionActions(item);
  const reply = actions.find((a) => a.id === 'opt:reply')!;
  const toTask = actions.find((a) => a.id === 'opt:to_task')!;
  assert.equal(reply.kind, 'ask_agent');
  assert.equal(toTask.kind, 'create_task');
});

test('store 往返保留 executor', () => {
  insert('attn_m2_store', [
    { id: 'to_task', label: '拟成待办', directive: 'd1', executor: 'create_task' },
  ]);
  const back = getAttentionItem('attn_m2_store');
  assert.equal(back?.actionOptions?.[0].executor, 'create_task');
});

// ---------------------------------------------------------------------------
// 2 + 3. store 往返 & projection
// ---------------------------------------------------------------------------

function insert(id: string, processingOptions?: unknown) {
  return insertAttentionItem({
    id,
    generation: 1,
    llmRunId: null,
    inputHash: `hash-${id}`,
    now: new Date().toISOString(),
    llmItem: {
      priority: 'P0',
      title: `卡 ${id}`,
      why: 'why',
      signalIds: ['u1'],
      recommendedAgent: 'commitmentDigest',
      processingOptions: processingOptions as any,
    },
  });
}

test('store 往返：processingOptions 落库后读回 actionOptions', () => {
  insert('attn_opts', [
    { id: 'draft_reply', label: '起草回复', directive: 'd1' },
    { id: 'summarize', label: '梳理要点', directive: 'd2' },
  ]);
  const back = getAttentionItem('attn_opts');
  assert.equal(back?.actionOptions?.length, 2);
  assert.equal(back?.actionOptions?.[0].directive, 'd1');
});

test('store 往返：无/空角度 → actionOptions 为 null（禁止存 []）', () => {
  insert('attn_none'); // processingOptions undefined
  assert.equal(getAttentionItem('attn_none')?.actionOptions, null);

  insert('attn_empty', []);
  assert.equal(getAttentionItem('attn_empty')?.actionOptions, null);
});

test('projection：有角度 → ack + opt:* 多按钮 + dismiss', () => {
  insert('attn_proj', [
    { id: 'draft_reply', label: '起草回复', directive: 'd1' },
    { id: 'summarize', label: '梳理要点', directive: 'd2' },
  ]);
  const item = getAttentionItem('attn_proj')!;
  const actions = defaultAttentionActions(item);
  assert.deepEqual(
    actions.map((a) => a.id),
    ['ack', 'opt:draft_reply', 'opt:summarize', 'dismiss']
  );
  // 角度按钮 kind 仍是 ask_agent（复用执行通道），且不下发 directive
  const opt = actions.find((a) => a.id === 'opt:draft_reply')!;
  assert.equal(opt.kind, 'ask_agent');
  assert.equal((opt as any).prompt, undefined);
});

test('projection：无角度 → 退回单个「让 AI 处理」', () => {
  insert('attn_single');
  const item = getAttentionItem('attn_single')!;
  const actions = defaultAttentionActions(item);
  assert.deepEqual(
    actions.map((a) => a.id),
    ['ack', 'ask_agent', 'dismiss']
  );
});
