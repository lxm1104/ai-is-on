/**
 * MVP29D — matter id 卫生：matter（事项）有独立 id 空间，不该混进 signalIds（解不出原文 →
 * "未解析的 signal"），matterId 又常被 LLM 截断成 8 位（auto-clear 按 matter_id 匹配不上 →
 * "已处理还在催"）。修复：matchMatterId 识别 matter id；写时把 matter id 踢出 signalIds、
 * 把 matterId 还原成完整 id；读时跳过 signalIds 里的 matter id；auto-clear 前缀兜底。
 *
 * Run: npx tsx --test apps/server/test/mvp29d-matter-id-hygiene.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp29d-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const proj = await import('../src/cards/contextProjection.js');
const prompt = await import('../src/attention/attentionPrompt.js');
const ms = await import('../src/matter/matterStore.js');

const NOW = new Date('2026-06-08T09:00:00Z').toISOString();
let seq = 0;

function mkMatter(title: string, status: import('../src/matter/matterTypes.js').MatterStatus = 'open') {
  seq += 1;
  return ms.createMatter({
    scope: 'work',
    type: 'discussion',
    title,
    canonicalKey: `k-${seq}`,
    createdFromContextUnitId: `u-${seq}`,
    status,
    priority: 'P1',
    now: NOW,
  });
}

function mkUnit(id: string, title: string) {
  db.db
    .prepare(
      `INSERT INTO context_units
        (id, scope, origin_kind, origin_ref_id, kind, title, content, created_at, updated_at)
       VALUES (?, 'work', 'manual', ?, 'commitment', ?, ?, ?, ?)`
    )
    .run(id, `origin-${id}`, title, `content of ${title}`, NOW, NOW);
}

function mkCard(opts: { id: string; matterId: string | null; signalIds: string[]; status?: string }) {
  db.db
    .prepare(
      `INSERT INTO attention_items
        (id, generation, input_hash, priority, title, why, signal_ids_json, status, source_kind, raw_json, matter_id, created_at, updated_at)
       VALUES (?, 0, 'h', 'P1', 'T', 'w', ?, ?, 'attention', '{}', ?, ?, ?)`
    )
    .run(opts.id, JSON.stringify(opts.signalIds), opts.status ?? 'live', opts.matterId, NOW, NOW);
}

test('T1 matchMatterId：精确 / 唯一前缀命中 → 完整 matter id；非 matter → null', () => {
  const m = mkMatter('讨论去掉 memory 中的 tool');
  assert.equal(db.matchMatterId(m.id), m.id, '完整 id 精确命中');
  assert.equal(db.matchMatterId(m.id.slice(0, 8)), m.id, '8 位前缀唯一命中 → 还原');
  assert.equal(db.matchMatterId('00000000'), null, '查不到 → null');
  assert.equal(db.matchMatterId('aaaaaaaa-1111-2222-3333-444444444444'), null, '完整但非 matter → null');
});

test('T2 parseAttentionOutput：把误混进 signalIds 的 matter id 踢掉，保留真信号', () => {
  const m = mkMatter('matter for signalIds test');
  const cu = 'c0ffee00-1111-2222-3333-444444444444';
  mkUnit(cu, '真·commitment');
  const out = prompt.parseAttentionOutput(
    JSON.stringify({
      items: [{ priority: 'P1', title: 'T', why: 'w', signalIds: [cu, m.id.slice(0, 8)] }],
    })
  );
  assert.deepEqual(out[0].signalIds, [cu], 'matter id 被踢出，只剩 commitment');
});

test('T3 parseAttentionOutput：截断的 matterId 还原成完整 matter id', () => {
  const m = mkMatter('matter for matterId test');
  const out = prompt.parseAttentionOutput(
    JSON.stringify({ items: [{ priority: 'P1', title: 'T', why: 'w', matterId: m.id.slice(0, 8) }] })
  );
  assert.equal(out[0].matterId, m.id, 'matterId 还原成完整 id（auto-clear 才匹配得上）');
});

test('T4 resolveAttentionSignalDetails：signalIds 里的 matter id 被跳过，不再 unknown', () => {
  const m = mkMatter('matter for resolve test');
  const cu = 'beef0000-1111-2222-3333-444444444444';
  mkUnit(cu, '会议纪要承诺');
  // 一条 commitment（截断）+ 一个 matter id（截断）
  const details = proj.resolveAttentionSignalDetails([cu.slice(0, 8), m.id.slice(0, 8)]);
  assert.equal(details.length, 1, 'matter id 不产出条目');
  assert.equal(details[0].kind, 'context_unit');
  assert.equal(details[0].title, '会议纪要承诺');
  // 只有一个 matter id 时 → 空列表，而不是一条 "未解析的 signal"
  assert.equal(proj.resolveAttentionSignalDetails([m.id.slice(0, 8)]).length, 0);
});

test('T6 coerceSignalIds：与 matterId 同值的 id（含 echo uuid 改错一位、库里查不到）也踢出 signalIds', () => {
  // 模拟"雅迪"卡：LLM 把 matter id 同时写进 matterId 和 signalIds，且 36 位 uuid 改错一位 → 库里无此 id
  const corrupted = 'a2889c0b-3d8d-412c-860e-2bc5ab25f804';
  const out = prompt.parseAttentionOutput(
    JSON.stringify({
      items: [{ priority: 'P1', title: 'T', why: 'w', matterId: corrupted, signalIds: [corrupted] }],
    })
  );
  assert.deepEqual(out[0].signalIds, [], 'matterId 同值（即便查不到）也从 signalIds 踢掉');
  assert.equal(out[0].matterId, corrupted, 'matterId 字段保留原值（auto-clear 另说）');
});

test('T7 signalIdsForOrigin：解析前剔除本条 matterId 的值', () => {
  assert.deepEqual(
    proj.signalIdsForOrigin({ signalIds: ['x-keep', 'm-dup'], matterId: 'm-dup' }),
    ['x-keep']
  );
  assert.deepEqual(
    proj.signalIdsForOrigin({ signalIds: ['a', 'b'], matterId: null }),
    ['a', 'b'],
    '无 matterId → 不动'
  );
});

test('T5 auto-clear：matter_id 被截断也能在 matter resolved 后清掉旧卡', () => {
  const resolved = mkMatter('已办掉的事', 'open');
  const open = mkMatter('还在进行的事', 'open');
  ms.saveMatter({ ...ms.getMatterById(resolved.id)!, status: 'resolved', resolvedAt: NOW });

  mkCard({ id: 'card-trunc', matterId: resolved.id.slice(0, 8), signalIds: [] }); // 截断绑定
  mkCard({ id: 'card-open', matterId: open.id, signalIds: [] }); // 完整绑定，matter 仍 open

  const changed = db.markAttentionSupersededForResolvedMatters(NOW);
  assert.ok(changed >= 1, '至少清掉一张');
  assert.equal(db.getAttentionItem('card-trunc')!.status, 'superseded', '截断绑定也被前缀匹配清掉');
  assert.equal(db.getAttentionItem('card-open')!.status, 'live', 'matter 仍 open 的卡不动');
});
