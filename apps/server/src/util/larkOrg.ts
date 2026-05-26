/**
 * MVP15 §4.1 飞书组织信息查询封装。
 *
 * 当前 phase（A'）只走 `lark-cli contact +search-user`，因为它在用户已授权的现有
 * scope 下（contact:user:search）就能返回 is_cross_tenant / department（字符串） /
 * email / has_chatted / p2p_chat_id —— 足以推断 external / cross_dept / peer_same_dept。
 *
 * 不在本期范围（等 `contact:user.employee:readonly` 审批后用 lark-cli api 调
 * `/contact/v3/users/:id` 拿 leader_user_id / department_ids / job_title，见
 * MVP15 §4.bis Phase A.5）。
 *
 * 错误分类：调用方按 ErrorKind 决定降级行为
 *   - permission_denied：scope 不够（401/403/permission_violations）。larkOrgCollector
 *     看见这类应该停 retry，等用户重新授权。
 *   - transient：网络 / TLS 超时 / 5xx。下次 tick 再试。
 *   - parse_error：JSON 解析失败 / 字段缺失。记日志，跳过这批。
 */

import { runLarkCli } from './larkCli.js';

export type LarkUserInfo = {
  openId: string;
  localizedName?: string;
  email?: string;
  enterpriseEmail?: string;
  /** 字符串部门名，例 'Lark Base Automation and Integrations'。可能为空字符串或缺失。 */
  department?: string;
  /** true = 外部租户用户；本期 external 判定的核心依据。 */
  isCrossTenant?: boolean;
  isActivated?: boolean;
  hasChatted?: boolean;
  p2pChatId?: string;
};

export type LarkOrgErrorKind = 'permission_denied' | 'transient' | 'parse_error';

export class LarkOrgError extends Error {
  constructor(public readonly kind: LarkOrgErrorKind, message: string) {
    super(message);
    this.name = 'LarkOrgError';
  }
}

/** 单批最大 user_ids 数（飞书侧上限 100；保守取 80 与 nameResolver 一致） */
const SEARCH_USER_BATCH_LIMIT = 80;

type SearchUserResp = {
  ok?: boolean;
  data?: {
    users?: Array<{
      open_id?: string;
      localized_name?: string;
      name?: string;
      en_name?: string;
      email?: string;
      enterprise_email?: string;
      department?: string;
      is_cross_tenant?: boolean;
      is_activated?: boolean;
      has_chatted?: boolean;
      p2p_chat_id?: string;
    }>;
  };
  error?: {
    type?: string;
    code?: number;
    message?: string;
    detail?: {
      permission_violations?: Array<{ subject?: string; type?: string }>;
    };
  };
};

/**
 * 批量查询用户。openIds 内会自动 chunk 成 ≤80 一组。
 *
 * 单次调用整体失败（CLI 非零退出）会按 stderr 判错误类型，抛 `LarkOrgError`。
 * 单 chunk 失败但其他 chunk 成功时：记日志、丢这一批，继续返回成功部分（不抛）。
 *
 * 特殊参数 `openIds === ['me']` 等价于 lark-cli 的 --user-ids me（取当前用户）。
 */
