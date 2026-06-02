import { runLarkCliJson } from './larkCli.js';

let cached: { openId: string; userName?: string } | null = null;
let inflight: Promise<string> | null = null;

type AuthStatus = {
  userOpenId?: string;
  userName?: string;
  identities?: {
    user?: {
      openId?: string;
      userName?: string;
    };
  };
};

export function parseMyIdentity(status: AuthStatus): { openId: string; userName?: string } | null {
  const openId = status.userOpenId ?? status.identities?.user?.openId;
  if (!openId) return null;
  return {
    openId,
    userName: status.userName ?? status.identities?.user?.userName,
  };
}

/** Cached lookup of the current user's open_id via `lark-cli auth status`. */
export async function getMyOpenId(): Promise<string> {
  if (cached) return cached.openId;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const status = await runLarkCliJson<AuthStatus>(['auth', 'status']);
      const identity = parseMyIdentity(status);
      if (!identity) throw new Error('lark-cli auth status: missing userOpenId');
      cached = identity;
      return identity.openId;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getMyUserName(): string | undefined {
  return cached?.userName;
}
