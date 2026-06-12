/**
 * MVP33 U2 — matter_observations 消费通路：门槛、让路、召回、保守阈值复用、
 * 幂等、重启补扫。judge 走 DI stub（与 reducer 测试同模式），零真实 LLM 调用。
 *
 * Run: npx tsx --test apps/server/test/mvp33-observation-consumer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp33-obs-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.MATTER_OBS_CONSUME_ENABLED = 'true';

const { getMatterObservationRow } = await import('../src/db.js');
const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const { consumeMatterObservation, recoverUnconsumedObservations, recallByTitle } = await import(
  '../src/matter/matterObservationConsumer.js'
);
import type { MatterReduceDecision } from '../src/matter/matterTypes.js';

let n = 0;

function mkMatter(title: string) {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment',
    title,
    content: title,
    scope: 'work',
    origin: { kind: 'manual', refId: `obs-mu-${n}` },
    silent: true,
  }).unit;
  return ms.createMatter({
    scope: 'work',
    type: 'delivery',
    title,
    canonicalKey: `obs-mk-${n}`,
    createdFromContextUnitId: unit.id,
  });
}

function mkUnit(kind: string, title: string) {
  n += 1;
  return cs.upsertContextUnit({
    kind: kind as never,
    title,
    content: `${title} 的内容`,
    scope: 'work',
    origin: { kind: 'manual', refId: `obs-u-${n}` },
    silent: true,
  }).unit;
}

function mkObs(opts: {
  title: string;
  lifecycle?: string | null;
  confidence?: number;
  unitIds?: string[];
}) {
  return ms.recordMatterObservation({
    sourceEventId: randomUUID(),
    contextUnitIds: opts.unitIds ?? [],
    observationType: 'progress',
    matterType: 'delivery',
    title: opts.title,
    lifecycleEffect: opts.lifecycle === undefined ? 'advance' : opts.lifecycle,
    evidence: `证据：${opts.title}`,
    confidence: opts.confidence ?? 0.85,
  });
}

function stubJudge(decision: Partial<MatterReduceDecision>, calls: { count: number }) {
  return async () => {
    calls.count++;
    return {
      action: 'attach',
      confidence: 0.9,
      reason: 'stub',
      ...decision,
    } as MatterReduceDecision;
  };
}

// ---- 主链路：标题轴召回 + attach/advance 落地 ----

test('progress 观察经标题轴召回 → attach/progress 落地，matter 进 in_progress，销账回写候选', async () => {
  const matter = mkMatter('提交memory、上下文、Instruction三个专利');
  const unit = mkUnit('event', 'Base Chatbot专利挖掘');
  const obsId = mkObs({ title: '提交memory、上下文、Instruction三个专利', unitIds: [unit.id] });
  const calls = { count: 0 };

  const out = await consumeMatterObservation(obsId, {
    judge: stubJudge({ action: 'attach', matterId: matter.id, effect: 'progress', confidence: 0.9 }, calls),
  });

  assert.equal(out.result, 'attach:progress:applied');
  assert.equal(calls.count, 1);
  const m = ms.getMatterById(matter.id)!;
  assert.equal(m.status, 'in_progress');
  const row = getMatterObservationRow(obsId)!;
  assert.ok(row.consumed_at, '应已销账');
  assert.equal(row.consume_result, 'attach:progress:applied');
  assert.ok(
    (JSON.parse(row.candidate_matter_ids_json) as string[]).includes(matter.id),
    'candidate_matter_ids_json 应回写命中的 matter'
  );
});

test('resolve 观察高置信 → matter resolved（复用 ≥0.78 阈值）', async () => {
  const matter = mkMatter('完成季度OKR复盘文档');
  const unit = mkUnit('state', 'OKR复盘已完成');
  const obsId = mkObs({ title: '完成季度OKR复盘文档', lifecycle: 'resolve', unitIds: [unit.id] });
  const calls = { count: 0 };

  const out = await consumeMatterObservation(obsId, {
    judge: stubJudge({ action: 'attach', matterId: matter.id, effect: 'resolve', confidence: 0.9 }, calls),
  });
  assert.equal(out.result, 'attach:resolve:applied');
  assert.equal(ms.getMatterById(matter.id)!.status, 'resolved');
});

test('中置信（0.55-0.78）→ 只挂证据不改状态（保守阈值复用）', async () => {
  const matter = mkMatter('部署灰度发布配置');
  const unit = mkUnit('state', '灰度配置部署中');
  const obsId = mkObs({ title: '部署灰度发布配置', lifecycle: 'resolve', unitIds: [unit.id] });
  const calls = { count: 0 };

  const out = await consumeMatterObservation(obsId, {
    judge: stubJudge({ action: 'attach', matterId: matter.id, effect: 'resolve', confidence: 0.7 }, calls),
  });
  assert.equal(out.result, 'attach:no_change:no_status_change');
  assert.equal(ms.getMatterById(matter.id)!.status, 'open', '中置信不得改状态');
});

// ---- 门槛与让路 ----

test('create 类观察跳过（创建语义归 commitment 路径）', async () => {
  const unit = mkUnit('event', '新事项苗头');
  const obsId = mkObs({ title: '新事项苗头', lifecycle: 'create', unitIds: [unit.id] });
  const calls = { count: 0 };
  const out = await consumeMatterObservation(obsId, { judge: stubJudge({}, calls) });
  assert.equal(out.result, 'skip:effect=create');
  assert.equal(calls.count, 0, '不应触发 LLM 判定');
  assert.ok(getMatterObservationRow(obsId)!.consumed_at);
});

test('低置信观察跳过', async () => {
  const unit = mkUnit('event', '低置信进展');
  const obsId = mkObs({ title: '低置信进展', confidence: 0.4, unitIds: [unit.id] });
  const calls = { count: 0 };
  const out = await consumeMatterObservation(obsId, { judge: stubJudge({}, calls) });
  assert.match(out.result, /^skip:low_confidence/);
  assert.equal(calls.count, 0);
});

test('event 已产出 HANDLED_KINDS 语义单元 → 让路给 reducer hook', async () => {
  const evUnit = mkUnit('event', '某次对话');
  const cmUnit = mkUnit('commitment', '我承诺周五交付');
  const obsId = mkObs({ title: '我承诺周五交付', unitIds: [evUnit.id, cmUnit.id] });
  const calls = { count: 0 };
  const out = await consumeMatterObservation(obsId, { judge: stubJudge({}, calls) });
  assert.equal(out.result, 'delegated_to_reducer');
  assert.equal(calls.count, 0);
});

test('无关联 unit → 跳过', async () => {
  const obsId = mkObs({ title: '凭空观察', unitIds: [] });
  const out = await consumeMatterObservation(obsId, { judge: stubJudge({}, { count: 0 }) });
  assert.equal(out.result, 'skip:no_context_unit');
});

test('无候选（标题无关 + 无实体重叠）→ 跳过且零 LLM 调用', async () => {
  mkMatter('某个毫不相干的事项ABC');
  const unit = mkUnit('event', 'qwertyuiop');
  const obsId = mkObs({ title: 'zzzz完全无关观察9876', unitIds: [unit.id] });
  const calls = { count: 0 };
  const out = await consumeMatterObservation(obsId, { judge: stubJudge({}, calls) });
  assert.equal(out.result, 'skip:no_candidates');
  assert.equal(calls.count, 0);
});

// ---- 幂等与补扫 ----

test('重复消费 → already_consumed 直接跳过', async () => {
  const unit = mkUnit('event', '幂等检查对象');
  const obsId = mkObs({ title: '幂等检查对象', lifecycle: 'create', unitIds: [unit.id] });
  await consumeMatterObservation(obsId, { judge: stubJudge({}, { count: 0 }) });
  const out = await consumeMatterObservation(obsId, { judge: stubJudge({}, { count: 0 }) });
  assert.equal(out.result, 'already_consumed');
});

test('judge 瞬时失败 → 不销账（pending_retry），补扫用好 judge 重试成功', async () => {
  const matter = mkMatter('补扫重试目标事项');
  const unit = mkUnit('state', '补扫重试目标事项 推进中');
  const obsId = mkObs({ title: '补扫重试目标事项', unitIds: [unit.id] });

  const out1 = await consumeMatterObservation(obsId, {
    judge: async () => {
      throw new Error('provider timeout');
    },
  });
  assert.equal(out1.result, 'pending_retry');
  assert.equal(getMatterObservationRow(obsId)!.consumed_at, null, '失败不得销账');

  // 启动补扫：未消费观察被捞起，用可用 judge 消费成功
  const calls = { count: 0 };
  const rec = await recoverUnconsumedObservations({
    judge: stubJudge({ action: 'attach', matterId: matter.id, effect: 'progress', confidence: 0.9 }, calls),
  });
  assert.ok(rec.scanned >= 1);
  assert.ok(getMatterObservationRow(obsId)!.consumed_at, '补扫后应销账');
  assert.equal(ms.getMatterById(matter.id)!.status, 'in_progress');
});

// ---- 纯函数 ----

test('recallByTitle：相似标题召回、无关标题不召回', () => {
  const a = mkMatter('提交三个专利交底书');
  const hitList = recallByTitle('提交三个专利', [a]);
  assert.equal(hitList.length, 1);
  const missList = recallByTitle('完全无关的另一件事xyz', [a]);
  assert.equal(missList.length, 0);
});
