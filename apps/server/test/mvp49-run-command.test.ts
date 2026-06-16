/**
 * MVP49 — 本地只读命令工具 run_command 的硬只读边界测试。
 *
 * 重点：穷举对抗审查（adversarial review）实锤出的 RCE/写盘/外泄向量，断言 assertSafeCommand 一律 throw；
 * 安全命令放行；并跑几条真 spawn 验证读路径通、写/越界路径被 runReadTool 兜成 ok:false。
 *
 * Run: npx tsx --test apps/server/test/mvp46-run-command.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { assertSafeCommand, buildSafeEnv } from '../src/investigation/runCommand.js';
import { listReadTools, runReadTool } from '../src/investigation/readTools.js';

const HOME = os.homedir();
const CHATBOT = `${HOME}/MyProject/bitable-chatbot`;

// ---- 安全命令：放行 ----

test('S1 安全只读命令放行', () => {
  assert.doesNotThrow(() => assertSafeCommand('rg', ['-n', 'keyword', 'src']));
  assert.doesNotThrow(() => assertSafeCommand('grep', ['-rn', 'foo', 'src']));
  assert.doesNotThrow(() => assertSafeCommand('git', ['log', '-5', '--oneline']));
  assert.doesNotThrow(() => assertSafeCommand('git', ['-C', CHATBOT, 'log', '-1']));
  assert.doesNotThrow(() => assertSafeCommand('git', ['config', '--get', 'user.email']));
  assert.doesNotThrow(() => assertSafeCommand('fornax-cli', ['trace', 'get', '--id', 'abc123']));
  assert.doesNotThrow(() => assertSafeCommand('fornax-cli', ['workspace', 'list']));
  assert.doesNotThrow(() => assertSafeCommand('cat', ['package.json']));
  assert.doesNotThrow(() => assertSafeCommand('ls', ['-1']));
});

// ---- P0-1：环境最小化（env 注入向量被剔除） ----

test('P0-1 buildSafeEnv 剔除 env 注入向量、保留必需键、钉死 pager', () => {
  const saved = { ...process.env };
  try {
    process.env.GIT_EXTERNAL_DIFF = '/tmp/evil.sh';
    process.env.GIT_SSH_COMMAND = '/tmp/evil.sh';
    process.env.RIPGREP_CONFIG_PATH = '/tmp/rc';
    process.env.LD_PRELOAD = '/tmp/evil.so';
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/evil.dylib';
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.BASH_ENV = '/tmp/evil.sh';
    const env = buildSafeEnv();
    for (const k of ['GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'RIPGREP_CONFIG_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'BASH_ENV']) {
      assert.equal(env[k], undefined, `${k} 必须被剔除`);
    }
    assert.ok(env.PATH && env.HOME, '必须保留 PATH/HOME');
    assert.equal(env.GIT_PAGER, 'cat');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  } finally {
    process.env = saved;
  }
});

// ---- P0-2：rg 预处理器 RCE ----

test('P0-2 rg --pre/--search-zip 预处理器执行被拒', () => {
  assert.throws(() => assertSafeCommand('rg', ['--pre', '/tmp/evil.sh', '--pre-glob', '*.txt', 'x', '.']), /预处理器|拒绝/);
  assert.throws(() => assertSafeCommand('rg', ['-z', 'x', '.']), /拒绝/);
  assert.throws(() => assertSafeCommand('rg', ['--search-zip', 'x', '.']), /拒绝/);
  assert.throws(() => assertSafeCommand('rg', ['--hostname-bin', '/tmp/evil.sh', 'x']), /拒绝/);
});

// ---- P0-3：git 任意写盘 ----

test('P0-3 git --output 写盘 + -c/--exec-path 注入被拒', () => {
  assert.throws(() => assertSafeCommand('git', ['log', '--output=/tmp/pwn.txt']), /输出写盘|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['diff', '--output', '/tmp/pwn']), /输出写盘|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['-c', 'core.pager=/tmp/evil.sh', 'log']), /注入|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['--exec-path=/tmp/evil', 'log']), /注入|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['push']), /只读子命令|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['commit', '-m', 'x']), /只读子命令|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['branch', '-D', 'main']), /删|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['config', '--global', 'alias.x', '!sh']), /--get|拒绝/);
});

// ---- 三轮对抗审查 critical：git grep -O 分页器 RCE ----

test('NEW-O git grep -O/--open-files-in-pager 执行任意程序被拒', () => {
  assert.throws(() => assertSafeCommand('git', ['grep', '-Otouch /tmp/PWNED', 'needle']), /分页器执行|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['grep', '--open-files-in-pager=touch /tmp/x', 'needle']), /分页器执行|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['-C', CHATBOT, 'grep', '-O/tmp/evil.sh', 'x']), /分页器执行|拒绝/);
});

// ---- P0-4：fornax-cli 写/凭证/自更新 ----

test('P0-4 fornax-cli 写/凭证/自更新/写动词被拒', () => {
  assert.throws(() => assertSafeCommand('fornax-cli', ['config', 'set', 'ak', 'AKxxx']), /凭证|拒绝/);
  assert.throws(() => assertSafeCommand('fornax-cli', ['auth', 'login']), /凭证|拒绝/);
  assert.throws(() => assertSafeCommand('fornax-cli', ['update']), /自更新|拒绝/);
  assert.throws(() => assertSafeCommand('fornax-cli', ['prompt', 'delete', '--prompt-id', '1', '-y']), /写动词|拒绝/);
  assert.throws(() => assertSafeCommand('fornax-cli', ['prompt', 'create']), /写动词|拒绝/);
  assert.throws(() => assertSafeCommand('fornax-cli', ['dataset', 'import', '--hdfs-path', '/x']), /写动词|拒绝/);
  assert.throws(() => assertSafeCommand('fornax-cli', ['dataset', 'clear-items']), /写动词|拒绝/);
});

// ---- NEW-1（二轮对抗审查 critical）：flag 值伪装成子命令 ----

test('NEW-1 flag 值不得伪装成子命令放过写操作', () => {
  // `-C log` 的值 "log" 曾被当成子命令、放过真正的 branch 写
  assert.throws(() => assertSafeCommand('git', ['-C', 'log', 'branch', 'newbranch']), /不是只读子命令|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['-C', 'status', 'push', 'origin']), /不是只读子命令|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['--git-dir', 'show', 'gc']), /不是只读子命令|拒绝/);
  // fornax 全局取值 flag 伪装
  assert.throws(() => assertSafeCommand('fornax-cli', ['--workspace-id', 'trace', 'config', 'set', 'sk', 'X']), /写|凭证|拒绝/);
});

// ---- NEW-2：连字符写动词（锚定正则会漏） ----

test('NEW-2 fornax 连字符写动词被拒（前缀判定）', () => {
  assert.throws(() => assertSafeCommand('fornax-cli', ['dataset', 'update-item', '--id', '1']), /写动词|拒绝/);
  assert.throws(() => assertSafeCommand('fornax-cli', ['dataset', 'cancel-job']), /写动词|拒绝/);
  assert.throws(() => assertSafeCommand('fornax-cli', ['dataset', 'append-schema-fields']), /写动词|拒绝/);
  assert.throws(() => assertSafeCommand('fornax-cli', ['experiment', 'retry']), /写动词|拒绝/);
  // 读动作放行
  assert.doesNotThrow(() => assertSafeCommand('fornax-cli', ['dataset', 'get-item', '--id', '1']));
  assert.doesNotThrow(() => assertSafeCommand('fornax-cli', ['dataset', 'list-items']));
});

// ---- NEW-3：fornax -o 下载目录受路径根约束（允许根内可下载，越界/敏感拒绝） ----

test('NEW-3 fornax -o 下载目录限根内：根内放行、越界/敏感拒绝', () => {
  // 根内（~/MyProject 下）下载 trace 是正常用法 → 放行
  assert.doesNotThrow(() => assertSafeCommand('fornax-cli', ['trace', 'get', '--id', 'x', '-o', `${HOME}/MyProject/ai-is-on/tmp`]));
  // -o 越出允许目录 / 指向敏感目录 → 拒
  assert.throws(() => assertSafeCommand('fornax-cli', ['trace', 'get', '--id', 'x', '-o', '/etc']), /越出允许目录|拒绝/);
  assert.throws(() => assertSafeCommand('fornax-cli', ['trace', 'get', '--id', 'x', '--output=' + `${HOME}/.ssh`]), /敏感|越出|拒绝/);
});

// ---- 被剔除的 git 子命令（带裸位置参数即可写） ----

test('NEW git branch/tag/remote/reflog 已整体下线', () => {
  assert.throws(() => assertSafeCommand('git', ['branch', '-a']), /不是只读子命令|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['tag']), /不是只读子命令|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['remote', '-v']), /不是只读子命令|拒绝/);
  assert.throws(() => assertSafeCommand('git', ['reflog']), /不是只读子命令|拒绝/);
});

// ---- P1-2/P1-3：路径根限制 + 敏感文件 ----

test('P1 路径越界/敏感文件/.. 逃逸被拒', () => {
  assert.throws(() => assertSafeCommand('cat', ['/etc/passwd']), /越出允许目录|拒绝/);
  assert.throws(() => assertSafeCommand('cat', [`${HOME}/.ssh/id_rsa`]), /敏感路径|越出允许目录|拒绝/);
  assert.throws(() => assertSafeCommand('cat', ['../../../../etc/passwd']), /越出允许目录|拒绝/);
  assert.throws(() => assertSafeCommand('cat', [`${HOME}/.aws/credentials`]), /敏感|越出|拒绝/);
  assert.throws(() => assertSafeCommand('cat', ['.env']), /敏感|拒绝/);
  // cwd 越界
  assert.throws(() => assertSafeCommand('ls', [], '/etc'), /cwd|越出|拒绝/);
});

// ---- 白名单/形态 ----

test('S2 cmd 形态校验：非白名单 / 含路径分隔符 / 非字符串参数', () => {
  assert.throws(() => assertSafeCommand('curl', ['http://x']), /白名单|拒绝/);
  assert.throws(() => assertSafeCommand('lark-cli', ['version']), /白名单|拒绝/); // lark 不在 run_command 白名单
  assert.throws(() => assertSafeCommand('/bin/ls', []), /路径分隔符|拒绝/);
  assert.throws(() => assertSafeCommand('ls', ['a\nb']), /换行|拒绝/);
  // @ts-expect-error 故意传非数组
  assert.throws(() => assertSafeCommand('ls', 'notarray'), /数组|拒绝/);
});

// ---- run_command 进工具集 + 真 spawn 端到端 ----

test('S3 run_command 出现在只读工具集中', () => {
  const names = listReadTools().map((t) => t.name);
  assert.ok(names.includes('run_command'), 'run_command 应在工具集（默认启用）');
});

test('S4 真 spawn：git 只读命令 ok:true', async () => {
  const r = await runReadTool('run_command', { cmd: 'git', args: ['rev-parse', '--show-toplevel'] });
  assert.equal(r.ok, true, r.error);
  const d = r.data as { code: number; stdout: string };
  assert.equal(d.code, 0);
  assert.match(d.stdout, /ai-is-on/);
});

test('S5 真 spawn：被拒命令 ok:false 不执行', async () => {
  const r = await runReadTool('run_command', { cmd: 'git', args: ['push', 'origin', 'main'] });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /只读子命令|拒绝/);
});

test('S6 真 spawn：越界路径 ok:false', async () => {
  const r = await runReadTool('run_command', { cmd: 'cat', args: ['/etc/passwd'] });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /越出允许目录|拒绝/);
});
