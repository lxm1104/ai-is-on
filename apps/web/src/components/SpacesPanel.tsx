import { useEffect, useState } from 'react';
import {
  createContextSpace,
  fetchContextSpaceDetail,
  fetchContextSpaces,
  reconcileContextSpaces,
  type ContextSpace,
  type ContextSpaceDetail,
} from '../lib/api';
import type { ContextUnit } from '../types';

export function SpacesPanel() {
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<ContextSpace[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContextSpaceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createName, setCreateName] = useState('');
  const [createType, setCreateType] = useState<'project' | 'topic'>('project');
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setSpaces(await fetchContextSpaces());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const d = await fetchContextSpaceDetail(selectedId);
        if (!cancelled) setDetail(d);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function onCreate() {
    const name = createName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const space = await createContextSpace({ name, type: createType });
      setCreateName('');
      await refresh();
      setSelectedId(space.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function onReconcile() {
    setLoading(true);
    setError(null);
    try {
      const r = await reconcileContextSpaces();
      if (selectedId) {
        const d = await fetchContextSpaceDetail(selectedId);
        setDetail(d);
      }
      // ephemeral toast via error slot
      setError(`reconciled: scanned=${r.scanned} linked=${r.linked}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`ctx-panel sp-panel ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="ctx-panel__toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Spaces</span>
        <span className="ctx-panel__chev">{open ? '▾' : '▸'}</span>
        {open && (
          <span className="ctx-panel__counts">
            {spaces.length} space{spaces.length === 1 ? '' : 's'}
          </span>
        )}
      </button>
      {open && (
        <div className="ctx-panel__body">
          <div className="sp-panel__createbar">
            <select
              value={createType}
              onChange={(e) => setCreateType(e.target.value as 'project' | 'topic')}
              disabled={creating}
            >
              <option value="project">project</option>
              <option value="topic">topic</option>
            </select>
            <input
              type="text"
              placeholder="新 Space 名字 (e.g. AI is ON)"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              disabled={creating}
            />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void onCreate()}
              disabled={creating || !createName.trim()}
            >
              {creating ? '创建中…' : '+ 创建'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void onReconcile()}
              disabled={loading}
              title="重新扫描所有 ContextUnit 并归入匹配的 Space"
            >
              ↻ 关联
            </button>
          </div>
          {error && <div className="ctx-panel__err">{error}</div>}
          {spaces.length === 0 && !loading && (
            <div className="ctx-panel__empty">还没有 Space。创建一个开始项目化的 context。</div>
          )}
          <ul className="sp-list">
            {spaces.map((s) => (
              <li
                key={s.id}
                className={`sp-list__item ${selectedId === s.id ? 'is-on' : ''}`}
                onClick={() => setSelectedId(s.id === selectedId ? null : s.id)}
              >
                <span className={`sp-type sp-type--${s.type}`}>{s.type}</span>
                <span className="sp-name">{s.name}</span>
              </li>
            ))}
          </ul>
          {detail && selectedId && (
            <SpaceDetail detail={detail} />
          )}
        </div>
      )}
    </div>
  );
}

function SpaceDetail({ detail }: { detail: ContextSpaceDetail }) {
  const { space, commitments, goals, risks, state, recentEvents, allUnitCount, entityLinks } = detail;
  return (
    <div className="sp-detail">
      <div className="sp-detail__head">
        <strong>{space.name}</strong>
        <span className="sp-detail__meta">
          {allUnitCount} unit{allUnitCount === 1 ? '' : 's'} · {entityLinks.length} seed entit{entityLinks.length === 1 ? 'y' : 'ies'}
        </span>
      </div>
      {space.description && <div className="sp-detail__desc">{space.description}</div>}
      <SpaceGroup title="关键承诺" units={commitments} />
      <SpaceGroup title="目标 / 意图" units={goals} />
      <SpaceGroup title="状态" units={state} />
      <SpaceGroup title="风险 / 不确定" units={risks} />
      <SpaceGroup title="近期事件" units={recentEvents} />
      {allUnitCount === 0 && (
        <div className="ctx-panel__empty">这个 Space 还没绑到任何 ContextUnit。点 ↻ 关联 试试。</div>
      )}
    </div>
  );
}

function SpaceGroup({ title, units }: { title: string; units: ContextUnit[] }) {
  if (!units || units.length === 0) return null;
  return (
    <div className="sp-group">
      <div className="sp-group__title">{title}（{units.length}）</div>
      <ul className="sp-group__list">
        {units.slice(0, 6).map((u) => (
          <li key={u.id} className="sp-group__item">
            <span className={`ctx-kind ctx-kind--${u.kind}`}>{u.kind}</span>
            <span className="sp-group__name">{u.title}</span>
            {u.time?.dueAt && <span className="sp-group__due">due {shortTime(u.time.dueAt)}</span>}
          </li>
        ))}
        {units.length > 6 && (
          <li className="sp-group__more">… 另外 {units.length - 6} 条</li>
        )}
      </ul>
    </div>
  );
}

function shortTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}
