// 2026-06-10/11 优化循环关键修复的防回归测试：
//   - llmGate：并发上限 / FIFO / 高优先级插队 / release 唤醒
//   - authWatchdog.looksLikeAuthError：鉴权错误识别（网络错误不误报）
//   - chatConclusionService.parseVerdict：LLM 判定 JSON 解析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlmGate } from '../src/llm/llmGate.js';
import { looksLikeAuthError } from '../src/collectors/authWatchdog.js';
import { parseVerdict } from '../src/matter/chatConclusionService.js';

// ---------- llmGate ----------

test('gate: 并发不超过上限', async () => {
  const gate = createLlmGate(1);
  await gate.acquire(false);
  assert.equal(gate.stats().active, 1);
  let second = false;
  const p = gate.acquire(false).then(() => {
    second = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(second, false, '第二个调用应在闸外等待');
  gate.release();
  await p;
  assert.equal(second, true);
  gate.release();
  assert.equal(gate.stats().active, 0);
});

test('gate: 同级 FIFO 顺序', async () => {
  const gate = createLlmGate(1);
  await gate.acquire(false);
  const order: number[] = [];
  const p1 = gate.acquire(false).then(() => order.push(1));
  const p2 = gate.acquire(false).then(() => order.push(2));
  gate.release();
  await p1;
  gate.release();
  await p2;
  gate.release();
  assert.deepEqual(order, [1, 2]);
});

test('gate: 高优先级插队到 normal 之前', async () => {
  const gate = createLlmGate(1);
  await gate.acquire(false);
  const order: string[] = [];
  const pn = gate.acquire(false).then(() => order.push('normal'));
  const ph = gate.acquire(true).then(() => order.push('high'));
  gate.release(); // 应先放 high
  await ph;
  gate.release();
  await pn;
  gate.release();
  assert.deepEqual(order, ['high', 'normal']);
});

test('gate: maxConcurrency≥2 允许并行', async () => {
  const gate = createLlmGate(2);
  await gate.acquire(false);
  await gate.acquire(true);
  assert.equal(gate.stats().active, 2);
  gate.release();
  gate.release();
});

// ---------- authWatchdog ----------

test('authWatchdog: 鉴权类错误命中', () => {
  assert.equal(looksLikeAuthError('lark-cli exit 4: user identity: missing'), true);
  assert.equal(looksLikeAuthError('401 Unauthorized'), true);
  assert.equal(looksLikeAuthError('token expired, please re-login'), true);
  assert.equal(looksLikeAuthError('code 99991663 app ticket invalid'), true);
});

test('authWatchdog: 网络/其他错误不误报', () => {
  assert.equal(looksLikeAuthError('dial tcp 1.2.3.4:443: i/o timeout'), false);
  assert.equal(looksLikeAuthError('ECONNRESET'), false);
  assert.equal(looksLikeAuthError('500 Internal Server Error'), false);
});

// ---------- parseVerdict ----------

test('parseVerdict: 标准 JSON', () => {
  const v = parseVerdict('{"verdict":"resolved","confidence":0.9,"evidence":"已完成"}');
  assert.deepEqual(v, { verdict: 'resolved', confidence: 0.9, evidence: '已完成' });
});

test('parseVerdict: 容忍 JSON 外围杂质', () => {
  const v = parseVerdict('好的，判定如下：\n{"verdict":"no_change","confidence":0.8,"evidence":"只是建议"}\n以上。');
  assert.equal(v?.verdict, 'no_change');
});

test('parseVerdict: 非法输入返回 null', () => {
  assert.equal(parseVerdict('完全不是 JSON'), null);
  assert.equal(parseVerdict('{"verdict":"weird","confidence":1}'), null);
  assert.equal(parseVerdict('{"verdict":"resolved"}'), null); // 缺 confidence
});
