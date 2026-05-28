/**
 * MVP21 S1 §9 — buildAttentionUserMessage 行尾 [src=...] 标签输出测试。
 * 直接构造 packet shape，跳过 DB / runtime，纯粹断言 prompt 字符串。
 *
 * 运行：npx tsx --test apps/server/test/attention-src-tag.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  GlobalContextPacket,
  CommitmentInPacket,
  GoalInPacket,
  UncertaintyInPacket,
} from '../src/context/agentContextAssembler.js';
import type { ContextLayerHint } from '../src/context/layerClassifier.js';
import { buildAttentionUserMessage } from '../src/attention/attentionPrompt.js';

const NOW = '2026-05-28T10:00:00.000Z';

function baseUnit(overrides: Partial<CommitmentInPacket>): CommitmentInPacket {
  return {
    id: 'u-1',
    subjectId: 'me',
    scope: 'work',
    origin: { kind: 'system', refId: 'work_map' },
    kind: 'commitment',
    title: 'test',
    content: '',
    entities: [],
    actionability: 'record',
    confidence: 0.9,
    version: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as CommitmentInPacket;
}

function makePacket(opts: {
  commitments?: CommitmentInPacket[];
  goals?: GoalInPacket[];
  uncertainties?: UncertaintyInPacket[];
}): GlobalContextPacket {
  return {
    packetAssemblerVersion: 1,
    generatedAt: NOW,
    bootstrapped: true,
    subject: null,
    spaces: [],
    goals: opts.goals ?? [],
    commitments: opts.commitments ?? [],
    uncertainties: opts.uncertainties ?? [],
    recentEvents: [],
    topActive: [],
    stakeholders: [],
    myTopCollaborators: [],
    preferences: [],
    boundaryRules: [],
    attentionInteractions: [],
    agentProposals: [],
    tokenEstimate: 100,
    inputHash: 'hash-stub',
  };
}

const SEED_HINT: ContextLayerHint = {
  layer: 'dynamic_signal',
  source: 'work_map_seed',
  asserted: true,
  voluntary: true,
};
const TRIAGE_HINT: ContextLayerHint = {
  layer: 'dynamic_signal',
  source: 'triage',
  asserted: false,
  voluntary: false,
};
const INDUCER_HINT: ContextLayerHint = {
  layer: 'derived_signal',
  source: 'inducer',
  asserted: false,
  voluntary: false,
};

test('commitments 行带 [src=work_map_seed] 标签', () => {
  const c = baseUnit({
    id: 'c-seed',
    title: 'Base UX 文案',
    mergeKey: 'work_map:commitment:base-ux',
    _layerHint: SEED_HINT,
  });
  const msg = buildAttentionUserMessage(makePacket({ commitments: [c] }));
  // 该行格式：- [c-seed] (commitment) Base UX 文案 ... [src=work_map_seed]
  const line = msg.split('\n').find((l) => l.includes('[c-seed]'));
  assert.ok(line, 'commitment 行应被渲染');
  assert.match(line!, /\[src=work_map_seed\]/);
});

test('commitments 行带 [src=triage] 标签', () => {
  const c = baseUnit({
    id: 'c-triage',
    title: 'IM 抓的',
    origin: { kind: 'event', refId: 'ev-1' },
    _layerHint: TRIAGE_HINT,
  });
  const msg = buildAttentionUserMessage(makePacket({ commitments: [c] }));
  const line = msg.split('\n').find((l) => l.includes('[c-triage]'));
  assert.match(line!, /\[src=triage\]/);
});

test('goals 行也带 [src=...] 标签', () => {
  const g = {
    ...baseUnit({ id: 'g-1', title: 'Q3 目标', kind: 'goal' }),
    _layerHint: SEED_HINT,
  } as GoalInPacket;
  const msg = buildAttentionUserMessage(makePacket({ goals: [g] }));
  const line = msg.split('\n').find((l) => l.includes('[g-1]'));
  assert.ok(line);
  assert.match(line!, /\[src=work_map_seed\]/);
});

test('uncertainties 行也带 [src=...] 标签', () => {
  const u = {
    ...baseUnit({ id: 'u-1', title: '风险点', kind: 'uncertainty' }),
    _layerHint: TRIAGE_HINT,
  } as UncertaintyInPacket;
  const msg = buildAttentionUserMessage(makePacket({ uncertainties: [u] }));
  const line = msg.split('\n').find((l) => l.includes('[u-1]'));
  assert.match(line!, /\[src=triage\]/);
});

test('inducer / unknown / 缺失 _layerHint → 不输出 [src=...] 标签', () => {
  const cInducer = {
    ...baseUnit({ id: 'c-ind', title: 'derived' }),
    _layerHint: INDUCER_HINT,
  } as CommitmentInPacket;
  const cMissing = baseUnit({ id: 'c-no-hint', title: '没有 hint' });

  const msg = buildAttentionUserMessage(
    makePacket({ commitments: [cInducer, cMissing] })
  );
  const inducerLine = msg.split('\n').find((l) => l.includes('[c-ind]'));
  const missingLine = msg.split('\n').find((l) => l.includes('[c-no-hint]'));
  assert.ok(inducerLine && missingLine);
  assert.doesNotMatch(inducerLine!, /\[src=/, 'inducer 来源不输出 [src=]');
  assert.doesNotMatch(missingLine!, /\[src=/, '缺 _layerHint 不输出 [src=]');
});

test('selfRoleOnUnit 与 [src=...] 同时存在，两个标签都出现', () => {
  const c = baseUnit({
    id: 'c-both',
    title: '双标签',
    selfRoleOnUnit: 'requester',
    _layerHint: SEED_HINT,
  });
  const msg = buildAttentionUserMessage(makePacket({ commitments: [c] }));
  const line = msg.split('\n').find((l) => l.includes('[c-both]'));
  assert.match(line!, /\[role=requester\]/);
  assert.match(line!, /\[src=work_map_seed\]/);
});
