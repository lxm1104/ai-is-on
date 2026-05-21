/**
 * MVP13 §4.7 / §S4 · prompt builder + parser + finalScore + surface gate。
 *
 * 运行：npx tsx --test apps/server/test/mvp13-llm-ranker-prompt.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp13-prompt-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { insertMinimalEventContextUnit } = await import(
  '../src/context/contextStore.js'
);
const { tryInsertEvent, getContextSpaceByTypeName, db } = await import(
  '../src/db.js'
);

function clearRankerCache() {
  db.prepare(`DELETE FROM context_space_ranker_runs`).run();
}
const { writeWorkMap } = await import('../src/bootstrap/workMapWriter.js');
const { buildChatAffinityCandidates } = await import(
  '../src/spaces/chatAffinityEvidence.js'
);
const {
  buildUserPrompt,
  parseRankerResponse,
  rankChatAffinityCandidates,
  RANKER_SYSTEM_PROMPT,
} = await import('../src/spaces/llmChatAffinityRanker.js');
import { randomUUID } from 'node:crypto';

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

function seedChatbotBadcase() {
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
  const chatName = 'lark_chat:oc_chatbot_badcase';
  const chatAlias = '【 Badcase 】Chatbot badcase 跟进群';
  for (let i = 0; i < 3; i++) {
    const evId = newEvent(`m ${i}`);
    insertMinimalEventContextUnit({
      eventId: evId,
      scope: 'work',
      title: `bug ${i}`,
      content: 'b',
      occurredAt: new Date().toISOString(),
      source: 'im',
      entities: [
        { type: 'chat', name: chatName, role: 'container', aliases: [chatAlias] },
        { type: 'person', name: 'Zeke', role: 'actor' },
      ],
    });
  }
  return { chatName, chatAlias };
}

test('buildUserPrompt 包含必要字段 + Candidates JSON 段', () => {
  seedChatbotBadcase();
  const candidates = buildChatAffinityCandidates({
    workerRunId: 'wr_p1',
    now: new Date(),
  });
  assert.ok(candidates.length > 0);

  const prompt = buildUserPrompt(candidates.slice(0, 1), []);
  // 系统 prompt 不在 user 段，但 user 段必须含输出 schema + Candidates 段
  assert.ok(prompt.includes('"candidateId"'));
  assert.ok(prompt.includes('strong_accept|accept|maybe|reject'));
  assert.ok(prompt.includes('Candidates:'));
  // 而 system prompt 与 prompt 不同
  assert.ok(!prompt.includes(RANKER_SYSTEM_PROMPT));
});

test('parseRankerResponse 容错：plain / fenced / 噪声前后', () => {
  const ok = parseRankerResponse(
    '{"results":[{"candidateId":"s:c","decision":"accept","llmScore":0.8,"confidence":0.7}]}'
  );
  assert.ok(ok && ok.length === 1);
  assert.equal(ok![0].decision, 'accept');

  const fenced = parseRankerResponse(
    'sure, here is the result:\n```json\n{"results":[{"candidateId":"x","decision":"reject","llmScore":0.1,"confidence":0.9}]}\n```\n'
  );
  assert.ok(fenced && fenced.length === 1);
  assert.equal(fenced![0].decision, 'reject');

  // 非法 decision 被 drop
  const bad = parseRankerResponse(
    '{"results":[{"candidateId":"y","decision":"definitely","llmScore":1}]}'
  );
  assert.ok(bad);
  assert.equal(bad!.length, 0);

  assert.equal(parseRankerResponse('not json at all'), null);
});

test('rankChatAffinityCandidates with mock runner: strong_accept → surfaced finalScore 高', async () => {
  clearRankerCache();
  const candidates = buildChatAffinityCandidates({
    workerRunId: 'wr_p2',
    now: new Date(),
  });
  assert.ok(candidates.length > 0);

  const summary = await rankChatAffinityCandidates(candidates, {
    workerRunId: 'wr_p2',
    runner: async (_userMessage: string) => ({
      text: JSON.stringify({
        results: candidates.map((c) => ({
          candidateId: c.candidateId,
          decision: 'strong_accept',
          llmScore: 0.91,
          confidence: 0.78,
          reasons: ['n', 'i'],
          concerns: [],
          matchedSignals: ['chat_name', 'work_map_goal'],
        })),
      }),
      raw: { model: 'mock-model' },
    }),
    enableLlm: true,
  });
  assert.ok(summary.outcomes.length >= 1);
  const o = summary.outcomes[0];
  assert.equal(o.rankerStatus, 'llm_ok');
  assert.equal(o.llmResult?.decision, 'strong_accept');
  // finalScore = 0.25 * rule + 0.75 * 0.91 ≈ 0.68+
  assert.ok(
    o.finalScore >= 0.6,
    `expected finalScore >= 0.6, got ${o.finalScore}`
  );
  assert.equal(o.surfaced, true);
  assert.equal(summary.llmAccepted, candidates.length);
  assert.equal(o.llmModelId, 'mock-model');
});

test('decision=maybe / reject 永不 surfaced', async () => {
  clearRankerCache();
  const candidates = buildChatAffinityCandidates({
    workerRunId: 'wr_p3',
    now: new Date(),
  });
  const summary = await rankChatAffinityCandidates(candidates, {
    workerRunId: 'wr_p3',
    runner: async () => ({
      text: JSON.stringify({
        results: candidates.map((c) => ({
          candidateId: c.candidateId,
          decision: 'maybe',
          llmScore: 0.55,
          confidence: 0.9,
        })),
      }),
      raw: {},
    }),
    enableLlm: true,
  });
  for (const o of summary.outcomes) {
    assert.equal(o.surfaced, false);
  }
});

test('cache hit: 第二次同 input_hash 复用上次结果', async () => {
  clearRankerCache();
  const candidates = buildChatAffinityCandidates({
    workerRunId: 'wr_cache_1',
    now: new Date(),
  });
  let runs = 0;
  const runner = async () => {
    runs++;
    return {
      text: JSON.stringify({
        results: candidates.map((c) => ({
          candidateId: c.candidateId,
          decision: 'accept',
          llmScore: 0.8,
          confidence: 0.8,
        })),
      }),
      raw: {},
    };
  };
  const a = await rankChatAffinityCandidates(candidates, {
    workerRunId: 'wr_cache_1',
    runner,
    enableLlm: true,
  });
  // 再跑一次同样的 candidates（注意要构造同 input_hash → 用同样的 candidate）
  const candidates2 = buildChatAffinityCandidates({
    workerRunId: 'wr_cache_2', // workerRunId 不进 hash
    now: new Date(),
  });
  const b = await rankChatAffinityCandidates(candidates2, {
    workerRunId: 'wr_cache_2',
    runner,
    enableLlm: true,
  });
  assert.ok(a.outcomes.length > 0);
  assert.ok(b.outcomes.length > 0);
  assert.equal(runs, 1, `runner called more than once: ${runs}`);
  assert.ok(b.rankerCacheHit >= 1);
});
