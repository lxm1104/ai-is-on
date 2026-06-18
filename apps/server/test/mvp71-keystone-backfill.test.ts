/**
 * MVP71 KEYSTONE — 让"你补一手→AI 接着查"从假闭环变真闭环：用户经求助卡补的内容
 * ① 能被 db.listUserBackfillUnitsForMatter 取到（origin=card_action，非 card_action 不取）；
 * ② 被 buildInvestigateUserMessage 渲染进 `<用户补充>` 段，供重查的 LLM 真正读到。
 *
 * Run: npx tsx --test apps/server/test/mvp71-keystone-backfill.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp71k-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const ms = await import('../src/matter/matterStore.js');
const cs = await import('../src/context/contextStore.js');
const prompt = await import('../src/investigation/investigationPrompt.js');

function mkMatter() {
  return ms.createMatter({
    scope: 'work', type: 'follow_up', title: `排查 ${randomUUID().slice(0, 6)}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: 'u-' + randomUUID(),
    currentSummary: '', nextAction: '跟进进展并确认结果',
  });
}

// ---- ① 渲染：纯函数，无 DB ----
test('MVP71 KEYSTONE：buildInvestigateUserMessage 在有 backfill 时渲染 <用户补充> 段', () => {
  const withBf = prompt.buildInvestigateUserMessage({
    matterTitle: 't', matterType: 'follow_up', currentSummary: '', nextAction: 'x',
    entities: [], findings: [], round: 1, maxRounds: 3,
    userBackfills: ['高虎伟说已经调长到 60s 了，6/15 上线', 'traceID: 7650050742669888755'],
  });
  assert.match(withBf, /<用户补充/, '应渲染用户补充段');
  assert.match(withBf, /高虎伟说已经调长到 60s/, '应含补充正文1');
  assert.match(withBf, /7650050742669888755/, '应含补充正文2（traceID）');
  assert.match(withBf, /不要无视用户补充再下"查不到"/, '应含强语气判定纪律');
});

test('MVP71 KEYSTONE：无 backfill 时不渲染该段（向后兼容，旧行为不变）', () => {
  const noBf = prompt.buildInvestigateUserMessage({
    matterTitle: 't', matterType: 'follow_up', currentSummary: '', nextAction: 'x',
    entities: [], findings: [], round: 1, maxRounds: 3,
  });
  assert.doesNotMatch(noBf, /<用户补充/, '无 backfill 不应渲染该段');
});

// ---- ② 读取：origin=card_action 才取，agent_run 自产证据不取 ----
test('MVP71 KEYSTONE：listUserBackfillUnitsForMatter 只取 card_action 补充、不取 AI 自产证据', () => {
  const m = mkMatter();
  const now = new Date().toISOString();

  // 用户经求助卡补的（origin=card_action）→ 应取到
  const u1 = cs.upsertContextUnit({
    kind: 'action_result', origin: { kind: 'card_action', refId: 'card-1' },
    title: '补充：xxx', content: '高虎伟说已经在 6/15 调长授权超时到 60s 了',
    scope: 'work', actionability: 'record', confidence: 1,
    mergeHint: `needhelp-backfill:card-1:${now}:${randomUUID().slice(0, 8)}`, silent: true,
  }).unit;
  ms.attachMatterContextLink({ matterId: m.id, contextUnitId: u1.id, relation: 'evidence', effect: 'no_change', confidence: 1, reason: '求助卡补充', now });

  // AI 自产排查证据（origin=agent_run, investigation:%）→ 不应取到（这是回声，不是用户补的）
  const u2 = cs.upsertContextUnit({
    kind: 'action_result', origin: { kind: 'agent_run', refId: `investigation:${m.id}` },
    title: 'AI 排查：未查到', content: 'AI 自主排查结论（unknown）：未查到任何跟进',
    scope: 'work', actionability: 'record', confidence: 0.3,
    mergeHint: `investigation:${m.id}:x`, silent: true,
  }).unit;
  ms.attachMatterContextLink({ matterId: m.id, contextUnitId: u2.id, relation: 'evidence', effect: 'no_change', confidence: 0.3, reason: 'AI 排查', now });

  const got = db.listUserBackfillUnitsForMatter(m.id, 5);
  assert.equal(got.length, 1, '只应取到 1 条（用户 card_action 补充），不含 AI 自产');
  assert.match(got[0].content, /高虎伟说已经在 6\/15 调长/, '取到的是用户补的那条');
});

test('MVP71 KEYSTONE：无任何补充时返回空数组', () => {
  const m = mkMatter();
  assert.deepEqual(db.listUserBackfillUnitsForMatter(m.id, 5), []);
});
