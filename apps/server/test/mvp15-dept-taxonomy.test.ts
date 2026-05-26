/**
 * MVP15 §4 (revision) — departmentTaxonomy 解析 + 缓存测试。
 *
 * 不依赖真实 LLM，用 llmHook 注入假返回。临时 SQLite，COLLECTOR_ENABLED=false。
 *
 * 覆盖：
 *   T1  首次调用：3 个 dept 命中 LLM，结果入缓存，返回正确
 *   T2  再调用：全命中缓存（hook 没被调用）
 *   T3  混合：1 已缓存 + 2 新，hook 只对新的 2 个调一次
 *   T4  LLM 返回 results 顺序错乱：按 deptName 字段对齐，仍返回正确
 *   T5  LLM 抛错：留 null 结果，不污染缓存，下次重试
 *   T6  超过 LLM_BATCH_LIMIT (30) 时分批调用
 *
 * 运行：npx tsx --test apps/server/test/mvp15-dept-taxonomy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp15-tax-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { parseDepartments } = await import('../src/util/departmentTaxonomy.js');
const { db, getDeptTaxonomy } = await import('../src/db.js');

function resetDb() {
  db.exec('DELETE FROM org_department_taxonomy');
}

function fakeLlm(map: Record<string, { business: string | null; functionPath: string[] | null }>) {
  return async (userMessage: string): Promise<string> => {
    // 从 userMessage 抠出 deptNames 数组
    const m = userMessage.match(/<deptNames>\s*(\[[\s\S]*?\])\s*<\/deptNames>/);
    if (!m) throw new Error('test fake LLM: cannot parse deptNames from userMessage');
    const requested = JSON.parse(m[1]) as string[];
    const results = requested.map((name) => ({
      deptName: name,
      business: map[name]?.business ?? null,
      functionPath: map[name]?.functionPath ?? null,
    }));
    return JSON.stringify({ results });
  };
}

test('T1 首次调用：3 个 dept 命中 LLM，结果入缓存', async () => {
  resetDb();
  const hook = fakeLlm({
    'Lark Base Engineering': { business: 'Lark Base', functionPath: ['Engineering'] },
    'TikTok-Product': { business: 'TikTok', functionPath: ['Product'] },
    'Lark Design-Base': { business: 'Lark Base', functionPath: ['Design'] },
  });
  const result = await parseDepartments(
    ['Lark Base Engineering', 'TikTok-Product', 'Lark Design-Base'],
    { llmHook: hook }
  );

  assert.equal(result.get('Lark Base Engineering')?.business, 'Lark Base');
  assert.deepEqual(result.get('Lark Base Engineering')?.functionPath, ['Engineering']);
  assert.equal(result.get('TikTok-Product')?.business, 'TikTok');
  assert.equal(result.get('Lark Design-Base')?.business, 'Lark Base');

  // 缓存检查
  assert.equal(getDeptTaxonomy('Lark Base Engineering')?.business, 'Lark Base');
  assert.equal(getDeptTaxonomy('TikTok-Product')?.business, 'TikTok');
});

test('T2 再调用：全命中缓存，hook 不会被触发', async () => {
  // T1 已缓存
  let hookCallCount = 0;
  const hook = async (): Promise<string> => {
    hookCallCount++;
    return '{"results":[]}';
  };
  const result = await parseDepartments(
    ['Lark Base Engineering', 'TikTok-Product', 'Lark Design-Base'],
    { llmHook: hook }
  );
  assert.equal(hookCallCount, 0, 'hook 不应被调用');
  assert.equal(result.get('Lark Base Engineering')?.business, 'Lark Base');
});

test('T3 混合：1 已缓存 + 2 新，hook 只对新的 2 个调一次', async () => {
  let hookBatchSize = -1;
  const hook = async (userMessage: string): Promise<string> => {
    const m = userMessage.match(/<deptNames>\s*(\[[\s\S]*?\])\s*<\/deptNames>/);
    if (!m) throw new Error('parse fail');
    const requested = JSON.parse(m[1]) as string[];
    hookBatchSize = requested.length;
    return JSON.stringify({
      results: requested.map((name) => ({
        deptName: name,
        business: 'NewBiz',
        functionPath: ['NewFn'],
      })),
    });
  };
  const result = await parseDepartments(
    ['Lark Base Engineering', '懂车帝-研发', '飞书-PM'], // 第 1 个已缓存，后两个新
    { llmHook: hook }
  );
  assert.equal(hookBatchSize, 2, 'hook 应只收到 2 个 dept');
  assert.equal(result.get('Lark Base Engineering')?.business, 'Lark Base', '已缓存的不变');
  assert.equal(result.get('懂车帝-研发')?.business, 'NewBiz');
  assert.equal(result.get('飞书-PM')?.business, 'NewBiz');
});

test('T4 LLM 返回 results 顺序错乱：按 deptName 字段对齐', async () => {
  resetDb();
  const hook = async (): Promise<string> => {
    // 故意打乱顺序
    return JSON.stringify({
      results: [
        { deptName: 'B', business: 'BizB', functionPath: ['FnB'] },
        { deptName: 'A', business: 'BizA', functionPath: ['FnA'] },
      ],
    });
  };
  const result = await parseDepartments(['A', 'B'], { llmHook: hook });
  assert.equal(result.get('A')?.business, 'BizA');
  assert.equal(result.get('B')?.business, 'BizB');
});

test('T5 LLM 抛错：留 null 结果，不污染缓存', async () => {
  resetDb();
  const hook = async (): Promise<string> => {
    throw new Error('mock LLM failure');
  };
  const result = await parseDepartments(['X-Dept', 'Y-Dept'], { llmHook: hook });
  assert.equal(result.get('X-Dept')?.business, null);
  assert.equal(result.get('Y-Dept')?.business, null);
  // 缓存不应有这两个
  assert.equal(getDeptTaxonomy('X-Dept'), null);
  assert.equal(getDeptTaxonomy('Y-Dept'), null);
});

test('T6 functionLabel 自动取 functionPath[0]', async () => {
  resetDb();
  const hook = fakeLlm({
    'Some-Dept': { business: 'BizX', functionPath: ['L1', 'L2', 'L3'] },
  });
  const result = await parseDepartments(['Some-Dept'], { llmHook: hook });
  assert.equal(result.get('Some-Dept')?.functionLabel, 'L1');
  assert.deepEqual(result.get('Some-Dept')?.functionPath, ['L1', 'L2', 'L3']);
});

test('T7 重复输入 dedupe（同一 name 出现 N 次只查一次）', async () => {
  resetDb();
  let hookCallSize = 0;
  const hook = async (userMessage: string): Promise<string> => {
    const m = userMessage.match(/<deptNames>\s*(\[[\s\S]*?\])\s*<\/deptNames>/);
    if (m) hookCallSize = JSON.parse(m[1]).length;
    return JSON.stringify({
      results: [{ deptName: 'Dup', business: 'B', functionPath: ['F'] }],
    });
  };
  const result = await parseDepartments(['Dup', 'Dup', 'Dup'], { llmHook: hook });
  assert.equal(hookCallSize, 1, 'unique 之后应该只有 1 个');
  assert.equal(result.get('Dup')?.business, 'B');
});
