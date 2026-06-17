/**
 * MVP49 — 自主排查的本地只读命令工具 run_command。
 *
 * 让自主排查能跑**本地 CLI**（fornax-cli 拿 trace、git/grep/rg 查代码库、cat/jq 看文件），
 * 从而把"日志ID→traceID→fornax 下 trace→grep 代码库定位"这类需要外部系统的排查也自动化。
 * 但无人在环时是 AI 自己构造命令，因此必须是**硬只读**：绝不能产生写 / 破坏 / 凭证外泄。
 *
 * 防线（纵深，全部不依赖 shell —— argv 直 spawn、shell:false，从根上消灭 ;|&$()`> 注入）：
 *  1. 可执行名白名单（config.investigationReadClis，可配不写死；已剔除 lark-cli —— 飞书读走专用只读工具，
 *     不在这里重新开 lark 写子命令的口子）。cmd 不得含路径分隔符（不能指定任意二进制）。
 *  2. **最小化环境变量**：不继承 process.env，只下传安全键。这一条独立封死一大类"无 shell 也能 RCE"的注入
 *     （对抗审查 P0-1 实锤：GIT_EXTERNAL_DIFF / GIT_SSH_COMMAND / GIT_CONFIG_* / RIPGREP_CONFIG_PATH /
 *     PAGER / LESSOPEN / LD_PRELOAD / DYLD_* 都能让 git/rg 直接执行任意程序）。
 *  3. 每 CLI 危险面护栏：git（读子命令白名单 + 封 -c/--exec-path/--output 写盘 + branch/tag 删改）、
 *     fornax-cli（读子命令白名单 + 封 auth/config/update + 写动词）、
 *     bytedcli（庞大内部多功能 CLI：顶层只放行 log 只读日志查询家族，挡掉 deploy/release/tce/scm/env… 写/部署族，
 *       log 下再按读动词 allowlist + 写动词前缀拦截）、rg（封 --pre/--search-zip 预处理器 RCE）、
 *     find/bfs（封 -exec/-delete/-fprint* 等动作谓词）。
 *  4. **路径根限制**：cwd 与所有"看起来是路径"的参数，realpath 解析后必须落在 allowedRoots 内
 *     （封 symlink/.. 逃逸；把"能读哪"从黑名单倒转成白名单 —— 对抗审查 P1-2/P1-3）。叠加敏感文件名黑名单兜底。
 *  5. 超时 + 输出截断 + 子进程收割（仿 util/larkCli.ts，防挂死占资源）。
 *
 * assertSafeCommand 为纯函数、导出，供单测穷举攻击向量（这是本特性最关键的可测安全面）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { getInvestigationReadClis } from './readClisSettings.js';

// ---------------------------------------------------------------------------
// 1) 环境最小化：只下传安全键 + 钉死中和已知注入向量。
// ---------------------------------------------------------------------------

// fornax-cli/git 在最小环境下实测可用（auth 走 ~/.fornax-cli 与 ~/.gitconfig，靠 HOME；
// 网络无需特殊 env）。代理/CA 键放行以兼容公司网络环境，它们不是 RCE 向量。
const SAFE_ENV_ALLOW = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TZ', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

export function buildSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV_ALLOW) {
    const v = process.env[k];
    if (typeof v === 'string') env[k] = v;
  }
  // 双保险：即便上面白名单将来误放，这里把 git/rg 的 pager/prompt 钉成无害默认，避免挂起。
  // （GIT_EXTERNAL_DIFF / GIT_SSH_COMMAND / GIT_CONFIG_* / RIPGREP_CONFIG_PATH 等注入键
  //  因不在 SAFE_ENV_ALLOW 中，已被天然剔除，不在此再 set 空串以免反而触发"执行空命令"。）
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

// ---------------------------------------------------------------------------
// 4) 允许的根目录（cwd 与路径参数都必须落在其中）。
// ---------------------------------------------------------------------------

function resolveRoots(): string[] {
  const raw = [...config.investigationAllowedRoots, os.tmpdir()];
  const out: string[] = [];
  for (const r of raw) {
    try {
      out.push(realpathSync(r));
    } catch {
      // 不存在的根忽略
    }
  }
  return out;
}

/** 把 p 解析到"最近的已存在祖先"的真实路径，再拼回不存在的尾段。用于校验尚未创建的输出目录。 */
function realOfNearestExisting(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  let real: string;
  try {
    real = realpathSync(cur);
  } catch {
    real = cur;
  }
  return tail.length ? path.join(real, ...tail) : real;
}

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root + path.sep);
}

