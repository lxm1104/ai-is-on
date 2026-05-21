/**
 * Build the env for a spawned Claude Code CLI subprocess.
 *
 * When this server itself is started from inside a Claude Code session, the
 * parent injects a host-managed OAuth token (ANTHROPIC_API_KEY +
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1). That token is only valid for the
 * host process — if a child subprocess uses it to call api.anthropic.com it
 * gets back `403 {"error":{"type":"forbidden","message":"Request not allowed"}}`.
 *
 * Stripping these makes the spawned CLI fall back to the user's own
 * `claude login` credentials.
 */
const HOST_MANAGED_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
] as const;

export function buildClaudeChildEnv(
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of HOST_MANAGED_KEYS) delete env[k];
  return env;
}
