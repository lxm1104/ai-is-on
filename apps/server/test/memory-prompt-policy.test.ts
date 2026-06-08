/**
 * Memory prompt policy regression tests.
 *
 * Run: npx tsx --test apps/server/test/memory-prompt-policy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const chatPromptSrc = fs.readFileSync(path.join(serverRoot, 'src/claude/prompts.ts'), 'utf8');
const triagePromptSrc = fs.readFileSync(path.join(serverRoot, 'src/triage/triagePrompt.ts'), 'utf8');

test('chat prompt treats relative memories as narrow runtime-missing work context', () => {
  assert.ok(chatPromptSrc.includes('<relative-memories>'));
  assert.ok(chatPromptSrc.includes('当前运行时拿不到但工作场景必要'));
  assert.ok(chatPromptSrc.includes('不要依靠历史记忆来提高工具调用或任务执行的"成功率"'));
  assert.ok(chatPromptSrc.includes('以当前可验证信息为准'));
});

test('triage prompt forbids turning memory into tool tips or generic profile facts', () => {
  assert.ok(triagePromptSrc.includes('每个信号最多 3 条'));
  assert.ok(triagePromptSrc.includes('工具调用成功率、失败案例、推荐参数'));
  assert.ok(triagePromptSrc.includes('用户泛泛画像或个人生活偏好'));
  assert.ok(triagePromptSrc.includes('不要使用泛化的 memory kind'));
  assert.ok(!triagePromptSrc.includes('数量不设上限'));
});

test('triage user reminder keeps extraction small and work-scoped', () => {
  assert.ok(triagePromptSrc.includes('contextUpdates 最多 3 条'));
  assert.ok(triagePromptSrc.includes('运行时拿不到但工作判断必要'));
});