function assertWithinRoots(p: string, roots: string[], label: string): void {
  const real = realOfNearestExisting(p);
  if (!roots.some((r) => isWithin(real, r))) {
    throw new Error(`run_command 拒绝：${label} 越出允许目录（${real} 不在 ${roots.join(' / ')} 内）`);
  }
}

// 敏感文件名/路径黑名单（兜底；即便落在允许根内也拒绝读密钥）。
const SENSITIVE_RE =
  /(\/\.ssh(\/|$)|id_rsa|id_ed25519|\/\.aws(\/|$)|\/\.gnupg(\/|$)|\.git-credentials|\/\.netrc|\.pgpass|\/\.npmrc|\/\.pypirc|\/\.docker\/config|\/\.kube\/config|\/\.config\/gh(\/|$)|credentials|(^|\/)\.env(\.|$)|\/etc\/shadow|Keychains)/i;

// ---------------------------------------------------------------------------
// 3) 每 CLI 危险面护栏。
// ---------------------------------------------------------------------------

// git 写盘：仅长形 --output / --output= 在所有子命令下都是写文件（短 -o/-O 在 ls-files/diff 等是只读，
// 不能一刀切）；其值若是路径还会再过路径根校验。
const GIT_OUTPUT_WRITE_RE = /^--output(=.*)?$/;

// 只保留"无论位置参数怎么填都不可能写"的 git 只读子命令。
// 已**剔除 branch/tag/remote/reflog/symbolic-ref**：它们带裸位置参数即可建/删/改（如 `git branch x` 建分支、
// `git remote add`），靠 flag 黑名单兜不住 —— 排查用不到，直接不放行更干净。config 保留但必须带读 flag。
const GIT_READ_SUBCMDS = new Set([
  'log', 'show', 'diff', 'status', 'blame', 'grep', 'ls-files', 'ls-tree',
  'cat-file', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'whatchanged',
  'name-rev', 'count-objects', 'for-each-ref', 'show-ref', 'var', 'config', 'help', 'version',
]);
// 全局选项里能注入配置/可执行的 → 直接拒（-c key=val 可设 alias/core.pager 执行；--exec-path 换 git-* 目录）。
const GIT_BAD_GLOBAL_RE = /^(-c|--config-env|--exec-path|--upload-pack|--receive-pack)(=.*)?$/;
// 会消耗下一个 token 作为值的 git 全局 flag —— 定位子命令时必须跳过其值，否则值会被误当子命令
// （对抗审查 NEW-1 实锤：`git -C log branch x` 会把值 "log" 当成子命令、放过真正的 branch 写操作）。
const GIT_VALUE_FLAGS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '-c', '--config-env', '--exec-path']);

const FORNAX_READ_SUBCMDS = new Set([
  'trace', 'span', 'prompt', 'experiment', 'eval-set', 'evaluator',
  'dataset', 'workspace', 'model', 'version', 'help',
]);
// 绝不放行：auth(写凭证) / config(set 凭证) / update(自更新拉二进制执行) / 高写面子命令。
const FORNAX_BLOCK_SUBCMDS = new Set([
  'auth', 'config', 'update', 'synthesis', 'training-dataset', 'experiment-template', 'skill', 'completion',
]);
const FORNAX_TERMINAL_SUBCMDS = new Set(['version', 'help']); // 无需子动作
// fornax 子动作（verb）按**前缀**判定：写前缀一律拒（含 update-item/cancel-job/append-schema-fields 这类带连字符的，
// 对抗审查 NEW-2：锚定式 ^verb$ 会漏掉它们）；其余必须命中只读前缀，否则按未知拒绝。
const FORNAX_WRITE_VERB_RE =
  /^(set|create|delete|remove|release|publish|import|export|clear|add|append|update|upload|push|login|logout|run|submit|cancel|retry|edit|new|init|apply|sync|save|draft|stop|start|enable|disable|move|copy|rename|restore)/i;
const FORNAX_READ_VERB_RE = /^(get|list|detail|describe|show|query|search|view|results|agg|count|stat)/i;
// 会消耗下一个 token 作为值的 fornax 全局 flag。
const FORNAX_VALUE_FLAGS = new Set([
  '--workspace-id', '--endpoint', '--custom-region', '--region', '--ak', '--sk',
  '--byted-jwt-token', '--timeout', '--format', '-o', '--output',
]);

