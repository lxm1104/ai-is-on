/**
 * MVP81「征询习惯学习：记录 → 会用」+「可迁移学习包」。
 * 覆盖：习惯引擎纯函数（连续一致才算惯例/安全白名单/暂停闸/具体对象层覆盖通用层/过期不作数）、
 * 惯例成立照办不再问（含自动日配额回落为征询）、征询带「猜你会选」提示 + 回「好」兑现、
 * 「先问我」刹车、学习包导出去个人化 + 导入进草稿避让权威版。
 *
 * Run: npx tsx --test apps/server/test/mvp81-consult-habit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp81-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.CONSULT_DAILY_MAX = '10';
process.env.CONSULT_AUTO_DAILY_MAX = '1'; // 便于测"自动配额用尽回落为征询"

const engine = await import('../src/habit/consultHabitEngine.js');
const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const notify = await import('../src/lark/larkNotifyService.js');
const consult = await import('../src/matter/consultService.js');
const learning = await import('../src/routes/learning.js');
const pbStore = await import('../src/playbook/playbookStore.js');
const { writeAudit } = await import('../src/boundary/auditLog.js');
const db = await import('../src/db.js');

const SELF = 'self-' + randomUUID();
const now = new Date().toISOString();
function mkPerson(name: string): string {
  const id = 'p-' + randomUUID();
  db.insertContextEntity({
    id, type: 'person', name, aliases_json: '[]', source: 'test', confidence: 0.9,
    created_at: now, updated_at: now, attributes_json: null,
  } as never);
  return id;
}
function resetDb() {
  db.db.exec(
    `DELETE FROM attention_items; DELETE FROM matters; DELETE FROM context_units;
     DELETE FROM matter_context_links; DELETE FROM audit_logs; DELETE FROM matter_entities;
     DELETE FROM matter_transitions; DELETE FROM settings; DELETE FROM context_entities;
     DELETE FROM task_playbooks; DELETE FROM task_traces;`
  );
  db.insertContextEntity({
    id: SELF, type: 'person', name: '刘昕明', aliases_json: '[]', source: 'test', confidence: 1,
    created_at: now, updated_at: now, attributes_json: JSON.stringify({ larkLocalizedName: '刘昕明' }),
  } as never);
  db.setSetting('self_person_entity_id', SELF);
  notify.__disarmNotifyServiceForTest();
}

let n = 0;
function mkMatter(entities: Array<{ entityId: string; role: string }>) {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment', title: `事项${n}`, content: `有人在群里请刘昕明处理问题 ${n}`,
    scope: 'work', origin: { kind: 'manual', refId: `u-${n}` }, silent: true,
  }).unit;
  return ms.createMatter({
    scope: 'work', type: 'follow_up', title: `帮王爽排查问题${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id,
    ownerEntityId: SELF, currentSummary: '王爽反馈查询结果不准', nextAction: '跟进',
    entities: entities as never,
  });
}
function armSender() {
  const sent: Array<{ args: string[] }> = [];
  notify.__setNotifySenderForTest(async (args: string[]) => {
    sent.push({ args });
    return { ok: true, data: { message_id: `om_${sent.length}`, chat_id: 'oc_t' } };
  });
  return sent;
}
const mdOf = (s: { args: string[] }) => s.args[s.args.indexOf('--markdown') + 1];
function mkAck() {
  const acks: string[] = [];
  return { acks, ack: async (md: string) => { acks.push(md); } };
}
/** 造一条历史选择审计（习惯学习的原料）。 */
function seedChoice(matterId: string, choice: string) {
  writeAudit({ action: 'consult_choice', reason: 't', payload: { matterId, choice, text: choice } });
}

// ---- 引擎纯函数 ----
test('MVP81 引擎：连续一致≥N 且在安全白名单 → auto；断档/不安全/暂停/无历史 → ask', () => {
  const at = (i: number) => new Date(Date.parse('2026-07-01T00:00:00Z') + i * 60_000).toISOString();
  const ev = (choice: string, i: number, subjectId = 'wang') => ({ key: 'follow_up:chase', subjectId, choice, at: at(i) });
  const params = { autoMinStreak: 3, autoSafeChoices: ['draft', 'investigate'], now: at(10) };
  // 连续 3 次同选择 → auto
  const d1 = engine.decideConsultHabit([ev('investigate', 1), ev('investigate', 2), ev('investigate', 3)],
    { key: 'follow_up:chase', subjectId: 'wang' }, params);
  assert.deepEqual(d1, { mode: 'auto', choice: 'investigate', habitKey: 'wang|follow_up:chase', evidenceCount: 3 });
  // 中间被别的选择打断 → 最近 streak 只有 2 → ask 带提示
  const d2 = engine.decideConsultHabit([ev('investigate', 1), ev('draft', 2), ev('investigate', 3), ev('investigate', 4)],
    { key: 'follow_up:chase', subjectId: 'wang' }, params);
  assert.equal(d2.mode, 'ask');
  assert.equal((d2 as { hintedChoice: string }).hintedChoice, 'investigate');
  // 不在安全白名单（ignore 会归档）→ 永不 auto
  const d3 = engine.decideConsultHabit([ev('ignore', 1), ev('ignore', 2), ev('ignore', 3)],
    { key: 'follow_up:chase', subjectId: 'wang' }, params);
  assert.equal(d3.mode, 'ask');
  // 暂停闸：命中 pausedKeys → 只提示不自动
  const d4 = engine.decideConsultHabit([ev('investigate', 1), ev('investigate', 2), ev('investigate', 3)],
    { key: 'follow_up:chase', subjectId: 'wang' }, { ...params, pausedKeys: ['follow_up:chase'] });
  assert.equal(d4.mode, 'ask');
  // 无历史 → ask 无提示
  const d5 = engine.decideConsultHabit([], { key: 'follow_up:chase', subjectId: 'wang' }, params);
  assert.deepEqual(d5, { mode: 'ask', hintedChoice: null, habitKey: null, evidenceCount: 0 });
});

