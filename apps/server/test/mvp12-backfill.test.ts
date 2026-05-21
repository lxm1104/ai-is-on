/**
 * MVP12 Step 5 — backfillUnitRouting 幂等性 + 端到端正确性。
 *
 * 场景：先以 MVP11 风格直接写一个 event（带 raw chat），写一个 event ContextUnit
 * （此时 unit_sources / cache 已经被 upsertContextUnit 自动填了；模拟"旧数据"我们
 * 手动清空），然后跑 backfill，期望 cache 重新出现。
 *
 * 运行：npx tsx --test apps/server/test/mvp12-backfill.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp12-bf-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { insertMinimalEventContextUnit, upsertContextUnit } = await import(
  '../src/context/contextStore.js'
);
const {
  db,
  listUnitSourcesByUnit,
  listUnitRoutingCacheByUnit,
  tryInsertEvent,
} = await import('../src/db.js');
const { backfillUnitRouting } = await import(
  '../src/bootstrap/backfillUnitRouting.js'
);
import { randomUUID } from 'node:crypto';

test('backfill rebuilds unit_sources + routing cache from events.raw_json', () => {
  const now = new Date().toISOString();
  const evId = randomUUID();
  const chatId = 'oc_backfill_test';
  tryInsertEvent({
    id: evId,
    source: 'im',
    source_id: 'test:' + evId,
    kind: 'group_message',
    occurred_at: now,
    title: 't',
    text: '关联 https://www.feishu.cn/docx/BackfillTokenAAA 看看',
    actor: null,
    url: null,
    raw_json: JSON.stringify({
      chat: { chat_id: chatId, name: '回填测试群' },
      msg: { sender: { id: 'ou_alice', name: 'Alice', sender_type: 'user' } },
    }),
    content_hash: evId,
    processed_at: null,
    created_at: now,
  });
  const evUnit = insertMinimalEventContextUnit({
    eventId: evId,
    scope: 'work',
    title: 'group msg',
    content: 'body',
    occurredAt: now,
    source: 'im',
    // 故意不传 entities，模拟 MVP11 旧数据 (entities 只有 fallback person)
  });
  // semantic 通过 origin event 关联
  const semantic = upsertContextUnit({
    kind: 'commitment',
    title: 'bf commit',
    content: 'b',
    entities: [{ type: 'project', name: 'BackfillProj', role: 'about' }],
    mergeHint: 'commit:bf',
    scope: 'work',
    origin: { kind: 'event', refId: evId },
  });

  // 清空 MVP12 在上面 upsert 中自动写入的 routing 行，模拟旧 DB
  db.prepare(`DELETE FROM unit_sources`).run();
  db.prepare(`DELETE FROM unit_routing_cache`).run();

  assert.equal(listUnitSourcesByUnit(evUnit.id).length, 0, 'pre-cond cleared');
  assert.equal(listUnitRoutingCacheByUnit(evUnit.id).length, 0);

  const stats = backfillUnitRouting();
  assert.ok(stats.eventsScanned >= 1);
  assert.ok(stats.unitSourcesInserted >= 1);
  assert.ok(stats.cacheRowsWritten >= 1);

  // event unit 的 unit_sources 重新出现
  const evSrcs = listUnitSourcesByUnit(evUnit.id);
  assert.ok(evSrcs.some((s) => s.event_id === evId));

  // routing cache 含 chat + doc（从 raw_json + text 抽到）
  const evCache = listUnitRoutingCacheByUnit(evUnit.id);
  assert.ok(evCache.length > 0);
  const entities = JSON.parse(evCache[0].routing_entities_json) as Array<{
    type: string;
  }>;
  const types = new Set(entities.map((e) => e.type));
  assert.ok(types.has('chat'), 'chat routing');
  assert.ok(types.has('doc'), 'doc routing from URL in text');

  // semantic 也通过 context_links{updates}? 这里没显式建 link，所以 backfill 对它不写
  // unit_sources（除非有 link）—— 这是 expected 行为（保守）。
  // 注：实际线上 triage 走 persistContextUpdates 会建 'updates' link。
  void semantic;
});

test('backfill is idempotent (re-run yields no new unit_sources)', () => {
  const stats1 = backfillUnitRouting();
  // 第一次没写多少（因为前一个 test 已 backfill 过）
  const stats2 = backfillUnitRouting();
  assert.equal(
    stats2.unitSourcesInserted,
    0,
    'second backfill insert no new unit_sources'
  );
  void stats1;
});