// bytedcli（@bytedance-dev/bytedcli）是庞大的内部多功能 CLI——deploy/release/tce/scm/env/tcc/abase… 全是写/部署族。
// run_command 只放行 **log 只读日志查询家族**（Chatbot 排查"run_log_id→traceID"的键石：先 `bytedcli log search-psm-log`
// 按关键词解出 trace_id，再喂 fornax-cli）。顶层子命令白名单只含 log，从根上挡掉所有写/部署族；log 下再按
// 读动词 allowlist + 写动词前缀拦截兜底（即便将来 log 家族新增写子动作）。auth 走 ~/.bytedcli 下的 JWT（靠 HOME，
// 已在 buildSafeEnv 保留）；BYTEDCLI_* 仅是 base-url 等可选覆盖，有默认值，剔除不影响 log 查询。
const BYTEDCLI_READ_SUBCMDS = new Set(['log', 'help', 'version']);
const BYTEDCLI_TERMINAL_SUBCMDS = new Set(['version', 'help']); // 无需子动作
// log 子动作（verb）按**前缀**判定：写/部署前缀一律拒，其余必须命中只读前缀（覆盖现网全部 log 子命令：
// search-psm-log / search-prod-instance-log / search-log-matchers / get-logid-log / get-lane-instance-log /
// get-log-cluster / analysis / footprint / trace-tree），否则按未知拒绝。
const BYTEDCLI_WRITE_VERB_RE =
  /^(set|create|delete|remove|deploy|release|publish|update|restart|add|append|import|upload|push|login|logout|run|submit|cancel|retry|edit|new|init|apply|sync|save|draft|stop|start|enable|disable|move|copy|rename|restore|clear|kill|scale|rollback|exec|grant|revoke|reset|put|patch|modify|destroy|terminate|bind|unbind)/i;
const BYTEDCLI_READ_VERB_RE =
  /^(get|list|search|query|show|describe|view|detail|count|stat|analysis|footprint|trace|tail|head|cat|find)/i;
// 会消耗下一个 token 作为值的 bytedcli 全局 flag（出现在 log 子命令之前，需在定位子命令时跳过其值，
// 防"flag 值伪装成子命令"旁路；-d/--debug、-j/--json 是布尔，不消耗值，无需列入）。
const BYTEDCLI_VALUE_FLAGS = new Set(['--site', '--auth-site', '--vregion', '--vdc']);

const RG_BLOCK = new Set(['--pre', '--pre-glob', '--hostname-bin', '-z', '--search-zip']);
const FIND_ACTION_RE = /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls|fprint0)$/i;

// 通用危险参数（对**所有** CLI 生效，含用户自加的 custom CLI）：exec / 预处理器类长 flag——
// 没有任何只读命令的正常用法需要它们，但 fd/ugrep 等"类只读"工具靠它们执行任意程序（fd --exec、
// ugrep --pre）。这是 per-CLI 护栏之外的兜底层（fd 的短 flag -x/-X 无法通用拦，故 fd 类直接进 DENY）。
const COMMON_DANGEROUS_FLAG_RE =
  /^(--exec|--exec-batch|--exec-dir|-exec|-execdir|-ok|-okdir|--pre|--pre-glob|--hostname-bin|--search-zip)(=.*)?$/i;

/**
 * 定位子命令 = **跳过全局 flag 及其值后**遇到的第一个非 dash token，及其下标。
 * 关键：valueFlags 里的分离形取值 flag 会连同它的值一起跳过，从根上消灭"flag 值伪装成子命令"的旁路。
 * 返回 -1 表示没有子命令。子命令是否合法由调用方按集合判定（首个裸 token 不在白名单 → 拒）。
 */
function locateSubcommand(args: string[], valueFlags: Set<string>): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) return i; // 第一个裸 token 即子命令
    if (valueFlags.has(a)) i++; // 分离形取值 flag：跳过它的值（`--flag=value` 形不消耗下一个 token）
  }
  return -1;
}

function firstNonDashAfter(args: string[], idx: number): string | undefined {
  for (let i = idx + 1; i < args.length; i++) if (!args[i].startsWith('-')) return args[i];
  return undefined;
}

