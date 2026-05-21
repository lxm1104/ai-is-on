/**
 * MVP13 §4.6 / §S4 · ranker fallback paths.
 *
 * 场景：
 *   1. runner spawn fail → llm_failed + fallbackEligible 判定
 *   2. runner 返回不可解析 → parse_error → fallback
 *   3. enableLlm=false → llm_skipped；fallbackEligible 才 surfaced
 *   4. batch parse 失败但单独 retry 成功 → llm_ok
 *
 * 运行：npx tsx --test apps/server/test/mvp13-ranker-fallback.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp13-fb-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { insertMinimalEventContextUnit } = await import(
  '../src/context/contextStore.js'
);
const { tryInsertEvent, db } = await import('../src/db.js');
const { writeWorkMap } = await import('../src/bootstrap/workMapWriter.js');
const { buildChatAffinityCandidates } = await import(
  '../src/spaces/chatAffinityEvidence.js'
);
const { rankChatAffinityCandidates } = await import(
  '../src/spaces/llmChatAffinityRanker.js'
);

function clearRankerCache() {
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
// 5 个 unit → fallbackEligible by nameSimilarity >= 0.72 && units7d >= 3
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
        name: chatName,
        role: 'container',
        aliases: ['【 Badcase 】Chatbot badcase 跟进群'],
      },
      { type: 'person', name: 'Zeke', role: 'actor' },
    ],
  });
}

test('runner spawn fail → llm_failed + fallback 走起', async () => {
  clearRankerCache();
  const candidates = buildChatAffinityCandidates({
    workerRunId: 'wr_fb_1',
    now: new Date(),
  });
  assert.ok(candidates.length > 0);
  const summary = await rankChatAffinityCandidates(candidates, {
    workerRunId: 'wr_fb_1',
    runner: async () => {
      throw new Error('spawn failed');
    },
    enableLlm: true,
  });
  assert.ok(summary.llmFailed >= 1);
  for (const o of summary.outcomes) {
    assert.equal(o.rankerStatus, 'llm_failed');
    assert.equal(o.fallbackEligible, true);
    assert.equal(o.surfaced, true); // fallbackEligible → surfaced
  }
  // ranker run 审计写了 failed
  const rows = db
    .prepare(
      `SELECT * FROM context_space_ranker_runs WHERE worker_run_id = 'wr_fb_1'`
    )
    .all() as Array<{ status: string }>;
  assert.ok(rows.some((r) => r.status === 'failed'));
});

test('runner 返回不可解析 → parse_error → fallback', async () => {
  clearRankerCache();
  const candidates = buildChatAffinityCandidates({
    workerRunId: 'wr_fb_2',
    now: new Date(),
  });
  // runner 返回纯文本，第一遍批 + 单 candidate retry 都解析不出
  const summary = await rankChatAffinityCandidates(candidates, {
    workerRunId: 'wr_fb_2',
    runner: async () => ({
      text: 'I have no idea, sorry.',
      raw: {},
    }),
    enableLlm: true,
  });
  assert.ok(summary.llmFailed >= 1);
  const rows = db
    .prepare(
      `SELECT status FROM context_space_ranker_runs WHERE worker_run_id = 'wr_fb_2'`
    )
    .all() as Array<{ status: string }>;
  assert.ok(rows.some((r) => r.status === 'parse_error'));
});

test('enableLlm=false → llm_skipped；fallbackEligible 才 surfaced', async () => {
  clearRankerCache();
  const candidates = buildChatAffinityCandidates({
    workerRunId: 'wr_fb_3',
    now: new Date(),
  });
  const summary = await rankChatAffinityCandidates(candidates, {
    workerRunId: 'wr_fb_3',
    runner: async () => {
      throw new Error('should not be called');
    },
    enableLlm: false,
  });
  for (const o of summary.outcomes) {
    assert.equal(o.rankerStatus, 'llm_skipped');
    assert.equal(o.surfaced, o.fallbackEligible);
  }
});

test('batch parse 失败 → 单 candidate retry 成功 → llm_ok', async () => {
  clearRankerCache();
  // 需要 ≥ 2 个候选位于"同一 Space"才会进同一 batch → 触发拆单 retry。
  // 多建一个 chat 让 Chatbot Space 下出现 2 个 candidate。
  const chatName2 = 'lark_chat:oc_chatbot_badcase_2';
  for (let i = 0; i < 4; i++) {
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
          name: chatName2,
          role: 'container',
          aliases: ['Chatbot badcase 跟进群 B'],
        },
        { type: 'person', name: 'Yoda', role: 'actor' },
      ],
    });
  }
  const c2 = buildChatAffinityCandidates({
    workerRunId: 'wr_fb_4',
    now: new Date(),
  });
  // 至少两个 candidate 在同一 Space（Chatbot）下
  const bySpace = new Map<string, number>();
  for (const c of c2) {
    bySpace.set(c.spaceId, (bySpace.get(c.spaceId) ?? 0) + 1);
  }
  const maxPerSpace = Math.max(...bySpace.values());
  assert.ok(maxPerSpace >= 2, `need ≥2 candidates in one space, got ${maxPerSpace}`);

  let call = 0;
  const summary = await rankChatAffinityCandidates(c2, {
    workerRunId: 'wr_fb_4',
    runner: async (userMessage: string) => {
      call++;
      // prompt 中 "candidateId": 出现一次在 schema description，再加每个 candidate 一次；
      // 因此 ≥2 个 candidate 时计数 ≥3。
      const idCount = (userMessage.match(/"candidateId":/g) ?? []).length;
      // 第一次 batch（多 candidate）返回 garbage
      if (idCount >= 3) {
        return { text: 'nope', raw: {} };
      }
      // 单 candidate retry —— 找出真正的 candidateId（schema 描述里第一个值是 "string"，跳过它）
      const all = [...userMessage.matchAll(/"candidateId":\s*"([^"]+)"/g)].map(
        (m) => m[1]
      );
      const cid = all.find((x) => x !== 'string') ?? 'unknown';
      return {
        text: JSON.stringify({
          results: [
            {
              candidateId: cid,
              decision: 'accept',
              llmScore: 0.8,
              confidence: 0.7,
            },
          ],
        }),
        raw: {},
      };
    },
    enableLlm: true,
  });
  assert.ok(call >= 2, `expected retry, runner called ${call} times`);
  // 至少一个 llm_ok
  assert.ok(
    summary.outcomes.some((o) => o.rankerStatus === 'llm_ok'),
    'expected at least one llm_ok outcome'
  );
});
