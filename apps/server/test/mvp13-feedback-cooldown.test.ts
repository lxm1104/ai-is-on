/**
 * MVP13 §6 · Feedback row + reason-aware cooldown + few-shot examples 联动。
 *
 * 验证：
 *   - confirm 写入 feedback row（reason=exact_project_chat by default）
 *   - reject reasonCode='wrong_space' → 90d cooldown
 *   - reject reasonCode='obsolete' → 14d cooldown
 *   - reject reasonCode='duplicate_seed' → 365d cooldown
 *   - 下次 ranker 拉 examples 时优先同 Space confirmed/rejected
 *
 * 运行：npx tsx --test apps/server/test/mvp13-feedback-cooldown.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp13-fb-cd-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.MVP13_LLM_RANKER_ENABLED = 'false';

const { insertMinimalEventContextUnit } = await import(
  '../src/context/contextStore.js'
);
const {
  tryInsertEvent,
  db,
  getContextSpaceByTypeName,
  listSpaceSuggestions,
  listSuggestionFeedbackForCalibration,
  listSuggestionFeedbackExamples,
} = await import('../src/db.js');
const { writeWorkMap } = await import('../src/bootstrap/workMapWriter.js');
const { runSuggestionWorker } = await import('../src/spaces/suggestionWorker.js');
const {
  confirmChatAffinitySuggestion,
  rejectSuggestion,
  cooldownDaysForRejectReason,
} = await import('../src/spaces/contextSpaceService.js');
const { loadFewShotExamples } = await import(
  '../src/spaces/llmChatAffinityRanker.js'
);

function newEvent(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  tryInsertEvent({
    id,
    source: 'im',
    source_id: 'test:' + id,
    kind: 'group_message',
    occurred_at: now,
    title: 't',
    text: 'b',
    actor: null,
    url: null,
    raw_json: '{}',
    content_hash: id,
    processed_at: null,
    created_at: now,
  });
  return id;
}

writeWorkMap({
  profile: { roleTitle: 'TL', responsibilities: [] },
  projects: [
    {
      name: 'Chatbot',
      description: 'Chatbot 项目',
      goals: ['降低 Chatbot badcase 率'],
      authoritativeDocs: [],
      upcomingDeadlines: [],
      risks: [],
    },
  ],
  stakeholders: [],
  preferences: [],
  boundaries: [],
});

const chatName1 = 'lark_chat:oc_confirm_target';
const chatName2 = 'lark_chat:oc_reject_target';
for (const cname of [chatName1, chatName2]) {
  for (let i = 0; i < 5; i++) {
    insertMinimalEventContextUnit({
      eventId: newEvent(),
      scope: 'work',
      title: `t${i}`,
      content: 'b',
      occurredAt: new Date().toISOString(),
      source: 'im',
      entities: [
        {
          type: 'chat',
          name: cname,
          role: 'container',
          aliases: ['Chatbot ' + cname.slice(-6)],
        },
        { type: 'person', name: 'Zeke', role: 'actor' },
      ],
    });
  }
}

test('cooldownDaysForRejectReason 默认表正确', () => {
  assert.equal(cooldownDaysForRejectReason('obsolete'), 14);
  assert.equal(cooldownDaysForRejectReason('wrong_space'), 90);
  assert.equal(cooldownDaysForRejectReason('private_or_noise'), 90);
  assert.equal(cooldownDaysForRejectReason('duplicate_seed'), 365);
  assert.equal(cooldownDaysForRejectReason('permanent_not_relevant'), 365);
  assert.equal(cooldownDaysForRejectReason('chat_too_broad'), 30);
  assert.equal(cooldownDaysForRejectReason('only_incidental_mention'), 30);
  assert.equal(cooldownDaysForRejectReason(undefined), 30);
});

test('confirm 写 feedback row（默认 reason=exact_project_chat），状态 confirmed', async () => {
  const space = getContextSpaceByTypeName('project', 'Chatbot')!;
  await runSuggestionWorker({ enableLlm: false });
  const items = listSpaceSuggestions(space.id, 'suggested');
  const target = items.find(
    (s) =>
      s.suggestion_type === 'chat_affinity' &&
      JSON.parse(s.evidence_json).chatName === chatName1
  );
  assert.ok(target);
  const r = confirmChatAffinitySuggestion({
    spaceId: space.id,
    suggestionId: target!.id,
  });
  assert.equal(r.ok, true);

  const fbRows = listSuggestionFeedbackForCalibration(7);
  const fb = fbRows.find((f) => f.suggestion_id === target!.id);
  assert.ok(fb, 'feedback row written');
  assert.equal(fb!.action, 'confirmed');
  assert.equal(fb!.reason_code, 'exact_project_chat');

  // suggestion 表 decided_by + decided_at + status=confirmed
  const after = db
    .prepare(`SELECT * FROM context_space_suggestions WHERE id = ?`)
    .get(target!.id) as {
    status: string;
    decided_by: string | null;
    decided_at: string | null;
  };
  assert.equal(after.status, 'confirmed');
  assert.equal(after.decided_by, 'me');
  assert.ok(after.decided_at);
});

test('reject reasonCode=wrong_space → cooldown 90d', async () => {
  const space = getContextSpaceByTypeName('project', 'Chatbot')!;
  const items = listSpaceSuggestions(space.id, 'suggested');
  const target = items.find(
    (s) =>
      s.suggestion_type === 'chat_affinity' &&
      JSON.parse(s.evidence_json).chatName === chatName2
  );
  assert.ok(target);
  const before = Date.now();
  const r = rejectSuggestion({
    spaceId: space.id,
    suggestionId: target!.id,
    reasonCode: 'wrong_space',
  });
  assert.equal(r.ok, true);
  const cooldownMs = new Date(r.cooldownUntil!).getTime() - before;
  // 90 天 ±1 天容差
  assert.ok(
    cooldownMs >= 89 * 86400_000 && cooldownMs <= 91 * 86400_000,
    `cooldown approx 90d, got ${cooldownMs / 86400_000}d`
  );

  const fbRows = listSuggestionFeedbackForCalibration(7);
  const fb = fbRows.find((f) => f.suggestion_id === target!.id);
  assert.ok(fb);
  assert.equal(fb!.action, 'rejected');
  assert.equal(fb!.reason_code, 'wrong_space');
});

test('few-shot examples: 同 Space 拿到 confirmed + rejected', () => {
  const space = getContextSpaceByTypeName('project', 'Chatbot')!;
  const ex = loadFewShotExamples(space.id);
  assert.ok(ex.length >= 2);
  assert.ok(ex.some((e) => e.action === 'confirmed'));
  assert.ok(ex.some((e) => e.action === 'rejected'));
  for (const e of ex) {
    assert.equal(e.scope, 'space');
  }
});

test('全局兜底：同 Space 无 feedback 时，loadFewShotExamples 走全局', () => {
  // 新建一个完全无 feedback 的 Space
  writeWorkMap({
    profile: { roleTitle: 'TL', responsibilities: [] },
    projects: [
      {
        name: 'EmptySpace',
        description: '',
        goals: ['x'],
        authoritativeDocs: [],
        upcomingDeadlines: [],
        risks: [],
      },
    ],
    stakeholders: [],
    preferences: [],
    boundaries: [],
  });
  const sp = getContextSpaceByTypeName('project', 'EmptySpace')!;
  const ex = loadFewShotExamples(sp.id);
  // 因为 Chatbot 的 feedback 是全局可用，所以这里至少 1 个
  assert.ok(ex.length >= 1);
  for (const e of ex) {
    assert.equal(e.scope, 'global');
  }
});

// 防止未使用警告
void listSuggestionFeedbackExamples;
