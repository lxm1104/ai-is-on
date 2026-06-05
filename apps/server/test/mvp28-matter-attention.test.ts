/**
 * MVP28 — Matter-aware attention：packet matters slice、prompt 渲染、resolved 清卡、matterId 往返。
 *
 * Run: npx tsx --test apps/server/test/mvp28-matter-attention.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp28-attn-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const ms = await import('../src/matter/matterStore.js');
const mp = await import('../src/matter/matterProjection.js');
const assembler = await import('../src/context/agentContextAssembler.js');
const prompt = await import('../src/attention/attentionPrompt.js');
const astore = await import('../src/attention/attentionStore.js');

const NOW_ISO = new Date('2026-06-03T09:00:00Z').toISOString();

function resetDb() {
  db.db.exec(`
    DELETE FROM matters; DELETE FROM matter_entities;
    DELETE FROM matter_context_links; DELETE FROM matter_transitions;
    DELETE FROM attention_items;
    DELETE FROM context_units; DELETE FROM context_entities; DELETE FROM context_unit_entities;
    DELETE FROM settings WHERE key='self_person_entity_id';
  `);
}

let n = 0;
function mkMatter(opts: {
  title: string;
  status?: import('../src/matter/matterTypes.js').MatterStatus;
  priority?: import('../src/matter/matterTypes.js').MatterPriority;
}) {
  n += 1;
  return ms.createMatter({
    scope: 'work',
    type: 'discussion',
    title: opts.title,
    canonicalKey: `k-${n}`,
    createdFromContextUnitId: `u-${n}`,
    status: opts.status ?? 'open',
    priority: opts.priority ?? 'P2',
    now: NOW_ISO,
  });
}

test('T1 projectMattersForPacket：排除 resolved/dropped，按 priority 排序', () => {
  resetDb();
  mkMatter({ title: '低优开放', priority: 'P2', status: 'open' });
  mkMatter({ title: '高优进行', priority: 'P0', status: 'in_progress' });
  const resolved = mkMatter({ title: '已完成', priority: 'P1', status: 'open' });
  ms.saveMatter({ ...ms.getMatterById(resolved.id)!, status: 'resolved', resolvedAt: NOW_ISO });

  const packetMatters = mp.projectMattersForPacket();
  assert.equal(packetMatters.length, 2, 'resolved 不进 packet');
  assert.equal(packetMatters[0].priority, 'P0', 'P0 排最前');
  assert.ok(!packetMatters.some((m) => m.title === '已完成'));
});

test('T2 assembleGlobalContextPacket 含 matters slice，resolve 后 inputHash 变化', () => {
  resetDb();
  const m = mkMatter({ title: '安排与 Yufan 讨论', priority: 'P1', status: 'open' });
  const p1 = assembler.assembleGlobalContextPacket();
  assert.ok(Array.isArray(p1.matters), 'packet 必须有 matters 字段');
  assert.equal(p1.matters.length, 1);
  assert.equal(p1.matters[0].id, m.id);

  ms.saveMatter({ ...ms.getMatterById(m.id)!, status: 'resolved', resolvedAt: NOW_ISO });
  const p2 = assembler.assembleGlobalContextPacket();
  assert.equal(p2.matters.length, 0, 'resolved Matter 掉出 slice');
  assert.notEqual(p1.inputHash, p2.inputHash, 'matters 变化必须改变 inputHash → attention 重跑');
});

test('T3 buildAttentionUserMessage 渲染 <matters> block', () => {
  resetDb();
  mkMatter({ title: '评审设计文档', priority: 'P1', status: 'blocked' });
  const packet = assembler.assembleGlobalContextPacket();
  const msg = prompt.buildAttentionUserMessage(packet, { currentLive: [] });
  assert.ok(msg.includes('<matters'), '应渲染 <matters> 块');
  assert.ok(msg.includes('评审设计文档'));
  assert.ok(msg.includes('status=blocked'));
});

test('T4 markAttentionItemsSupersededForResolvedMatters：只清 resolved/dropped 绑定的卡', () => {
  resetDb();
  const active = mkMatter({ title: '进行中', status: 'in_progress' });
  const resolved = mkMatter({ title: '已完成', status: 'open' });
  ms.saveMatter({ ...ms.getMatterById(resolved.id)!, status: 'resolved', resolvedAt: NOW_ISO });

  const mk = (matterId: string | undefined, title: string) =>
    astore.insertAttentionItem({
      id: `ai-${title}`,
      generation: 1,
      llmRunId: null,
      inputHash: 'h',
      llmItem: { priority: 'P1', title, why: 'w', matterId },
      now: NOW_ISO,
    });
  mk(resolved.id, 'card-resolved');
  mk(active.id, 'card-active');
  mk(undefined, 'card-nomatter');

  const cleared = astore.markAttentionItemsSupersededForResolvedMatters(NOW_ISO);
  assert.equal(cleared, 1, '只清 1 张（绑定 resolved Matter 的）');
  assert.equal(astore.getAttentionItem('ai-card-resolved')!.status, 'superseded');
  assert.equal(astore.getAttentionItem('ai-card-active')!.status, 'live');
  assert.equal(astore.getAttentionItem('ai-card-nomatter')!.status, 'live');
});

test('T5 matterId 持久化往返', () => {
  resetDb();
  const m = mkMatter({ title: 'X' });
  const item = astore.insertAttentionItem({
    id: 'ai-rt',
    generation: 1,
    llmRunId: null,
    inputHash: 'h',
    llmItem: { priority: 'P0', title: 'Y', why: 'w', matterId: m.id },
    now: NOW_ISO,
  });
  assert.equal(item.matterId, m.id);
  assert.equal(astore.getAttentionItem('ai-rt')!.matterId, m.id);
});

test('T6 parseAttentionOutput 解析 matterId；system prompt 含 §16', () => {
  const out = prompt.parseAttentionOutput(
    JSON.stringify({ items: [{ priority: 'P1', title: 'T', why: 'because matter', matterId: 'm-123' }] })
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].matterId, 'm-123');
  assert.ok(prompt.ATTENTION_SYSTEM_PROMPT.includes('matterId'), 'system prompt 必须教 LLM 填 matterId');
  assert.ok(prompt.ATTENTION_SYSTEM_PROMPT.includes('<matters>'));
});
