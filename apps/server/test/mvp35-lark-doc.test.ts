/**
 * MVP35 — AI 起草并新建飞书文档（内部可逆执行动作）。
 * lark-cli 用注入 stub —— 不真实创建文档。
 *
 * Run: npx tsx --test apps/server/test/mvp35-lark-doc.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp35-doc-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { insertAttentionItem, getAttentionItem } = await import('../src/attention/attentionStore.js');
const { createDocFromCard } = await import('../src/lark/larkDocService.js');

let n = 0;
function mkUnit() {
  n += 1;
  return cs.upsertContextUnit({
    kind: 'commitment',
    title: `证据${n}`,
    content: `给丘晓骁交付字体调整文档 ${n}`,
    scope: 'work',
    origin: { kind: 'manual', refId: `u-${n}` },
    silent: true,
  }).unit;
}
function mkAttn(opts: { signalIds: string[]; matterId?: string }): string {
  return insertAttentionItem({
    id: randomUUID(),
    generation: 1,
    llmRunId: null,
    inputHash: `hash-${randomUUID()}`,
    now: new Date().toISOString(),
    llmItem: {
      priority: 'P1',
      title: '写字体调整 feature 文档',
      why: '答应丘晓骁本周给文档',
      signalIds: opts.signalIds,
      relatedEntityIds: [],
      relatedSpaceIds: [],
      matterId: opts.matterId,
    },
  }).id;
}
function stubCli(docId = `doxcn${randomUUID().slice(0, 8)}`) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ document_id: docId, url: `https://x.feishu.cn/docx/${docId}` }), stderr: '' };
  };
  return { run, calls };
}

test('T1 confirm=false → 拒绝', async () => {
  const attnId = mkAttn({ signalIds: [mkUnit().id] });
  const { run } = stubCli();
  await assert.rejects(() => createDocFromCard({ cardId: attnId, confirm: false }, { runLarkCli: run }), /confirm is required/);
});

test('T2 正常创建：命令含 docs +create + content 带 title，回写 + 挂 matter + acted', async () => {
  const unit = mkUnit();
  const matter = ms.createMatter({
    scope: 'work', type: 'delivery', title: '写字体调整 feature 文档（对丘晓骁承诺）',
    canonicalKey: `k-${randomUUID()}`, createdFromContextUnitId: unit.id,
    currentSummary: '丘晓骁要字体调整说明', nextAction: '整理字体目录与配置写成文档',
  });
  const attnId = mkAttn({ signalIds: [unit.id], matterId: matter.id });
  const { run, calls } = stubCli('doxcnFIXED2');
  const res = await createDocFromCard({ cardId: attnId, confirm: true }, { runLarkCli: run });

  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.deepEqual(args.slice(0, 4), ['docs', '+create', '--api-version', 'v2']);
  const content = args[args.indexOf('--content') + 1];
  assert.ok(content.includes('<title>'), 'content 必须含 title');
  assert.ok(content.includes('整理字体目录与配置写成文档'), 'content 应含 matter 的下一步');

  assert.equal(res.ok, true);
  assert.equal(res.documentId, 'doxcnFIXED2');
  assert.equal(res.url, 'https://x.feishu.cn/docx/doxcnFIXED2');
  assert.equal(res.reused, false);

  const ru = cs.getContextUnitById(res.resultUnitId);
  assert.ok(ru && ru.kind === 'action_result');
  assert.ok(ms.listMatterContextLinks(matter.id).some((l) => l.contextUnitId === res.resultUnitId), 'matter 应挂文档证据');
  assert.equal(getAttentionItem(attnId)!.status, 'acted');
});

test('T3 幂等：同来源同标题二次创建 → reused，不重复调用 lark-cli', async () => {
  const unit = mkUnit();
  const attnId = mkAttn({ signalIds: [unit.id] });
  const a = stubCli();
  const r1 = await createDocFromCard({ cardId: attnId, confirm: true, title: '同名文档X' }, { runLarkCli: a.run });
  assert.equal(r1.reused, false);
  const b = stubCli();
  const attnId2 = mkAttn({ signalIds: [unit.id] });
  // 用不同卡但相同标题不会复用（key 含 sourceRefId）；用同卡同标题才复用：
  const r2 = await createDocFromCard({ cardId: attnId, confirm: true, title: '同名文档X' }, { runLarkCli: b.run });
  assert.equal(r2.reused, true, '同卡同标题应复用');
  assert.equal(b.calls.length, 0, '复用不得再调 lark-cli');
});

test('T4 dry-run：调用带 --dry-run，不写回（resultUnitId 空）', async () => {
  const attnId = mkAttn({ signalIds: [mkUnit().id] });
  const { run, calls } = stubCli();
  const res = await createDocFromCard({ cardId: attnId, confirm: true, dryRun: true }, { runLarkCli: run });
  assert.ok(calls[0].includes('--dry-run'));
  assert.equal(res.dryRun, true);
  assert.equal(res.resultUnitId, '');
  assert.equal(getAttentionItem(attnId)!.status, 'live', 'dry-run 不得标记 acted');
});
