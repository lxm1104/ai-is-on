import { useEffect, useState } from 'react';
import {
  fetchPlaybooks,
  savePlaybook,
  approvePlaybook,
  setPlaybookActive,
  type TaskPlaybook,
} from '../lib/api';

/**
 * MVP37 流程记忆面板：用户在这里补充信息、加速 playbook 收敛。
 * - 列出已学/用户编写的 playbook（按任务类型）
 * - 编写/编辑一份权威 playbook（教 AI 这类任务怎么做）
 * - 批准自学草稿 → 升权威；停用/启用
 */
export function PlaybookPanel() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TaskPlaybook[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null); // 正在编辑/新建的 taskTypeKey（'' = 新建）
  const [form, setForm] = useState({ taskTypeKey: '', title: '', stepsText: '' });
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchPlaybooks());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (open) void load();
  }, [open]);

  function startEdit(p?: TaskPlaybook) {
    if (p) {
      setEditKey(p.taskTypeKey);
      setForm({ taskTypeKey: p.taskTypeKey, title: p.title, stepsText: p.steps.map((s) => s.intent).join('\n') });
    } else {
      setEditKey('');
      setForm({ taskTypeKey: '', title: '', stepsText: '' });
    }
  }

  async function submit() {
    const steps = form.stepsText.split('\n').map((l) => l.trim()).filter(Boolean).map((intent, i) => ({ order: i + 1, intent }));
    if (!form.taskTypeKey.trim() || !form.title.trim() || steps.length === 0) {
      setError('任务类型键 / 标题 / 至少一步 必填');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await savePlaybook({ taskTypeKey: form.taskTypeKey.trim(), title: form.title.trim(), steps });
      setEditKey(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doApprove(key: string) {
    setBusy(true);
    try {
      await approvePlaybook(key);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function doToggleActive(p: TaskPlaybook) {
    setBusy(true);
    try {
      await setPlaybookActive(p.taskTypeKey, !p.active);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`ctx-panel ${open ? 'is-open' : ''}`}>
      <button type="button" className="ctx-panel__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="ctx-panel__chev">{open ? '▾' : '▸'}</span>
        流程记忆 (Playbook){items.length ? ` · ${items.length}` : ''}
      </button>
      {open && (
        <div className="ctx-panel__body">
          <p className="playbook__hint">
            教 AI「这类任务怎么做」——你写的会立刻生效并优先于 AI 自学的草稿。任务类型键形如 <code>follow_up:verify</code>。
          </p>
          {error && <p className="card__reply-err">⚠ {error}</p>}
          <button type="button" className="btn btn--card" disabled={busy} onClick={() => startEdit()}>
            ＋ 新建流程
          </button>
          {editKey !== null && (
            <div className="playbook__form">
              <input
                placeholder="任务类型键，如 follow_up:verify"
                value={form.taskTypeKey}
                disabled={editKey !== ''}
                onChange={(e) => setForm({ ...form, taskTypeKey: e.target.value })}
              />
              <input placeholder="这套流程的名字" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <textarea
                placeholder="每行一步，按顺序写。如：&#10;搜双方 IM 确认是否提过/发过&#10;读关联文档或任务确认当前状态"
                rows={4}
                value={form.stepsText}
                onChange={(e) => setForm({ ...form, stepsText: e.target.value })}
              />
              <div className="card__reply-actions">
                <button type="button" className="btn btn--card btn--reply-send" disabled={busy} onClick={() => void submit()}>
                  {busy ? '保存中…' : '保存（权威）'}
                </button>
                <button type="button" className="btn btn--card" disabled={busy} onClick={() => setEditKey(null)}>
                  取消
                </button>
              </div>
            </div>
          )}
          {loading ? (
            <p className="playbook__hint">加载中…</p>
          ) : items.length === 0 ? (
            <p className="playbook__hint">还没有 playbook。AI 自主排查会逐步学出草稿，你也可以直接新建。</p>
          ) : (
            <ul className="playbook__list">
              {items.map((p) => (
                <li key={p.id} className={`playbook__item${p.active ? '' : ' playbook__item--off'}`}>
                  <div className="playbook__row">
                    <code>{p.taskTypeKey}</code>
                    <span className={`playbook__tag playbook__tag--${p.origin}`}>{p.origin === 'user' ? '你写的' : '自学'}</span>
                    {p.approved && p.origin !== 'user' && <span className="playbook__tag playbook__tag--ok">已批准</span>}
                    {!p.approved && p.origin !== 'user' && <span className="playbook__tag">草稿</span>}
                  </div>
                  <div className="playbook__title">{p.title}</div>
                  <ol className="playbook__steps">
                    {p.steps.slice().sort((a, b) => a.order - b.order).map((s, i) => (
                      <li key={i}>{s.intent}</li>
                    ))}
                  </ol>
                  <div className="card__reply-actions">
                    <button type="button" className="btn btn--card" disabled={busy} onClick={() => startEdit(p)}>编辑</button>
                    {!p.approved && p.origin !== 'user' && (
                      <button type="button" className="btn btn--card btn--reply-send" disabled={busy} onClick={() => void doApprove(p.taskTypeKey)}>批准</button>
                    )}
                    <button type="button" className="btn btn--card" disabled={busy} onClick={() => void doToggleActive(p)}>
                      {p.active ? '停用' : '启用'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
