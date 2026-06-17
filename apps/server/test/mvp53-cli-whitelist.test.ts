/**
 * MVP53 — 自主排查只读 CLI 白名单「运行时可改」层的安全与正确性测试。
 *
 * 重点：DENY 黑名单是安全的命门（这白名单给无人在环 AI 用）。穷举 shell/解释器/网络/写删类被拒、
 * 用户增删生效、以及 **defense-in-depth**：即便有人直接改库把危险项塞进 settings，getInvestigationReadClis
 * 与 assertSafeCommand 仍兜底过滤、绝不放行。每个用例自行快照 + 还原 settings 行，不污染 dev DB。
 *
 * Run: npx tsx --test apps/server/test/mvp53-cli-whitelist.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSetting, setSetting } from '../src/db.js';
import {
  RUN_CLIS_SETTING_KEY,
  getInvestigationReadClis,
  setInvestigationReadClis,
  resetInvestigationReadClis,
  validateCli,
  classifyCli,
  describeReadClis,
} from '../src/investigation/readClisSettings.js';
import { assertSafeCommand } from '../src/investigation/runCommand.js';

// **每个**用例前快照真实 settings 值、用例后还原 —— 哪怕用例不改它，也保证跑测试不会
// 误删/覆盖用户已自定义的白名单（beforeEach 自动 snap，避免漏 snap 导致 afterEach 写空）。
let snapshot: string | null = null;
beforeEach(() => {
  snapshot = getSetting(RUN_CLIS_SETTING_KEY);
});
afterEach(() => {
  // 还原成快照值（null = 删不掉，置 '' 等价"未设定→默认"，与 reset 语义一致）。
  setSetting(RUN_CLIS_SETTING_KEY, snapshot ?? '');
  snapshot = null;
});

// ---- validateCli：格式 + DENY 黑名单 ----

test('V1 危险类命令一律被 validateCli 拒（shell/解释器/网络/写删/exec包装）', () => {
  for (const bad of ['bash', 'sh', 'zsh', 'python', 'python3', 'node', 'ruby', 'perl', 'awk', 'sed',
    'curl', 'wget', 'nc', 'ssh', 'scp', 'rm', 'mv', 'cp', 'dd', 'tee', 'chmod', 'tar', 'env', 'xargs',
    'sudo', 'make', 'npm', 'npx', 'pip', 'docker', 'kubectl', 'vim', 'less', 'lark-cli',
    // exec/改写类"类只读"工具也拒（fd -x / sd / ast-grep / ugrep --pre 等）
    'fd', 'fdfind', 'sd', 'sad', 'ugrep', 'comby', 'ast-grep', 'sg']) {
    assert.ok(validateCli(bad) !== null, `${bad} 必须被拒`);
  }
  // 大小写无关
  assert.ok(validateCli('BASH') !== null);
  assert.ok(validateCli('Python3') !== null);
  assert.ok(validateCli('FD') !== null);
});

test('V2 格式非法被拒：路径分隔符 / 空白 / 控制字符 / 空 / 过长', () => {
  assert.ok(validateCli('/bin/ls') !== null);
  assert.ok(validateCli('a/b') !== null);
  assert.ok(validateCli('foo bar') !== null);
  assert.ok(validateCli('a\tb') !== null);
  assert.ok(validateCli('a\x00b') !== null);
  assert.ok(validateCli('') !== null);
  assert.ok(validateCli('   ') !== null);
  assert.ok(validateCli('x'.repeat(65)) !== null);
});

test('V3 合法只读 CLI 放行', () => {
  for (const ok of ['git', 'fornax-cli', 'bytedcli', 'rg', 'grep', 'cat', 'jq', 'tokei', 'gron']) {
    assert.equal(validateCli(ok), null, `${ok} 应放行`);
  }
});

test('V4 classifyCli 分级正确（sort/uniq 不再算 readonly → custom）', () => {
  assert.equal(classifyCli('git'), 'guarded');
  assert.equal(classifyCli('bytedcli'), 'guarded');
  assert.equal(classifyCli('cat'), 'readonly');
  assert.equal(classifyCli('jq'), 'readonly');
  assert.equal(classifyCli('tokei'), 'custom');
  assert.equal(classifyCli('sort'), 'custom'); // 能 -o 写盘，不再误标 readonly
  assert.equal(classifyCli('uniq'), 'custom');
});

// ---- set / get / reset ----

test('S1 set 拒绝危险项（整批回滚，不落库）', () => {
  assert.throws(() => setInvestigationReadClis(['git', 'bash']), /shell|禁止|拒/);
  // 抛错后不应有部分写入：仍是默认
  assert.ok(getInvestigationReadClis().includes('git'));
});

test('S2 set 去重 + 持久化 + get 读回', () => {
  const saved = setInvestigationReadClis(['git', 'rg', 'git', 'cat']);
  assert.deepEqual(saved, ['git', 'rg', 'cat']); // 去重保序
  assert.deepEqual(getInvestigationReadClis(), ['git', 'rg', 'cat']);
});

test('S3 未设定时回落 config 默认（含 bytedcli）', () => {
  resetInvestigationReadClis();
  const def = getInvestigationReadClis();
  assert.ok(def.includes('git') && def.includes('fornax-cli') && def.includes('bytedcli'));
});

test('S4 用户加自定义只读 CLI 生效', () => {
  setInvestigationReadClis(['git', 'tokei']);
  assert.deepEqual(getInvestigationReadClis(), ['git', 'tokei']);
  const d = describeReadClis();
  assert.ok(d.entries.some((e) => e.cli === 'tokei' && e.risk === 'custom'));
  assert.equal(d.customized, true);
  assert.equal(d.runCommandEnabled, true);
});

// ---- defense-in-depth：直接改库塞危险项也兜底过滤 ----

test('DEF-1 直接往 settings 塞 bash/curl，getInvestigationReadClis 兜底过滤掉', () => {
  setSetting(RUN_CLIS_SETTING_KEY, JSON.stringify(['git', 'bash', 'curl', 'rg', '/bin/sh']));
  const eff = getInvestigationReadClis();
  assert.ok(eff.includes('git') && eff.includes('rg'));
  assert.ok(!eff.includes('bash') && !eff.includes('curl') && !eff.includes('/bin/sh'), '危险项绝不进有效白名单');
});

test('DEF-2 坏 JSON / 非数组 → 回落默认，不崩', () => {
  setSetting(RUN_CLIS_SETTING_KEY, '{not json');
  assert.ok(getInvestigationReadClis().includes('git'));
  setSetting(RUN_CLIS_SETTING_KEY, JSON.stringify({ foo: 1 }));
  assert.ok(getInvestigationReadClis().includes('git'));
});

// ---- 与 assertSafeCommand 的端到端：白名单运行时生效 + 危险项永不放行 ----

test('E2E-1 用户改白名单 → assertSafeCommand 随之生效', () => {
  setInvestigationReadClis(['git']); // 只留 git
  assert.doesNotThrow(() => assertSafeCommand('git', ['log', '-1']));
  assert.throws(() => assertSafeCommand('rg', ['x', '.']), /白名单|拒绝/); // rg 被移除 → 拒
});

test('E2E-2 即便危险项被强塞进 settings，assertSafeCommand 仍拒（兜底过滤后不在有效表）', () => {
  setSetting(RUN_CLIS_SETTING_KEY, JSON.stringify(['git', 'bash', 'python3']));
  assert.doesNotThrow(() => assertSafeCommand('git', ['log', '-1']));
  assert.throws(() => assertSafeCommand('bash', ['-c', 'rm -rf /']), /白名单|拒绝/);
  assert.throws(() => assertSafeCommand('python3', ['-c', 'print(1)']), /白名单|拒绝/);
});

// ---- 加固：大小写规整 + 通用 exec/预处理器 flag 兜底 + fd 类 RCE ----

test('H1 名称规整为小写：set/get/describe 一致，去大小写绕过面', () => {
  const saved = setInvestigationReadClis(['GIT', 'Cat', 'git']);
  assert.deepEqual(saved, ['git', 'cat']); // 小写 + 去重
  assert.deepEqual(getInvestigationReadClis(), ['git', 'cat']);
});

test('H2 大小写不能绕过专项护栏（GIT 强塞进 settings 也 → guardGit 命中/或不在小写白名单）', () => {
  setSetting(RUN_CLIS_SETTING_KEY, JSON.stringify(['GIT']));
  const eff = getInvestigationReadClis();
  assert.deepEqual(eff, ['git']); // 读出即小写
  assert.throws(() => assertSafeCommand('GIT', ['push']), /白名单|拒绝/); // 大写 cmd 不在小写白名单 → 拒
  assert.throws(() => assertSafeCommand('git', ['push']), /只读子命令|拒绝/); // 小写仍走 guardGit
});

test('H3 通用 exec/预处理器 flag 对所有 CLI（含默认只读项）一律拒', () => {
  resetInvestigationReadClis(); // 默认白名单含 cat/grep/git
  assert.throws(() => assertSafeCommand('cat', ['--exec', 'rm']), /危险参数|拒绝/);
  assert.throws(() => assertSafeCommand('grep', ['--pre', '/tmp/evil.sh', 'x', '.']), /危险参数|预处理器|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['log', '--exec-batch', 'x']), /危险参数|拒绝/);
});

test('H4 fd 类 exec 工具进不了白名单（堵 fd -x RCE）', () => {
  // 保存被拒
  assert.throws(() => setInvestigationReadClis(['git', 'fd']), /禁止|拒/);
  // 即便强塞 settings，也被兜底过滤、assertSafeCommand 不放行
  setSetting(RUN_CLIS_SETTING_KEY, JSON.stringify(['git', 'fd', 'sd', 'ast-grep']));
  assert.deepEqual(getInvestigationReadClis(), ['git']);
  assert.throws(() => assertSafeCommand('fd', ['-x', 'bash', '-c', 'evil']), /白名单|拒绝/);
});