export async function lookupUsers(openIds: string[]): Promise<LarkUserInfo[]> {
  if (openIds.length === 0) return [];
  const out: LarkUserInfo[] = [];

  // 'me' 是 lark-cli 的特殊 token，单独跑（不能跟真实 open_id 混批）
  const me = openIds.includes('me');
  const real = openIds.filter((x) => x !== 'me');

  if (me) {
    const meBatch = await searchUserChunk(['me']);
    out.push(...meBatch);
  }

  for (let i = 0; i < real.length; i += SEARCH_USER_BATCH_LIMIT) {
    const slice = real.slice(i, i + SEARCH_USER_BATCH_LIMIT);
    try {
      const batch = await searchUserChunk(slice);
      out.push(...batch);
    } catch (err) {
      if (err instanceof LarkOrgError && err.kind === 'permission_denied') {
        // permission 错误立即向上抛；后续 chunk 不会通过
        throw err;
      }
      // transient / parse_error：丢这一批，继续
      console.warn(
        `[larkOrg] chunk failed (${slice.length} ids): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return out;
}

/**
 * 按姓名搜索飞书用户。用于给 Work Map 里的 entity 反查 open_id（用户提供 name 但
 * 没 ou_ alias 的情况，比如 LLM draft 提名的人）。
 *
 * 默认带 `--has-chatted`：把搜索范围限制到"我聊过的人"，**显著降低同名碰撞**
 * 在大企业环境下"王某某"重名很常见，has_chatted 是最强的去歧义信号。
 *
 * @returns 候选 LarkUserInfo[]。可能 0 个（找不到）、1 个（确切匹配）、多个（同名）。
 *          调用方负责去歧义。
 */
export async function searchUserByName(
  name: string,
  opts: { hasChatted?: boolean } = {}
): Promise<LarkUserInfo[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];

  const args = [
    'contact',
    '+search-user',
    '--as',
    'user',
    '--query',
    trimmed,
    '--format',
    'json',
    '--page-size',
    '20',
  ];
  // 默认开启 has-chatted（用户在 panel 加的相关人通常都是聊过的）
  if (opts.hasChatted !== false) {
    args.push('--has-chatted');
  }

  const { code, stdout, stderr } = await runLarkCli(args);
  if (code !== 0) {
    throw classifyCliError(code, stderr || stdout);
  }
  let parsed: SearchUserResp;
  try {
    parsed = JSON.parse(stdout) as SearchUserResp;
  } catch {
    throw new LarkOrgError('parse_error', `non-JSON response: ${stdout.slice(0, 300)}`);
  }
  if (parsed.ok === false) {
    throw classifyApiError(parsed);
  }
  const users = parsed.data?.users ?? [];
  return users.flatMap((u) => (u.open_id ? [toLarkUserInfo(u)] : []));
}

async function searchUserChunk(ids: string[]): Promise<LarkUserInfo[]> {
  const args = [
    'contact',
    '+search-user',
    '--as',
    'user',
    '--user-ids',
    ids.join(','),
    '--format',
    'json',
    '--page-size',
    String(Math.min(ids.length, 30)),
  ];
  const { code, stdout, stderr } = await runLarkCli(args);
  if (code !== 0) {
    throw classifyCliError(code, stderr || stdout);
  }
  let parsed: SearchUserResp;
  try {
    parsed = JSON.parse(stdout) as SearchUserResp;
  } catch {
    throw new LarkOrgError('parse_error', `non-JSON response: ${stdout.slice(0, 300)}`);
  }
  // CLI 把 API 错误装在 ok=false 里返回（exit 0），自检一遍
  if (parsed.ok === false) {
    throw classifyApiError(parsed);
  }
  const users = parsed.data?.users ?? [];
  return users.flatMap((u) => (u.open_id ? [toLarkUserInfo(u)] : []));
}

function toLarkUserInfo(u: NonNullable<NonNullable<SearchUserResp['data']>['users']>[number]): LarkUserInfo {
  return {
    openId: u.open_id!, // searchUserChunk 已过滤
    localizedName: u.localized_name || u.name || u.en_name || undefined,
    email: u.email || undefined,
    enterpriseEmail: u.enterprise_email || undefined,
    department: u.department || undefined,
    isCrossTenant: typeof u.is_cross_tenant === 'boolean' ? u.is_cross_tenant : undefined,
    isActivated: typeof u.is_activated === 'boolean' ? u.is_activated : undefined,
    hasChatted: typeof u.has_chatted === 'boolean' ? u.has_chatted : undefined,
    p2pChatId: u.p2p_chat_id || undefined,
  };
}

function classifyCliError(code: number, stderrText: string): LarkOrgError {
  // lark-cli auth/permission 失败时 exit 非零，stderr 含 permission/scope 关键词
  const txt = (stderrText || '').toLowerCase();
  if (
    code === 401 ||
    code === 403 ||
    txt.includes('permission') ||
    txt.includes('scope') ||
    txt.includes('unauthorized')
  ) {
    return new LarkOrgError('permission_denied', `lark-cli exit ${code}: ${stderrText.slice(-300)}`);
  }
  return new LarkOrgError('transient', `lark-cli exit ${code}: ${stderrText.slice(-300)}`);
}

function classifyApiError(resp: SearchUserResp): LarkOrgError {
  const err = resp.error;
  const type = err?.type ?? '';
  const violations = err?.detail?.permission_violations ?? [];
  const msg = `${err?.code ?? '?'} ${err?.message ?? 'unknown error'}`;
  if (type === 'permission' || violations.length > 0) {
    return new LarkOrgError('permission_denied', msg);
  }
  return new LarkOrgError('transient', msg);
}
