/**
 * MVP36 — 自主排查的「硬只读边界」基座。
 *
 * 背景（2026-06-14 多 agent 调研）：现状 aiisn-chat 排查靠模型裸 bash 调 lark-cli，"只读"只是 prompt
 * 软约束（bash:allow 无命令过滤）。用户拍板：无人值守的自主排查必须有**硬只读边界**。
 *
 * 本模块是后端中介式排查的工具层：模型**不碰 shell**，只能请求这里注册的一组**白名单只读工具**，
 * 后端用现有 lark-cli 读命令执行。写操作「按构造不可能」——注册表里只有读工具，且每次执行前
 * assertReadOnly() 二次校验命令动词（纵深防御：未来误加写工具会在执行前抛错，不会真发出去）。
 *
 * 这层也顺带绕开了"并发 opencode 进程爆炸"——排查不开 opencode turn，走后端读 + gated one-shot 判断。
 */
import { runLarkCliJson } from '../util/larkCli.js';
import { config } from '../config.js';
import {
  runLocalReadCommand,
  RUN_COMMAND_DESCRIPTION,
  RUN_COMMAND_PARAMS_HINT,
} from './runCommand.js';
import { getInvestigationReadClis } from './readClisSettings.js';

export type ReadToolName =
  | 'search_im_messages'
  | 'read_chat_messages'
  | 'read_doc'
  | 'list_my_tasks'
  | 'run_command';

export type ReadToolParams = Record<string, unknown>;

export type ReadToolResult = {
  tool: ReadToolName;
  ok: boolean;
  data?: unknown;
  summary: string;
  error?: string;
};

export type ReadToolDeps = {
  runJson?: <T = unknown>(args: string[]) => Promise<T>;
};

// ---- 硬只读护栏：只允许这些 (domain +verb) 读命令；任何写动词一律拒绝 ----

const READ_ALLOWLIST = new Set<string>([
  'im +messages-search',
  'im +chat-messages-list',
  'im +messages-mget',
  'im +chat-list',
  'im +chat-search',
  'docs +fetch',
  'drive +inspect',
  'drive +search',
  'task +get-my-tasks',
  'task +get-related-tasks',
  'calendar +agenda',
  'contact +search-user',
]);

// 兜底黑名单：即便有人把写命令塞进 allowlist，这条正则也会先拦下。
const WRITE_VERB_RE =
  /^\+(messages-send|messages-reply|send|reply|create|update|delete|remove|add|cancel|chat-create|chat-update|flag-create|flag-cancel|feed-shortcut-create|feed-shortcut-remove|import|move|copy)/i;

