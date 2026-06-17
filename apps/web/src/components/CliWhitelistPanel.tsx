import { useEffect, useState } from 'react';
import {
  fetchCliWhitelist,
  saveCliWhitelist,
  resetCliWhitelist,
  type CliWhitelistInfo,
  type CliRisk,
} from '../lib/api';

// 客户端快速校验（fail-fast UX）。服务端 validateCli 才是权威；这里只挡最常见的非法/危险输入，
// 与服务端规则保持一致：格式正则 + 长度 + 一小撮高危命令（完整 DENY 在后端）。
const CLI_NAME_RE = /^[a-z0-9][a-z0-9_.+-]*$/;
const CLIENT_DENY = new Set([
  'bash', 'sh', 'zsh', 'fish', 'python', 'python3', 'node', 'ruby', 'perl', 'php', 'awk', 'sed',
  'curl', 'wget', 'nc', 'ssh', 'scp', 'rm', 'mv', 'cp', 'dd', 'tee', 'chmod', 'tar', 'env', 'xargs',
  'sudo', 'make', 'npm', 'npx', 'pip', 'docker', 'kubectl', 'vim', 'less', 'fd', 'sd', 'lark-cli',
]);
function clientValidate(c: string): string | null {
  if (c.length > 64) return 'CLI 名过长（上限 64 字符）';
  if (!CLI_NAME_RE.test(c.toLowerCase())) return '名称非法：只允许字母/数字与 . _ + -，且需以字母或数字开头';
  if (CLIENT_DENY.has(c.toLowerCase())) return `「${c}」是 shell/解释器/网络/写删类命令，禁止加入白名单`;
  return null;
}

/**
 * MVP53 自主排查只读 CLI 白名单面板：把 config.investigationReadClis 这道安全边界显式化、可改。
 * - 列出当前生效的 CLI + 风险分级（已护栏 / 只读 / 自定义）
 * - 增（输入只读命令名）/ 删（移除）/ 恢复默认；每次操作立即保存，后端逐项校验
 * - shell/解释器/网络/写删类命令后端硬拒（保存时报错回显）
 */
const RISK_LABEL: Record<CliRisk, string> = {
  guarded: '已护栏',
  readonly: '只读',
  custom: '自定义 · 仅通用防护',
};
const RISK_CLASS: Record<CliRisk, string> = {
  guarded: 'playbook__tag--ok',
  readonly: '',
  custom: 'playbook__tag--warn',
};

export function CliWhitelistPanel() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<CliWhitelistInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCli, setNewCli] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setInfo(await fetchCliWhitelist());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (open) void load();
  }, [open]);

  async function persist(clis: string[]) {
    setBusy(true);
    setError(null);
    try {
      setInfo(await saveCliWhitelist(clis));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function addCli() {
    const c = newCli.trim();
    if (!c) return;
    const err = clientValidate(c);
    if (err) {
      setError(err);
      return;
    }
    if (info?.clis.includes(c.toLowerCase())) {
      setError(`「${c}」已在白名单`);
      return;
    }
    await persist([...(info?.clis ?? []), c]);
    setNewCli('');
  }
  async function removeCli(cli: string) {
    if (!info) return;
    await persist(info.clis.filter((x) => x !== cli));
  }
  async function doReset() {
    setBusy(true);
    setError(null);
    try {
      setInfo(await resetCliWhitelist());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const count = info?.clis.length ?? 0;
  const customCount = info?.entries.filter((e) => e.risk === 'custom').length ?? 0;

  return (
    <div className={`ctx-panel ${open ? 'is-open' : ''}`}>
      <button type="button" className="ctx-panel__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="ctx-panel__chev">{open ? '▾' : '▸'}</span>
        排查命令白名单{count ? ` · ${count}${customCount ? ` (${customCount} 自定义)` : ''}` : ''}
      </button>
      {open && (
        <div className="ctx-panel__body">
          <p className="playbook__hint">
            自主排查的 <code>run_command</code> 只能调起这里列出的<strong>只读 CLI</strong>，这是给无人在环 AI 的安全边界。
            <span style={{ color: 'var(--ok)' }}>已护栏</span>=有专项写面拦截（git/fornax-cli/bytedcli/rg/find）；
            <span>只读</span>=已知无害工具；
            <span style={{ color: 'var(--warn)' }}>自定义</span>=你自加、只有通用防护（无 shell · 环境最小化 · 路径根限制），请只加你信任的只读命令。
            shell/解释器/网络/写删类（bash · python · curl · rm…）会被拒绝。
          </p>
          {info && !info.runCommandEnabled && (
            <p className="card__reply-err">⚠ run_command 当前未启用（白名单为空，或被 kill-switch 关闭）。</p>
          )}
          {error && <p className="card__reply-err">⚠ {error}</p>}
          {loading ? (
            <p className="playbook__hint">加载中…</p>
          ) : info ? (
            <>
              <ul className="playbook__list">
                {info.entries.map((e) => (
                  <li key={e.cli} className="playbook__item">
                    <div className="playbook__row">
                      <code style={{ fontSize: 12 }}>{e.cli}</code>
                      <span className={`playbook__tag ${RISK_CLASS[e.risk]}`}>{RISK_LABEL[e.risk]}</span>
                      <button
                        type="button"
                        className="btn btn--card"
                        style={{ marginLeft: 'auto' }}
                        disabled={busy}
                        onClick={() => void removeCli(e.cli)}
                        title="从白名单移除"
                      >
                        移除
                      </button>
                    </div>
                  </li>
                ))}
                {info.entries.length === 0 && (
                  <li className="playbook__hint">白名单为空 —— 自主排查跑不了任何本地命令。</li>
                )}
              </ul>
              <div className="playbook__form">
                <div className="card__reply-actions">
                  <input
                    aria-label="新增只读 CLI 名称"
                    placeholder="新增只读 CLI（如 tokei、gron…）"
                    value={newCli}
                    disabled={busy}
                    onChange={(ev) => setNewCli(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') void addCli();
                    }}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn btn--card btn--reply-send"
                    disabled={busy || !newCli.trim()}
                    onClick={() => void addCli()}
                  >
                    {busy ? '保存中…' : '添加'}
                  </button>
                </div>
              </div>
              {info.customized && (
                <div className="card__reply-actions">
                  <button type="button" className="btn btn--card" disabled={busy} onClick={() => void doReset()}>
                    恢复默认（{info.default.length} 项）
                  </button>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
