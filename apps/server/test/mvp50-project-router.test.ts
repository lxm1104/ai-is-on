/**
 * MVP50 — 项目路由（事项→项目，决定拼哪个项目的排查档案）测试。
 * 覆盖：纯解析(只收候选内 id)、确定性三档(primary/标题包含/不命中)、AI 兜底(注入 judge)+缓存+gating、
 * 以及 resolveProjectProfileForMatter 端到端取档案。
 *
 * Run: npx tsx --test apps/server/test/mvp50-project-router.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp50-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const dbm = await import('../src/db.js');
const { config } = await import('../src/config.js');
const router = await import('../src/investigation/projectRouter.js');
const { buildProjectRouterMessage, parseProjectRouterReply } = await import('../src/investigation/projectRouterPrompt.js');
const profileMod = await import('../src/investigation/projectProfile.js');

function mkProjectSpace(name: string, profile?: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  dbm.insertContextSpace({
    id, type: 'project', name, description: null,
    owner_subject_id: 'me', status: 'active', created_at: now, updated_at: now,
  });
  if (profile) dbm.setSpaceInvestigationProfile(id, profile, now);
  return id;
}

// ---- 纯解析：只接受候选集合内的 id ----

test('parseProjectRouterReply：候选内 id 收，越界/编造/null/垃圾一律 null', () => {
  const ids = new Set(['sp_a', 'sp_b']);
  assert.equal(parseProjectRouterReply('{"spaceId":"sp_a"}', ids), 'sp_a');
  assert.equal(parseProjectRouterReply('{"spaceId":"sp_HALLUCINATED"}', ids), null); // 不在候选 → 丢弃
  assert.equal(parseProjectRouterReply('{"spaceId":null}', ids), null);
  assert.equal(parseProjectRouterReply('随便说点啥没有json', ids), null);
  assert.equal(parseProjectRouterReply('```json\n{"spaceId":"sp_b"}\n```', ids), 'sp_b'); // 带围栏也能解
});

test('buildProjectRouterMessage：含候选 id 与标题', () => {
  const msg = buildProjectRouterMessage(
    { title: '排查 Chatbot trigger', currentSummary: '某 case 报错' },
    [{ id: 'sp_a', name: 'Chatbot', aliases: ['bitable', '多维表格'] }]
  );
  assert.match(msg, /排查 Chatbot trigger/);
  assert.match(msg, /id=sp_a/);
  assert.match(msg, /别名=bitable\/多维表格/);
});

// ---- 确定性三档 ----

test('确定性①：primarySpaceId 直出（basis=primary，零 DB 依赖）', () => {
  const r = router.resolveProjectSpaceDeterministic({ primarySpaceId: 'sp_primary_1' });
  assert.deepEqual(r, { spaceId: 'sp_primary_1', basis: 'primary' });
});

test('确定性③：标题包含独特项目名 → basis=title 唯一命中', () => {
  const sid = mkProjectSpace('Chatbot灰度内测', '代码库：/Users/x/MyProject/bitable-chatbot');
  const r = router.resolveProjectSpaceDeterministic({
    title: '排查 Chatbot灰度内测 的 trigger 聚合 query 报错',
    primarySpaceId: null,
  });
  assert.equal(r?.basis, 'title');
  assert.equal(r?.spaceId, sid);
});

test('确定性：完全不相关标题 → null（宁缺毋错）', () => {
  const r = router.resolveProjectSpaceDeterministic({ title: 'zzz 毫不相关 qwerty 9999 任务', primarySpaceId: null });
  assert.equal(r, null);
});

test('isDistinctiveName：长/独特名可信，短/通用名不可信', () => {
  for (const n of ['Chatbot灰度内测', 'OrderPipeline', '端到端项目X独特名', '订单履约系统']) {
    assert.equal(router.isDistinctiveName(n), true, `${n} 应判为独特`);
  }
  for (const n of ['Chatbot', 'test', '测试', '报错', 'API', 'app']) {
    assert.equal(router.isDistinctiveName(n), false, `${n} 应判为不独特`);
  }
});

test('确定性③防误路由：短项目名(Chatbot)在不相关标题里"顺带出现" → 不路由（核心修复）', () => {
  // Chatbot 7 个英数字 <8 → 不独特 → 不可信其子串。这件事其实属于"订单链路"，只是顺带提了 Chatbot。
  mkProjectSpace('Chatbot', '代码库 /repo/chatbot —— 不该被这条事项拼进去');
  const r = router.resolveProjectSpaceDeterministic({
    title: '订单链路里 Chatbot 调用超时排查 trace',
    primarySpaceId: null,
  });
  assert.equal(r, null, '短名顺带提及不得确定性路由（应交给 AI 兜底用全上下文判）');
});

test('确定性③防误路由：标题同时含两个独特项目名 → 歧义不采纳（null）', () => {
  mkProjectSpace('歧义项目甲独特名', 'A');
  mkProjectSpace('歧义项目乙独特名', 'B');
  const r = router.resolveProjectSpaceDeterministic({
    title: '把 歧义项目甲独特名 的能力集成进 歧义项目乙独特名',
    primarySpaceId: null,
  });
  assert.equal(r, null, '两个独特名都命中 → 歧义，宁缺毋错');
});

test('确定性③防误路由：通用短名(测试) 即便出现也不路由', () => {
  mkProjectSpace('测试', 'profile of 测试 项目');
  const r = router.resolveProjectSpaceDeterministic({ title: '测试 一下这个新功能能不能跑', primarySpaceId: null });
  assert.notEqual(r?.basis, 'title');
});

// ---- AI 兜底：注入 judge ----

test('AI 兜底：确定性命中(primary)时绝不调用 judge', async () => {
  let called = 0;
  const judge = async () => { called++; return '{"spaceId":"x"}'; };
  const r = await router.resolveProjectSpaceWithAI({ id: 'm1', primarySpaceId: 'sp_primary_2' }, { judge });
  assert.equal(r?.basis, 'primary');
  assert.equal(called, 0, '确定性命中不应打 LLM');
});

test('AI 兜底：确定性落空 → judge 选中候选 id → basis=ai；二次命中缓存不再打', async () => {
  router._clearProjectRouterCache();
  const sid = mkProjectSpace('AImatchProjUnique', '该项目的处理方法 ……'); // 有档案才进候选
  let called = 0;
  const judge = async () => { called++; return JSON.stringify({ spaceId: sid }); };
  const matter = { id: 'm-ai-' + randomUUID(), title: '一个无法确定性命中的 xyzzy-不相关-标题', primarySpaceId: null };
  const r1 = await router.resolveProjectSpaceWithAI(matter, { judge });
  assert.equal(r1?.basis, 'ai');
  assert.equal(r1?.spaceId, sid);
  const r2 = await router.resolveProjectSpaceWithAI(matter, { judge });
  assert.equal(r2?.spaceId, sid);
  assert.equal(called, 1, '同一 matterId 应命中缓存，judge 只打一次');
});

test('AI 兜底：judge 给越界 id → null（不拼错项目）', async () => {
  router._clearProjectRouterCache();
  mkProjectSpace('AnotherProjWithProfile', '处理方法 ……');
  const judge = async () => '{"spaceId":"sp_NOT_A_CANDIDATE"}';
  const r = await router.resolveProjectSpaceAI({ id: 'm-bad-' + randomUUID(), title: 'xyzzy 不相关' }, { judge });
  assert.equal(r, null);
});

test('AI 兜底：config.projectRoutingAiEnabled=false 时直接 null，不打 judge', async () => {
  router._clearProjectRouterCache();
  let called = 0;
  const judge = async () => { called++; return '{}'; };
  const saved = config.projectRoutingAiEnabled;
  config.projectRoutingAiEnabled = false;
  try {
    const r = await router.resolveProjectSpaceAI({ id: 'm-off-' + randomUUID(), title: 'xyzzy' }, { judge });
    assert.equal(r, null);
    assert.equal(called, 0);
  } finally {
    config.projectRoutingAiEnabled = saved;
  }
});

// ---- 端到端：resolveProjectProfileForMatter 取到档案 ----

test('resolveProjectProfileForMatter：primary 命中取档案；标题命中也取得到', async () => {
  const sid = mkProjectSpace('端到端项目X独特名', '代码库：/repo/x\nTrace：fornax-cli');
  const viaPrimary = await profileMod.resolveProjectProfileForMatter({ id: 'mp1', primarySpaceId: sid });
  assert.match(viaPrimary || '', /fornax-cli/);
  const viaTitle = await profileMod.resolveProjectProfileForMatter({ id: 'mp2', title: '排查 端到端项目X独特名 的问题', primarySpaceId: null });
  assert.match(viaTitle || '', /fornax-cli/);
});
