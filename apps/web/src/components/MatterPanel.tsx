// MVP29B — Matter Panel：事项状态层的可视化 + 用户纠错/控制。
// mirror ContextPanel 的折叠面板模式；tabs 按状态分组；点开某条看 detail（摘要/证据/时间线）
// + 动作（标记已处理 / 放弃 / 重开 / 合并 / 拆分 / 标记证据不属于）。
import { useEffect, useState } from 'react';
import {
  fetchMatterDetail,
  fetchMatters,
  postMatterDrop,
  postMatterMerge,
  postMatterReopen,
  postMatterResolve,
  postMatterSplit,
  postMatterWrongEvidence,
} from '../lib/api';
import type { MatterDetail, MatterListItem, MatterStatus } from '../types';

type Tab = 'active' | 'waiting' | 'blocked' | 'resolved';

const TAB_STATUSES: Record<Tab, MatterStatus[]> = {
  active: ['open', 'acknowledged', 'in_progress'],
  waiting: ['waiting'],
  blocked: ['blocked'],
  resolved: ['resolved', 'dropped'],
};
const TAB_LABEL: Record<Tab, string> = {
  active: '进行中',
  waiting: '等待',
  blocked: '阻塞',
  resolved: '已了结',
};
const STATUS_LABEL: Record<string, string> = {
  open: '待办',
  acknowledged: '已确认',
  in_progress: '进行中',
  waiting: '等待',
  blocked: '阻塞',
  resolved: '已完成',
  dropped: '已放弃',
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function fmt(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
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

export function MatterPanel({ refreshSignal }: { refreshSignal?: number }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('active');
  const [matters, setMatters] = useState<MatterListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MatterDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reloadList(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setMatters(await fetchMatters(TAB_STATUSES[tab], 100));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }
  async function reloadDetail(id: string): Promise<void> {
    try {
      setDetail(await fetchMatterDetail(id));
    } catch (err) {
      setError(errMsg(err));
    }
  }

  useEffect(() => {
    if (!open) return;
    void reloadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, refreshSignal]);

  useEffect(() => {
    if (open && selectedId) void reloadDetail(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, refreshSignal, open]);

  function select(id: string): void {
    setSelectedId((cur) => (cur === id ? null : id));
    setDetail(null);
  }

  async function act(fn: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reloadList();
      if (selectedId) await reloadDetail(selectedId);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`ctx-panel ${open ? 'is-open' : ''}`}>
      <button className="ctx-panel__toggle" onClick={() => setOpen((v) => !v)}>
        <span>事项 Matter</span>
        <span className="ctx-panel__chev">{open ? '▾' : '▸'}</span>
        {open && <span className="ctx-panel__counts">{matters.length}</span>}
      </button>
      {open && (
        <div className="ctx-panel__body">
          <div className="ctx-panel__tabs">
            {(Object.keys(TAB_STATUSES) as Tab[]).map((t) => (
              <button
                key={t}
                className={`ctx-panel__tab ${tab === t ? 'is-on' : ''}`}
                onClick={() => {
                  setTab(t);
                  setSelectedId(null);
                  setDetail(null);
                }}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
            <button className="btn btn--ghost" onClick={() => void reloadList()} disabled={loading}>
              刷新
            </button>
          </div>
          {error && <div className="ctx-panel__err">{error}</div>}
          {loading && matters.length === 0 ? (
            <div className="ctx-panel__empty">加载中…</div>
          ) : matters.length === 0 ? (
            <div className="ctx-panel__empty">这个状态下暂无事项</div>
          ) : (
            <ul className="matter-list">
              {matters.map((m) => (
                <li key={m.id}>
                  <MatterRow m={m} selected={selectedId === m.id} onClick={() => select(m.id)} />
                  {selectedId === m.id && detail && detail.id === m.id && (
                    <MatterDetailView detail={detail} allMatters={matters} busy={busy} onAct={act} />
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

function MatterRow({
  m,
  selected,
  onClick,
}: {
  m: MatterListItem;
  selected: boolean;
  onClick: () => void;
}) {
  const people = m.entities.filter((e) => e.type === 'person' && e.name).slice(0, 3);
  return (
    <div className={`matter-item ${selected ? 'is-selected' : ''}`} onClick={onClick}>
      <div className="matter-item__head">
        <span className={`matter-status matter-status--${m.status}`}>
          {STATUS_LABEL[m.status] ?? m.status}
        </span>
        <span className={`matter-prio matter-prio--${m.priority}`}>{m.priority}</span>
        <span className="matter-item__title">{m.title}</span>
      </div>
      <div className="matter-item__meta">
        <span className="matter-type">{m.type}</span>
        {m.dueAt && <span className="matter-due">due {fmt(m.dueAt)}</span>}
        {people.map((e) => (
          <span key={e.entityId} className="matter-chip">
            {e.name}
          </span>
        ))}
        <span className="matter-ev-count">{m.evidenceCount} 证据</span>
      </div>
    </div>
  );
}

function MatterDetailView({
  detail,
  allMatters,
  busy,
  onAct,
}: {
  detail: MatterDetail;
  allMatters: MatterListItem[];
  busy: boolean;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [mergeTarget, setMergeTarget] = useState('');
  const isDone = detail.status === 'resolved' || detail.status === 'dropped';
  const others = allMatters.filter((x) => x.id !== detail.id);

  return (
    <div className="matter-detail">
      {detail.currentSummary && <div className="matter-detail__summary">{detail.currentSummary}</div>}
      {detail.nextAction && <div className="matter-detail__next">下一步：{detail.nextAction}</div>}
      {detail.spaces.length > 0 && (
        <div className="matter-detail__spaces">{detail.spaces.map((s) => s.name).join(' · ')}</div>
      )}

      <div className="matter-actions">
        {!isDone && (
          <button className="btn btn--ghost" disabled={busy} onClick={() => onAct(() => postMatterResolve(detail.id))}>
            标记已处理
          </button>
        )}
        {!isDone && (
          <button className="btn btn--ghost" disabled={busy} onClick={() => onAct(() => postMatterDrop(detail.id))}>
            放弃
          </button>
        )}
        {isDone && (
          <button className="btn btn--ghost" disabled={busy} onClick={() => onAct(() => postMatterReopen(detail.id))}>
            重开
          </button>
        )}
        {others.length > 0 && (
          <span className="matter-merge">
            <select value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)} disabled={busy}>
              <option value="">合并到…</option>
              {others.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
            <button
              className="btn btn--ghost"
              disabled={busy || !mergeTarget}
              onClick={() => mergeTarget && onAct(() => postMatterMerge(detail.id, mergeTarget))}
            >
              合并
            </button>
          </span>
        )}
      </div>

      <div className="matter-detail__section">
        <div className="matter-detail__head">证据（{detail.evidence.length}）</div>
        <ul className="matter-evlist">
          {detail.evidence.map((ev) => (
            <li key={`${ev.contextUnitId}:${ev.relation}`} className="matter-ev-item">
              <div className="matter-ev-head">
                <span className="matter-ev-rel">{ev.relation}</span>
                {ev.kind && <span className="matter-ev-kind">{ev.kind}</span>}
                <span className="matter-ev-title">{ev.title ?? ev.contextUnitId.slice(0, 8)}</span>
              </div>
              <div className="matter-ev-actions">
                <button
                  className="btn btn--ghost"
                  disabled={busy}
                  title="这条证据不属于本事项"
                  onClick={() => onAct(() => postMatterWrongEvidence(detail.id, ev.contextUnitId))}
                >
                  不属于
                </button>
                <button
                  className="btn btn--ghost"
                  disabled={busy}
                  title="把这条证据拆成独立事项"
                  onClick={() => onAct(() => postMatterSplit(detail.id, ev.contextUnitId))}
                >
                  拆分
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="matter-detail__section">
        <div className="matter-detail__head">时间线</div>
        <ul className="matter-timeline">
          {detail.timeline.map((t) => (
            <li key={t.id} className="matter-timeline__item">
              <span className="matter-tl-status">
                {(t.fromStatus ?? '∅')} → {t.toStatus}
              </span>
              <span className="matter-tl-reason">{t.reason}</span>
              <span className="matter-tl-at">{fmt(t.at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
