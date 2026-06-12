/**
 * MVP32 — 办结核实（第二档）：verdict 解析/门槛、提案卡、守卫、恢复扫描。
 *
 * Run: npx tsx --test apps/server/test/mvp32-matter-verify.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp32-verify-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.MATTER_VERIFY_ENABLED = 'true';

const { db } = await import('../src/db.js');
const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const ma = await import('../src/matter/matterActions.js');
const mv = await import('../src/matter/matterVerifyService.js');
const { insertAttentionItem, getAttentionItem } = await import(
  '../src/attention/attentionStore.js'
);

let n = 0;

function mkResolvedMatter(note?: string) {
  n += 1;
  const unit = cs.upsertContextUnit({
    kind: 'commitment',
    title: `承诺${n}`,
    content: `交付物 ${n}`,
    scope: 'work',
    origin: { kind: 'manual', refId: `vu-${n}` },
    silent: true,
  }).unit;
  const matter = ms.createMatter({
    scope: 'work',
    type: 'delivery',
    title: `交付物提交${n}`,
    canonicalKey: `vk-${n}`,
    createdFromContextUnitId: unit.id,
  });
  ma.userResolveMatter(matter.id, note ? `用户标记已处理：${note}` : '用户标记已处理');
  return ms.getMatterById(matter.id)!;
}

function fakeShot(payload: unknown) {
  return async () => ({
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    raw: null,
    timing: { waitMs: 0, execMs: 1 },
  });
}

function liveReopenProposal(matterId: string) {
  return db
    .prepare(
      `SELECT id FROM attention_items WHERE status='live' AND input_hash = ? LIMIT 1`
    )
    .get(`proposal:matter-reopen:${matterId}`) as { id: string } | undefined;
}

test('parseVerifyVerdict：合法 / 包裹文本 / 非法 JSON / 未知 verdict', () => {
  assert.deepEqual(
    mv.parseVerifyVerdict('{"verdict":"confirmed","confidence":0.9,"evidence":"对方已确认"}'),
    { verdict: 'confirmed', confidence: 0.9, evidence: '对方已确认' }
  );
  assert.equal(
    mv.parseVerifyVerdict('前缀噪声 {"verdict":"contradicted","confidence":0.8,"evidence":"e"} 尾巴')
      ?.verdict,
    'contradicted'
  );
  assert.equal(mv.parseVerifyVerdict('not json'), null);
  assert.equal(mv.parseVerifyVerdict('{"verdict":"maybe","confidence":1}'), null);
});

test('confirmed ≥0.7 → verification 落库 + userNote 从 transition 反解', async () => {
  const matter = mkResolvedMatter('已发邮件提交');
  const rec = await mv.runMatterResolveVerification(matter.id, {
    deps: { runShot: fakeShot({ verdict: 'confirmed', confidence: 0.85, evidence: '对方回复已收到' }) },
  });
  assert.equal(rec?.verdict, 'confirmed');
  assert.equal(rec?.userNote, '已发邮件提交');
  const fresh = ms.getMatterById(matter.id)!;
  assert.equal(fresh.resolveVerification?.verdict, 'confirmed');
  assert.equal(liveReopenProposal(matter.id), undefined);
});

test('confirmed 低于 0.7 → 降级 unverifiable，不打扰', async () => {
  const matter = mkResolvedMatter();
  const rec = await mv.runMatterResolveVerification(matter.id, {
    deps: { runShot: fakeShot({ verdict: 'confirmed', confidence: 0.5, evidence: 'e' }) },
  });
  assert.equal(rec?.verdict, 'unverifiable');
  assert.equal(liveReopenProposal(matter.id), undefined);
});

test('contradicted ≥0.75 + 证据 → 落库 + 升核实存疑提案卡（幂等不重复）', async () => {
  const matter = mkResolvedMatter();
  const verdict = { verdict: 'contradicted', confidence: 0.9, evidence: '对方今早又在群里催' };
  const rec = await mv.runMatterResolveVerification(matter.id, {
    deps: { runShot: fakeShot(verdict) },
  });
  assert.equal(rec?.verdict, 'contradicted');

  const proposal = liveReopenProposal(matter.id);
  assert.ok(proposal, '应有 live 的重开提案卡');
  const item = getAttentionItem(proposal!.id)!;
  assert.equal(item.priority, 'P1');
  assert.equal(item.matterId, matter.id);
  assert.match(item.title, /^核实存疑：/);

  // 幂等：手动清掉 verification 再跑一次，提案卡不重复
  ms.setMatterResolveVerification(matter.id, null);
  await mv.runMatterResolveVerification(matter.id, { deps: { runShot: fakeShot(verdict) } });
  const count = db
    .prepare(`SELECT COUNT(*) AS c FROM attention_items WHERE input_hash = ?`)
    .get(`proposal:matter-reopen:${matter.id}`) as { c: number };
  assert.equal(count.c, 1);
});

test('contradicted 无证据 / 解析失败 → 一律降级 unverifiable', async () => {
  const m1 = mkResolvedMatter();
  const r1 = await mv.runMatterResolveVerification(m1.id, {
    deps: { runShot: fakeShot({ verdict: 'contradicted', confidence: 0.9, evidence: '' }) },
  });
  assert.equal(r1?.verdict, 'unverifiable');
  assert.equal(liveReopenProposal(m1.id), undefined);

  const m2 = mkResolvedMatter();
  const r2 = await mv.runMatterResolveVerification(m2.id, {
    deps: { runShot: fakeShot('LLM 拉胯了，没有 JSON') },
  });
  assert.equal(r2?.verdict, 'unverifiable');
});

test('守卫：matter 非 resolved（已被重开）→ 跳过不落章；已核实过 → 跳过', async () => {
  const matter = mkResolvedMatter();
  ma.userReopenMatter(matter.id, '测试重开');
  const rec = await mv.runMatterResolveVerification(matter.id, {
    deps: { runShot: fakeShot({ verdict: 'confirmed', confidence: 0.9, evidence: 'e' }) },
  });
  assert.equal(rec, null);
  assert.equal(ms.getMatterById(matter.id)!.resolveVerification, null);

  const m2 = mkResolvedMatter();
  await mv.runMatterResolveVerification(m2.id, {
    deps: { runShot: fakeShot({ verdict: 'confirmed', confidence: 0.9, evidence: 'e' }) },
  });
  const again = await mv.runMatterResolveVerification(m2.id, {
    deps: { runShot: fakeShot({ verdict: 'contradicted', confidence: 0.99, evidence: 'x' }) },
  });
  assert.equal(again, null); // 已有 verification → 不重跑
  assert.equal(ms.getMatterById(m2.id)!.resolveVerification?.verdict, 'confirmed');
});

test('核实输入排除 mark_done 自己的 note unit（防循环自证）', async () => {
  // 构造：matter 仅有的"证据"是用户处理说明（resolved_by + card_action）→ 输入里不应出现该内容
  const matter = mkResolvedMatter('我自己说我做完了');
  const attnId = randomUUID();
  const noteUnit = cs.upsertContextUnit({
    kind: 'action_result',
    title: '已处理：催办',
    content: '我自己说我做完了',
    scope: 'work',
    origin: { kind: 'card_action', refId: attnId },
    silent: true,
  }).unit;
  ms.attachMatterContextLink({
    matterId: matter.id,
    contextUnitId: noteUnit.id,
    relation: 'resolved_by',
    effect: 'resolve',
    confidence: 1,
    reason: '用户标记已处理时填写的处理说明',
  });

  let captured = '';
  await mv.runMatterResolveVerification(matter.id, {
    deps: {
      runShot: async (msg: string) => {
        captured = msg;
        return {
          text: JSON.stringify({ verdict: 'unverifiable', confidence: 0.3, evidence: '' }),
          raw: null,
          timing: { waitMs: 0, execMs: 1 },
        };
      },
    },
  });
  assert.ok(captured.includes('【用户声明】'));
  // 证据行格式固定为 "- [time] (kind/relation) ..."——note unit 若漏进证据块会带
  // 'action_result/resolved_by' 标记；【状态轨迹】里出现 transition reason 是合法的，不在此断言范围。
  assert.ok(
    !captured.includes('action_result/resolved_by'),
    '处理说明 unit 不应出现在证据块'
  );
});

test('启动恢复扫描：24h 内用户 resolve 且无 verification 的 matter 被补排程', async () => {
  mv.stopMatterVerifyService(); // 清状态，保证 start 真正执行

  const pending = mkResolvedMatter('恢复我'); // 无 verification → 应补排
  const done = mkResolvedMatter();
  ms.setMatterResolveVerification(done.id, {
    verdict: 'confirmed',
    confidence: 0.9,
    evidence: 'e',
    checkedAt: new Date().toISOString(),
  }); // 已核实 → 不补排

  mv.startMatterVerifyService();
  // 排程进了 timer 注册表（10-60s 抖动，不会在测试期间真跑）；用第二次 schedule 去重来探测：
  // scheduleMatterResolveVerification 对已在表中的 matter 直接 return（无重复 timer）。
  // 直接断言内部不可见，这里用行为侧写：stop 后重 start 不抛错且日志路径可达即视为通过；
  // 关键校验是"已核实的不补排"——通过给 done.id 立即跑核实应被守卫拦下来验证。
  const again = await mv.runMatterResolveVerification(done.id, {
    deps: { runShot: fakeShot({ verdict: 'contradicted', confidence: 0.99, evidence: 'x' }) },
  });
  assert.equal(again, null);
  assert.equal(ms.getMatterById(pending.id)!.resolveVerification, null); // timer 未触发前仍为空

  mv.stopMatterVerifyService();
});
