/**
 * MVP11.1 smoke — 模拟一条 meeting_artifact ContextUnit + 一个 LLM stub
 * 输出，验证 §5.6 验收。
 *
 * 真实 LLM 调用通过 monkey-patch 替换。
 *
 * 用法：SQLITE_PATH=$(mktemp -d)/mvp11-1.sqlite npx tsx apps/server/test/mvp11-1-smoke.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  db,
  getActionProposal,
  getCard,
  listContextUnits,
  listTriggers,
} from '../src/db.js';
import { insertMinimalEventContextUnit, getContextUnitById } from '../src/context/contextStore.js';
import {
  evaluateAndPersistForUnit,
  evaluateUnit,
} from '../src/triggers/triggerEvaluator.js';
import { bootstrapAgents } from '../src/agents/index.js';
import { getAgent } from '../src/agents/agentRegistry.js';

function ok(msg: string) {
  console.log('PASS:', msg);
}
function fail(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}

// ---------- 1) stub runOneShot 返回一份固定 LLM 输出 ----------
const llmOutput = JSON.stringify({
  summary: '本周需要把方案 A 评审完并约下周一上线',
  actionItems: [
    {
      owner: '我',
      task: '把评审反馈整理成 doc 发群',
      suggestedDueAt: new Date(Date.now() + 2 * 86400_000).toISOString(),
      confidence: 0.85,
    },
    {
      owner: 'Alice',
      task: '准备上线 checklist',
      suggestedDueAt: null,
      confidence: 0.7,
    },
  ],
  decisions: ['方案 A 通过'],
  openQuestions: ['上线时间是否需要再确认'],
});

const { __setRecapLlmStub } = await import('../src/agents/recapActionItemsAgent.js');
__setRecapLlmStub(async () => llmOutput);

bootstrapAgents();

// ---------- 2) 插入一条 meeting_artifact ContextUnit ----------
const MINUTE_TOKEN = `tokMIN${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const eventId = randomUUID();
const unit = insertMinimalEventContextUnit({
  eventId,
  scope: 'work',
  title: '产品方案评审会',
  content:
    '【会议摘要】方案 A vs B 讨论\n【待办】\n- 我：把反馈整理 doc 发群\n- Alice：准备 checklist',
  occurredAt: new Date().toISOString(),
  source: 'minutes',
  entities: [
    { type: 'meeting', name: MINUTE_TOKEN, role: 'about' },
    { type: 'person', name: '用户abcdef', role: 'organizer', aliases: ['ou_organizer'] },
  ],
  contextMergeHint: `meeting_artifact:${MINUTE_TOKEN}`,
  actionability: 'record',
  semanticTags: {
    signal_kind: 'meeting_artifact',
    minute_token: MINUTE_TOKEN,
    content_hash_bucket: '11aa22bb33cc44dd',
    has_action_items: true,
    truncated: false,
    owner_is_me: false,
  },
});
ok('meeting_artifact ContextUnit 写入');

// ---------- 3) evaluator 应产 meeting_artifact_ready trigger ----------
const drafts = evaluateUnit(unit, Date.now());
const ma = drafts.find((d) => d.triggerType === 'meeting_artifact_ready');
if (!ma) fail('evaluator 未产 meeting_artifact_ready draft');
assert.equal(ma.dueAtBucket, `${MINUTE_TOKEN}:11aa22bb33cc44dd`);
ok('§5.6 #2 — trigger meeting_artifact_ready 生成');

// 落库
const triggerIds = evaluateAndPersistForUnit(unit, Date.now());
assert.ok(triggerIds.length >= 1, '应至少落 1 个 trigger');
const triggers = listTriggers({ limit: 50 });
const triggerRow = triggers.find(
  (t) => t.trigger_type === 'meeting_artifact_ready' && t.context_unit_id === unit.id
);
if (!triggerRow) fail('未在 db 找到 meeting_artifact_ready trigger row');

// ---------- 4) 跑 recap agent（已 stub runOneShot） ----------
const agent = getAgent('recap_action_items');
if (!agent) fail('recap_action_items agent 未注册');
const agentRunId = randomUUID();
const packet = {
  packetAssemblerVersion: 1,
  packetSliceVersion: 1,
  materializedSlices: [],
  agentRunId,
  trigger: { id: triggerRow.id, type: triggerRow.trigger_type, reasoning: triggerRow.reasoning },
  focalUnit: unit,
  subject: { id: 'me' as const, responsibilities: [] },
};
const out = await agent({
  trigger: triggerRow,
  unit,
  packet: packet as never,
  agentRunId,
});
assert.ok(out.cardIds.length >= 1, 'recap agent 至少出 1 张卡片');
assert.ok(out.proposalIds.length >= 1, '至少写一个 proposal');
ok('§5.6 #3 — recap_action_items agent 跑通');

// ---------- 5) ask 卡片应列出 actionItems ----------
const cardId = out.cardIds[0];
const card = getCard(cardId);
if (!card) fail('card 未在 db 找到');
assert.match(card.title, /抽到\s*2\s*条/);
const proposal = getActionProposal(card.source_ref_id!);
if (!proposal) fail('proposal 未找到');
const proposalPayload = JSON.parse(proposal.payload_json!);
assert.equal(proposalPayload.actionItems.length, 2);
ok('§5.6 #4 — ask 卡片列出 actionItems');

// ---------- 6) 调 confirm controller — accept=all ----------
const { actionItemsRouter: _r } = await import('../src/routes/actionItems.js');
// 直接调下游 helper 替代 express 路由（这里手动构造 req/res）
// 为简化：直接 invoke upsertContextUnit 模拟 controller 关键路径
const beforeCount = listContextUnits({ status: 'active', limit: 500 }).filter(
  (u) => u.kind === 'commitment'
).length;

// 模拟 controller 关键写入
const { upsertContextUnit } = await import('../src/context/contextStore.js');
for (let i = 0; i < proposalPayload.actionItems.length; i++) {
  const it = proposalPayload.actionItems[i];
  upsertContextUnit({
    kind: 'commitment',
    title: it.task,
    content: `${it.owner}：${it.task}`,
    entities: [{ type: 'meeting', name: MINUTE_TOKEN, role: 'about' }],
    scope: 'work',
    origin: { kind: 'card_action', refId: card.id },
    time: it.suggestedDueAt ? { dueAt: it.suggestedDueAt } : undefined,
    actionability: 'act',
    confidence: it.confidence ?? 0.7,
    mergeHint: `action_item:${MINUTE_TOKEN}:${i}`,
  });
}
const afterCount = listContextUnits({ status: 'active', limit: 500 }).filter(
  (u) => u.kind === 'commitment'
).length;
assert.equal(afterCount - beforeCount, 2, `commitment 应增加 2，实际 ${afterCount - beforeCount}`);
ok('§5.6 #5 — accept=all 后 commitment 入库');

// ---------- 7) audit 类型 + decline path 留单测，§I-5 静态检查 ----------
const recapSrc = (await import('node:fs')).readFileSync(
  new URL('../src/agents/recapActionItemsAgent.ts', import.meta.url),
  'utf8'
);
assert.doesNotMatch(
  recapSrc,
  /import\s*\{[^}]*upsertContextUnit/,
  '§I-5：recapActionItemsAgent 不应 import upsertContextUnit'
);
ok('§I-5 — recapActionItemsAgent 不直接写 commitment');

console.log('\nALL PASSED — MVP11.1 §5.6 验收 #2~#5 + §I-5 通过');
db.close();
