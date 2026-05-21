import { useEffect, useState } from 'react';
import {
  confirmSpaceSuggestion,
  createContextSpace,
  fetchContextSpaceDetail,
  fetchContextSpaces,
  fetchSpaceSuggestions,
  reconcileContextSpaces,
  rejectSpaceSuggestion,
  runSpaceSuggestionWorker,
  type ContextSpace,
  type ContextSpaceDetail,
  type SpaceSuggestion,
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
            <SpaceDetail
              detail={detail}
              onReloadDetail={async () => {
                const d = await fetchContextSpaceDetail(selectedId);
                setDetail(d);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SpaceDetail({
  detail,
  onReloadDetail,
}: {
  detail: ContextSpaceDetail;
  onReloadDetail: () => Promise<void>;
}) {
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
      <SuggestionsSection spaceId={space.id} onAfterConfirm={onReloadDetail} />
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

// MVP12 Phase 2/3 — "📥 建议加入" 区块。
function SuggestionsSection({
  spaceId,
  onAfterConfirm,
}: {
  spaceId: string;
  onAfterConfirm: () => Promise<void>;
}) {
  const [items, setItems] = useState<SpaceSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      setItems(await fetchSpaceSuggestions(spaceId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  async function onRunWorker() {
    setLoading(true);
    setErr(null);
    try {
      const r = await runSpaceSuggestionWorker();
      if (r.stats) {
        setErr(
          `worker: chats=${r.stats.chatsScanned} (skip ${r.stats.chatsBigSkipped}) · ` +
            `chat=${r.stats.chatAffinityInserted}+${r.stats.chatAffinityUpdated} · ` +
            `person=${r.stats.personCoOccurInserted}+${r.stats.personCoOccurUpdated}`
        );
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onConfirm(
    s: SpaceSuggestion,
    reasonCode?: import('../lib/api').SpaceConfirmReason
  ) {
    setBusyId(s.id);
    setErr(null);
    try {
      const r = await confirmSpaceSuggestion(spaceId, s.id, { reasonCode });
      if (r.reconciled) {
        setErr(`confirmed · reconciled scanned=${r.reconciled.scanned} linked=${r.reconciled.linked}`);
      }
      await refresh();
      await onAfterConfirm();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(
    s: SpaceSuggestion,
    reasonCode?: import('../lib/api').SpaceRejectReason
  ) {
    setBusyId(s.id);
    setErr(null);
    try {
      await rejectSpaceSuggestion(spaceId, s.id, { reasonCode });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="sp-group sp-sugs">
      <div className="sp-group__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        📥 建议加入（{items.length}）
        <button
          type="button"
          className="btn btn--ghost"
          style={{ marginLeft: 'auto' }}
          onClick={() => void onRunWorker()}
          disabled={loading}
          title="重新扫近 7 天的 unit，看看有哪些 chat / person 值得加进这个 Space"
        >
          {loading ? '扫描中…' : '↻ 重新扫描'}
        </button>
      </div>
      {err && <div className="ctx-panel__err">{err}</div>}
      {items.length === 0 && !loading && (
        <div className="ctx-panel__empty" style={{ fontSize: 12 }}>
          暂无建议。点 ↻ 重新扫描 触发一次。
        </div>
      )}
      <ul className="sp-group__list">
        {items.map((s) => (
          <li key={s.id} className="sp-group__item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className={`ctx-kind ctx-kind--${s.suggestion_type === 'chat_affinity' ? 'commitment' : 'state'}`}>
                {s.suggestion_type === 'chat_affinity' ? 'chat' : 'person'}
              </span>
              <span className="sp-group__name" style={{ flex: 1 }}>
                {renderSuggestionLabel(s)}
              </span>
              <span className="sp-group__due">score {s.score.toFixed(2)}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              {renderSuggestionEvidence(s)}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void onConfirm(s, 'exact_project_chat')}
                disabled={busyId === s.id}
                title="确认加入：这就是本项目的群"
              >
                {busyId === s.id ? '…' : '✓ 加入'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void onReject(s, 'wrong_space')}
                disabled={busyId === s.id}
                title="90 天内不再建议：放错 Space 了"
              >
                ✕ 错 Space
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void onReject(s, 'chat_too_broad')}
                disabled={busyId === s.id}
                title="30 天内不再建议：群太宽，不专属本项目"
              >
                ✕ 群太泛
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void onReject(s, 'only_incidental_mention')}
                disabled={busyId === s.id}
                title="30 天内不再建议：只是偶然提到"
              >
                ✕ 偶然提到
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void onReject(s, 'private_or_noise')}
                disabled={busyId === s.id}
                title="90 天内不再建议：私人或噪声"
              >
                ✕ 噪声
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderSuggestionLabel(s: SpaceSuggestion): string {
  if (s.suggestion_type === 'chat_affinity') {
    const ev = s.evidence ?? {};
    const alias = ev.chatAliases && ev.chatAliases.length ? ev.chatAliases[0] : undefined;
    const id = ev.chatName?.replace('lark_chat:', '').slice(-6) ?? '???';
    return alias ? `${alias} (#${id})` : `群 #${id}`;
  }
  return `person ${s.target_id.slice(0, 8)}…`;
}

function renderSuggestionEvidence(s: SpaceSuggestion): string {
  const ev = s.evidence ?? {};
  if (s.suggestion_type === 'chat_affinity') {
    const parts: string[] = [];
    if (ev.unitsInChat != null) parts.push(`${ev.unitsInChat} units`);
    if (ev.directHits != null) parts.push(`${ev.directHits} 命中`);
    if (ev.personOverlap) parts.push(`${ev.personOverlap} 同人`);
    if (ev.docOverlap) parts.push(`${ev.docOverlap} 同 doc`);
    if (ev.recentDays) parts.push(`近 ${ev.recentDays}d`);
    return parts.join(' · ');
  }
  // person_co_occur
  const parts: string[] = [];
  if (ev.coOccurCount != null) parts.push(`与 seed 共现 ${ev.coOccurCount} 次`);
  if (ev.chatName) parts.push(`群 ${ev.chatName.slice(-8)}`);
  return parts.join(' · ');
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
