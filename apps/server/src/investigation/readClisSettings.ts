/**
 * 自主排查只读 CLI 白名单的「运行时可改」层。
 *
 * 背景：config.investigationReadClis 在模块加载时从 env 一次性算定、之后不可变。要让用户在前端页面
 * 显式增删这个白名单，需要一个运行时来源：用户改过 → 落 settings 表（沿用 caringSettings 同款 get/setSetting
 * 键值存储）；没改过 → 回落 config 默认。assertSafeCommand / runCommandEnabled 改读本模块的 getter。
 *
 * 安全要点（这是安全敏感面，white-list 是给「无人在环的自主 AI」用的）：
 *  - **硬拒类黑名单 DENY**：shell / 解释器 / 网络 / 写删 / exec 包装器 等——它们无论参数怎么填都能绕过
 *    "硬只读"（python -c / node -e = 任意代码执行；curl/nc = 外泄；dd/tee/rm = 写删；no-shell + 路径根
 *    都拦不住二进制自身的能力）。这类**永远不进**有效白名单：保存时报错拒绝，getter 里也兜底过滤。
 *  - **风险分级**给前端展示：guarded（有 per-CLI 写面护栏：git/fornax-cli/bytedcli/rg/find）、
 *    readonly（已知无害只读工具）、custom（用户自加、无护栏、只有通用防护——前端给警告）。
 *  - 黑名单不可能穷举；custom 档承担"用户作为 operator 自负其责但被明确警示"的兜底。
 */
import { getSetting, setSetting } from '../db.js';
import { config } from '../config.js';

export const RUN_CLIS_SETTING_KEY = 'investigation.read_clis';

/** 有 per-CLI 写面护栏的 CLI（runCommand.ts 的 guardX 分发表）。 */
const GUARDED = new Set(['git', 'fornax-cli', 'bytedcli', 'rg', 'find']);

/**
 * 已知无害的只读工具（无 guard 但按构造只写 stdout、不靠 flag 写盘/不联网/不执行）。
 * 注意：**故意不含 sort/uniq** —— 它们能用 `-o FILE` / 第二位置参数写盘，不属"按构造只读"
 * （加进来会被归为 custom 档警示，而非误标"只读"）。
 */
const KNOWN_READONLY = new Set([
  'grep', 'cat', 'head', 'tail', 'ls', 'wc', 'jq', 'file', 'stat',
  'cut', 'tr', 'nl', 'comm', 'diff', 'column', 'od', 'xxd',
  'basename', 'dirname', 'realpath', 'readlink', 'du', 'df', 'tree', 'pwd',
  'sha1sum', 'sha256sum', 'md5sum', 'cksum',
]);

/**
 * 硬拒黑名单：永不允许进白名单（即便用户在前端硬塞）。按类别列，覆盖高危向量；
 * 不求穷举（穷举不可能），custom 档 + 通用防护兜其余。
 */
const DENY = new Set([
  // shell（带 -c 即任意命令；本工具 spawn 已 shell:false，但放行 shell 二进制等于自废武功）
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'ash', 'busybox', 'powershell', 'pwsh',
  // 解释器 / 任意代码执行（python -c / node -e / perl -e / awk system() / sed e命令 …）
  'python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'ruby', 'perl', 'php',
  'lua', 'luajit', 'rscript', 'osascript', 'groovy', 'scala', 'tclsh', 'expect',
  'awk', 'gawk', 'mawk', 'sed', 'ssed',
  // 类只读但能 exec/改写的搜索/重写工具：fd 的 -x/-X 是短 flag（无法被通用 --exec 兜底拦），故直接 DENY；
  // sd/sad/comby/ast-grep 会改写文件；ugrep 有 --pre/--filter 预处理执行。
  'fd', 'fdfind', 'ugrep', 'sd', 'sad', 'comby', 'ast-grep', 'sg',
  // exec 包装 / 提权 / 构建（能借壳起任意进程）
  'env', 'xargs', 'nohup', 'timeout', 'watch', 'nice', 'ionice', 'time', 'stdbuf', 'setsid',
  'sudo', 'doas', 'su', 'chroot', 'eval', 'exec', 'command', 'parallel',
  'make', 'cmake', 'ninja', 'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip2', 'pip3',
  'gem', 'cargo', 'go', 'mvn', 'gradle',
  // 网络（外泄 / 拉远端执行）
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'sftp', 'rsync',
  'ftp', 'telnet', 'lynx', 'links', 'http', 'https', 'aria2c',
  // 写 / 删 / 改文件系统
  'dd', 'tee', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'ln', 'install',
  'chmod', 'chown', 'chgrp', 'truncate', 'shred', 'mkfifo', 'mknod', 'patch', 'sponge',
  // 编辑器 / 分页器（! 可起 shell）
  'vi', 'vim', 'nvim', 'emacs', 'nano', 'ed', 'less', 'more', 'man', 'pico', 'view',
  // 归档（--to-command / -I 等可起进程）
  'tar', 'zip', 'unzip', '7z', '7za', 'gzip', 'gunzip', 'bzip2', 'xz', 'zstd', 'cpio', 'ar',
  // 编排 / 云（任意远端写）
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'ansible', 'aws', 'gcloud', 'az',
  // 飞书读走专用硬只读工具（readTools.ts），不在 run_command 重开 lark 写口子
  'lark-cli', 'lark',
]);

