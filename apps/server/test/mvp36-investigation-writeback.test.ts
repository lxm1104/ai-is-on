/**
 * MVP36 — 排查结论回写 matter（安全：补证据+更新摘要，绝不自动改 status）。
 *
 * Run: npx tsx --test apps/server/test/mvp36-investigation-writeback.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp36-wb-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { applyInvestigationResult } = await import('../src/investigation/investigationWriteback.js');

let n = 0;
function mkMatter(opts?: { status?: string; summary?: string }) {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment', title: `承诺${n}`, content: `给鲁升纲发评测集 ${n}`,
    scope: 'work', origin: { kind: 'manual', refId: `u-${n}` }, silent: true,
  }).unit;
  const m = ms.createMatter({
    scope: 'work', type: 'follow_up', title: `确认评测集发送${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id,
    currentSummary: opts?.summary ?? '答应给鲁升纲发评测集', nextAction: '确认评测集是否已发给鲁升纲',
  });
  if (opts?.status) ms.saveMatter({ ...ms.getMatterById(m.id)!, status: opts.status as never });
  return m;
}

test('T1 progressed：挂证据 + 更新摘要，status 不变', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: '6/13 在群里发了初版，未见对方确认', evidence: ['om_abc 鲁升纲: 收到'] },
    toolSummary: 'search_im_messages:命中3条',
  });
  assert.equal(r.ok, true);
  assert.ok(r.resultUnitId);
  const after = ms.getMatterById(m.id)!;
  assert.equal(after.status, 'open', 'status 必须不变');
  assert.ok(after.currentSummary.includes('AI 排查'), '摘要并入排查结论');
  assert.ok(ms.listMatterContextLinks(m.id).some((l) => l.contextUnitId === r.resultUnitId && l.effect === 'no_change'), '证据 effect=no_change');
});

test('T2 resolved 高置信：nextAction 改提示待确认，但 status 仍不变（不自动办结）', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'resolved', confidence: 0.9, factSummary: '对方已确认收到评测集', evidence: ['om_xyz'] },
  });
  assert.equal(r.ok, true);
  const after = ms.getMatterById(m.id)!;
  assert.equal(after.status, 'open', 'resolved 也绝不自动改 status');
  assert.match(after.nextAction || '', /待确认|疑似已完成/);
});

test('T3 blocked：nextAction 反映受阻', () => {
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'blocked', confidence: 0.6, factSummary: '评测集文件权限未开，对方打不开', evidence: [] },
  });
  assert.equal(r.ok, true);
  assert.match(ms.getMatterById(m.id)!.nextAction || '', /受阻/);
});

test('T4 unknown：仍挂证据记录"查了但没结论"，不动 nextAction/status', () => {
  const m = mkMatter();
  const beforeNext = ms.getMatterById(m.id)!.nextAction;
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'unknown', confidence: 0.2, factSummary: '未查到评测集相关消息', evidence: [] },
  });
  assert.equal(r.ok, true);
  assert.ok(r.resultUnitId, 'unknown 也留痕');
  assert.equal(ms.getMatterById(m.id)!.nextAction, beforeNext, 'unknown 不动 nextAction');
});

test('T5 matter 不存在 → ok:false 不抛', () => {
  const r = applyInvestigationResult({ matterId: 'nope', conclusion: { verdict: 'unknown', confidence: 0, factSummary: '', evidence: [] } });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /not found/);
});
