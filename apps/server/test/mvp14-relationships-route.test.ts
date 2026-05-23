/**
 * MVP14 Phase 1a · Relationships read model 测试。
 *
 * 覆盖（与 Codex coreview 共识对齐）：
 *   - context_relations=0 但 kind='relationship' units>0 时新 service 仍返回 units
 *   - relationship units=0 时返回 []
 *   - source 分类：work_map / extracted_from_event / manual / system / agent / other
 *   - persons：resolveAliased 后多个 alias 指向同一人时只出一个 chip
 *   - summary fallback：meaning ?? content ?? title
 *   - 旧 listAllRelations 仍可调（Phase 1c 才删）
 *
 * 运行：npx tsx --test apps/server/test/mvp14-relationships-route.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp14-rel-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { db, insertEntityAlias } = await import('../src/db.js');
const { upsertContextUnit } = await import('../src/context/contextStore.js');
const { resolveOrCreateEntity } = await import('../src/context/entityResolver.js');
const { listRelationships, classifySource } = await import(
  '../src/context/relationshipsService.js'
);

test('relationship units=0 时返回空数组', () => {
  // 测试启动时是空 db
  const items = listRelationships();
  assert.deepEqual(items, []);
});

test('context_relations=0 但 relationship units>0 时仍返回 units', () => {
  // 确认 context_relations 空，避免误读
  const rel = db.prepare(`SELECT COUNT(*) AS n FROM context_relations`).get() as {
    n: number;
  };
  assert.equal(rel.n, 0, 'context_relations 应为空');

  upsertContextUnit({
    kind: 'relationship',
    title: '协作者：Alice',
    content: '语音输入需求维护',
    entities: [{ type: 'person', name: 'Alice', role: 'about' }],
    scope: 'work',
    origin: { kind: 'system', refId: 'work_map' },
    actionability: 'record',
    confidence: 0.85,
    mergeHint: 'work_map:relationship:alice',
  });

  const items = listRelationships();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '协作者：Alice');
  assert.equal(items[0].source, 'work_map');
  assert.equal(items[0].persons.length, 1);
  assert.equal(items[0].persons[0].name, 'Alice');
});

test('source 分类覆盖所有 origin.kind', () => {
  // 各 origin.kind 各写一条 — origin.refId 必须不同避免 mergeKey 冲突
  upsertContextUnit({
    kind: 'relationship',
    title: '从消息抽取：Bob',
    content: '某次会议提到 Bob',
    entities: [{ type: 'person', name: 'Bob' }],
    scope: 'work',
    origin: { kind: 'event', refId: 'evt_bob' },
    actionability: 'record',
    confidence: 0.6,
  });
  upsertContextUnit({
    kind: 'relationship',
    title: '手工：Carol',
    content: '用户手动记录 Carol 是 PM',
    entities: [{ type: 'person', name: 'Carol' }],
    scope: 'work',
    origin: { kind: 'manual', refId: 'manual_carol' },
    actionability: 'record',
    confidence: 0.9,
  });
  upsertContextUnit({
    kind: 'relationship',
    title: '系统：Dave',
    content: '非 work_map 的 system origin',
    entities: [{ type: 'person', name: 'Dave' }],
    scope: 'work',
    origin: { kind: 'system', refId: 'other_system' },
    actionability: 'record',
    confidence: 0.7,
  });
  upsertContextUnit({
    kind: 'relationship',
    title: 'Agent：Eve',
    content: 'agent_run 产出',
    entities: [{ type: 'person', name: 'Eve' }],
    scope: 'work',
    origin: { kind: 'agent_run', refId: 'run_eve' },
    actionability: 'record',
    confidence: 0.7,
  });

  const items = listRelationships();
  const bySource = new Map(items.map((i) => [i.title, i.source]));
  assert.equal(bySource.get('从消息抽取：Bob'), 'extracted_from_event');
  assert.equal(bySource.get('手工：Carol'), 'manual');
  assert.equal(bySource.get('系统：Dave'), 'system');
  assert.equal(bySource.get('Agent：Eve'), 'agent');
});

test('alias 化后多个 entity 指向同一人时只出一个 person chip', () => {
  // 创建两个 person entity，把第二个 alias 到第一个
  const primary = resolveOrCreateEntity('person', '钱崇雪');
  const alias = resolveOrCreateEntity('person', '钱崇雪 (PM)');
  const now = new Date().toISOString();
  insertEntityAlias({ id: alias.id, alias_of: primary.id, created_at: now });

  upsertContextUnit({
    kind: 'relationship',
    title: '钱崇雪是 PRD 对接人',
    content: '宋一鹏建议找钱崇雪',
    // 同时挂两个 entity name；resolver 内部会都映到同一 entity_id 行
    entities: [
      { type: 'person', name: '钱崇雪', role: 'about' },
      { type: 'person', name: '钱崇雪 (PM)', role: 'about' },
    ],
    scope: 'work',
    origin: { kind: 'event', refId: 'evt_qcx' },
    actionability: 'record',
    confidence: 0.8,
  });

  const items = listRelationships();
  const qcx = items.find((i) => i.title === '钱崇雪是 PRD 对接人');
  assert.ok(qcx, '应找到刚写入的 unit');
  // canonical 后只剩一个人
  assert.equal(qcx!.persons.length, 1, `期望 1 个 canonical person，实际 ${qcx!.persons.length}`);
  assert.equal(qcx!.persons[0].id, primary.id);
});

test('summary fallback 优先 meaning > content > title', () => {
  const items = listRelationships();
  // workMapWriter 不写 meaning，content 有内容 → summary 应来自 content
  const alice = items.find((i) => i.title === '协作者：Alice');
  assert.equal(alice?.summary, '语音输入需求维护');
});

test('summary 截断到 200 字符 + 省略号', () => {
  const longContent = 'x'.repeat(300);
  upsertContextUnit({
    kind: 'relationship',
    title: 'long content test',
    content: longContent,
    entities: [{ type: 'person', name: 'LongPerson' }],
    scope: 'work',
    origin: { kind: 'manual', refId: 'long_test' },
    actionability: 'record',
    confidence: 0.5,
  });
  const items = listRelationships();
  const long = items.find((i) => i.title === 'long content test');
  assert.equal(long!.summary.length, 201); // 200 + '…'
  assert.ok(long!.summary.endsWith('…'));
});

test('classifySource 单元逻辑直测', () => {
  // mergeKey 命中优先
  assert.equal(
    classifySource({
      origin: { kind: 'agent_run', refId: 'x' },
      mergeKey: 'work_map:relationship:alice',
    } as never),
    'work_map'
  );
  // origin.refId='work_map' 兜底
  assert.equal(
    classifySource({
      origin: { kind: 'system', refId: 'work_map' },
      mergeKey: undefined,
    } as never),
    'work_map'
  );
  // 未知 origin.kind → other
  assert.equal(
    classifySource({
      origin: { kind: 'unknown' as never, refId: 'x' },
      mergeKey: undefined,
    } as never),
    'other'
  );
});

test('Phase 1c 已删 listAllRelations / context_relations 应用层 — 物理表保留', () => {
  // SQL 表仍存在（CREATE TABLE 没动），但应用层零 caller
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='context_relations'`
    )
    .get() as { name?: string } | undefined;
  assert.equal(row?.name, 'context_relations', '物理表 schema 应保留');
});
