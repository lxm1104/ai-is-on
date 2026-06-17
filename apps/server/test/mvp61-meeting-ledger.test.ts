/**
 * MVP61 — 会前自动拉齐：gatherMeetingLedger 按 owner 把与参会人的未了 matter 分到
 * 我欠对方 / 对方欠我 / 相关跟进，并带上次结论 + 待答。
 *
 * Run: npx tsx --test apps/server/test/mvp61-meeting-ledger.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp61-ledger-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const ms = await import('../src/matter/matterStore.js');
const { gatherMeetingLedger, renderLedgerBlock, isLedgerEmpty } = await import('../src/agents/meetingLedger.js');

function resetDb() {
  db.db.exec(`
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM context_entities;
    DELETE FROM matters;
    DELETE FROM matter_entities;
    DELETE FROM settings WHERE key='self_person_entity_id';
  `);
}

function mkEntity(name: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insertContextEntity({ id, type: 'person', name, aliases_json: null, source: null, confidence: 0.9, created_at: now, updated_at: now, attributes_json: null });
  return id;
}

function mkMeetingUnit(entityIds: string[]): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.db.prepare(
    `INSERT INTO context_units (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content, actionability, confidence, version, status, created_at, updated_at)
     VALUES (?, 'me', 'work', 'calendar', 'test', 'meeting', '周会', '', 'record', 0.9, 1, 'active', ?, ?)`
  ).run(id, now, now);
  for (const e of entityIds) {
    db.db.prepare(`INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence) VALUES (?, ?, 'about', 1.0)`).run(id, e);
  }
  return id;
}

function mkMatter(opts: { title: string; owner: string; attendee: string; summary?: string; next?: string }) {
  const m = ms.createMatter({
    scope: 'work', type: 'follow_up', title: opts.title, canonicalKey: 'k-' + randomUUID(),
    createdFromContextUnitId: 'u-' + randomUUID(), ownerEntityId: opts.owner,
    currentSummary: opts.summary ?? '', nextAction: opts.next ?? null,
  });
  ms.attachMatterEntity({ matterId: m.id, entityId: opts.attendee, role: 'stakeholder' as any });
  return m;
}

test('MVP61：按 owner 分到 我欠/对方欠我，带上次结论+待答', () => {
  resetDb();
  const self = mkEntity('刘昕明');
  const zhang = mkEntity('张三');
  db.setSetting('self_person_entity_id', self);
  const meeting = mkMeetingUnit([self, zhang]);

  mkMatter({ title: '给张三补方案', owner: self, attendee: zhang, summary: '［AI 排查］初稿已发待评审', next: '确认评审意见' });
  mkMatter({ title: '张三的接口联调', owner: zhang, attendee: zhang, next: '催张三给联调时间' });

  const l = gatherMeetingLedger(meeting);
  assert.equal(isLedgerEmpty(l), false);
  assert.equal(l.iOwe.length, 1, '我欠对方 1 条');
  assert.equal(l.iOwe[0].title, '给张三补方案');
  assert.match(l.iOwe[0].summary, /初稿已发/, '带上次结论');
  assert.equal(l.iOwe[0].nextAction, '确认评审意见', '带待答');
  assert.equal(l.owedToMe.length, 1, '对方欠我 1 条');
  assert.equal(l.owedToMe[0].title, '张三的接口联调');

  const block = renderLedgerBlock(l);
  assert.match(block, /我欠对方/);
  assert.match(block, /对方欠我/);
  assert.match(block, /初稿已发/);
});

test('MVP61：无参会人 / 无关联 matter → 空台账', () => {
  resetDb();
  const self = mkEntity('刘昕明');
  db.setSetting('self_person_entity_id', self);
  // 只有自己参会
  const meeting = mkMeetingUnit([self]);
  assert.equal(isLedgerEmpty(gatherMeetingLedger(meeting)), true);
  assert.equal(renderLedgerBlock(gatherMeetingLedger(meeting)), '');
});

test('MVP61：owner 不明 → 落「相关跟进」，不误判归属', () => {
  resetDb();
  const self = mkEntity('刘昕明');
  const li = mkEntity('李四');
  db.setSetting('self_person_entity_id', self);
  const meeting = mkMeetingUnit([self, li]);
  // owner 用一个既非 self 又非参会人的第三方
  const other = mkEntity('王五');
  mkMatter({ title: '共担事项', owner: other, attendee: li, next: '对齐分工' });
  const l = gatherMeetingLedger(meeting);
  assert.equal(l.iOwe.length, 0);
  assert.equal(l.owedToMe.length, 0);
  assert.equal(l.related.length, 1, 'owner 非 self 非参会人 → 相关跟进');
});

// MVP62 被@预装脉络：gatherCounterpartLedgerForMatter —— 给定线索 matter，拉齐与同对方的其它未了往来
test('MVP62：counterpart 台账 = 与同对方的其它 open matter（排除线索自身）', async () => {
  resetDb();
  const { gatherCounterpartLedgerForMatter } = await import('../src/agents/meetingLedger.js');
  const self = mkEntity('刘昕明');
  const zhang = mkEntity('张三');
  db.setSetting('self_person_entity_id', self);

  // 线索本身（被@的那条）：与张三相关、owner=自己
  const thread = mkMatter({ title: '回复张三的评审请求', owner: self, attendee: zhang, next: '答复评审意见' });
  // 与同对方(张三)的其它未了：张三欠我的联调
  mkMatter({ title: '张三的接口联调', owner: zhang, attendee: zhang, summary: '上周说本周给', next: '催联调时间' });

  const l = gatherCounterpartLedgerForMatter(thread.id);
  // 线索自身被排除，只剩与张三的其它事项
  assert.equal(l.iOwe.length, 0, '线索自身(我欠)被 excludeMatterId 排除');
  assert.equal(l.owedToMe.length, 1, '张三欠我的联调进脉络');
  assert.equal(l.owedToMe[0].title, '张三的接口联调');
})
