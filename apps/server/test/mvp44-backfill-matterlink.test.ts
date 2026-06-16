/**
 * MVP44 — null-matter 卡按 signal(context_unit) → matter_context_links 确定性回链到唯一 open matter。
 *
 * Run: npx tsx --test apps/server/test/mvp44-backfill-matterlink.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp44-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const {
  insertMatter,
  upsertMatterContextLink,
  backfillMatterIdFromContextLinks,
  collapseDuplicateLiveCardsByMatter,
} = await import('../src/db.js');
const { insertAttentionItem, listLiveAttentionItems, getAttentionItem } = await import(
  '../src/attention/attentionStore.js'
);

function mkMatter(id: string, status: 'open' | 'in_progress' | 'resolved'): void {
  insertMatter({
    id,
    subject_id: 'me',
    scope: 'work',
    type: 'follow_up',
    title: `matter-${id}`,
    canonical_key: `k-${id}`,
    status,
    priority: 'P2',
    owner_entity_id: null,
    primary_space_id: null,
    due_at: null,
    current_summary: '',
    next_action: null,
    created_from_context_unit_id: 'u',
    last_evidence_context_unit_id: null,
    last_evidence_at: null,
    confidence: 0.7,
    reopened_count: 0,
    version: 1,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-10T00:00:00Z',
    resolved_at: status === 'resolved' ? '2026-06-10T00:00:00Z' : null,
    dropped_at: null,
  } as Parameters<typeof insertMatter>[0]);
}

function link(matterId: string, cuId: string): void {
  upsertMatterContextLink({
    matter_id: matterId,
    context_unit_id: cuId,
    relation: 'evidence',
    effect: 'progress',
    confidence: 0.8,
    reason: 't',
    created_at: '2026-06-10T00:00:00Z',
  } as Parameters<typeof upsertMatterContextLink>[0]);
}

let t = 0;
function mkCard(opts: { inputHash: string; title: string; signalIds: string[] }): string {
  t += 1;
  const id = randomUUID();
  insertAttentionItem({
    id,
    generation: 1,
    llmRunId: null,
    inputHash: opts.inputHash,
    now: new Date(Date.UTC(2026, 5, 16, 0, 0, t)).toISOString(),
    llmItem: {
      priority: 'P2',
      title: opts.title,
      why: 'x',
      signalIds: opts.signalIds,
      relatedEntityIds: [],
      relatedSpaceIds: [],
      matterId: undefined,
    },
  });
  return id;
}

test('signal → 唯一 open matter → 回链', () => {
  mkMatter('M1', 'open');
  link('M1', 'cu-1');
  const card = mkCard({ inputHash: 'h1', title: '某事', signalIds: ['cu-1'] });
  const n = backfillMatterIdFromContextLinks(new Date().toISOString());
  assert.equal(n, 1);
  assert.equal(getAttentionItem(card)?.matterId, 'M1');
});

test('signal → 两个 open matter（歧义）→ 不回链', () => {
  mkMatter('M2a', 'open');
  mkMatter('M2b', 'in_progress');
  link('M2a', 'cu-2');
  link('M2b', 'cu-2');
  const card = mkCard({ inputHash: 'h2', title: '歧义事', signalIds: ['cu-2'] });
  backfillMatterIdFromContextLinks(new Date().toISOString());
  assert.equal(getAttentionItem(card)?.matterId, null, '歧义保守跳过');
});

test('signal → 仅 resolved matter → 不回链（只认 open/in_progress）', () => {
  mkMatter('M3', 'resolved');
  link('M3', 'cu-3');
  const card = mkCard({ inputHash: 'h3', title: '已结事', signalIds: ['cu-3'] });
  backfillMatterIdFromContextLinks(new Date().toISOString());
  assert.equal(getAttentionItem(card)?.matterId, null);
});

test('提案卡不被回链', () => {
  mkMatter('M4', 'open');
  link('M4', 'cu-4');
  const card = mkCard({ inputHash: 'proposal:matter-resolve:M4', title: '确认办结', signalIds: ['cu-4'] });
  backfillMatterIdFromContextLinks(new Date().toISOString());
  assert.equal(getAttentionItem(card)?.matterId, null, '提案卡 matterId 不被兜底改写');
});

test('回链后 collapse 接力：两张漏链卡 → 同 matter → 去重成 1', () => {
  mkMatter('M5', 'open');
  link('M5', 'cu-5');
  mkCard({ inputHash: 'h5a', title: '催办甲', signalIds: ['cu-5'] });
  const newest = mkCard({ inputHash: 'h5b', title: '催办乙', signalIds: ['cu-5'] });
  const now = new Date().toISOString();
  assert.equal(backfillMatterIdFromContextLinks(now), 2, '两张都回链到 M5');
  collapseDuplicateLiveCardsByMatter(now);
  const live = listLiveAttentionItems(300).filter((x) => x.matterId === 'M5');
  assert.equal(live.length, 1, '同 matter 去重成 1');
  assert.equal(live[0].id, newest, '留最新');
});
