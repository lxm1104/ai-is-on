import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp14-attn-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const {
  insertContextEntity,
  getContextEntityById,
  db,
} = await import('../src/db.js');
const { insertAttentionItem, getAttentionItem, updateAttentionItemStatus } =
  await import('../src/attention/attentionStore.js');
const {
  recordAttentionInteraction,
  listRecentAttentionInteractions,
} = await import('../src/attention/attentionInteractions.js');
const { applyAttentionFeedback } = await import('../src/attention/attentionFeedback.js');
const { applyCardAction } = await import('../src/cards/cardsService.js');
const { createLarkTaskFromCard } = await import('../src/lark/larkTaskService.js');
const { assembleGlobalContextPacket } = await import('../src/context/agentContextAssembler.js');
const { getContextUnitById } = await import('../src/context/contextStore.js');
const { buildAttentionUserMessage } = await import('../src/attention/attentionPrompt.js');

function createAttentionItem(opts: {
  id: string;
  title: string;
  relatedEntityIds?: string[];
  signalIds?: string[];
}) {
  return insertAttentionItem({
    id: opts.id,
    generation: 1,
    llmRunId: null,
    inputHash: `hash-${opts.id}`,
    now: new Date().toISOString(),
    llmItem: {
      priority: 'P1',
      title: opts.title,
      why: `测试 ${opts.title}`,
      signalIds: opts.signalIds ?? [`unit-${opts.id}`],
      relatedEntityIds: opts.relatedEntityIds ?? [],
      relatedSpaceIds: [],
    },
  });
}

test('ack interaction is recorded and rendered into attention prompt/hash', () => {
  const item = createAttentionItem({ id: 'attn_ack_1', title: '查看评审风险' });
  const before = assembleGlobalContextPacket({ now: Date.now() });

  recordAttentionInteraction(item, 'ack', '2026-05-26T10:00:00.000Z');
  updateAttentionItemStatus(item.id, 'acted', '2026-05-26T10:00:01.000Z');

  const after = assembleGlobalContextPacket({
    now: new Date('2026-05-26T10:00:02.000Z').getTime(),
  });
  assert.notEqual(after.inputHash, before.inputHash);
  assert.equal(after.attentionInteractions.length, 1);
  assert.equal(after.attentionInteractions[0].action, 'ack');

  const prompt = buildAttentionUserMessage(after);
  assert.match(prompt, /<recentAttentionInteractions/);
  assert.match(prompt, /\[ack\] P1 查看评审风险/);
});

test('card dismiss records interaction and demotes related entity', async () => {
  const now = new Date().toISOString();
  insertContextEntity({
    id: 'entity_dismiss_1',
    type: 'project',
    name: '低相关项目',
    aliases_json: null,
    source: 'test',
    confidence: 0.8,
    created_at: now,
    updated_at: now,
  });
  const item = createAttentionItem({
    id: 'attn_dismiss_1',
    title: '低相关项目提醒',
    relatedEntityIds: ['entity_dismiss_1'],
  });

  const result = await applyCardAction(item.id, 'dismiss');

  assert.equal(result.ok, true);
  assert.equal(getAttentionItem(item.id)?.status, 'dismissed');
  assert.ok(
    Math.abs((getContextEntityById('entity_dismiss_1')?.confidence ?? 0) - 0.7) < 0.0001
  );

  const interactions = listRecentAttentionInteractions({
    sinceIso: '2026-01-01T00:00:00.000Z',
    limit: 10,
  });
  const dismiss = interactions.find((i) => i.attentionId === item.id);
  assert.ok(dismiss);
  assert.equal(dismiss.action, 'dismiss');

  const audits = db
    .prepare(`SELECT action FROM audit_logs WHERE action = 'attention_dismissed_with_learn'`)
    .all() as Array<{ action: string }>;
  assert.equal(audits.length, 1);
});

test('explicit not_relevant feedback records its own interaction action', () => {
  const item = createAttentionItem({
    id: 'attn_not_relevant_1',
    title: '明确没用提醒',
  });

  const result = applyAttentionFeedback({
    attentionId: item.id,
    type: 'not_relevant',
    payload: {},
    confirm: true,
  });
  assert.equal(result.applied, true);

  const interactions = listRecentAttentionInteractions({
    sinceIso: '2026-01-01T00:00:00.000Z',
    limit: 20,
  });
  const hit = interactions.find((i) => i.attentionId === item.id);
  assert.ok(hit);
  assert.equal(hit.action, 'not_relevant');
});

test('creating a Lark task from an attention card writes binding and context result', async () => {
  const item = createAttentionItem({
    id: 'attn_task_1',
    title: '跟进任务回流',
    signalIds: ['unit-task-source'],
  });
  let calledArgs: string[] = [];

  const result = await createLarkTaskFromCard(
    {
      cardId: item.id,
      confirm: true,
      dueAt: '2026-05-28',
    },
    {
      getOpenId: async () => 'ou_me',
      runLarkCliJson: async (args) => {
        calledArgs = args;
        return {
          ok: true,
          data: {
            task: {
              guid: 'task-guid-1',
              url: 'https://applink.larkoffice.com/client/todo/task?guid=task-guid-1',
            },
          },
        };
      },
    }
  );

  assert.equal(result.task.guid, 'task-guid-1');
  assert.equal(getAttentionItem(item.id)?.status, 'acted');
  assert.ok(calledArgs.includes('--assignee'));
  assert.ok(calledArgs.includes('ou_me'));
  assert.ok(calledArgs.includes('--idempotency-key'));

  const commitment = getContextUnitById(result.commitmentUnitId);
  const actionResult = getContextUnitById(result.resultUnitId);
  assert.equal(commitment?.kind, 'commitment');
  assert.equal(commitment?.actionability, 'act');
  assert.equal(actionResult?.kind, 'action_result');
  assert.match(actionResult?.content ?? '', /已在飞书创建任务/);

  const bindings = db
    .prepare(`SELECT * FROM external_task_bindings WHERE external_guid = ?`)
    .all('task-guid-1') as Array<{ external_guid: string; status: string }>;
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].status, 'created');

  const interactions = listRecentAttentionInteractions({
    sinceIso: '2026-01-01T00:00:00.000Z',
    limit: 50,
  });
  const hit = interactions.find((i) => i.attentionId === item.id);
  assert.ok(hit);
  assert.equal(hit.action, 'create_task');
});
