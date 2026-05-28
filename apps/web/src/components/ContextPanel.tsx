import { useEffect, useState } from 'react';
import type {
  ContextEntity,
  ContextUnit,
  CooccurrenceItem,
  RelationshipItem,
  RelationshipSource,
} from '../types';
import {
  fetchContextEntities,
  fetchContextUnits,
  fetchCooccurrences,
  fetchRelationships,
} from '../lib/api';

type Tab = 'units' | 'entities' | 'relationships';

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
  const [relationships, setRelationships] = useState<RelationshipItem[]>([]);
  const [cooccurrences, setCooccurrences] = useState<CooccurrenceItem[]>([]);
  const [kindFilter, setKindFilter] = useState<string>('');
  const [actFilter, setActFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number>(0);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [u, e, r, c] = await Promise.all([
        fetchContextUnits({
          kind: kindFilter || undefined,
          actionability: actFilter || undefined,
          limit: 100,
        }),
        fetchContextEntities(),
        fetchRelationships(),
        fetchCooccurrences(),
      ]);
      setUnits(u);
      setEntities(e);
      setRelationships(r);
      setCooccurrences(c);
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
            {units.length} units · {entities.length} entities · {relationships.length} relationships
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
              className={`ctx-panel__tab ${tab === 'relationships' ? 'is-on' : ''}`}
              onClick={() => setTab('relationships')}
            >
              Relationships ({relationships.length})
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
          {tab === 'relationships' && (
            <RelationshipsList items={relationships} cooccurrences={cooccurrences} />
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
        {u._layerHint && (
          <>
            <span
              className={`ctx-layer ctx-layer--${u._layerHint.layer}`}
              title={`layer: ${u._layerHint.layer} · asserted=${u._layerHint.asserted} · voluntary=${u._layerHint.voluntary}`}
            >
              {u._layerHint.layer}
            </span>
            <span
              className={`ctx-src ctx-src--${u._layerHint.source}`}
              title={`source: ${u._layerHint.source}`}
            >
              {u._layerHint.source}
            </span>
          </>
        )}
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

const SOURCE_LABEL: Record<RelationshipSource, string> = {
  work_map: 'Work Map',
  extracted_from_event: '从消息抽取',
  manual: '手工',
  system: '系统',
  agent: 'Agent',
  other: '其他',
};

function RelationshipsList({
  items,
  cooccurrences,
}: {
  items: RelationshipItem[];
  cooccurrences: CooccurrenceItem[];
}) {
  const [showCooccur, setShowCooccur] = useState(true);

  if (items.length === 0 && cooccurrences.length === 0) {
    return (
      <div className="ctx-panel__empty">
        还没有沉淀关系。在 Work Map 添加协作者，或等待消息沉淀。
      </div>
    );
  }
  return (
    <div className="ctx-relationships-wrap">
      <div className="ctx-relationships-section">
        <div className="ctx-relationships-section__title">
          ✦ Explicit relationships ({items.length})
        </div>
        {items.length === 0 ? (
          <div className="ctx-panel__empty" style={{ fontSize: 12 }}>
            还没有沉淀关系。在 Work Map 添加协作者，或等待消息沉淀。
          </div>
        ) : (
          <ul className="ctx-relationships">
            {items.map((r) => (
              <li key={r.id} className="ctx-relationship">
                <div className="ctx-relationship__head">
                  {r.persons.length === 0 ? (
                    <span className="ctx-relationship__title">{r.title}</span>
                  ) : (
                    r.persons.map((p) => (
                      <span key={p.id} className="ctx-ent-chip">
                        person:{p.name}
                      </span>
                    ))
                  )}
                  <span
                    className={`ctx-relationship__source ctx-relationship__source--${r.source}`}
                  >
                    {SOURCE_LABEL[r.source] ?? r.source}
                  </span>
                </div>
                <div className="ctx-relationship__summary">{r.summary}</div>
                <div className="ctx-relationship__foot">
                  updated {new Date(r.updatedAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ctx-relationships-section">
        <button
          type="button"
          className="ctx-relationships-section__title ctx-relationships-section__title--toggle"
          onClick={() => setShowCooccur((v) => !v)}
          title="entity 共现是推测信号，不是事实关系"
        >
          {showCooccur ? '▾' : '▸'} ◌ Observed together ({cooccurrences.length})
        </button>
        {showCooccur && (
          cooccurrences.length === 0 ? (
            <div className="ctx-panel__empty" style={{ fontSize: 12 }}>
              暂无 entity 共现信号。
            </div>
          ) : (
            <ul className="ctx-cooccurrences">
              {cooccurrences.map((c) => (
                <li
                  key={`${c.left.id}::${c.right.id}`}
                  className="ctx-cooccurrence"
                  title={`evidence: ${c.evidenceUnit.title}`}
                >
                  <span className="ctx-ent-chip">
                    {c.left.type}:{c.left.name}
                  </span>
                  <span className="ctx-cooccurrence__op">↔</span>
                  <span className="ctx-ent-chip">
                    {c.right.type}:{c.right.name}
                  </span>
                  <span className="ctx-cooccurrence__count">×{c.count}</span>
                  <span className="ctx-cooccurrence__when">
                    {new Date(c.lastSeenAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}