/** 硬只读校验：抛错即代表这条命令不该被执行。导出供测试与执行层调用。 */
export function assertReadOnly(args: string[]): void {
  const domain = args[0];
  const verb = args.find((a) => a.startsWith('+'));
  if (!verb) throw new Error(`read-only violation: no lark-cli subcommand in [${args.join(' ')}]`);
  if (WRITE_VERB_RE.test(verb)) {
    throw new Error(`read-only violation: write verb ${verb} 被禁止`);
  }
  const key = `${domain} ${verb}`;
  if (!READ_ALLOWLIST.has(key)) {
    throw new Error(`read-only violation: ${key} 不在只读白名单内`);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

// ---- 工具定义 ----

type ReadTool = {
  name: ReadToolName;
  description: string;
  paramsHint: string;
  /** 构造 lark-cli 读命令 args。两步类工具（如 read_doc）在 run 内自行处理，build 返回主命令。 */
  build: (params: ReadToolParams) => string[];
  summarize: (data: unknown) => string;
  /**
   * 非 lark-cli 类工具的自定义执行器（如 run_command 走本地 spawn）。提供时 runReadTool 用它，
   * 跳过 build/assertReadOnly/lark runJson 那条路。安全边界由执行器自身负责。
   */
  exec?: (params: ReadToolParams) => Promise<{ data: unknown; summary: string }>;
};

const TOOLS: Record<ReadToolName, ReadTool> = {
  search_im_messages: {
    name: 'search_im_messages',
    description: '在飞书 IM 里搜消息（按关键词/发件人/会话/时间窗）。用于"某人最近跟我说了什么""这件事在群里有没有结论"。',
    paramsHint: '{ query?, sender?(open_id), chatId?(oc_), start?(ISO), end?(ISO), limit? } —— 至少给 query 或 chatId 之一',
    build: (p) => {
      const args = ['im', '+messages-search', '--page-limit', String(clampLimit(p.limit, 20, 50)), '--format', 'json'];
      const query = str(p.query);
      const chatId = str(p.chatId);
      if (!query && !chatId) throw new Error('search_im_messages 需要 query 或 chatId');
      if (query) args.push('--query', query);
      if (str(p.sender)) args.push('--sender', str(p.sender)!);
      if (chatId) args.push('--chat-id', chatId);
      if (str(p.start)) args.push('--start', str(p.start)!);
      if (str(p.end)) args.push('--end', str(p.end)!);
      return args;
    },
    summarize: (d) => `IM 搜索命中 ${countItems(d)} 条`,
  },
  read_chat_messages: {
    name: 'read_chat_messages',
    description: '读某个会话最近的消息原文（按 chat-id + 时间窗）。用于看清一个群/单聊当前的对话状态。',
    paramsHint: '{ chatId(oc_), start?(ISO), end?(ISO), limit? }',
    build: (p) => {
      const chatId = str(p.chatId);
      if (!chatId) throw new Error('read_chat_messages 需要 chatId');
      // 注意：chat-messages-list 用 --page-size（不是 messages-search 的 --page-limit）。
      // 2026-06-15 试运行实测：用错 flag → lark-cli exit 2 unknown flag。
      const args = ['im', '+chat-messages-list', '--chat-id', chatId, '--page-size', String(clampLimit(p.limit, 20, 50)), '--format', 'json'];
      if (str(p.start)) args.push('--start', str(p.start)!);
      if (str(p.end)) args.push('--end', str(p.end)!);
      return args;
    },
    summarize: (d) => `会话读取 ${countItems(d)} 条消息`,
  },
  list_my_tasks: {
    name: 'list_my_tasks',
    description: '列出指派给我的未完成飞书任务。用于"某任务是否还没做完/是否已办结"。',
    paramsHint: '{}（无参数）',
    build: () => ['task', '+get-my-tasks', '--as', 'user', '--complete=false', '--page-all', '--format', 'json'],
    summarize: (d) => `未完成任务 ${countItems(d)} 条`,
  },
  read_doc: {
    name: 'read_doc',
    description: '读飞书文档当前正文（按 doc token）。若只有链接，先用 resolveUrl 解析出 token。',
    paramsHint: '{ token(doxcn.../docx token) }',
    build: (p) => {
      const token = str(p.token);
      if (!token) throw new Error('read_doc 需要 token');
      return ['docs', '+fetch', '--doc', token, '--api-version', 'v2', '--format', 'json'];
    },
    summarize: (d) => `已读取文档正文（${typeof d === 'string' ? d.length : JSON.stringify(d ?? '').length} 字符）`,
  },
  // MVP49：本地只读命令（fornax-cli 拿 trace / git·rg·grep 查代码库）。不走 lark-cli，走 exec。
  // 硬只读边界全在 runCommand.ts（环境最小化 + 每 CLI 写面护栏 + 路径根限制）。
  run_command: {
    name: 'run_command',
    description: RUN_COMMAND_DESCRIPTION,
    paramsHint: RUN_COMMAND_PARAMS_HINT,
    build: () => {
      throw new Error('run_command 不走 lark-cli build 路径');
    },
    summarize: (d) => (d && typeof d === 'object' && 'summary' in d ? String((d as { summary: unknown }).summary) : 'run_command 已执行'),
    exec: runLocalReadCommand,
  },
};

// 注意：lark-cli 把结果包在 { ok, identity, data: { messages|items|... } } 里。
// 旧实现只看顶层 messages/items，又把 data 当数组判断（它是对象）→ **对每次 IM 搜索都数成 0 条**
// （2026-06-18 实测：搜「高虎伟」API 明明返回多条，countItems 却报 0；这是 55% unknown 的主因）。
// 修复：识别结果数组键，并下钻一层 lark-cli 的 data 信封。
/** 下钻 lark-cli 的 { ok, data: {...} } 信封拿到真正的结果对象。 */
function unwrapEnvelope(d: unknown): unknown {
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const o = d as Record<string, unknown>;
    if (o.data !== undefined && o.data !== d) return o.data;
  }
  return d;
}

/**
 * MVP70：把列表类结果（IM 消息 / 任务 / 文件）压成对模型友好、可读的紧凑文本，取代"喂原始 verbose
 * JSON 被 600 字截断"——后者让模型只看到一堆 chat_id 元数据、看不到消息正文，等于瞎查。
 * 返回空串表示"不是列表结果"，调用方回落原 JSON。导出供测试。
 */
export function compactToolData(data: unknown, maxItems = 8): string {
  const inner = unwrapEnvelope(data) as Record<string, unknown> | unknown;
  const o = (inner && typeof inner === 'object' ? inner : {}) as Record<string, unknown>;
  const msgs = o.messages;
  if (Array.isArray(msgs)) {
    return msgs
      .slice(0, maxItems)
      .map((m: any) => {
        const who = m?.sender?.name ?? m?.sender?.id ?? '?';
        const when = m?.create_time ?? '';
        const where = m?.chat_name ? `[${m.chat_name}] ` : '';
        const text = String(m?.content ?? '').replace(/\s+/g, ' ').slice(0, 180);
        return `${where}${who}（${when}）：${text}`;
      })
      .join('\n');
  }
  const list = o.items ?? o.tasks ?? o.results ?? o.records;
  if (Array.isArray(list)) {
    return list
      .slice(0, maxItems)
      .map((it: any) => `· ${String(it?.title ?? it?.summary ?? it?.name ?? JSON.stringify(it)).replace(/\s+/g, ' ').slice(0, 180)}`)
      .join('\n');
  }
  return '';
}

function countItems(d: unknown): number {
  if (Array.isArray(d)) return d.length;
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>;
    for (const k of ['items', 'messages', 'tasks', 'results', 'records', 'files', 'events', 'chats']) {
      if (Array.isArray(o[k])) return (o[k] as unknown[]).length;
    }
    if (o.data !== undefined && o.data !== d) return countItems(o.data); // 下钻 lark-cli data 信封
  }
  return 0;
}

