/**
 * MVP46 — ask_agent 对话结论桥接：progressed/blocked 也升「进展回执」卡 + 结论回写 matter。
 * 测核心纯函数 applyChatConclusion（不含 LLM）。
 *
 * Run: npx tsx --test apps/server/test/mvp46-chat-conclusion.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp46-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { db, insertMatter } = await import('../src/db.js');
const { getMatterById } = await import('../src/matter/matterStore.js');
const { insertAttentionItem, listLiveAttentionItems, updateAttentionItemStatus } = await import(
  '../src/attention/attentionStore.js'
);
const { applyChatConclusion } = await import('../src/matter/chatConclusionService.js');

let seq = 0;
function mkMatter(status: 'open' | 'in_progress' | 'blocked' = 'open'): string {
  seq += 1;
  const id = `M-${seq}-${randomUUID().slice(0, 6)}`;
  insertMatter({
    id, subject_id: 'me', scope: 'work', type: 'follow_up', title: `事项${seq}`,
    canonical_key: `k-${id}`, status, priority: 'P2', owner_entity_id: null, primary_space_id: null,
    due_at: null, current_summary: '', next_action: null, created_from_context_unit_id: 'u',
    last_evidence_context_unit_id: null, last_evidence_at: null, confidence: 0.7, reopened_count: 0,
    version: 1, created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-10T00:00:00Z',
    resolved_at: null, dropped_at: null,
  } as Parameters<typeof insertMatter>[0]);
  return id;
}

function liveFor(matterId: string, prefix: string) {
  return listLiveAttentionItems(500).filter(
    (x) => x.matterId === matterId && x.inputHash.startsWith(prefix)
  );
}
const PROGRESS = 'proposal:matter-progress:';
const RESOLVE = 'proposal:matter-resolve:';

function run(matterId: string, verdict: string, confidence: number) {
  const m = getMatterById(matterId)!;
  return applyChatConclusion({
    matter: m,
    verdict: { verdict, confidence, evidence: `证据片段-${verdict}` } as never,
    topicTitle: '帮我处理这个事',
    topicId: 't-' + matterId,
  });
}

test('progressed≥0.6 → 升进展回执卡 + 回写 matter 摘要/证据链/audit', () => {
  const M = mkMatter('open');
  const r = run(M, 'progressed', 0.7);
  assert.equal(r.outcome, 'progress');
  assert.equal(r.raised, true);
  assert.equal(liveFor(M, PROGRESS).length, 1, '一张进展回执卡');
  const m = getMatterById(M)!;
  assert.ok(m.currentSummary.startsWith('［AI 对话］'), '摘要带 AI 对话前缀');
  assert.ok(m.lastEvidenceAt, '刷新证据时钟');
  const link = db.prepare(
    `SELECT 1 FROM matter_context_links WHERE matter_id=? AND relation='evidence' LIMIT 1`
  ).get(M);
  assert.ok(link, '证据 context link 已挂');
  const audit = db.prepare(
    `SELECT 1 FROM audit_logs WHERE action='chat_conclusion_written_back'
       AND json_extract(payload_json,'$.matterId')=? LIMIT 1`
  ).get(M);
  assert.ok(audit, '写了 chat_conclusion_written_back 审计');
});

test('blocked≥0.6 → 也升进展回执卡', () => {
  const M = mkMatter('open');
  const r = run(M, 'blocked', 0.65);
  assert.equal(r.outcome, 'progress');
  assert.equal(liveFor(M, PROGRESS).length, 1);
});

test('resolved≥0.75 → 升办结提案卡', () => {
  const M = mkMatter('open');
  const r = run(M, 'resolved', 0.8);
  assert.equal(r.outcome, 'resolve');
  assert.equal(liveFor(M, RESOLVE).length, 1, '一张办结提案卡');
  assert.equal(liveFor(M, PROGRESS).length, 0);
});

test('no_change → skip，不出卡不回写', () => {
  const M = mkMatter('open');
  const r = run(M, 'no_change', 0.9);
  assert.equal(r.outcome, 'skip');
  assert.equal(liveFor(M, PROGRESS).length + liveFor(M, RESOLVE).length, 0);
  assert.equal(getMatterById(M)!.currentSummary, '', '未回写摘要');
});

test('progressed 但低置信(0.5<0.6) → skip', () => {
  const M = mkMatter('open');
  const r = run(M, 'progressed', 0.5);
  assert.equal(r.outcome, 'skip');
  assert.equal(liveFor(M, PROGRESS).length, 0);
});

test('幂等：已有 live 进展卡 → 再 progressed 不叠卡', () => {
  const M = mkMatter('open');
  run(M, 'progressed', 0.7);
  const r2 = run(M, 'progressed', 0.8);
  assert.equal(r2.raised, false, '第二次未真正升卡');
  assert.equal(liveFor(M, PROGRESS).length, 1, '仍只有一张');
});

test('dismiss 抑制：matter 有被 dismiss 的提案卡 → 不再回发', () => {
  const M = mkMatter('open');
  // 构造一张已 dismiss 的提案卡
  const did = randomUUID();
  insertAttentionItem({
    id: did, generation: 0, llmRunId: null, inputHash: `${PROGRESS}${M}`,
    llmItem: { priority: 'P2', title: '旧进展', why: 'x', signalIds: [], matterId: M },
    now: '2026-06-15T00:00:00Z',
  });
  updateAttentionItemStatus(did, 'dismissed', '2026-06-15T01:00:00Z');
  const r = run(M, 'progressed', 0.9);
  assert.equal(r.outcome, 'skip');
  assert.equal(r.reason, 'dismissed');
  assert.equal(liveFor(M, PROGRESS).length, 0, '不升新卡');
});

test('办结优先：已有 live 办结提案 → progressed skip(has_live_resolve)', () => {
  const M = mkMatter('open');
  run(M, 'resolved', 0.8); // 先升办结
  const r = run(M, 'progressed', 0.9);
  assert.equal(r.outcome, 'skip');
  assert.equal(r.reason, 'has_live_resolve');
  assert.equal(liveFor(M, PROGRESS).length, 0);
  assert.equal(liveFor(M, RESOLVE).length, 1);
});
