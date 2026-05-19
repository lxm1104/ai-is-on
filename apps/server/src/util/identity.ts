import { runLarkCliJson } from './larkCli.js';

let cached: { openId: string; userName?: string } | null = null;
let inflight: Promise<string> | null = null;

type AuthStatus = {
  userOpenId?: string;
  userName?: string;
};

/** Cached lookup of the current user's open_id via `lark-cli auth status`. */
export async function getMyOpenId(): Promise<string> {
  if (cached) return cached.openId;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const status = await runLarkCliJson<AuthStatus>(['auth', 'status']);
      if (!status.userOpenId) throw new Error('lark-cli auth status: missing userOpenId');
      cached = { openId: status.userOpenId, userName: status.userName };
      return status.userOpenId;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getMyUserName(): string | undefined {
  return cached?.userName;
}