function guardGit(args: string[]): void {
  for (const a of args) {
    if (GIT_BAD_GLOBAL_RE.test(a)) throw new Error(`run_command 拒绝：git 全局选项 ${a} 可注入执行`);
    if (GIT_OUTPUT_WRITE_RE.test(a)) throw new Error(`run_command 拒绝：git 输出写盘选项 ${a}`);
    // git grep -O<cmd> / --open-files-in-pager=<cmd> 会**执行**该程序（覆盖强制的 GIT_PAGER=cat），
    // 是 argv 级 RCE（对抗审查三轮实锤建出 /tmp/PWNED）。整类硬拒（git diff 的 -O 排序文件读功能一并舍弃，排查用不到）。
    if (/^(-O|--open-files-in-pager)/.test(a)) throw new Error(`run_command 拒绝：git 分页器执行选项 ${a} 可执行任意程序`);
  }
  const i = locateSubcommand(args, GIT_VALUE_FLAGS);
  const sub = i >= 0 ? args[i] : undefined;
  if (!sub || !GIT_READ_SUBCMDS.has(sub))
    throw new Error(`run_command 拒绝：git ${sub ?? '(空)'} 不是只读子命令（push/commit/reset/branch 等一律拒）`);
  if (sub === 'config') {
    const hasRead = args.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a));
    const hasWrite = args.some((a) => /^(--add|--unset|--unset-all|--replace-all|--edit|-e|--remove-section|--rename-section)$/.test(a));
    if (hasWrite || !hasRead) throw new Error('run_command 拒绝：git config 仅允许 --get/--list 读取');
  }
}

function guardFornax(args: string[]): void {
  // 注：fornax 的 -o <dir> 是"把 trace/prompt 下载到本地"的正常用法（自动命名 trace_<id>.json，
  // AI 既不能控文件名也不能控内容=API 返回），属受控缓存写。其目标目录由下方路径根校验限制在 allowedRoots 内
  // （-o 已列入 FORNAX_VALUE_FLAGS，定位子命令时跳过其值，不会被伪装旁路）。故此处不封 -o。
  const i = locateSubcommand(args, FORNAX_VALUE_FLAGS);
  const sub = i >= 0 ? args[i] : undefined;
  if (!sub) throw new Error('run_command 拒绝：未见 fornax-cli 子命令');
  if (FORNAX_BLOCK_SUBCMDS.has(sub)) throw new Error(`run_command 拒绝：fornax-cli ${sub} 含写/凭证/自更新能力`);
  if (!FORNAX_READ_SUBCMDS.has(sub)) throw new Error(`run_command 拒绝：fornax-cli ${sub} 非已知只读子命令`);
  if (FORNAX_TERMINAL_SUBCMDS.has(sub)) return; // version/help 无子动作
  const verb = firstNonDashAfter(args, i);
  if (!verb) throw new Error(`run_command 拒绝：fornax-cli ${sub} 缺只读子动作（get/list/...）`);
  if (FORNAX_WRITE_VERB_RE.test(verb)) throw new Error(`run_command 拒绝：fornax-cli ${sub} ${verb} 是写动词`);
  if (!FORNAX_READ_VERB_RE.test(verb)) throw new Error(`run_command 拒绝：fornax-cli ${sub} ${verb} 非已知只读子动作`);
}

function guardBytedcli(args: string[]): void {
  const i = locateSubcommand(args, BYTEDCLI_VALUE_FLAGS);
  const sub = i >= 0 ? args[i] : undefined;
  if (!sub) throw new Error('run_command 拒绝：未见 bytedcli 子命令');
  if (!BYTEDCLI_READ_SUBCMDS.has(sub))
    throw new Error(`run_command 拒绝：bytedcli ${sub} 非只读日志查询子命令（只放行 log；deploy/release/tce/scm/env 等一律拒）`);
  if (BYTEDCLI_TERMINAL_SUBCMDS.has(sub)) return; // version/help 无子动作
  const verb = firstNonDashAfter(args, i);
  if (!verb) throw new Error(`run_command 拒绝：bytedcli ${sub} 缺只读子动作（search-psm-log/get-logid-log/...）`);
  if (BYTEDCLI_WRITE_VERB_RE.test(verb)) throw new Error(`run_command 拒绝：bytedcli ${sub} ${verb} 是写/部署动词`);
  if (!BYTEDCLI_READ_VERB_RE.test(verb)) throw new Error(`run_command 拒绝：bytedcli ${sub} ${verb} 非已知只读子动作`);
}

function guardRg(args: string[]): void {
  for (const a of args) {
    const head = a.split('=')[0];
    if (RG_BLOCK.has(head)) throw new Error(`run_command 拒绝：rg ${head} 可执行预处理器`);
  }
}

function guardFind(args: string[]): void {
  for (const a of args) {
    if (FIND_ACTION_RE.test(a)) throw new Error(`run_command 拒绝：find 动作谓词 ${a} 可执行/写盘`);
  }
}

