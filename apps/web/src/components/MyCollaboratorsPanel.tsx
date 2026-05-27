/**
 * MVP15A §7.7 — 我的协作圈面板（read-only）。
 *
 * 数据源：/api/graph/my-collaborators，read-only 展示 top 20 协作者。
 * 每行：
 *   weight 进度条 + 姓名 + orgRole chip + biz/fn 二级标签 + sharedProjects + hint
 *   hover evidence unit ids（最多 5）
 *
 * 不开编辑：协作图是 read model，不允许用户改边/合并/删人。想调整协作关系应该改
 * Work Map relationship unit。
 */

import { useEffect, useState } from 'react';
import {
  fetchMyCollaborators,
  type OrgRoleFromMe,
  type SelfCollaboratorEntry,
} from '../lib/api';

const ORG_ROLE_LABEL: Record<OrgRoleFromMe, { text: string; cls: string }> = {
  peer_same_dept: { text: '同部门', cls: 'wm-chip--peer' },
  same_business_cross_function: { text: '同业务', cls: 'wm-chip--same-biz' },
  cross_dept: { text: '跨部门', cls: 'wm-chip--cross' },
  external: { text: '外部', cls: 'wm-chip--ext' },
  manager_of_me: { text: '上级', cls: 'wm-chip--manager' },
  report_of_me: { text: '下属', cls: 'wm-chip--report' },
};

const HINT_LABEL: Record<string, string> = {
  co_owner: '共主',
  reviewer: '评审',
  contributor: '参与',
  observer: '旁观',
};

export function MyCollaboratorsPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<SelfCollaboratorEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [inducerLastRunAt, setInducerLastRunAt] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchMyCollaborators({ limit: 20 });
      setEntries(r.entries);
      setInducerLastRunAt(r.inducerLastRunAt);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && entries.length === 0 && !loading) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const maxWeight = entries.length ? Math.max(...entries.map((e) => e.weight)) : 1;

  return (
    <div className={`ctx-panel ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="ctx-panel__toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>我的协作圈（MVP15A）</span>
        <span className="ctx-panel__chev">{open ? '▾' : '▸'}</span>
        <span className="ctx-panel__counts">
          {entries.length > 0
            ? `top ${entries.length}${inducerLastRunAt ? ' · 归纳于 ' + shortTime(inducerLastRunAt) : ''}`
            : '未加载'}
        </span>
      </button>
      {open && (
        <div className="ctx-panel__body">
          {err && <div className="ctx-panel__err">{err}</div>}
          {loading && <div className="mc-hint">加载中…</div>}
          {!loading && entries.length === 0 && !err && (
            <div className="mc-hint">
              暂无协作数据。需要 server 跑过 graph inducer，并且 Work Map 有
              relationship 数据。
            </div>
          )}
          <div className="mc-list">
            {entries.map((e) => (
              <CollaboratorRow key={e.personEntityId} entry={e} maxWeight={maxWeight} />
            ))}
          </div>
          <div className="mc-actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              ↻ 重新拉取
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CollaboratorRow({
  entry,
  maxWeight,
}: {
  entry: SelfCollaboratorEntry;
  maxWeight: number;
}) {
  const weightPct = Math.round((entry.weight / maxWeight) * 100);
  const orgRole = entry.orgRole ? ORG_ROLE_LABEL[entry.orgRole] : null;
  const hint = entry.decisionRoleHint ? HINT_LABEL[entry.decisionRoleHint] : null;
  const evidenceTooltip =
    entry.evidenceUnitIds.length > 0
      ? `evidence units: ${entry.evidenceUnitIds.slice(0, 5).join(', ')}`
      : '无 evidence unit';

  return (
    <div className="mc-row" title={evidenceTooltip}>
      <div className="mc-row__bar">
        <div className="mc-row__bar-fill" style={{ width: `${weightPct}%` }} />
      </div>
      <div className="mc-row__name">{entry.name}</div>
      <div className="mc-row__weight">{entry.weight.toFixed(2)}</div>
      {orgRole && (
        <span className={`wm-chip ${orgRole.cls}`} title={`orgRole=${entry.orgRole}`}>
          {orgRole.text}
        </span>
      )}
      {entry.business && (
        <span className="mc-tag mc-tag--biz">{entry.business}</span>
      )}
      {entry.functionLabel && (
        <span className="mc-tag mc-tag--fn">{entry.functionLabel}</span>
      )}
      {hint && <span className="mc-tag mc-tag--hint">{hint}</span>}
      {entry.sharedProjectCanonicalNames.length > 0 && (
        <span
          className="mc-tag mc-tag--shared"
          title={entry.sharedProjectCanonicalNames.join(', ')}
        >
          共项目 ×{entry.sharedProjectCanonicalNames.length}
        </span>
      )}
    </div>
  );
}

function shortTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
