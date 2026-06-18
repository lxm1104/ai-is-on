/**
 * MVP71 — 确定性「需要你」分类器：稳健 self 身份集 + isSelfCommitment + isNamedOtherPerson + deriveNeedFromUser。
 * 重点覆盖红队发现：S1 身份取 larkLocalizedName(不是占位 name)+openid 防撞名；S2 owned_by_other ≤2 人 + self 是 requester。
 *
 * Run: npx tsx --test apps/server/test/mvp71-needhelp-classifier.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp71c-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const clf = await import('../src/investigation/needHelpClassifier.js');

const SELF_OPENID = 'ou_157fad6e865f0205225d79f93ddf5b5e';
function mkPerson(name: string, attrs?: Record<string, unknown>): string {
  const id = 'e-' + randomUUID();
  const now = new Date().toISOString();
  db.insertContextEntity({
    id, type: 'person', name, aliases_json: '[]', source: 'test', confidence: 0.9,
    created_at: now, updated_at: now, attributes_json: attrs ? JSON.stringify(attrs) : null,
  } as any);
  return id;
}

function resetEntities() {
  db.db.exec(`DELETE FROM context_entities; DELETE FROM entity_aliases;`);
  clf.invalidateSelfEntityCache();
}

// ---- getSelfEntityIds（身份碎裂处理 + S1 取数路径）----
// 真实库实情（已核实 UNIQUE(type,name)）：self 实体 name 是占位「用户df5b5e」、真名「刘昕明」只在
// attributes.larkLocalizedName；matter 里执行人写成另一个 name=「刘昕明」(无 openid) / 「我」的实体。
test('MVP71 getSelfEntityIds：经 larkLocalizedName 捞回碎裂的 self（刘昕明/我），不含他人', () => {
  resetEntities();
  const selfId = mkPerson('用户df5b5e', { larkLocalizedName: '刘昕明', larkOpenId: SELF_OPENID });
  const sameName = mkPerson('刘昕明'); // 无 openid 的同名实体（真实 fdfa）→ 应纳入
  const meColloquial = mkPerson('我'); // 口语自指 → 应纳入
  const other = mkPerson('黄炜深');
  db.setSetting('self_person_entity_id', selfId);
  clf.invalidateSelfEntityCache();

  const selfSet = clf.getSelfEntityIds();
  assert.ok(selfSet.has(selfId), '含 self 本体');
  assert.ok(selfSet.has(sameName), '经 larkLocalizedName 捞回 name=刘昕明 的碎裂实体');
  assert.ok(selfSet.has(meColloquial), '含「我」');
  assert.ok(!selfSet.has(other), '不含无关他人');
});

test('MVP71 getSelfEntityIds：openid 防撞名——唯一的同名实体若带不同 openid 则剔除', () => {
  resetEntities();
  const selfId = mkPerson('用户df5b5e', { larkLocalizedName: '刘昕明', larkOpenId: SELF_OPENID });
  const impostor = mkPerson('刘昕明', { larkOpenId: 'ou_someone_else' }); // 同名但 openid 不同 → 真同名他人
  db.setSetting('self_person_entity_id', selfId);
  clf.invalidateSelfEntityCache();

  const selfSet = clf.getSelfEntityIds();
  assert.ok(selfSet.has(selfId));
  assert.ok(!selfSet.has(impostor), '同名但 openid 不同 → 判为他人，剔除');
});

// ---- isSelfCommitmentByTitle（S4 正则收紧）----
test('MVP71 isSelfCommitmentByTitle：（对X承诺）命中；反对/针对/对接…承诺 不误命中', () => {
  assert.equal(clf.isSelfCommitmentByTitle('排查授权超时（对高虎伟承诺）'), true);
  assert.equal(clf.isSelfCommitmentByTitle('修复 bug（对王爽承诺）'), true);
  assert.equal(clf.isSelfCommitmentByTitle('反对降低承诺标准的做法'), false, '反对…承诺 不命中');
  assert.equal(clf.isSelfCommitmentByTitle('针对该承诺的复盘'), false, '针对…承诺 不命中');
  assert.equal(clf.isSelfCommitmentByTitle('对接系统时要兑现承诺'), false, '对接…承诺 不命中');
  assert.equal(clf.isSelfCommitmentByTitle('跟进黄炜深进展'), false, '无承诺括注不命中');
});

// ---- isNamedOtherPerson ----
test('MVP71 isNamedOtherPerson：具名他人=true；self/代词/非人/超长 名=false', () => {
  const selfSet = new Set(['self-1']);
  assert.equal(clf.isNamedOtherPerson({ id: 'p1', name: '黄炜深', type: 'person' }, selfSet), true);
  assert.equal(clf.isNamedOtherPerson({ id: 'self-1', name: '刘昕明', type: 'person' }, selfSet), false, 'self 不算他人');
  assert.equal(clf.isNamedOtherPerson({ id: 'p2', name: '对方', type: 'person' }, selfSet), false, '代词不算具名');
  assert.equal(clf.isNamedOtherPerson({ id: 'p3', name: 'lark_task:abc', type: 'person' }, selfSet), false, '任务id 不算人');
  assert.equal(clf.isNamedOtherPerson({ id: 'p4', name: 'x', type: 'task' }, selfSet), false, '非 person 类型 false');
});

// ---- deriveNeedFromUser（S2：≤2 人 + self 是 requester）----
function ctx(entities: Array<{ id: string; name: string; type: string; role: string }>) {
  return { entities, selfSet: new Set(['ME']) };
}
const unk = { verdict: 'unknown', confidence: 0.6 };

test('MVP71 deriveNeedFromUser：1 具名他人 executor + 我是 requester + conf>0 → owned_by_other', () => {
  const n = clf.deriveNeedFromUser(unk, ctx([
    { id: 'X', name: '黄炜深', type: 'person', role: 'executor' },
    { id: 'ME', name: '我', type: 'person', role: 'requester' },
  ]));
  assert.equal(n?.kind, 'owned_by_other');
  assert.match(n!.ask, /黄炜深/);
});

test('MVP71 deriveNeedFromUser：≥3 具名他人(群事项) → 不升（降噪 S2）', () => {
  const n = clf.deriveNeedFromUser(unk, ctx([
    { id: 'A', name: '何志斌', type: 'person', role: 'executor' },
    { id: 'B', name: '卢俊杰', type: 'person', role: 'executor' },
    { id: 'C', name: '邹晶', type: 'person', role: 'executor' },
    { id: 'ME', name: '我', type: 'person', role: 'requester' },
  ]));
  assert.equal(n, undefined);
});

test('MVP71 deriveNeedFromUser：我不是 requester（纯旁观）→ 不升', () => {
  const n = clf.deriveNeedFromUser(unk, ctx([
    { id: 'X', name: '黄炜深', type: 'person', role: 'executor' },
    { id: 'Y', name: '张三', type: 'person', role: 'requester' },
  ]));
  assert.equal(n, undefined, '不是我委派的不归我催');
});

test('MVP71 deriveNeedFromUser：我也是 executor → 不升（互斥，归 dangling）', () => {
  const n = clf.deriveNeedFromUser(unk, ctx([
    { id: 'X', name: '黄炜深', type: 'person', role: 'executor' },
    { id: 'ME', name: '我', type: 'person', role: 'executor' },
    { id: 'ME', name: '我', type: 'person', role: 'requester' },
  ]));
  assert.equal(n, undefined);
});

test('MVP71 deriveNeedFromUser：conf=0 → 不升（降噪红线）', () => {
  const n = clf.deriveNeedFromUser({ verdict: 'unknown', confidence: 0 }, ctx([
    { id: 'X', name: '黄炜深', type: 'person', role: 'executor' },
    { id: 'ME', name: '我', type: 'person', role: 'requester' },
  ]));
  assert.equal(n, undefined);
});