/** 对所有 CLI 生效的通用 exec/预处理器 flag 兜底（防 custom CLI 借 --exec/--pre 执行任意程序）。 */
function guardCommonDangerousFlags(args: string[]): void {
  for (const a of args) {
    if (COMMON_DANGEROUS_FLAG_RE.test(a))
      throw new Error(`run_command 拒绝：危险参数 ${a}（exec/预处理器类，可执行任意程序）`);
  }
}

// ---------------------------------------------------------------------------
// 主校验：违规即 throw。
// 注：白名单成员现走 getInvestigationReadClis()（运行时可改，用户在前端增删 → settings 表），
// 故本函数不再是"纯函数"——但行为仍确定（无 override 时回落 config 默认，与旧版一致），且不改入参。
// ---------------------------------------------------------------------------

/** 硬只读 + 安全校验。throw 即代表这条命令不该执行。导出供单测穷举攻击向量。 */
export function assertSafeCommand(cmd: string, args: string[], cwd?: string): void {
  if (!cmd || typeof cmd !== 'string') throw new Error('run_command 拒绝：缺 cmd');
  if (/[\\/]/.test(cmd)) throw new Error(`run_command 拒绝：cmd 不能含路径分隔符（${cmd}）`);
  // 白名单走运行时来源（用户在前端可改 → settings 表；未改回落 config 默认）。
  // getInvestigationReadClis() 已对 DENY 黑名单/非法格式兜底过滤，故能进到这里的有效项一定安全。
  const whitelist = getInvestigationReadClis();
  if (!whitelist.includes(cmd))
    throw new Error(`run_command 拒绝：${cmd} 不在只读 CLI 白名单（${whitelist.join(',')}）`);
  if (!Array.isArray(args)) throw new Error('run_command 拒绝：args 必须是数组');
  for (const a of args) {
    if (typeof a !== 'string') throw new Error('run_command 拒绝：args 必须全为字符串');
    if (a.includes('\0') || a.includes('\n')) throw new Error('run_command 拒绝：参数含换行/NUL');
  }

  // 通用兜底护栏：exec/预处理器类 flag 对所有 CLI（含 custom）一律拒。
  guardCommonDangerousFlags(args);

  // 每 CLI 护栏。按**小写**分发：有效白名单已规整为小写，且大小写不应绕过专项护栏
  // （macOS 大小写不敏感文件系统下 spawn('GIT') 真会跑 git —— 必须让 guardGit 照样命中）。
  const lc = cmd.toLowerCase();
  if (lc === 'git') guardGit(args);
  else if (lc === 'fornax-cli') guardFornax(args);
  else if (lc === 'bytedcli') guardBytedcli(args);
  else if (lc === 'rg') guardRg(args);
  else if (lc === 'find') guardFind(args);

  // 路径根限制 + 敏感文件兜底
  const roots = resolveRoots();
  if (roots.length === 0) throw new Error('run_command 拒绝：未配置任何允许根目录');
  const base = cwd ? path.resolve(cwd) : process.cwd();
  if (cwd) {
    assertWithinRoots(base, roots, 'cwd');
    if (SENSITIVE_RE.test(realOfNearestExisting(base))) throw new Error('run_command 拒绝：cwd 命中敏感路径');
  }
  for (const a of args) {
    // 提取可能的路径：裸路径参数，或 --flag=<路径> 的值
    let candidate: string | null = null;
    if (!a.startsWith('-')) {
      candidate = a;
    } else {
      const eq = a.indexOf('=');
      if (eq >= 0) candidate = a.slice(eq + 1);
    }
    if (!candidate) continue;
    const looksPath =
      path.isAbsolute(candidate) ||
      candidate.startsWith('./') ||
      candidate.startsWith('../') ||
      candidate.startsWith('~') ||
      candidate.includes('/') ||
      existsSync(path.resolve(base, candidate));
    if (!looksPath) continue;
    const abs = path.isAbsolute(candidate)
      ? candidate
      : candidate.startsWith('~')
        ? path.join(os.homedir(), candidate.slice(1))
        : path.resolve(base, candidate);
    const real = realOfNearestExisting(abs);
    if (SENSITIVE_RE.test(real) || SENSITIVE_RE.test(candidate))
      throw new Error(`run_command 拒绝：参数命中敏感路径（${candidate}）`);
    assertWithinRoots(abs, roots, `路径参数 ${candidate}`);
  }
}

// ---------------------------------------------------------------------------
// 5) 受控执行：超时 + 输出截断 + 收割。
// ---------------------------------------------------------------------------

