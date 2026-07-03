/**
 * MVP79「小助理拦一道」—— 有人 IM 请你办事 → AI 收集信息发飞书征询 → 按你的选择办。
 * 覆盖：角色窄门（具名他人 requester+我 executor 才触发）、终身一次+日配额、choice 分类、
 * 四种选择的执行（起草/先查/忽略可恢复/自由指示回填）、botReplyLoop 三种路由（裸编号/引用/自由文本兜底）。
 *
 * Run: npx tsx --test apps/server/test/mvp79-consult.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp79-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.CONSULT_DAILY_MAX = '2';

const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { userResolveMatter } = await import('../src/matter/matterActions.js');
const notify = await import('../src/lark/larkNotifyService.js');
const loop = await import('../src/lark/botReplyLoop.js');
const consult = await import('../src/matter/consultService.js');
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
     DELETE FROM matter_transitions; DELETE FROM settings; DELETE FROM context_entities;`
  );
  db.insertContextEntity({
    id: SELF, type: 'person', name: '刘昕明', aliases_json: '[]', source: 'test', confidence: 1,
    created_at: now, updated_at: now, attributes_json: JSON.stringify({ larkLocalizedName: '刘昕明' }),
  } as never);
  db.setSetting('self_person_entity_id', SELF);
  notify.__disarmNotifyServiceForTest();
}

let n = 0;
function mkMatter(entities: Array<{ entityId: string; role: string }>, opts: { title?: string } = {}) {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment', title: `事项${n}`, content: `有人在群里请刘昕明处理问题 ${n}`,
    scope: 'work', origin: { kind: 'manual', refId: `u-${n}` }, silent: true,
  }).unit;
  return ms.createMatter({
    scope: 'work', type: 'follow_up', title: opts.title ?? `帮王爽排查问题${n}`,
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id,
    ownerEntityId: SELF, currentSummary: '王爽反馈查询结果不准', nextAction: '跟进',
    entities: entities as never,
  });
}

type Sent = { args: string[] };
function armSender() {
  const sent: Sent[] = [];
  notify.__setNotifySenderForTest(async (args: string[]) => {
    sent.push({ args });
    return { ok: true, data: { message_id: `om_${sent.length}`, chat_id: 'oc_t' } };
  });
  return sent;
}
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));
function mkAck() {
  const acks: string[] = [];
  return { acks, ack: async (md: string) => { acks.push(md); } };
}

// ---- 角色窄门 ----
test('MVP79 角色门：具名他人requester+我executor→触发；我自己requester/无executor/≥3人→不触发', () => {
  resetDb();
  const wang = mkPerson('王爽');
  const hit = mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  assert.deepEqual(consult.consultRequestersFor(hit)?.map((r) => r.name), ['王爽']);
  // 我是 requester（我委派别人）→ 不征询（那是 owned_by_other 的领地）
  const mine = mkMatter([{ entityId: SELF, role: 'requester' }, { entityId: wang, role: 'executor' }]);
  assert.equal(consult.consultRequestersFor(mine), null);
  // 没有我 executor → 不征询
  const other = mkPerson('高虎伟');
  const notMe = mkMatter([{ entityId: wang, role: 'requester' }, { entityId: other, role: 'executor' }]);
  db.db.prepare(`UPDATE matters SET owner_entity_id=NULL WHERE id=?`).run(notMe.id);
  assert.equal(consult.consultRequestersFor({ ...notMe, ownerEntityId: null }), null);
  // ≥3 具名 requester（群发）→ 不打扰
  const p3 = [mkPerson('甲甲'), mkPerson('乙乙'), mkPerson('丙丙')];
  const crowd = mkMatter([...p3.map((id) => ({ entityId: id, role: 'requester' })), { entityId: SELF, role: 'executor' }]);
  assert.equal(consult.consultRequestersFor(crowd), null);
});

// ---- 征询发送：内容 + 终身一次 + 日配额 ----
test('MVP79 征询：发🤝带选项；同matter终身一次；日配额兜底', async () => {
  resetDb();
  const sent = armSender();
  const wang = mkPerson('王爽');
  const m1 = mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  assert.equal(await consult.maybeConsultOnMatterCreated(m1), true);
  const md = sent[0].args[sent[0].args.indexOf('--markdown') + 1];
  assert.match(md, /有人找你：王爽/);
  assert.match(md, /1 我来起草回复/);
  assert.match(md, /3 不用管/);
  assert.equal(db.countAuditActionSince('consult_asked', new Date(0).toISOString()), 1);
  // 终身一次
  assert.equal(await consult.maybeConsultOnMatterCreated(m1), false);
  // 日配额=2：第 2 件可以，第 3 件被拦
  const m2 = mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  assert.equal(await consult.maybeConsultOnMatterCreated(m2), true);
  const m3 = mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  assert.equal(await consult.maybeConsultOnMatterCreated(m3), false, '超日配额不打扰');
  assert.equal(sent.length, 2);
});

// ---- choice 分类 ----
test('MVP79 choice 分类：编号/关键词/自由文本', () => {
  assert.equal(consult.classifyConsultChoice('1'), 'draft');
  assert.equal(consult.classifyConsultChoice('帮我起草个回复'), 'draft');
  assert.equal(consult.classifyConsultChoice('2'), 'investigate');
  assert.equal(consult.classifyConsultChoice('先查清楚'), 'investigate');
  assert.equal(consult.classifyConsultChoice('3'), 'ignore');
  assert.equal(consult.classifyConsultChoice('不用管了'), 'ignore');
  assert.equal(consult.classifyConsultChoice('跟他说下周一给'), 'instruct');
});

// ---- 四种选择执行 ----
test('MVP79 执行：先查→回填+审计；忽略→归档可恢复；自由指示→回填原话；已办结→gone', async () => {
  resetDb();
  armSender();
  const wang = mkPerson('王爽');
  const mk = () => mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  // 2 先查
  const mA = mk();
  const a1 = mkAck();
  assert.equal(await consult.handleConsultChoice(mA.id, '2', a1.ack), 'investigate');
  assert.equal(db.listUserBackfillUnitsForMatter(mA.id, 5).length, 1);
  assert.match(a1.acks[0], /先去查/);
  // 3 忽略 → dropped + 恢复找得回
  const mB = mk();
  const a2 = mkAck();
  assert.equal(await consult.handleConsultChoice(mB.id, '不用管', a2.ack), 'ignore');
  assert.equal(ms.getMatterById(mB.id)!.status, 'dropped');
  const hits = db.listRecentlySweptMatters(new Date(Date.now() - 3600_000).toISOString(), mB.title.slice(0, 6));
  assert.equal(hits.length, 1, '飞书征询归档的事项可被恢复命令找回');
  // 自由文本 → 指示回填
  const mC = mk();
  const a3 = mkAck();
  assert.equal(await consult.handleConsultChoice(mC.id, '跟王爽说数据问题下周修', a3.ack), 'instruct');
  const bf = db.listUserBackfillUnitsForMatter(mC.id, 5);
  assert.match(bf[0].content, /下周修/);
  // 已办结 → gone
  const mD = mk();
  userResolveMatter(mD.id, '测试', new Date().toISOString());
  const a4 = mkAck();
  assert.equal(await consult.handleConsultChoice(mD.id, '1', a4.ack), 'gone');
  // 每次选择都有审计（gone 不计）
  assert.equal(db.countAuditActionSince('consult_choice', new Date(0).toISOString()), 3);
});

// ---- 起草流 ----
test('MVP79 起草：ack先行→aiisn-push草稿→📝 DM（绝不代发措辞）', async () => {
  resetDb();
  const sent = armSender();
  const wang = mkPerson('王爽');
  const m = mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  const { acks, ack } = mkAck();
  const oneShot = async () => ({ text: '王爽你好，查询不准的问题我们定位到了字段映射，下周一修复上线。' });
  assert.equal(await consult.handleConsultChoice(m.id, '1', ack, { oneShot }), 'draft');
  assert.match(acks[0], /正在给.*起草/);
  await flush(60);
  const joined = sent.map((s) => s.args.join(' ')).join('\n');
  assert.match(joined, /回复草稿/);
  assert.match(joined, /你来发，我不代发/);
  assert.match(joined, /字段映射/);
});

// ---- botReplyLoop 路由 ----
test('MVP79 路由：裸「1」→最近未答复征询；引用征询→choice；自由文本兜底征询', async () => {
  resetDb();
  armSender();
  const wang = mkPerson('王爽');
  const m = mkMatter([{ entityId: wang, role: 'requester' }, { entityId: SELF, role: 'executor' }]);
  // 模拟已发出的征询：audit consult_asked + notify_pushed(messageId=om_consult_1)
  writeAudit({ action: 'consult_asked', reason: 't', payload: { matterId: m.id, requesters: ['王爽'] } });
  writeAudit({
    action: 'notify_pushed', reason: 't',
    payload: { kind: 'consult', refId: m.id, idempotencyKey: 'kc', messageId: 'om_consult_1' },
  });
  const acks: string[] = [];
  const deps = { replyFn: async (args: string[]) => { acks.push(args[args.indexOf('--markdown') + 1]); return { ok: true }; } };
  const userMsg = (over: Record<string, unknown>) => ({
    message_id: `om_u_${++n}`, msg_type: 'text', create_time: '2026-07-03 22:00',
    sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' }, ...over,
  });
  // 裸编号
  assert.equal(await loop.handleUserReply(userMsg({ content: '2' }) as never, deps), 'consult_choice');
  assert.equal(db.listUserBackfillUnitsForMatter(m.id, 5).length, 1);
  // 引用征询消息 + 自由文本
  assert.equal(
    await loop.handleUserReply(userMsg({ content: '让他先提个工单', parent_id: 'om_consult_1' }) as never, deps),
    'consult_choice'
  );
  assert.equal(db.listUserBackfillUnitsForMatter(m.id, 5).length, 2);
  // 无未答复征询时裸编号 → 引导
  db.db.exec(`DELETE FROM audit_logs`);
  assert.equal(await loop.handleUserReply(userMsg({ content: '1' }) as never, deps), 'guidance');
});