test('MVP81 引擎：具体对象层覆盖通用层；过期事件不作数', () => {
  const at = (i: number) => new Date(Date.parse('2026-07-01T00:00:00Z') + i * 60_000).toISOString();
  const params = { autoMinStreak: 3, autoSafeChoices: ['draft', 'investigate'], now: at(10) };
  // 通用层 3×draft 够自动，但张三这个人有过 1 次 investigate → 以具体层为准（ask 提示 investigate）
  const events = [
    { key: 'k', subjectId: 'a', choice: 'draft', at: at(1) },
    { key: 'k', subjectId: 'b', choice: 'draft', at: at(2) },
    { key: 'k', subjectId: 'c', choice: 'draft', at: at(3) },
    { key: 'k', subjectId: 'zhang', choice: 'investigate', at: at(4) },
  ];
  const d = engine.decideConsultHabit(events, { key: 'k', subjectId: 'zhang' }, params);
  assert.equal(d.mode, 'ask');
  assert.equal((d as { hintedChoice: string }).hintedChoice, 'investigate');
  // 同样的事件对无历史的新对象 → 落到通用层（最近 streak 是 zhang 的 investigate 打断后…注意通用层含全部4条，
  // 最新一条是 investigate → streak=1 → ask 提示 investigate）——通用层把"最近怎么处理的"如实反映
  const d2 = engine.decideConsultHabit(events, { key: 'k', subjectId: 'new-person' }, params);
  assert.equal(d2.mode, 'ask');
  // 过期（>90 天）不作数
  const old = [1, 2, 3].map((i) => ({ key: 'k', subjectId: 'a', choice: 'draft', at: at(i) }));
  const d3 = engine.decideConsultHabit(old, { key: 'k', subjectId: 'a' },
    { ...params, now: new Date(Date.parse(at(3)) + 91 * 86_400_000).toISOString() });
  assert.deepEqual(d3, { mode: 'ask', hintedChoice: null, habitKey: null, evidenceCount: 0 });
});

// ---- 惯例成立 → 照办不再问 ----
test('MVP81 自动：同类事连续3次「先查」→ 新事项不再问，直接查+⚡通告+审计；自动配额用尽回落为征询', async () => {
  resetDb();
  const sent = armSender();
  const wang = mkPerson('王爽');
  const mk = () => mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  for (let i = 0; i < 3; i++) seedChoice(mk().id, 'investigate');
  // 第 4 件：惯例成立 → 不问，直接办
  const m4 = mk();
  assert.equal(await consult.maybeConsultOnMatterCreated(m4), true);
  const md = mdOf(sent[0]);
  assert.match(md, /照你的惯例，这次没再问你/);
  assert.match(md, /先问我/, '通告里必须给刹车入口');
  assert.equal(db.countAuditActionSince('consult_auto_handled', new Date(0).toISOString()), 1);
  assert.equal(db.countAuditActionSince('consult_asked', new Date(0).toISOString()), 0, '自动路径不发征询');
  assert.equal(db.listUserBackfillUnitsForMatter(m4.id, 5).length, 1, 'investigate 惯例真的落了排查指示');
  // 第 5 件：CONSULT_AUTO_DAILY_MAX=1 用尽 → 回落为征询（带提示，不静默丢）
  const m5 = mk();
  assert.equal(await consult.maybeConsultOnMatterCreated(m5), true);
  const md5 = mdOf(sent[sent.length - 1]);
  assert.match(md5, /有人找你/);
  assert.match(md5, /猜你会选 2/, '回落的征询带「猜你会选」提示');
});