const MAX_STDOUT = 16_384;
const MAX_STDERR = 4_096;

const inflight = new Set<ChildProcess>();
let reaperHooked = false;
function hookReaper() {
  if (reaperHooked) return;
  reaperHooked = true;
  process.once('exit', () => {
    for (const c of inflight) {
      try {
        c.kill('SIGKILL');
      } catch {
        // 已死
      }
    }
  });
}

type SpawnResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

function spawnCapped(cmd: string, args: string[], cwd?: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    hookReaper();
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: cwd || undefined,
        env: buildSafeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    inflight.add(child);
    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;
    const finish = (r: SpawnResult) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      inflight.delete(child);
      resolve(r);
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {}
      const hard = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 3_000);
      hard.unref();
      finish({ code: -1, stdout, stderr: stderr + `\n[run_command 超时 ${config.investigationCommandTimeoutMs}ms]`, timedOut: true });
    }, config.investigationCommandTimeoutMs);
    killTimer.unref();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      if (stdout.length < MAX_STDOUT) stdout += c;
      if (stdout.length >= MAX_STDOUT) {
        stdout = stdout.slice(0, MAX_STDOUT) + '\n…[输出已截断]';
        try {
          child.kill('SIGTERM');
        } catch {}
      }
    });
    child.stderr?.on('data', (c: string) => {
      if (stderr.length < MAX_STDERR) stderr += c;
    });
    child.on('error', (err) => finish({ code: -1, stdout, stderr: stderr + err.message, timedOut }));
    child.on('exit', (code) => finish({ code: code ?? -1, stdout, stderr, timedOut }));
  });
}

export type RunCommandResult = { data: unknown; summary: string };

/** 执行一条本地只读命令。先 assertSafeCommand（违规 throw），再受控 spawn。 */
export async function runLocalReadCommand(params: Record<string, unknown>): Promise<RunCommandResult> {
  const cmd = typeof params.cmd === 'string' ? params.cmd.trim() : '';
  const args = Array.isArray(params.args) ? params.args.map((x) => String(x)) : [];
  const cwd = typeof params.cwd === 'string' && params.cwd.trim() ? params.cwd.trim() : undefined;

  assertSafeCommand(cmd, args, cwd); // 违规直接 throw → runReadTool 兜成 ok:false

  const { code, stdout, stderr, timedOut } = await spawnCapped(cmd, args, cwd);
  const argPreview = args.slice(0, 4).join(' ');
  const summary = timedOut
    ? `run_command: ${cmd} ${argPreview} → 超时`
    : `run_command: ${cmd} ${argPreview} → exit ${code}，${stdout.length} 字符` +
      (code !== 0 && stderr ? `（stderr: ${stderr.slice(0, 160).replace(/\n/g, ' ')}）` : '');
  return {
    data: { cmd, args, code, timedOut, stdout, stderr: stderr.slice(0, MAX_STDERR) },
    summary,
  };
}

export const RUN_COMMAND_DESCRIPTION =
  '跑一条本地**只读**命令（用于查代码库 / 拿 trace 等飞书之外的来源）。常用：' +
  'rg/grep 在代码库搜关键字、git log/show/diff/blame 看改动、cat/head/jq 看文件、' +
  'fornax-cli trace/span/prompt 的 get/list 拿 trace 详情、' +
  'bytedcli log search-psm-log 把"日志ID(run_log_id)"解成 traceID（fornax 直接查不到，必须先用它解出再喂 fornax-cli）。' +
  '只读：写/删/发布/凭证/部署类命令会被拒绝。';
export const RUN_COMMAND_PARAMS_HINT =
  '{ cmd:"rg|git|fornax-cli|bytedcli|grep|cat|jq|find|ls|head|tail|wc|file|stat", args:[...], cwd?:"<绝对路径，查代码库时填项目根>" } ' +
  '——例：{cmd:"rg",args:["-n","keyword","src"],cwd:"<repo>"}；{cmd:"git",args:["-C","<repo>","log","-5","--oneline"]}；' +
  '{cmd:"fornax-cli",args:["trace","get","--id","<traceId>"]}；' +
  '{cmd:"bytedcli",args:["log","search-psm-log","--psm","bitable.ai.chatbot","--keyword","<run_log_id>","--start","<UTC-Z>","--end","<UTC-Z>","--output","console"]}（输出里 grep trace_id=<32hex>）。' +
  '命令在 cwd 下执行，路径不能越出允许目录。';
