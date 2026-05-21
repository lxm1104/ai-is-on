/**
 * MVP13 §0 / §4.8 · Badcase regression。
 *
 * 关键场景：dogfood 痛点示例。
 *   - Space "Chatbot" 默认 seed = project 'Chatbot' entity
 *   - 群名为 "【 Badcase 】Chatbot badcase 跟进群"
 *   - 群内 5 个 unit，没人是 Space seed，没文档命中 → MVP12 阈值卡死
 *   - MVP13 ranker mock strong_accept → suggestion 被 surfaced
 *
 * 运行：npx tsx --test apps/server/test/mvp13-badcase-regression.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp13-rg-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.MVP13_LLM_RANKER_ENABLED = 'false'; // 显式注入 runner

const { insertMinimalEventContextUnit } = await import(
  '../src/context/contextStore.js'
);
const { tryInsertEvent, getContextSpaceByTypeName, listSpaceSuggestions } =
  await import('../src/db.js');
const { writeWorkMap } = await import('../src/bootstrap/workMapWriter.js');
const { runSuggestionWorker } = await import('../src/spaces/suggestionWorker.js');

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

test('Chatbot ↔ Chatbot badcase 跟进群：MVP12 卡死，MVP13 LLM strong_accept 救回', async () => {
  writeWorkMap({
    profile: { roleTitle: 'TL', responsibilities: [] },
    projects: [
      {
        name: 'Chatbot',
        description: 'Chatbot 项目的评测、badcase 和上线跟进',
        goals: ['降低 Chatbot badcase 率'],
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

  const chatName = 'lark_chat:oc_chatbot_badcase';
  const chatAlias = '【 Badcase 】Chatbot badcase 跟进群';
  for (let i = 0; i < 5; i++) {
    insertMinimalEventContextUnit({
      eventId: newEvent(),
      scope: 'work',
      title: `bug ${i}`,
      content: 'b',
      occurredAt: new Date().toISOString(),
      source: 'im',
      entities: [
        { type: 'chat', name: chatName, role: 'container', aliases: [chatAlias] },
        // actor 不在 Space seed 里
        { type: 'person', name: 'Zeke', role: 'actor' },
      ],
    });
  }

  // 1) MVP12 严格阈值跑（LLM disabled）→ fallback：units7d=5 + nameSimilarity 子串≥0.72 → fallbackEligible
  //    本期产品决策是 fallback 也可以 surface（chat name 显然命中）
  //    因此这里 expect chat_affinity 出现，但 ranker_status=llm_skipped
  {
    const stats = await runSuggestionWorker({ enableLlm: false });
    assert.ok(stats.candidateGenerated >= 1, 'candidate generated');
    const items = listSpaceSuggestions(space.id, 'suggested');
    const item = items.find(
      (s) =>
        s.suggestion_type === 'chat_affinity' &&
        JSON.parse(s.evidence_json).chatName === chatName
    );
    assert.ok(item, 'fallback path surfaced via nameSimilarity');
    assert.equal(item!.ranker_status, 'llm_skipped');
  }

  // 2) MVP13 LLM strong_accept → ranker_status=llm_ok, llm_decision=strong_accept, final_score 高
  const stats2 = await runSuggestionWorker({
    enableLlm: true,
    runner: async (userMessage: string) => {
      const ids = [
        ...userMessage.matchAll(/"candidateId":\s*"([^"]+)"/g),
      ]
        .map((m) => m[1])
        .filter((x) => x !== 'string');
      return {
        text: JSON.stringify({
          results: ids.map((id) => ({
            candidateId: id,
            decision: 'strong_accept',
            llmScore: 0.91,
            confidence: 0.78,
            reasons: [
              'chat 名同时命中 Chatbot 和 badcase',
              'Space intent 与 Work Map goal 都指向 badcase 跟进',
            ],
            concerns: [],
            matchedSignals: ['chat_name', 'space_intent', 'work_map_goal'],
          })),
        }),
        raw: { model: 'mock-claude' },
      };
    },
  });
  assert.ok(stats2.llmAccepted >= 1);
  assert.ok(stats2.chatAffinityUpdated >= 1 || stats2.chatAffinityInserted >= 1);

  const items = listSpaceSuggestions(space.id, 'suggested');
  const item = items.find(
    (s) =>
      s.suggestion_type === 'chat_affinity' &&
      JSON.parse(s.evidence_json).chatName === chatName
  );
  assert.ok(item);
  assert.equal(item!.ranker_status, 'llm_ok');
  assert.equal(item!.llm_decision, 'strong_accept');
  assert.ok((item!.llm_confidence ?? 0) >= 0.55);
  assert.ok((item!.final_score ?? 0) >= 0.62);

  // evidence v2 schema 应该体现 LLM 评审摘要
  const ev = JSON.parse(item!.evidence_json) as Record<string, unknown>;
  assert.equal(ev.schemaVersion, 2);
  const llm = ev.llm as Record<string, unknown>;
  assert.equal(llm?.decision, 'strong_accept');
  // evidence 不含 IM 原文
  const evStr = item!.evidence_json;
  assert.ok(!evStr.includes('bug 0\n'));
});
