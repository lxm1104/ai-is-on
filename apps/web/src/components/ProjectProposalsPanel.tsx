// MVP19 §M4 — Project canonical proposals 审核面板（**最小可用版本**）。
//
// 锁死最小：GET 列表 + 行内 3 个按钮触发 POST。无样式、无分页、无批量。
// 不再追加 UI 投入；如审核需求真的不够用，再回头扩。
import { useEffect, useState } from 'react';
import {
  fetchProjectProposals,
  resolveProjectProposal,
  type ProjectProposal,
} from '../lib/api';

export function ProjectProposalsPanel() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ProjectProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 每行的 inline target 输入（approve_alias 用）
  const [aliasTarget, setAliasTarget] = useState<Record<string, string>>({});
  // 每行的 inline parent 输入（approve_new 用）
  const [parentInput, setParentInput] = useState<Record<string, string>>({});
  // 每行的 busy 状态
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      setItems(await fetchProjectProposals());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  async function handle(id: string, body: Parameters<typeof resolveProjectProposal>[1]) {
    setBusy(id);
    setErr(null);
    try {
      const r = await resolveProjectProposal(id, body);
      if (!r.ok) {
        const msg =
          r.error === 'alias_conflict' && r.alias
            ? `alias "${r.alias}" 已属于 "${r.existingCanonical}"，无法分配`
            : `处理失败：${r.error ?? '未知错误'}`;
        setErr(msg);
        return;
      }
      // 成功就刷新
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border, #ddd)', padding: '8px 12px' }}>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 13 }}
      >
        {open ? '▾' : '▸'} 项目名审核 {items.length > 0 && open ? `(${items.length})` : ''}
      </button>
      {open && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          {loading && <div>加载中…</div>}
          {err && <div style={{ color: '#c00' }}>{err}</div>}
          {!loading && items.length === 0 && (
            <div style={{ color: 'var(--muted, #888)' }}>暂无待审核项目名。</div>
          )}
          {items.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted, #888)' }}>
                  <th style={{ padding: '4px 6px' }}>名字</th>
                  <th style={{ padding: '4px 6px' }}>次数</th>
                  <th style={{ padding: '4px 6px' }}>最近</th>
                  <th style={{ padding: '4px 6px' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const rowBusy = busy === p.id;
                  return (
                    <tr key={p.id} style={{ borderTop: '1px solid var(--border, #eee)' }}>
                      <td style={{ padding: '4px 6px', fontFamily: 'monospace' }}>
                        {p.proposedName}
                      </td>
                      <td style={{ padding: '4px 6px' }}>{p.occurrences}</td>
                      <td style={{ padding: '4px 6px', color: 'var(--muted, #888)' }}>
                        {new Date(p.lastSeenAt).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td style={{ padding: '4px 6px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <input
                          type="text"
                          placeholder="parent (可选)"
                          value={parentInput[p.id] ?? ''}
                          onChange={(e) =>
                            setParentInput((m) => ({ ...m, [p.id]: e.target.value }))
                          }
                          disabled={rowBusy}
                          style={{ fontSize: 11, padding: '2px 4px', width: 110 }}
                        />
                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() =>
                            void handle(p.id, {
                              action: 'approve_new',
                              parentCanonical: parentInput[p.id]?.trim() || undefined,
                            })
                          }
                          style={{ fontSize: 11 }}
                        >
                          建为新 canonical
                        </button>
                        <input
                          type="text"
                          placeholder="合并到的 canonical"
                          value={aliasTarget[p.id] ?? ''}
                          onChange={(e) =>
                            setAliasTarget((m) => ({ ...m, [p.id]: e.target.value }))
                          }
                          disabled={rowBusy}
                          style={{ fontSize: 11, padding: '2px 4px', width: 130 }}
                        />
                        <button
                          type="button"
                          disabled={rowBusy || !aliasTarget[p.id]?.trim()}
                          onClick={() =>
                            void handle(p.id, {
                              action: 'approve_alias',
                              target: aliasTarget[p.id].trim(),
                            })
                          }
                          style={{ fontSize: 11 }}
                        >
                          合并为别名
                        </button>
                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() => void handle(p.id, { action: 'rejected' })}
                          style={{ fontSize: 11 }}
                        >
                          忽略
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
