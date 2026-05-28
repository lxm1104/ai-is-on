/**
 * MVP20 §M4 (PR2)：attentionPrompt 行尾 [role=...] 标签渲染测试。
 *
 * PR2 只验证标签暴露，不验证铁律行为（铁律 13 在 PR3）。
 *
 * 运行：npx tsx --test apps/server/test/mvp20-prompt-role-tag.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp20-prompt-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { assembleGlobalContextPacket } = await import(
  '../src/context/agentContextAssembler.js'
);
const { buildAttentionUserMessage } = await import(
  '../src/attention/attentionPrompt.js'
);

function resetDb() {
  db.db.exec(`
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM context_entities;
    DELETE FROM entity_aliases;
    DELETE FROM settings WHERE key='self_person_entity_id';
  `);
}

function mkEntity(type: string, name: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insertContextEntity({
    id, type, name,
    aliases_json: null, source: null, confidence: 0.8,
    created_at: now, updated_at: now,
    attributes_json: null,
  });
  return id;
}

function mkCommitment(opts: {
  title: string;
  entities: Array<{ entityId: string; role: string }>;
  dueOffsetMs?: number;
}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const dueAt =
    opts.dueOffsetMs !== undefined
      ? new Date(Date.now() + opts.dueOffsetMs).toISOString()
      : null;
  const timeJson = dueAt ? JSON.stringify({ dueAt }) : null;
  db.db
    .prepare(
      `INSERT INTO context_units
       (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
        actionability, confidence, version, status, created_at, updated_at, time_json)
       VALUES (?, 'me', 'work', 'manual', 'test', 'commitment', ?, '',
               'record', 0.9, 1, 'active', ?, ?, ?)`
    )
    .run(id, opts.title, now, now, timeJson);
  for (const e of opts.entities) {
    db.db
      .prepare(
        `INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence)
         VALUES (?, ?, ?, 1.0)`
      )
      .run(id, e.entityId, e.role);
  }
  return id;
}

// ============================================================================

test('attention prompt 行尾包含 [role=requester] 等标签', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const otherId = mkEntity('person', '张三');

  const uReq = mkCommitment({
    title: '张三答应我做 2 条文案',
    entities: [
      { entityId: otherId, role: 'actor' },
      { entityId: selfId, role: 'target' },
    ],
    dueOffsetMs: 24 * 3600_000,
  });
  const uExec = mkCommitment({
    title: '我答应张三周三补方案',
    entities: [
      { entityId: selfId, role: 'actor' },
      { entityId: otherId, role: 'target' },
    ],
    dueOffsetMs: 24 * 3600_000,
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const prompt = buildAttentionUserMessage(packet);

  // commitments 块里两条 unit 的行都应有 role 标签
  assert.match(
    prompt,
    new RegExp(`\\[${uReq}\\][\\s\\S]*\\[role=requester\\]`),
    'requester case 应有 [role=requester] 标签'
  );
  assert.match(
    prompt,
    new RegExp(`\\[${uExec}\\][\\s\\S]*\\[role=executor\\]`),
    'executor case 应有 [role=executor] 标签'
  );
});

test('attention prompt 对 selfRoleOnUnit=null 的 commitment 不输出 [role=...]', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const a = mkEntity('person', '张三');
  const b = mkEntity('person', '李四');
  const uid = mkCommitment({
    title: '张三和李四的事跟我无关',
    entities: [
      { entityId: a, role: 'actor' },
      { entityId: b, role: 'target' },
    ],
    dueOffsetMs: 24 * 3600_000,
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const prompt = buildAttentionUserMessage(packet);

  // 这条 commitment 行尾不应有 [role=...]
  const lineRe = new RegExp(`^- \\[${uid}\\][^\\n]*$`, 'm');
  const match = prompt.match(lineRe);
  assert.ok(match, '应能找到该 commitment 的渲染行');
  assert.doesNotMatch(
    match![0],
    /\[role=/,
    'selfRoleOnUnit=null 时不应输出 [role=...] 标签'
  );
});

test('B 路兜底——name=\'我\' entity 也能触发行尾标签', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const woEntity = mkEntity('person', '我');

  const uid = mkCommitment({
    title: 'IM 双向消息：我答应了',
    entities: [{ entityId: woEntity, role: 'actor' }],
    dueOffsetMs: 24 * 3600_000,
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const prompt = buildAttentionUserMessage(packet);

  assert.match(
    prompt,
    new RegExp(`\\[${uid}\\][\\s\\S]*\\[role=executor\\]`),
    'B 路兜底命中也应输出 [role=executor]'
  );
});

test('goal / uncertainty 行尾不输出 [role=...]（MVP20 范围限定）', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const otherId = mkEntity('person', '张三');

  const now = new Date().toISOString();
  // goal: self=target
  const gid = randomUUID();
  db.db.prepare(
    `INSERT INTO context_units
     (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
      actionability, confidence, version, status, created_at, updated_at)
     VALUES (?, 'me', 'work', 'manual', 'test', 'goal', ?, '', 'record', 0.9, 1,
             'active', ?, ?)`
  ).run(gid, 'goal-target-self', now, now);
  db.db.prepare(
    `INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence)
     VALUES (?, ?, ?, 1.0)`
  ).run(gid, selfId, 'target');
  // uncertainty: self=actor
  const uid = randomUUID();
  db.db.prepare(
    `INSERT INTO context_units
     (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
      actionability, confidence, version, status, created_at, updated_at)
     VALUES (?, 'me', 'work', 'manual', 'test', 'uncertainty', ?, '', 'record', 0.9, 1,
             'active', ?, ?)`
  ).run(uid, 'uncertainty-actor-self', now, now);
  db.db.prepare(
    `INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence)
     VALUES (?, ?, ?, 1.0)`
  ).run(uid, selfId, 'actor');

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const prompt = buildAttentionUserMessage(packet);

  // 这两条都不该有 [role=...]
  for (const id of [gid, uid]) {
    const lineRe = new RegExp(`^- \\[${id}\\][^\\n]*$`, 'm');
    const match = prompt.match(lineRe);
    assert.ok(match, `应能找到 ${id} 的渲染行`);
    assert.doesNotMatch(
      match![0],
      /\[role=/,
      `goal/uncertainty 不应输出 [role=...]，但 ${id} 行包含了`
    );
  }
});

test('行尾 [role=...] 出现在 entities {...} 和 meaning 之后（顺序稳定）', () => {
  resetDb();
  const selfId = mkEntity('person', '刘昕明');
  db.setSetting('self_person_entity_id', selfId);
  const projectId = mkEntity('project', 'Base UX');

  const uid = mkCommitment({
    title: '测试顺序',
    entities: [
      { entityId: selfId, role: 'actor' },
      { entityId: projectId, role: 'about' },
    ],
    dueOffsetMs: 24 * 3600_000,
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  const prompt = buildAttentionUserMessage(packet);
  const lineRe = new RegExp(`^- \\[${uid}\\][^\\n]*$`, 'm');
  const line = prompt.match(lineRe)![0];

  // entities 块（{...}）和 [role=...] 标签都应出现，且后者在行尾
  const entitiesIdx = line.indexOf('project:Base UX');
  const roleIdx = line.indexOf('[role=executor]');
  assert.ok(entitiesIdx >= 0, `entities 应包含 project:Base UX，实际行: "${line}"`);
  assert.ok(roleIdx >= 0, `[role=executor] 标签应存在，实际行: "${line}"`);
  assert.ok(entitiesIdx < roleIdx, '[role=...] 应在 entities 之后');
  // MVP21 S1：取消"必须以 [role=...] 结尾"的死锁——MVP21 在其后追加了 [src=...] 标签。
  // 真实约束是"role 出现在 entities 之后"，已由 entitiesIdx < roleIdx 覆盖。
});
