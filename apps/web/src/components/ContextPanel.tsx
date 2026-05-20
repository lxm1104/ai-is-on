import { useEffect, useState } from 'react';
import type { ContextEntity, ContextRelation, ContextUnit } from '../types';
import {
  fetchContextEntities,
  fetchContextRelations,
  fetchContextUnits,
} from '../lib/api';

type Tab = 'units' | 'entities' | 'relations';

const KIND_OPTIONS = [
  'event',
  'commitment',
  'goal',
  'intent',
  'state',
  'relationship',
  'emotion',
  'memory',
  'constraint',
  'uncertainty',
  'action_result',
];

const ACTIONABILITY_OPTIONS = ['record', 'notify', 'ask', 'act'];

export function ContextPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('units');
  const [units, setUnits] = useState<ContextUnit[]>([]);
  const [entities, setEntities] = useState<ContextEntity[]>([]);
  const [relations, setRelations] = useState<ContextRelation[]>([]);
  const [kindFilter, setKindFilter] = useState<string>('');
  const [actFilter, setActFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number>(0);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [u, e, r] = await Promise.all([
        fetchContextUnits({
          kind: kindFilter || undefined,
          actionability: actFilter || undefined,
          limit: 100,
        }),
        fetchContextEntities(),
        fetchContextRelations(),
      ]);
      setUnits(u);
      setEntities(e);
      setRelations(r);
      setLastLoadedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // 展开时初次加载；filter 变更时重新拉
  useEffect(() => {
    if (!open) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kindFilter, actFilter]);

  return (
    <div className={`ctx-panel ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="ctx-panel__toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Context（调试）</span>
        <span className="ctx-panel__chev">{open ? '▾' : '▸'}</span>
        {open && (
          <span className="ctx-panel__counts">
            {units.length} units · {entities.length} entities · {relations.length} rels
          </span>
        )}
      </button>
      {open && (
        <div className="ctx-panel__body">
          <div className="ctx-panel__tabs">
            <button
              className={`ctx-panel__tab ${tab === 'units' ? 'is-on' : ''}`}
              onClick={() => setTab('units')}
            >
              Units ({units.length})
            </button>
            <button
              className={`ctx-panel__tab ${tab === 'entities' ? 'is-on' : ''}`}
              onClick={() => setTab('entities')}
            >
              Entities ({entities.length})
            </button>
            <button
              className={`ctx-panel__tab ${tab === 'relations' ? 'is-on' : ''}`}
              onClick={() => setTab('relations')}
            >
              Relations ({relations.length})
            </button>
            <button
              className="ctx-panel__refresh btn btn--ghost"
              onClick={() => void reload()}
              disabled={loading}
              title={lastLoadedAt ? new Date(lastLoadedAt).toLocaleTimeString() : '点击刷新'}
            >
              {loading ? '加载中…' : '↻ 刷新'}
            </button>
          </div>

          {tab === 'units' && (
            <div className="ctx-panel__filters">
              <select
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
              >
                <option value="">所有 kind</option>
                {KIND_OPTIONS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
              <select
                value={actFilter}
                onChange={(e) => setActFilter(e.target.value)}
              >
                <option value="">所有 actionability</option>
                {ACTIONABILITY_OPTIONS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          )}

          {error && <div className="ctx-panel__err">{error}</div>}

          {tab === 'units' && (
            <UnitsList units={units} />
          )}
          {tab === 'entities' && (
            <EntitiesList entities={entities} />
          )}
          {tab === 'relations' && (
            <RelationsList relations={relations} entities={entities} />
          )}
        </div>
      )}
    </div>
  );
}

function UnitItem({ unit: u }: { unit: ContextUnit }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="ctx-unit">
      <div className="ctx-unit__head">
        <span className={`ctx-kind ctx-kind--${u.kind}`}>{u.kind}</span>
        <span className="ctx-unit__title">{u.title}</span>
        <span className="ctx-unit__meta">
          v{u.version} · conf {u.confidence.toFixed(2)} · {u.actionability}
        </span>
      </div>
      <div
        className={`ctx-unit__content ${expanded ? 'is-expanded' : ''}`}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? '点击收起' : '点击展开'}
      >
        {u.content}
      </div>
      {u.entities.length > 0 && (
        <div className="ctx-unit__entities">
          {u.entities.map((e, i) => (
            <span key={i} className="ctx-ent-chip">
              {e.type}:{e.name}{e.role ? ` (${e.role})` : ''}
            </span>
          ))}
        </div>
      )}
      <div className="ctx-unit__foot">
        <span>scope: {u.scope}</span>
        <span>origin: {u.origin.kind}</span>
        {u.time?.dueAt && <span>due: {u.time.dueAt}</span>}
        <span>updated: {new Date(u.updatedAt).toLocaleString()}</span>
      </div>
    </li>
  );
}

function UnitsList({ units }: { units: ContextUnit[] }) {
  if (units.length === 0) {
    return <div className="ctx-panel__empty">还没有 context unit。让 collector 跑一轮。</div>;
  }
  return (
    <ul className="ctx-units">
      {units.map((u) => (
        <UnitItem key={u.id} unit={u} />
      ))}
    </ul>
  );
}

function EntitiesList({ entities }: { entities: ContextEntity[] }) {
  if (entities.length === 0) {
    return <div className="ctx-panel__empty">还没有 entity。</div>;
  }
  return (
    <ul className="ctx-entities">
      {entities.map((e) => (
        <li key={e.id} className="ctx-ent">
          <span className="ctx-ent__type">{e.type}</span>
          <span className="ctx-ent__name">{e.name}</span>
          <span className="ctx-ent__meta">conf {e.confidence.toFixed(2)}</span>
        </li>
      ))}
    </ul>
  );
}

function RelationsList({
  relations,
  entities,
}: {
  relations: ContextRelation[];
  entities: ContextEntity[];
}) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  if (relations.length === 0) {
    return <div className="ctx-panel__empty">还没有 relation。</div>;
  }
  return (
    <ul className="ctx-relations">
      {relations.map((r) => {
        const from = byId.get(r.from_entity_id);
        const to = byId.get(r.to_entity_id);
        return (
          <li key={r.id} className="ctx-rel">
            <span>{from ? `${from.type}:${from.name}` : r.from_entity_id}</span>
            <span className="ctx-rel__arrow">— {r.relation_type} →</span>
            <span>{to ? `${to.type}:${to.name}` : r.to_entity_id}</span>
          </li>
        );
      })}
    </ul>
  );
}
