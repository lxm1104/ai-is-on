/**
 * MVP38 — 项目排查档案：召回 + 注入投资 prompt。
 *
 * Run: npx tsx --test apps/server/test/mvp38-project-profile.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp38-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const dbm = await import('../src/db.js');
const { getProjectProfileForMatter } = await import('../src/investigation/projectProfile.js');
const { buildInvestigateUserMessage } = await import('../src/investigation/investigationPrompt.js');

function mkProjectSpace(profile?: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  dbm.insertContextSpace({
    id, type: 'project', name: `proj-${id.slice(0, 6)}`, description: null,
    owner_subject_id: 'me', status: 'active', created_at: now, updated_at: now,
  });
  if (profile) dbm.setSpaceInvestigationProfile(id, profile, now);
  return id;
}

test('setSpaceInvestigationProfile + 召回', () => {
  const sid = mkProjectSpace('代码库：/Users/x/MyProject/bitable-chatbot\nTrace：用 fornax-cli');
  assert.match(getProjectProfileForMatter({ primarySpaceId: sid }) || '', /bitable-chatbot/);
  assert.match(getProjectProfileForMatter({ primarySpaceId: sid }) || '', /fornax-cli/);
});

test('无 space / 无档案 → null', () => {
  assert.equal(getProjectProfileForMatter({ primarySpaceId: null }), null);
  assert.equal(getProjectProfileForMatter({}), null);
  const sidNoProfile = mkProjectSpace();
  assert.equal(getProjectProfileForMatter({ primarySpaceId: sidNoProfile }), null);
});

test('清空档案（传空串）→ null', () => {
  const sid = mkProjectSpace('暂存内容');
  assert.ok(getProjectProfileForMatter({ primarySpaceId: sid }));
  dbm.setSpaceInvestigationProfile(sid, '   ', new Date().toISOString());
  assert.equal(getProjectProfileForMatter({ primarySpaceId: sid }), null);
});

test('档案注入投资 prompt 的 <项目背景与排查方法>', () => {
  const msg = buildInvestigateUserMessage({
    matterTitle: '排查 X', matterType: 'follow_up', currentSummary: '', nextAction: '确认是否完成',
    entities: [], findings: [], round: 1, maxRounds: 2,
    projectProfile: '代码库：/Users/x/MyProject/bitable-chatbot\nTrace：用 fornax-cli',
  });
  assert.match(msg, /项目背景与排查方法/);
  assert.match(msg, /bitable-chatbot/);
  assert.match(msg, /fornax-cli/);
  // 无档案则不注入该块
  const msg2 = buildInvestigateUserMessage({
    matterTitle: '排查 Y', matterType: 'follow_up', currentSummary: '', nextAction: '确认',
    entities: [], findings: [], round: 1, maxRounds: 2,
  });
  assert.doesNotMatch(msg2, /项目背景与排查方法/);
});
