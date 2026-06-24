/**
 * MVP74「从查到解决」—— conclude 长出 artifact 出口 + 升「修复方案」交付卡。
 * 覆盖：parseArtifact 防御式降级、后端校正硬门（targetRef/evidence）、writeback 互斥序、不吞求助、向后兼容。
 *
 * Run: npx tsx --test apps/server/test/mvp74-artifact.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp74-artifact-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { applyInvestigationResult } = await import('../src/investigation/investigationWriteback.js');
const { isValidArtifact, parseInvestigationStep } = await import('../src/investigation/investigationPrompt.js');
const { MATTER_ARTIFACT_PROPOSAL_PREFIX, MATTER_NEEDHELP_PROPOSAL_PREFIX, MATTER_PROGRESS_PROPOSAL_PREFIX, raiseMatterProgressProposal } =
  await import('../src/matter/matterResolveProposal.js');
const db = await import('../src/db.js');

const SELF = 'self-' + randomUUID();
function resetDb() {
  db.db.exec(`DELETE FROM attention_items; DELETE FROM matters; DELETE FROM context_units; DELETE FROM matter_context_links; DELETE FROM audit_logs; DELETE FROM matter_entities;`);
  db.setSetting('self_person_entity_id', SELF);
}

let n = 0;
function mkMatter(opts: { priority?: string; title?: string } = {}) {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment', title: `badcase${n}`, content: `公式 agent 报错 ${n}`,
    scope: 'work', origin: { kind: 'manual', refId: `u-${n}` }, silent: true,
  }).unit;
  const m = ms.createMatter({
    scope: 'work', type: 'follow_up', title: opts.title ?? `公式 agent badcase 排查${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id, ownerEntityId: SELF,
    currentSummary: '', nextAction: '追到代码根因',
  });
  if (opts.priority) db.db.prepare(`UPDATE matters SET priority=? WHERE id=?`).run(opts.priority, m.id);
  return m;
}

const goodArtifact = {
  kind: 'code_fix' as const,
  title: '公式 agent 漏判空参数',
  rootCause: 'parseArgs 未处理空数组',
  targetRef: 'src/agents/formula.ts:42',
  body: '在 parseArgs 入口加 if(!args.length) return null',
  verifyCmd: 'rg "parseArgs" src/agents/formula.ts',
};
function concl(over: Record<string, unknown>) {
  return { verdict: 'progressed' as const, confidence: 0.7, factSummary: '定位到 formula.ts:42 漏判', evidence: ['rg 命中 formula.ts:42'], ...over };
}
function artifactCard(matterId: string) {
  return db.db.prepare(`SELECT title, why, status FROM attention_items WHERE input_hash=?`)
    .get(`${MATTER_ARTIFACT_PROPOSAL_PREFIX}${matterId}`) as { title: string; why: string; status: string } | undefined;
}

// ---- isValidArtifact / parseArtifact 防御式降级 ----
test('MVP74 isValidArtifact：合法保留；缺 targetRef/title/body 即非法', () => {
  assert.equal(isValidArtifact(goodArtifact), true);
  assert.equal(isValidArtifact({ ...goodArtifact, targetRef: '   ' }), false, '空 targetRef → 非法');
  assert.equal(isValidArtifact({ ...goodArtifact, title: '' }), false);
  assert.equal(isValidArtifact({ ...goodArtifact, body: '' }), false);
  assert.equal(isValidArtifact({ ...goodArtifact, kind: 'whatever' } as any), false, '非 code_fix → 非法');
  assert.equal(isValidArtifact(undefined), false);
});

test('MVP74 parseInvestigationStep：合法 artifact 解析保留；脏数据降级 undefined', () => {
  const ok = parseInvestigationStep(JSON.stringify({ action: 'conclude', conclusion: concl({ solvability: 'can_produce_artifact', artifact: goodArtifact }) }));
  assert.equal(ok.action, 'conclude');
  if (ok.action === 'conclude') {
    assert.equal(ok.conclusion.solvability, 'can_produce_artifact');
    assert.equal(ok.conclusion.artifact?.targetRef, 'src/agents/formula.ts:42');
  }
  // 缺 targetRef → artifact 降级 undefined，不脏数据穿透
  const bad = parseInvestigationStep(JSON.stringify({ action: 'conclude', conclusion: concl({ solvability: 'can_produce_artifact', artifact: { ...goodArtifact, targetRef: '' } }) }));
  if (bad.action === 'conclude') assert.equal(bad.conclusion.artifact, undefined, '缺 targetRef → undefined');
  // 无 solvability/artifact → 向后兼容（等价今天）
  const legacy = parseInvestigationStep(JSON.stringify({ action: 'conclude', conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: 'x', evidence: ['e'] } }));
  if (legacy.action === 'conclude') {
    assert.equal(legacy.conclusion.solvability, undefined);
    assert.equal(legacy.conclusion.artifact, undefined);
  }
});

// ---- writeback 路由 ----
test('MVP74：can_produce_artifact + 合法 artifact + evidence≥1 → 升交付卡 + matter_artifact_raised 审计', () => {
  resetDb();
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: goodArtifact }) });
  assert.equal(r.proposalRaised, true);
  const card = artifactCard(m.id);
  assert.ok(card, '应有交付卡');
  assert.match(card!.title, /修复方案/);
  assert.match(card!.why, /formula\.ts:42/, '卡正文带 file:line');
  assert.match(card!.why, /改法/);
  const audit = db.db.prepare(`SELECT payload_json FROM audit_logs WHERE action='matter_artifact_raised' LIMIT 1`).get() as { payload_json: string } | undefined;
  assert.ok(audit, '应有 matter_artifact_raised 审计');
  assert.equal(JSON.parse(audit!.payload_json).hasTargetRef, true, 'payload 落 hasTargetRef=true');
});

test('MVP74 后端校正：标 can_produce_artifact 但 evidence=0 → 不升交付卡（降级）', () => {
  resetDb();
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: goodArtifact, evidence: [] }) });
  assert.equal(artifactCard(m.id), undefined, 'evidence=0 → 不升交付卡');
  // progressed conf 0.7 evidence=0：不满足 progress 卡(需 conf≥0.6 但…) —— 至少不应是 artifact
  assert.ok(!artifactCard(m.id));
  void r;
});

test('MVP74 后端校正：artifact 缺 targetRef（解析即降级）→ 不升交付卡，落回 progress', () => {
  resetDb();
  const m = mkMatter();
  // 直接喂 parse 后等价的 conclusion：artifact=undefined（模拟脏数据被 parse 丢弃），verdict=progressed
  const r = applyInvestigationResult({ matterId: m.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: undefined }) });
  assert.equal(artifactCard(m.id), undefined, '无合法 artifact → 不升交付卡');
  const prog = db.db.prepare(`SELECT 1 FROM attention_items WHERE input_hash=?`).get(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${m.id}`);
  assert.ok(prog, 'progressed 落回进展卡');
  void r;
});

test('MVP74 不吞求助：blocked + 缺 traceID + 无合法 artifact → 仍走 need_credential 求助卡', () => {
  resetDb();
  const m = mkMatter();
  const r = applyInvestigationResult({
    matterId: m.id,
    conclusion: { verdict: 'blocked', confidence: 0.6, factSummary: '要追代码根因但拿不到 traceID', evidence: ['IM 里没有日志ID'], solvability: 'need_user' },
  });
  assert.equal(artifactCard(m.id), undefined, '无 artifact → 不升交付卡');
  const help = db.db.prepare(`SELECT 1 FROM attention_items WHERE input_hash=?`).get(`${MATTER_NEEDHELP_PROPOSAL_PREFIX}${m.id}`);
  assert.ok(help, '应走求助卡（artifact 不抢）');
  void r;
});

test('MVP74 互斥：已有在场进展卡 → 升交付卡时顶掉进展（artifact > progress）', () => {
  resetDb();
  const m = mkMatter();
  raiseMatterProgressProposal(ms.getMatterById(m.id)!, { verdict: 'progressed', factSummary: '有进展', evidence: ['e'], confidence: 0.7 });
  const progBefore = db.db.prepare(`SELECT status FROM attention_items WHERE input_hash=?`).get(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${m.id}`) as { status: string };
  assert.equal(progBefore.status, 'live');
  const r = applyInvestigationResult({ matterId: m.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: goodArtifact }) });
  assert.equal(r.proposalRaised, true);
  assert.ok(artifactCard(m.id), '交付卡在场');
  const progAfter = db.db.prepare(`SELECT status FROM attention_items WHERE input_hash=?`).get(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${m.id}`) as { status: string };
  assert.notEqual(progAfter.status, 'live', '进展卡被顶掉');
});

test('MVP74 向后兼容：solvability 缺失 → 等价今天 verdict 级联（progressed→进展卡，不升交付卡）', () => {
  resetDb();
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: { verdict: 'progressed', confidence: 0.7, factSummary: '查到进展', evidence: ['e'] } });
  assert.equal(artifactCard(m.id), undefined, '无 solvability → 不升交付卡');
  const prog = db.db.prepare(`SELECT 1 FROM attention_items WHERE input_hash=?`).get(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${m.id}`);
  assert.ok(prog, '落回进展卡');
  void r;
});