/** run_command 是否启用（kill-switch + 必须有至少一个白名单 CLI；白名单走运行时来源，用户可改）。 */
function runCommandEnabled(): boolean {
  return config.investigationRunCommandEnabled && getInvestigationReadClis().length > 0;
}

export function listReadTools(): Array<{ name: ReadToolName; description: string; paramsHint: string }> {
  return Object.values(TOOLS)
    .filter((t) => t.name !== 'run_command' || runCommandEnabled())
    .map((t) => ({ name: t.name, description: t.description, paramsHint: t.paramsHint }));
}

/** 执行一个白名单只读工具。任何写命令在 assertReadOnly 处抛错，绝不发出。 */
export async function runReadTool(
  name: ReadToolName,
  params: ReadToolParams,
  deps: ReadToolDeps = {}
): Promise<ReadToolResult> {
  const tool = TOOLS[name];
  if (!tool) return { tool: name, ok: false, summary: '', error: `未知只读工具 ${name}` };
  // run_command 被 kill-switch 关闭时，即便模型请求也拒绝执行。
  if (name === 'run_command' && !runCommandEnabled())
    return { tool: name, ok: false, summary: '', error: 'run_command 已禁用' };
  try {
    if (tool.exec) {
      // 自定义执行器（run_command 本地 spawn）——安全边界在执行器内部。
      const { data, summary } = await tool.exec(params);
      return { tool: name, ok: true, data, summary };
    }
    const runJson = deps.runJson ?? runLarkCliJson;
    const args = tool.build(params);
    assertReadOnly(args); // 硬只读护栏：写命令到不了 runLarkCli
    const data = await runJson(args);
    return { tool: name, ok: true, data, summary: tool.summarize(data) };
  } catch (err) {
    return { tool: name, ok: false, summary: '', error: err instanceof Error ? err.message : String(err) };
  }
}
