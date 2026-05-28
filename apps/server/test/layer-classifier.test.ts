/**
 * MVP21 S1 §4.4 — classifyContextUnit 单测。
 * 覆盖 work_map:* 子前缀、所有 ContextOriginKind 分支、未知 work_map 子前缀兜底。
 *
 * 运行：npx tsx --test apps/server/test/layer-classifier.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ContextUnit,
  ContextOriginKind,
  ContextUnitKind,
} from '../src/context/ContextUnit.js';
import { classifyContextUnit } from '../src/context/layerClassifier.js';

function makeUnit(p: {
  kind: ContextUnitKind;
  mergeKey?: string;
  origin: { kind: ContextOriginKind; refId: string };
}): ContextUnit {
  const now = new Date().toISOString();
  return {
    id: 'u-test',
    subjectId: 'me',
    scope: 'work',
    origin: p.origin,
    kind: p.kind,
    title: 't',
    content: 'c',
    entities: [],
    actionability: 'record',
    confidence: 0.7,
    mergeKey: p.mergeKey,
    version: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

// ---------- work_map:* 前缀 ----------

test('work_map:role:self → identity_fact + work_map_seed + asserted + voluntary', () => {
  const u = makeUnit({
    kind: 'state',
    mergeKey: 'work_map:role:self',
    origin: { kind: 'system', refId: 'work_map' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.layer, 'identity_fact');
  assert.equal(h.source, 'work_map_seed');
  assert.equal(h.asserted, true);
  assert.equal(h.voluntary, true);
});

test('work_map:responsibility:* → identity_fact', () => {
  const u = makeUnit({
    kind: 'state',
    mergeKey: 'work_map:responsibility:chatbot-pm',
    origin: { kind: 'system', refId: 'work_map' },
  });
  assert.equal(classifyContextUnit(u).layer, 'identity_fact');
});

test('work_map:relationship:* → identity_fact', () => {
  const u = makeUnit({
    kind: 'relationship',
    mergeKey: 'work_map:relationship:zhang-san',
    origin: { kind: 'system', refId: 'work_map' },
  });
  assert.equal(classifyContextUnit(u).layer, 'identity_fact');
});

test('work_map:preference:* → identity_fact', () => {
  const u = makeUnit({
    kind: 'preference',
    mergeKey: 'work_map:preference:no-interrupt-weekend',
    origin: { kind: 'system', refId: 'work_map' },
  });
  assert.equal(classifyContextUnit(u).layer, 'identity_fact');
});

test('work_map:goal:* → project_intent', () => {
  const u = makeUnit({
    kind: 'goal',
    mergeKey: 'work_map:goal:chatbot:q3-ramp',
    origin: { kind: 'system', refId: 'work_map' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.layer, 'project_intent');
  assert.equal(h.source, 'work_map_seed');
});

test('work_map:commitment:* → dynamic_signal + source=work_map_seed (区分用)', () => {
  const u = makeUnit({
    kind: 'commitment',
    mergeKey: 'work_map:commitment:base-ux:image-2',
    origin: { kind: 'system', refId: 'work_map' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.layer, 'dynamic_signal');
  assert.equal(h.source, 'work_map_seed');
  assert.equal(h.asserted, true); // 关键：跟 triage 的 dynamic_signal 区分
});

test('work_map:risk:* → dynamic_signal + source=work_map_seed', () => {
  const u = makeUnit({
    kind: 'uncertainty',
    mergeKey: 'work_map:risk:base-ux:bandwidth',
    origin: { kind: 'system', refId: 'work_map' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.layer, 'dynamic_signal');
  assert.equal(h.source, 'work_map_seed');
});

test('未知 work_map:* 子前缀 → identity_fact 兜底', () => {
  const u = makeUnit({
    kind: 'state',
    mergeKey: 'work_map:newkind:foo',
    origin: { kind: 'system', refId: 'work_map' },
  });
  assert.equal(classifyContextUnit(u).layer, 'identity_fact');
  assert.equal(classifyContextUnit(u).source, 'work_map_seed');
});

// ---------- origin 分支 ----------

test('collector 直写最小 event unit → source=collector', () => {
  const u = makeUnit({
    kind: 'event',
    mergeKey: 'event:abc-123',
    origin: { kind: 'event', refId: 'ev-123' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.layer, 'dynamic_signal');
  assert.equal(h.source, 'collector');
  assert.equal(h.asserted, false);
});

test('triage enrichment 写的 commitment (origin.kind=event, kind!=event) → source=triage', () => {
  const u = makeUnit({
    kind: 'commitment',
    mergeKey: 'a1b2c3d4', // sha1
    origin: { kind: 'event', refId: 'ev-123' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.layer, 'dynamic_signal');
  assert.equal(h.source, 'triage');
});

test('agent_run 写的 unit → source=agent_run', () => {
  const u = makeUnit({
    kind: 'action_result',
    origin: { kind: 'agent_run', refId: 'run-9' },
  });
  assert.equal(classifyContextUnit(u).source, 'agent_run');
});

test('card_action 写的 unit → source=card_action + asserted', () => {
  const u = makeUnit({
    kind: 'commitment',
    origin: { kind: 'card_action', refId: 'card-7' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.source, 'card_action');
  assert.equal(h.asserted, true);
});

test('manual 路径写的 preference → identity_fact', () => {
  const u = makeUnit({
    kind: 'preference',
    origin: { kind: 'manual', refId: 'ui' },
  });
  assert.equal(classifyContextUnit(u).layer, 'identity_fact');
  assert.equal(classifyContextUnit(u).source, 'manual');
});

test('manual 路径写的 relationship → identity_fact', () => {
  const u = makeUnit({
    kind: 'relationship',
    origin: { kind: 'manual', refId: 'ui' },
  });
  assert.equal(classifyContextUnit(u).layer, 'identity_fact');
});

test('manual 路径写的 commitment → dynamic_signal', () => {
  const u = makeUnit({
    kind: 'commitment',
    origin: { kind: 'manual', refId: 'ui' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.layer, 'dynamic_signal');
  assert.equal(h.source, 'manual');
});

test('chat 路径写的 commitment → dynamic_signal + manual', () => {
  const u = makeUnit({
    kind: 'commitment',
    origin: { kind: 'chat', refId: 'topic-x' },
  });
  assert.equal(classifyContextUnit(u).source, 'manual');
});

test('非 work_map 的 origin.kind=system → source=system_feedback', () => {
  // 例：workMapMutator 写 origin.kind='system' + refId='attention_feedback'
  const u = makeUnit({
    kind: 'state',
    origin: { kind: 'system', refId: 'attention_feedback' },
  });
  const h = classifyContextUnit(u);
  assert.equal(h.source, 'system_feedback');
  assert.equal(h.asserted, true);
  assert.equal(h.voluntary, false);
});

test('mergeKey 为 undefined → 走 origin 分支兜底', () => {
  const u = makeUnit({
    kind: 'commitment',
    origin: { kind: 'event', refId: 'ev-1' },
  });
  assert.equal(classifyContextUnit(u).source, 'triage');
});

test('空 mergeKey 字符串 → 不被识别为 work_map 前缀', () => {
  const u = makeUnit({
    kind: 'commitment',
    mergeKey: '',
    origin: { kind: 'event', refId: 'ev-1' },
  });
  assert.equal(classifyContextUnit(u).source, 'triage');
});
