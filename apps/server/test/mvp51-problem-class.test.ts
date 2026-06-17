/**
 * MVP51 — 问题类聚合（case→根因类台账）测试。
 * 覆盖：诊断门/症状桶/前缀剥离纯函数、解析(只收候选内 id)、store CRUD、
 * 以及核心——LLM 拥有类身份的归类（同症状不同根因拆开 / 归到已有类 / reject / systemic / gating）。
 *
 * Run: npx tsx --test apps/server/test/mvp51-problem-class.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp51-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const types = await import('../src/problemClass/problemClassTypes.js');
const prompt = await import('../src/problemClass/problemClassDistillPrompt.js');
const analyzePrompt = await import('../src/problemClass/problemClassAnalyzePrompt.js');
const store = await import('../src/problemClass/problemClassStore.js');
const svc = await import('../src/problemClass/problemClassService.js');
const { config } = await import('../src/config.js');
const ms = await import('../src/matter/matterStore.js');
const cs = await import('../src/context/contextStore.js');
const { userReopenMatter } = await import('../src/matter/matterActions.js');

// ---- 纯函数 ----

test('deriveSymptomBucket：归到通用症状桶', () => {
  assert.equal(types.deriveSymptomBucket('内容被截断了'), '截断');
  assert.equal(types.deriveSymptomBucket('docx 鉴权失败 fallback 敏感'), '鉴权');
  assert.equal(types.deriveSymptomBucket('数据库连接报错'), '报错');
  assert.equal(types.deriveSymptomBucket('一切正常的描述'), '其他');
});

test('isDiagnostic：诊断/根因文本收，已完成/查不到进展弃', () => {
  assert.equal(types.isDiagnostic('middleware suppress 未返回 tool result 致 loop 断掉'), true);
  assert.equal(types.isDiagnostic('根因 list_feishu_calendar_events 返回冗长已定位'), true);
  assert.equal(types.isDiagnostic('模型走入安装技能链路导致无权限用户报错'), true);
  assert.equal(types.isDiagnostic('已完成并已发送给对方'), false);
  assert.equal(types.isDiagnostic('未查到该承诺的任何进展证据'), false);
  assert.equal(types.isDiagnostic('短'), false);
});

test('stripSummaryPrefix：剥掉 ［AI 排查］ 前缀取首段', () => {
  assert.equal(types.stripSummaryPrefix('［AI 排查］根因X已定位｜其他历史'), '根因X已定位');
  assert.equal(types.stripSummaryPrefix('普通摘要'), '普通摘要');
});

test('parseProblemClassOutput：只收候选内 matterId/classId', () => {
  const mids = new Set(['m1', 'm2', 'm3']);
  const cids = new Set(['c1']);
  const out = prompt.parseProblemClassOutput(
    JSON.stringify({
      assignments: [
        { matterId: 'm1', classId: 'c1' },
        { matterId: 'm2', newClass: { label: '截断类', rootCause: '工具返回被截断' } },
        { matterId: 'm3', reject: true, reason: '孤例' },
        { matterId: 'mX', classId: 'c1' }, // matterId 越界 → 丢
        { matterId: 'm1', classId: 'cX' }, // classId 越界 → 丢
      ],
    }),
    mids,
    cids
  );
  assert.equal(out.length, 3);
  assert.equal(out[0].classId, 'c1');
  assert.equal(out[1].newClass?.label, '截断类');
  assert.equal(out[2].reject, true);
});

// ---- store ----

test('store：upsert 成员 / 分配 / 建类 / refresh systemic / 台账', () => {
  const sid = 'space-store-' + randomUUID().slice(0, 6);
  const m1 = 'm-' + randomUUID();
  const r = store.upsertMember({ matterId: m1, spaceId: sid, symptomBucket: '报错', diagnosticText: 'DB 连接报错', evidence: ['e1'], confidence: 0.7 });
  assert.equal(r.isNew, true);
  assert.equal(store.countPendingMembers(sid), 1);
  const cls = store.createDistilledClass({ spaceId: sid, label: 'DB 连接', rootCause: 'DB 连接池耗尽' });
  store.setMemberAssigned(m1, cls.id);
  assert.equal(store.countPendingMembers(sid), 0);
  // 再加两条 assigned → 该类 systemic
  for (let i = 0; i < 2; i++) {
    const mid = 'm-' + randomUUID();
    store.upsertMember({ matterId: mid, spaceId: sid, symptomBucket: '报错', diagnosticText: 'DB 报错变体', evidence: [], confidence: 0.7 });
    store.setMemberAssigned(mid, cls.id);
  }
  const refreshed = store.refreshClass(cls.id);
  assert.equal(refreshed?.memberCount, 3);
  assert.equal(refreshed?.systemic, true);
  const ledger = store.listLedger(sid);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].members.length, 3);
});

// ---- 核心：LLM 拥有类身份 ----

test('归类：同症状不同根因 → 拆成两类（核心诉求）', async () => {
  const sid = 'space-split-' + randomUUID().slice(0, 6);
  const mDb = 'm-' + randomUUID();
  const mAuth = 'm-' + randomUUID();
  svc.ingestMember({ matterId: mDb, spaceId: sid, text: 'DB 连接超时报错，连接池耗尽', confidence: 0.7 });
  svc.ingestMember({ matterId: mAuth, spaceId: sid, text: '调用下游鉴权 token 过期报错', confidence: 0.7 });
  assert.equal(store.countPendingMembers(sid), 2);
  // 两条都"报错"，但根因不同 → judge 拆成两个新类
  const judge = async () =>
    JSON.stringify({
      assignments: [
        { matterId: mDb, newClass: { label: 'DB 连接耗尽', rootCause: '数据库连接池耗尽导致连接超时' } },
        { matterId: mAuth, newClass: { label: '下游鉴权过期', rootCause: '下游服务 token 过期未刷新' } },
      ],
    });
  const ok = await svc.maybeDistillForSpace(sid, { judge });
  assert.equal(ok, true);
  const ledger = store.listLedger(sid);
  assert.equal(ledger.length, 2, '同症状不同根因必须拆成两类');
  assert.equal(store.countPendingMembers(sid), 0);
});

test('归类：归到已有类 + reject 孤例', async () => {
  const sid = 'space-assign-' + randomUUID().slice(0, 6);
  const existing = store.createDistilledClass({ spaceId: sid, label: '内容截断', rootCause: '工具返回被截断、未取全文' });
  const mHit = 'm-' + randomUUID();
  const mNoise = 'm-' + randomUUID();
  svc.ingestMember({ matterId: mHit, spaceId: sid, text: '字段没取到，疑似 get_base_schema 截断', confidence: 0.7 });
  svc.ingestMember({ matterId: mNoise, spaceId: sid, text: '某个说不清的报错', confidence: 0.7 });
  const judge = async () =>
    JSON.stringify({
      assignments: [
        { matterId: mHit, classId: existing.id }, // 不同症状(没取到) 同根因(截断) → 归到已有类
        { matterId: mNoise, reject: true, reason: '诊断太泛，孤例' },
      ],
    });
  await svc.maybeDistillForSpace(sid, { judge });
  const cls = store.getProblemClass(existing.id);
  assert.equal(cls?.memberCount, 1);
  assert.equal(store.countPendingMembers(sid), 0); // 一个 assigned 一个 rejected，都不再 pending
});

test('ingestMember：非诊断/低置信不吸纳', () => {
  const sid = 'space-gate-' + randomUUID().slice(0, 6);
  assert.equal(svc.ingestMember({ matterId: 'g1', spaceId: sid, text: '已完成并发送', confidence: 0.9 }), false);
  assert.equal(svc.ingestMember({ matterId: 'g2', spaceId: sid, text: 'DB 报错根因已定位', confidence: 0.4 }), false); // 低置信
  assert.equal(svc.ingestMember({ matterId: 'g3', spaceId: sid, text: 'DB 报错根因已定位', confidence: 0.7 }), true);
  assert.equal(store.countPendingMembers(sid), 1);
});

test('gating：problemClassEnabled=false 时不吸纳/不蒸馏', async () => {
  const saved = config.problemClassEnabled;
  config.problemClassEnabled = false;
  try {
    assert.equal(svc.ingestMember({ matterId: 'off1', spaceId: 'sp', text: 'DB 报错根因已定位', confidence: 0.8 }), false);
    assert.equal(await svc.maybeDistillForSpace('sp', { judge: async () => '{}' }), false);
  } finally {
    config.problemClassEnabled = saved;
  }
});

test('backfillMembersFromMatters：空库不崩、返回数', () => {
  const n = svc.backfillMembersFromMatters();
  assert.equal(typeof n, 'number');
});

test('MVP54 setProblemClassStatus：open→fixing→resolved', () => {
  const c = store.createDistilledClass({ spaceId: 'sp-st', label: 'x', rootCause: 'y' });
  assert.equal(store.getProblemClass(c.id)?.status, 'open'); // 默认
  assert.equal(store.setProblemClassStatus(c.id, 'fixing')?.status, 'fixing');
  assert.equal(store.setProblemClassStatus(c.id, 'resolved')?.status, 'resolved');
});

test('MVP55 syncClassStatusForResolvedMatter：成员 matter 全办结 → 类自动标记已修复（缺一不标）', () => {
  const sid = 'sp-sync-' + randomUUID().slice(0, 6);
  const c = store.createDistilledClass({ spaceId: sid, label: '同类 bug', rootCause: '同一根因' });
  function mkResolvedMatter(resolved: boolean): string {
    const unit = cs.upsertContextUnit({ kind: 'commitment', title: 't', content: 'c', scope: 'work', origin: { kind: 'manual', refId: 'r-' + randomUUID() }, silent: true }).unit;
    const m = ms.createMatter({ scope: 'work', type: 'follow_up', title: '事项' + randomUUID().slice(0, 4), canonicalKey: 'k-' + randomUUID(), createdFromContextUnitId: unit.id, currentSummary: 's', nextAction: 'n' });
    store.upsertMember({ matterId: m.id, spaceId: sid, symptomBucket: '报错', diagnosticText: 'bug 根因', evidence: [], confidence: 0.8 });
    store.setMemberAssigned(m.id, c.id);
    if (resolved) ms.saveMatter({ ...ms.getMatterById(m.id)!, status: 'resolved' as never });
    return m.id;
  }
  const m1 = mkResolvedMatter(true);
  const m2 = mkResolvedMatter(false); // 还没办结
  svc.syncClassStatusForResolvedMatter(m1);
  assert.notEqual(store.getProblemClass(c.id)?.status, 'resolved', '还有成员未办结 → 类不标记已修复');
  ms.saveMatter({ ...ms.getMatterById(m2)!, status: 'resolved' as never });
  svc.syncClassStatusForResolvedMatter(m2);
  assert.equal(store.getProblemClass(c.id)?.status, 'resolved', '全部成员办结 → 类自动标记已修复');
  // MVP55 对称可逆：重开任一成员 matter → 类自动恢复 open（否则台账谎报已修复）
  userReopenMatter(m1, '测试重开');
  assert.equal(store.getProblemClass(c.id)?.status, 'open', '重开成员 → 类对称恢复 open');
});

test('MVP56 parseClassAnalysis：合法解析；缺系统性根因/解法 → null', () => {
  const ok = analyzePrompt.parseClassAnalysis(JSON.stringify({ systematicRootCause: '工具返回普遍被截断', systematicSolution: '统一加分页+fetch全文', affectedScope: 'get_base_schema', recommendedAction: '改 schema 读取', confidence: 0.7 }));
  assert.equal(ok?.systematicSolution, '统一加分页+fetch全文');
  assert.equal(ok?.confidence, 0.7);
  assert.equal(analyzePrompt.parseClassAnalysis(JSON.stringify({ systematicRootCause: '只有根因没解法' })), null);
  assert.equal(analyzePrompt.parseClassAnalysis('不是 JSON'), null);
});

test('MVP56 analyzeClass：综合成员 → 写"待审阅"系统性分析（不动任何 matter 状态）', async () => {
  const sid = 'sp-an-' + randomUUID().slice(0, 6);
  const c = store.createDistilledClass({ spaceId: sid, label: '截断类', rootCause: '工具返回被截断' });
  for (let i = 0; i < 2; i++) {
    const mid = 'm-' + randomUUID();
    store.upsertMember({ matterId: mid, spaceId: sid, symptomBucket: '截断', diagnosticText: `case${i} 字段没取全`, evidence: [], confidence: 0.8 });
    store.setMemberAssigned(mid, c.id);
  }
  const judge = async () => JSON.stringify({ systematicRootCause: '都因工具返回被截断', systematicSolution: '统一分页+fetch全文', affectedScope: 'get_base_schema', recommendedAction: '改读取逻辑', confidence: 0.8 });
  const ok = await svc.analyzeClass(c.id, { judge });
  assert.equal(ok, true);
  const got = store.getProblemClass(c.id)!;
  assert.equal(got.analysisStatus, 'pending_review', '分析结论必须待审阅，不自动落地');
  assert.equal(got.analysis?.systematicSolution, '统一分页+fetch全文');
  // 审阅
  store.markClassAnalysisReviewed(c.id);
  assert.equal(store.getProblemClass(c.id)?.analysisStatus, 'reviewed');
});

test('MVP56 maybeAnalyzeClass：非 systemic 不自动分析；systemic 且未分析才跑', async () => {
  const sid = 'sp-auto-' + randomUUID().slice(0, 6);
  const c = store.createDistilledClass({ spaceId: sid, label: 'x', rootCause: 'y' });
  let called = 0;
  const judge = async () => { called++; return JSON.stringify({ systematicRootCause: 'r', systematicSolution: 's', affectedScope: '', recommendedAction: '', confidence: 0.6 }); };
  // 只有 1 成员 → 非 systemic → 不分析
  const m1 = 'm-' + randomUUID();
  store.upsertMember({ matterId: m1, spaceId: sid, symptomBucket: '报错', diagnosticText: 'd', evidence: [], confidence: 0.8 });
  store.setMemberAssigned(m1, c.id);
  store.refreshClass(c.id);
  assert.equal(await svc.maybeAnalyzeClass(c.id, { judge }), false);
  assert.equal(called, 0);
  // 加到 3 成员 → systemic → 自动分析
  for (let i = 0; i < 2; i++) { const mid = 'm-' + randomUUID(); store.upsertMember({ matterId: mid, spaceId: sid, symptomBucket: '报错', diagnosticText: 'd' + i, evidence: [], confidence: 0.8 }); store.setMemberAssigned(mid, c.id); }
  store.refreshClass(c.id);
  assert.equal(await svc.maybeAnalyzeClass(c.id, { judge }), true);
  assert.equal(store.getProblemClass(c.id)?.analysisStatus, 'pending_review');
});

test('MVP54 listLedger.aiResolvedHint：成员诊断含"已修复"且 open → 提示；resolved 后不提示', () => {
  const sid = 'sp-hint-' + randomUUID().slice(0, 6);
  const c = store.createDistilledClass({ spaceId: sid, label: 'middleware', rootCause: 'suppress 未返回' });
  const mid = 'm-' + randomUUID();
  store.upsertMember({ matterId: mid, spaceId: sid, symptomBucket: '报错', diagnosticText: 'middleware bug 已修复，合入 release-2026.6.3', evidence: [], confidence: 0.8 });
  store.setMemberAssigned(mid, c.id);
  store.refreshClass(c.id);
  const led1 = store.listLedger(sid).find((x) => x.id === c.id);
  assert.equal(led1?.aiResolvedHint, true);
  store.setProblemClassStatus(c.id, 'resolved');
  const led2 = store.listLedger(sid).find((x) => x.id === c.id);
  assert.equal(led2?.aiResolvedHint, false, 'resolved 后不再提示');
});

test('userEditClass / approveClass：升权威，且自发蒸馏不再覆盖根因', () => {
  const sid = 'space-auth-' + randomUUID().slice(0, 6);
  const c = store.createDistilledClass({ spaceId: sid, label: '旧标签', rootCause: '蒸馏给的根因' });
  // 用户校正 → 权威
  const edited = store.userEditClass(c.id, { label: '人改标签', rootCause: '人写的真根因' });
  assert.equal(edited?.origin, 'user');
  assert.equal(edited?.approved, true);
  assert.equal(edited?.rootCause, '人写的真根因');
  // 自发蒸馏想刷新文案 → 被权威避让（只更计数，不覆盖根因/标签）
  const refreshed = store.refreshClass(c.id, { rootCause: '蒸馏又想改', label: '蒸馏标签' });
  assert.equal(refreshed?.rootCause, '人写的真根因', '权威版根因不被蒸馏覆盖');
  assert.equal(refreshed?.label, '人改标签');
  // approveClass：草稿升批准
  const c2 = store.createDistilledClass({ spaceId: sid, label: 'x', rootCause: 'y' });
  assert.equal(store.approveClass(c2.id)?.approved, true);
});
