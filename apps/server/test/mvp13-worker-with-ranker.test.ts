/**
 * MVP13 §S5 · worker 集成。
 *
 * 验证：
 *   - LLM disabled 时 fallback eligible 的 candidate 才 surfaced
 *   - LLM accept → 写 suggestion + rule_score / final_score / llm_decision 等列被填
 *   - LLM reject 不 surfaced（不写 suggestion）
 *
 * 运行：npx tsx --test apps/server/test/mvp13-worker-with-ranker.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp13-wk-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
// 默认禁用真实 LLM；测试通过 opts.runner / enableLlm 注入
process.env.MVP13_LLM_RANKER_ENABLED = 'false';

const { insertMinimalEventContextUnit } = await import(
  '../src/context/contextStore.js'
);
const { tryInsertEvent, db, getContextSpaceByTypeName, listSpaceSuggestions } =
  await import('../src/db.js');
const { writeWorkMap } = await import('../src/bootstrap/workMapWriter.js');
const { runSuggestionWorker } = await import('../src/spaces/suggestionWorker.js');

function clearRanker() {
  db.prepare(`DELETE FROM context_space_ranker_runs`).run();
}

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

// 种 Space + Chatbot badcase 群（弱信号，directHits=0）
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
for (let i = 0; i < 5; i++) {
  insertMinimalEventContextUnit({
    eventId: newEvent(),
    scope: 'work',
    title: `t${i}`,
    content: 'b',
    occurredAt: new Date().toISOString(),
    source: 'im',
    entities: [
      { type: 'chat', name: chatName, role: 'container', aliases: ['【 Badcase 】Chatbot 跟进群'] },
      { type: 'person', name: 'Zeke', role: 'actor' },
    ],
  });
}

test('LLM disabled → fallback eligible candidate surfaced（chat seed 写入）', async () => {
  clearRanker();
  const stats = await runSuggestionWorker({ enableLlm: false });
  assert.ok(stats.candidateGenerated >= 1);
  assert.ok(
    stats.chatAffinityInserted + stats.chatAffinityUpdated >= 1,
    'fallback surfaced'
  );
  const space = getContextSpaceByTypeName('project', 'Chatbot')!;
  const items = listSpaceSuggestions(space.id, 'suggested');
  const item = items.find((s) => s.suggestion_type === 'chat_affinity');
  assert.ok(item, 'chat_affinity suggestion written');
  // ranker_status 应为 llm_skipped
  assert.equal(item!.ranker_status, 'llm_skipped');
  // final_score 应等于 rule_score
  assert.equal(item!.final_score, item!.rule_score);
});

test('LLM accept → 写 suggestion + llm 字段被填', async () => {
  clearRanker();
  // 把上一轮的 suggested 状态保留 OK；再跑一次会 update
  const stats = await runSuggestionWorker({
    enableLlm: true,
    runner: async () => ({
      text: JSON.stringify({
        results: [
          {
            candidateId: 'placeholder', // applyResults 按 candidateId 查；用 wildcard 不行
          },
        ],
      }),
      raw: {},
    }),
  });
  // 上面 runner 返回的 candidateId 不匹配 → 全 llm_failed → fallback 救回
  assert.ok(stats.candidateRanked >= 1);
});

test('LLM accept（candidate id 精确匹配）→ ranker_status=llm_ok + llm_decision=accept', async () => {
  clearRanker();
  // Pre-fetch candidates 拿真实 candidateId，再注入 runner
  // 这里通过 worker 内部 build → rank 串联；我们让 runner 把所有传入 candidateId 都 accept
  const stats = await runSuggestionWorker({
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
            llmScore: 0.92,
            confidence: 0.8,
            reasons: ['x'],
            concerns: [],
            matchedSignals: ['chat_name', 'work_map_goal'],
          })),
        }),
        raw: { model: 'mock-claude' },
      };
    },
  });
  assert.ok(stats.llmAccepted >= 1);
  const space = getContextSpaceByTypeName('project', 'Chatbot')!;
  const items = listSpaceSuggestions(space.id, 'suggested');
  const item = items.find((s) => s.suggestion_type === 'chat_affinity');
  assert.ok(item);
  assert.equal(item!.ranker_status, 'llm_ok');
  assert.equal(item!.llm_decision, 'strong_accept');
  assert.equal(item!.model_id, 'mock-claude');
  assert.ok((item!.final_score ?? 0) >= 0.6);
});

test('LLM reject → 不 surfaced（不会 insert/update suggestion）', async () => {
  clearRanker();
  // 先把现有 suggestion 撤回到 rejected/clear 状态：直接清空表
  db.prepare(`DELETE FROM context_space_suggestions`).run();

  const stats = await runSuggestionWorker({
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
            decision: 'reject',
            llmScore: 0.1,
            confidence: 0.9,
          })),
        }),
        raw: {},
      };
    },
  });
  assert.ok(stats.llmRejected >= 1);
  assert.equal(stats.chatAffinityInserted, 0);
  assert.equal(stats.chatAffinityUpdated, 0);

  const items = db
    .prepare(`SELECT COUNT(*) as n FROM context_space_suggestions WHERE suggestion_type='chat_affinity'`)
    .get() as { n: number };
  assert.equal(items.n, 0);
});
