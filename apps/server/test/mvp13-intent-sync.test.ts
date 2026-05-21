/**
 * MVP13 §5 · Space intent sync from Work Map writer。
 *
 * 场景：
 *   1. Work Map 第一次写 project → Space.intent_json 自动填 summary/keywords/goalTitles
 *   2. 用户改了 intent (updatedBy='user') → 再次 Work Map sync 不覆盖用户字段
 *   3. 名字 / 关键词 tokenize + nameSimilarity 正确
 *
 * 运行：npx tsx --test apps/server/test/mvp13-intent-sync.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp13-intent-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { writeWorkMap } = await import('../src/bootstrap/workMapWriter.js');
const {
  getSpaceIntent,
  updateSpaceIntentByUser,
  decodeSpaceWorkMapRef,
} = await import('../src/spaces/contextSpaceService.js');
const { getContextSpaceByTypeName } = await import('../src/db.js');
const { extractKeywords, nameSimilarity, normalizeDisplayName } = await import(
  '../src/spaces/keywordExtractor.js'
);

test('writeWorkMap 第一次写 → Space intent_json 被填充', () => {
  writeWorkMap({
    profile: { roleTitle: 'TL', responsibilities: [] },
    projects: [
      {
        name: 'Chatbot',
        description: 'Chatbot 项目的评测、badcase 和上线跟进',
        goals: ['降低 Chatbot badcase 率', '完成 v2 上线'],
        authoritativeDocs: ['https://example.com/chatbot-prd'],
        upcomingDeadlines: [],
        risks: ['线上 badcase 跟进不及时'],
      },
    ],
    stakeholders: [],
    preferences: [],
    boundaries: [],
  });
  const sp = getContextSpaceByTypeName('project', 'Chatbot');
  assert.ok(sp);
  const intent = getSpaceIntent(sp!.id)!;
  assert.equal(intent.updatedBy, 'work_map_writer');
  assert.equal(intent.summary, 'Chatbot 项目的评测、badcase 和上线跟进');
  assert.ok((intent.workMapGoalTitles ?? []).includes('降低 Chatbot badcase 率'));
  assert.ok((intent.workMapRiskTitles ?? []).includes('线上 badcase 跟进不及时'));
  assert.ok((intent.keywords ?? []).some((k) => k.includes('chatbot')));
  assert.ok(
    (intent.authoritativeDocNames ?? []).includes(
      'https://example.com/chatbot-prd'
    )
  );
  // work_map_ref_json 写好
  const ref = decodeSpaceWorkMapRef(sp!.work_map_ref_json);
  assert.ok(ref);
  assert.equal(ref!.projectName, 'Chatbot');
  assert.equal(ref!.source, 'work_map_writer');
});

test('用户改 intent → 再次 sync 不覆盖用户字段', () => {
  const sp = getContextSpaceByTypeName('project', 'Chatbot')!;
  updateSpaceIntentByUser(sp.id, {
    summary: '用户自己写的 summary',
    keywords: ['mine'],
  });
  // 再跑一次 Work Map writer
  writeWorkMap({
    profile: { roleTitle: 'TL', responsibilities: [] },
    projects: [
      {
        name: 'Chatbot',
        description: '系统又生成的描述',
        goals: ['新 goal'],
        authoritativeDocs: [],
        upcomingDeadlines: [],
        risks: [],
      },
    ],
    stakeholders: [],
    preferences: [],
    boundaries: [],
  });
  const intent = getSpaceIntent(sp.id)!;
  assert.equal(intent.updatedBy, 'user'); // 仍是 user
  assert.equal(intent.summary, '用户自己写的 summary'); // 不被覆盖
  // 但 array merge：user 的 'mine' 还在，work_map 的新词也 append
  assert.ok((intent.keywords ?? []).includes('mine'));
});

test('keyword 抽取 + nameSimilarity', () => {
  const kws = extractKeywords('【 Badcase 】Chatbot badcase 跟进群');
  assert.ok(kws.includes('chatbot'));
  assert.ok(kws.includes('badcase'));

  const { similarity } = nameSimilarity(
    'Chatbot',
    '【 Badcase 】Chatbot badcase 跟进群'
  );
  // substring bonus → 至少 0.72
  assert.ok(similarity >= 0.72, `expected >= 0.72, got ${similarity}`);

  assert.equal(
    normalizeDisplayName('【 Badcase 】Chatbot badcase 跟进群'),
    'badcase chatbot badcase 跟进群'
  );
});
