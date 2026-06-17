import { useEffect, useState } from 'react';
import { fetchProblemClasses, editProblemClass, approveProblemClass, type ProblemClass } from '../lib/api';

/**
 * MVP51 问题类台账面板：AI 把已诊断的事项按**根因**自动汇总成"问题类"，这里看 + 校正。
 * - 列出每个问题类：标签、根因、成员数、是否系统性、来源（自学/你校正）
 * - 编辑标签/根因 → 升权威版（自发蒸馏不再覆盖）；批准草稿
 */
export function ProblemClassPanel() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ProblemClass[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ label: '', rootCause: '' });
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchProblemClasses();
      list.sort((a, b) => Number(b.systemic) - Number(a.systemic) || b.memberCount - a.memberCount);
      setItems(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (open) void load();
  }, [open]);

  function startEdit(c: ProblemClass) {
    setEditId(c.id);
    setForm({ label: c.label, rootCause: c.rootCause });
  }
  async function submit() {
    if (!form.label.trim() || !form.rootCause.trim()) {
      setError('标签 / 根因 必填');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await editProblemClass(editId!, { label: form.label.trim(), rootCause: form.rootCause.trim() });
      setEditId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function doApprove(id: string) {
    setBusy(true);
    try {
      await approveProblemClass(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const systemicCount = items.filter((c) => c.systemic).length;

  return (
    <div className={`ctx-panel ${open ? 'is-open' : ''}`}>
      <button type="button" className="ctx-panel__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="ctx-panel__chev">{open ? '▾' : '▸'}</span>
        问题类台账{items.length ? ` · ${items.length}${systemicCount ? ` (${systemicCount} 系统性)` : ''}` : ''}
      </button>
      {open && (
        <div className="ctx-panel__body">
          <p className="playbook__hint">
            AI 把已诊断的事项按<strong>根因</strong>自动汇总成"问题类"——同症状不同根因会拆开。某类攒到 ≥3 个成员自动标「系统性」。你可以校正根因（升权威，AI 不再覆盖）。
          </p>
          {error && <p className="card__reply-err">⚠ {error}</p>}
          {loading ? (
            <p className="playbook__hint">加载中…</p>
          ) : items.length === 0 ? (
            <p className="playbook__hint">还没有问题类。AI 自主排查出根因后会自动归类；或 POST /api/problem-classes/backfill 从历史回填。</p>
          ) : (
            <ul className="playbook__list">
              {items.map((c) => (
                <li key={c.id} className="playbook__item">
                  <div className="playbook__row">
                    {c.systemic && <span className="playbook__tag playbook__tag--ok">系统性</span>}
                    <span className="playbook__tag">成员 {c.memberCount}</span>
                    <span className={`playbook__tag playbook__tag--${c.origin}`}>{c.origin === 'user' ? '你校正' : c.approved ? '已批准' : '自学'}</span>
                  </div>
                  {editId === c.id ? (
                    <div className="playbook__form">
                      <input placeholder="问题类标签" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
                      <textarea placeholder="这一类 case 是哪一种问题引起的（根因）" rows={3} value={form.rootCause} onChange={(e) => setForm({ ...form, rootCause: e.target.value })} />
                      <div className="card__reply-actions">
                        <button type="button" className="btn btn--card btn--reply-send" disabled={busy} onClick={() => void submit()}>
                          {busy ? '保存中…' : '保存（权威）'}
                        </button>
                        <button type="button" className="btn btn--card" disabled={busy} onClick={() => setEditId(null)}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="playbook__title">{c.label}</div>
                      <div className="sp-profile__text" style={{ whiteSpace: 'pre-wrap' }}>{c.rootCause}</div>
                      {c.members.length > 0 && (
                        <ol className="playbook__steps">
                          {c.members.slice(0, 6).map((m) => (
                            <MemberTraceRow key={m.matterId} member={m} />
                          ))}
                        </ol>
                      )}
                      <div className="card__reply-actions">
                        <button type="button" className="btn btn--card" disabled={busy} onClick={() => startEdit(c)}>校正根因</button>
                        {!c.approved && c.origin !== 'user' && (
                          <button type="button" className="btn btn--card btn--reply-send" disabled={busy} onClick={() => void doApprove(c.id)}>批准</button>
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// MVP53b：台账下钻——点成员展开它那一次自主排查的工具链（直接打 matter-keyed 端点，不经 api.ts）
type TraceStepLite = { order: number; kind: string; tool?: string; summary: string; params?: Record<string, unknown> };
type TraceLite = { outcome: string | null; steps: TraceStepLite[] } | null;

function MemberTraceRow({ member }: { member: { matterId: string; diagnosticText: string } }) {
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<TraceLite | undefined>(undefined); // undefined=未拉取
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && trace === undefined) {
      try {
        const r = await fetch(`/api/matters/${encodeURIComponent(member.matterId)}/investigation-trace`);
        const j = await r.json();
        setTrace(j.trace ?? null);
      } catch {
        setTrace(null);
      }
    }
  }
  return (
    <li style={{ marginBottom: 4 }}>
      <button
        type="button"
        onClick={() => void toggle()}
        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left', padding: 0, font: 'inherit' }}
      >
        {open ? '▾' : '▸'} {member.diagnosticText.slice(0, 80)}
      </button>
      {open && trace !== undefined && (
        <div style={{ fontSize: 12, marginTop: 4, paddingLeft: 12, opacity: 0.9 }}>
          {trace === null ? (
            <span style={{ opacity: 0.6 }}>（这条没有自主排查的工具链记录）</span>
          ) : (
            <>
              {trace.outcome && <div style={{ marginBottom: 4, opacity: 0.8 }}>结论：{trace.outcome}</div>}
              <ol style={{ margin: 0, paddingLeft: 16 }}>
                {trace.steps.map((s) => (
                  <li key={s.order}>
                    <code>{s.tool ?? s.kind}</code> → {s.summary}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </li>
  );
}
