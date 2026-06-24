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

// ---- 审查 P1：交付卡独立配额，不饿死安全求助 ----
test('MVP74 审查P1：3张交付卡占满后，第4个matter的求助卡仍能升（artifact独立配额，安全>交付）', () => {
  resetDb();
  for (let i = 0; i < 3; i++) {
    const m = mkMatter();
    const r = applyInvestigationResult({ matterId: m.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: goodArtifact }) });
    assert.equal(r.proposalRaised, true, `第${i + 1}张交付卡应升`);
  }
  assert.equal(db.countLiveArtifactProposals(), 3);
  assert.equal(db.countLivePendingUserProposals(), 0, '安全求助池不被交付卡占用');
  // 第4个 matter 缺 traceID 求助 → 仍应升 needhelp（pre-fix 会被饿死）
  const m4 = mkMatter();
  applyInvestigationResult({ matterId: m4.id, conclusion: { verdict: 'blocked', confidence: 0.6, factSummary: '要追代码根因但拿不到 traceID', evidence: ['IM里没有日志ID'], solvability: 'need_user' } });
  const help = db.db.prepare(`SELECT 1 FROM attention_items WHERE input_hash=?`).get(`${MATTER_NEEDHELP_PROPOSAL_PREFIX}${m4.id}`);
  assert.ok(help, '求助卡不被交付卡饿死');
});

test('MVP74 审查P2：交付卡满独立cap后第4张落回进展卡（fall-through，不静默吞）', () => {
  resetDb();
  for (let i = 0; i < 3; i++) { const m = mkMatter(); applyInvestigationResult({ matterId: m.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: goodArtifact }) }); }
  const m4 = mkMatter();
  const r = applyInvestigationResult({ matterId: m4.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: goodArtifact }) });
  assert.equal(artifactCard(m4.id), undefined, '第4张交付卡被独立cap挡');
  const prog = db.db.prepare(`SELECT 1 FROM attention_items WHERE input_hash=?`).get(`${MATTER_PROGRESS_PROPOSAL_PREFIX}${m4.id}`);
  assert.ok(prog, 'fall-through 到进展卡，不静默吞');
  assert.equal(r.proposalRaised, true);
});

test('MVP74 审查P2：targetRef 无 file:line 形态（编造"大概在X模块"）→ isValidArtifact false', () => {
  assert.equal(isValidArtifact({ ...goodArtifact, targetRef: 'formula 模块大概' }), false, '无行号纯文本→false');
  assert.equal(isValidArtifact({ ...goodArtifact, targetRef: 'formula.ts' }), false, '只有文件无行号→false');
  assert.equal(isValidArtifact({ ...goodArtifact, targetRef: 'src/a.ts:42' }), true);
  assert.equal(isValidArtifact({ ...goodArtifact, targetRef: 'a.py:10; b.py:20' }), true, '多个 file:line→true');
});

// ---- P1-6：扩 task_spec / decision_brief ----
const taskSpec = { kind: 'task_spec' as const, title: '带 LogID 给邓贵羊', body: '整理本周 badcase 的 LogID 发邓贵羊跟进 TEA 方案', assignee: '我' };
const decisionBrief = { kind: 'decision_brief' as const, title: '是否含图片引用功能', body: '【立场】A要B不要【约束】排期紧【尚缺】无【建议】本期不做' };

test('P1-6 isValidArtifact：task_spec/decision_brief 不需 targetRef；code_fix 仍需', () => {
  assert.equal(isValidArtifact(taskSpec), true);
  assert.equal(isValidArtifact(decisionBrief), true);
  assert.equal(isValidArtifact({ kind: 'task_spec', title: '', body: 'x' } as any), false, 'title 空→false');
  assert.equal(isValidArtifact({ kind: 'task_spec', title: 'x', body: '' } as any), false, 'body 空→false');
  assert.equal(isValidArtifact({ ...taskSpec, kind: 'code_fix' } as any), false, 'code_fix 缺 targetRef→false');
  assert.equal(isValidArtifact({ kind: 'whatever', title: 'x', body: 'y' } as any), false, '非法 kind→false');
});

test('P1-6 task_spec → 升「待建任务」卡 + audit artifactKind=task_spec/hasTargetRef=false', () => {
  resetDb();
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: taskSpec }) });
  assert.equal(r.proposalRaised, true);
  const card = artifactCard(m.id);
  assert.match(card!.title, /待建任务/);
  assert.match(card!.why, /带 LogID/);
  const audit = JSON.parse((db.db.prepare(`SELECT payload_json FROM audit_logs WHERE action='matter_artifact_raised' LIMIT 1`).get() as any).payload_json);
  assert.equal(audit.artifactKind, 'task_spec');
  assert.equal(audit.hasTargetRef, false, 'task_spec 无 file:line');
});

test('P1-6 decision_brief → 升「决策信息包」卡（不替用户拍板）', () => {
  resetDb();
  const m = mkMatter();
  const r = applyInvestigationResult({ matterId: m.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: decisionBrief }) });
  assert.equal(r.proposalRaised, true);
  assert.match(artifactCard(m.id)!.title, /决策信息包/);
  assert.match(artifactCard(m.id)!.why, /建议/);
});

test('P1-6 producedCount 计入 task_spec/decision_brief（无 targetRef 也算真产出）', () => {
  resetDb();
  const m1 = mkMatter(); applyInvestigationResult({ matterId: m1.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: taskSpec }) });
  const m2 = mkMatter(); applyInvestigationResult({ matterId: m2.id, conclusion: concl({ solvability: 'can_produce_artifact', artifact: decisionBrief }) });
  assert.equal(db.getAiActivityTally().producedCount, 2, '两个非 code_fix 交付件都计入产出率');
});