export type CliRisk = 'guarded' | 'readonly' | 'custom';

export function classifyCli(cli: string): CliRisk {
  if (GUARDED.has(cli)) return 'guarded';
  if (KNOWN_READONLY.has(cli)) return 'readonly';
  return 'custom';
}

// 合法 CLI 名的**正向**白名单格式（小写后判定）：字母/数字开头，其后只允许字母数字与 . _ + -。
// 一条正则同时挡掉：路径分隔符(/ \)、空白、控制字符、unicode 同形字(homoglyph)、前导符号。
const CLI_NAME_RE = /^[a-z0-9][a-z0-9_.+-]*$/;

/** 校验单个 CLI 名（按小写判定）。返回错误信息字符串；合法返回 null。 */
export function validateCli(cli: string): string | null {
  if (typeof cli !== 'string') return 'CLI 名必须是字符串';
  const raw = cli.trim();
  if (!raw) return 'CLI 名不能为空';
  if (raw.length > 64) return 'CLI 名过长（上限 64 字符）';
  const c = raw.normalize('NFKC').toLowerCase();
  if (!CLI_NAME_RE.test(c))
    return `「${raw}」名称非法：只允许字母/数字与 . _ + -，且需以字母或数字开头（不能含路径分隔符/空格/特殊字符）`;
  if (DENY.has(c))
    return `「${raw}」是 shell/解释器/网络/写删/exec 类命令，会绕过"硬只读"边界，禁止加入白名单`;
  return null;
}

/** config 默认白名单（env 或硬编码）的拷贝。 */
function defaultClis(): string[] {
  return [...config.investigationReadClis];
}

/**
 * 当前生效的只读 CLI 白名单。用户设过 → settings 表；否则回落 config 默认。
 * 任何情况下都过 DENY 兜底过滤（即便 settings 被直接改库塞了危险项也拦下）+ 去重 + 去格式非法项。
 * DB 异常时回落 config 默认（保证 assertSafeCommand 不因存储故障崩）。
 */
export function getInvestigationReadClis(): string[] {
  let list: string[];
  try {
    const raw = getSetting(RUN_CLIS_SETTING_KEY);
    if (raw === null || raw === '') {
      list = defaultClis();
    } else {
      const parsed: unknown = JSON.parse(raw);
      list = Array.isArray(parsed) ? parsed.map((x) => String(x)) : defaultClis();
    }
  } catch {
    list = defaultClis();
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cli of list) {
    const c = (typeof cli === 'string' ? cli.trim() : '').normalize('NFKC').toLowerCase();
    if (!c || seen.has(c)) continue;
    if (validateCli(c) !== null) continue; // 兜底：DENY / 非法格式项不进有效白名单
    seen.add(c);
    out.push(c); // 规整为小写：避免大小写绕过专项护栏（见 runCommand.ts 的小写分发）
  }
  return out;
}

/** 用户是否自定义过（settings 表有非空值）。 */
export function isCustomized(): boolean {
  try {
    const raw = getSetting(RUN_CLIS_SETTING_KEY);
    return raw !== null && raw !== '';
  } catch {
    return false;
  }
}

/**
 * 保存用户白名单。逐项校验（格式/DENY，见 validateCli）——首个违规即抛错（前端展示）。
 * 名称规整为小写后存储（去大小写绕过面）。返回去重后的有效列表；允许空列表（= 关掉所有 CLI，run_command 随之禁用）。
 */
export function setInvestigationReadClis(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('clis 必须是数组');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    const err = validateCli(trimmed);
    if (err) throw new Error(err);
    const c = trimmed.normalize('NFKC').toLowerCase();
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  setSetting(RUN_CLIS_SETTING_KEY, JSON.stringify(out));
  return out;
}

/** 恢复默认（清掉用户设定 → 回落 config 默认）。 */
export function resetInvestigationReadClis(): string[] {
  setSetting(RUN_CLIS_SETTING_KEY, '');
  return getInvestigationReadClis();
}

/** 给前端的完整描述：生效列表 + 每项风险分级 + 默认列表 + 是否自定义 + run_command 总开关。 */
export function describeReadClis(): {
  clis: string[];
  entries: Array<{ cli: string; risk: CliRisk }>;
  default: string[];
  customized: boolean;
  runCommandEnabled: boolean;
} {
  const clis = getInvestigationReadClis();
  return {
    clis,
    entries: clis.map((cli) => ({ cli, risk: classifyCli(cli) })),
    default: defaultClis(),
    customized: isCustomized(),
    runCommandEnabled: config.investigationRunCommandEnabled && clis.length > 0,
  };
}