// ---- 提示 + 回「好」兑现 ----
test('MVP81 提示：历史不够自动 → 征询带「猜你会选」；回「好」照提示办', async () => {
  resetDb();
  const sent = armSender();
  const wang = mkPerson('王爽');
  const mk = () => mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  seedChoice(mk().id, 'investigate'); // 只有 1 次历史，不够自动
  const m = mk();
  assert.equal(await consult.maybeConsultOnMatterCreated(m), true);
  assert.match(mdOf(sent[0]), /猜你会选 2（先查清楚）/);
  // 回「好」→ 兑现为 investigate
  const { acks, ack } = mkAck();
  assert.equal(await consult.handleConsultChoice(m.id, '好', ack), 'investigate');
  assert.equal(db.listUserBackfillUnitsForMatter(m.id, 5).length, 1);
  assert.match(acks[0], /先去查/);
  // 没有提示的事项回「好」→ 仍是自由指示（不瞎猜）
  resetDb();
  armSender();
  const wang2 = mkPerson('王爽');
  const m2 = mkMatter([{ entityId: wang2, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  const a2 = mkAck();
  assert.equal(await consult.handleConsultChoice(m2.id, '好', a2.ack), 'instruct');
});

// ---- 「先问我」刹车 ----
test('MVP81 刹车：回「先问我」→ 暂停该类惯例；此后同类事即使惯例成立也改为征询', async () => {
  resetDb();
  const sent = armSender();
  const wang = mkPerson('王爽');
  const mk = () => mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  for (let i = 0; i < 3; i++) seedChoice(mk().id, 'investigate');
  const m = mk();
  const { acks, ack } = mkAck();
  assert.equal(await consult.handleConsultChoice(m.id, '先问我', ack), 'paused');
  assert.match(acks[0], /先问你/);
  assert.equal(consult.listPausedHabitKeys().length, 1);
  assert.equal(db.countAuditActionSince('consult_habit_paused', new Date(0).toISOString()), 1);
  // 惯例证据仍在（3 次），但已暂停 → 走征询而非自动
  const m2 = mk();
  assert.equal(await consult.maybeConsultOnMatterCreated(m2), true);
  assert.match(mdOf(sent[sent.length - 1]), /有人找你/);
  assert.equal(db.countAuditActionSince('consult_auto_handled', new Date(0).toISOString()), 0);
});

// ---- 工作日志四类结果观：照惯例办成 = 结果④ ----
test('MVP81 面板：consult_auto_handled 进工作日志且带 followedYourHabit 徽标；tally 计数', async () => {
  resetDb();
  armSender();
  const wang = mkPerson('王爽');
  const mk = () => mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  for (let i = 0; i < 3; i++) seedChoice(mk().id, 'investigate');
  await consult.maybeConsultOnMatterCreated(mk());
  const rows = db.listAiActivity(20).filter((r) => r.action === 'consult_auto_handled');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].followedYourHabit, 1);
  assert.ok(rows[0].matterTitle, '有事项标题，不是空行');
  assert.equal(db.getAiActivityTally().habitAutoCount, 1);
});

// ---- 可迁移学习包 ----
test('MVP81 学习包：导出去个人化（习惯只到通用键层）；导入进草稿、避让权威版、坏包报错', () => {
  resetDb();
  const wang = mkPerson('王爽');
  const m = mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  seedChoice(m.id, 'investigate');
  pbStore.userUpsertPlaybook({
    taskTypeKey: 'follow_up:verify', title: '核实类的做法',
    steps: [{ order: 1, intent: '先搜相关 IM 消息' }],
  });
  const pack = learning.buildLearningPack();
  assert.equal(pack.kind, 'aiisn-learning-pack');
  assert.equal(pack.playbooks.length, 1);
  // 习惯统计只有通用键 + 计数，无任何实体 id 字段
  assert.deepEqual(pack.habits, [{ key: 'follow_up:chase', choiceCounts: { investigate: 1 }, latestChoice: 'investigate' }]);
  assert.ok(!JSON.stringify(pack.habits).includes(wang), '习惯导出绝不带人员实体 id');
  // 导入：新键 → distilled 草稿（approved=0）；已有权威版的键 → 跳过不覆盖
  const result = learning.importLearningPack({
    kind: 'aiisn-learning-pack', version: 1, exportedAt: now,
    playbooks: [
      { taskTypeKey: 'incident:verify', title: '别人的核实做法', steps: [{ order: 1, intent: '查监控面板' }] },
      { taskTypeKey: 'follow_up:verify', title: '试图覆盖你的权威版', steps: [{ order: 1, intent: 'x' }] },
      { taskTypeKey: '', title: '坏条目', steps: [] },
    ],
  });
  assert.deepEqual(result, { imported: ['incident:verify'], skippedAuthoritative: ['follow_up:verify'], invalid: 1 });
  const imported = pbStore.getPlaybookByType('incident:verify')!;
  assert.equal(imported.origin, 'distilled');
  assert.equal(imported.approved, false);
  assert.equal(pbStore.getPlaybookByType('follow_up:verify')!.title, '核实类的做法', '权威版原样');
  assert.throws(() => learning.importLearningPack({ kind: 'nope' }), /不是学习包/);
});
