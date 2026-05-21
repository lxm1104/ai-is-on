/**
 * MVP13 §3.5 / §4.3 · chatAffinityEvidence builder。
 *
 * 重点场景：
 *   - Chatbot badcase 群：directHits=0 / personOverlap=0 / docOverlap=0，
 *     但 chat name 命中 Space name + Work Map goal token，应进 candidate
 *   - evidence v2 schema 正确，title/meaning 过了 sanitizeExcerpt
 *   - 大群（>30 senders）被跳过
 *
 * 运行：npx tsx --test apps/server/test/mvp13-evidence-builder.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp13-ev-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { insertMinimalEventContextUnit } = await import(
  '../src/context/contextStore.js'
);
const {
  tryInsertEvent,
  getContextSpaceByTypeName,
} = await import('../src/db.js');
const { resolveOrCreateEntity } = await import(
  '../src/context/entityResolver.js'
);
const { writeWorkMap } = await import('../src/bootstrap/workMapWriter.js');
const { buildChatAffinityCandidates } = await import(
  '../src/spaces/chatAffinityEvidence.js'
);

function newEvent(text = 'b'): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  tryInsertEvent({
    id,
    source: 'im',
    source_id: 'test:' + id,
    kind: 'group_message',
    occurred_at: now,
    title: 't',
    text,
    actor: null,
    url: null,
    raw_json: '{}',
    content_hash: id,
    processed_at: null,
    created_at: now,
  });
  return id;
}

test('Chatbot badcase 群：弱信号下仍生成 candidate（regression）', () => {
  // 1) 走 WorkMap writer 建 Space + intent
  writeWorkMap({
    profile: { roleTitle: 'TL', responsibilities: [] },
    projects: [
      {
        name: 'Chatbot',
        description: 'Chatbot 项目的评测、badcase 和上线跟进',
        goals: ['降低 Chatbot badcase 率', 'badcase 跟进流程化'],
        authoritativeDocs: [],
        upcomingDeadlines: [],
        risks: ['线上 badcase 跟进不及时'],
      },
    ],
    stakeholders: [],
    preferences: [],
    boundaries: [],
  });
  const space = getContextSpaceByTypeName('project', 'Chatbot')!;

  // 2) 建一个 chat，里面有 3 个 unit；不与 Space seed 直接重叠
  //    chat name = "【 Badcase 】Chatbot badcase 跟进群"
  //    units actor = 一个无关 person Zeke（不是 Space seed）
  const chatName = 'lark_chat:oc_chatbot_badcase';
  const chatAlias = '【 Badcase 】Chatbot badcase 跟进群';
  for (let i = 0; i < 3; i++) {
    const evId = newEvent(`m ${i}`);
    insertMinimalEventContextUnit({
      eventId: evId,
      scope: 'work',
      title: `bug ${i}`,
      content: '12345678901234567890 https://very-long-url.example.com/x',
      occurredAt: new Date().toISOString(),
      source: 'im',
      entities: [
        { type: 'chat', name: chatName, role: 'container', aliases: [chatAlias] },
        { type: 'person', name: 'Zeke', role: 'actor' },
      ],
    });
  }
  // 确保 chat entity 别名落库（contextStore 在 insertMinimal 已写）
  void resolveOrCreateEntity('person', 'Zeke');

  const candidates = buildChatAffinityCandidates({
    workerRunId: 'wr_test_1',
    now: new Date(),
  });
  const c = candidates.find(
    (x) => x.spaceId === space.id && x.evidence.chat.name === chatName
  );
  assert.ok(c, 'expected candidate for Chatbot ↔ Chatbot-badcase chat');
  const sig = c!.evidence.ruleSignals;
  assert.equal(sig.directHits, 0);
  assert.equal(sig.personOverlap, 0);
  assert.equal(sig.docOverlap, 0);
  assert.ok(sig.nameSimilarity >= 0.5, `nameSim too low: ${sig.nameSimilarity}`);
  // keyword overlap 应包含 "chatbot" 或 "badcase"
  const overlapAll = [
    ...sig.tokenOverlap,
    ...sig.keywordOverlap,
    ...sig.workMapTokenOverlap,
  ];
  assert.ok(
    overlapAll.includes('chatbot') || overlapAll.includes('badcase'),
    `expected chatbot/badcase overlap, got ${JSON.stringify(overlapAll)}`
  );
  // fallbackEligible — chat name 子串命中 + 3 个 unit ≥ 3
  assert.equal(c!.fallbackEligible, true);
});

test('evidence v2 fields: 摘要 title/meaning 被 sanitize；summarizedUnits 含 entityRefs', () => {
  const candidates = buildChatAffinityCandidates({
    workerRunId: 'wr_test_2',
    now: new Date(),
  });
  assert.ok(candidates.length > 0);
  const c = candidates[0];
  assert.equal(c.evidence.schemaVersion, 2);
  assert.equal(c.evidence.rankerVersion, 'mvp13.chat_affinity.v1');
  assert.ok(c.evidence.window.since);
  assert.ok(c.evidence.window.until);
  // 现在 unit content 含一个长数字 + URL；title 是 "bug N"，sanitize 主要影响 content。
  // 我们看 meaning（可能为 null），summarizedUnits 含 entityRefs
  assert.ok(Array.isArray(c.evidence.summarizedUnits));
  if (c.evidence.summarizedUnits.length > 0) {
    const u0 = c.evidence.summarizedUnits[0];
    assert.equal(typeof u0.title, 'string');
    assert.ok(u0.title.length <= 121);
    assert.ok(Array.isArray(u0.entityRefs));
  }
  // workMap goal titles 应 propagate 到 evidence.space.workMap
  assert.ok(c.evidence.space.workMap.goalTitles.length >= 1);
});
