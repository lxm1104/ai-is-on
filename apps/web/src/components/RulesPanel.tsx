import { useEffect, useState } from 'react';
import {
  fetchAuditLogs,
  fetchBoundaryRules,
  patchBoundaryRule,
  type AuditLog,
  type BoundaryRule,
} from '../lib/api';

type Tab = 'rules' | 'audit';

export function RulesPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('rules');
  const [rules, setRules] = useState<BoundaryRule[]>([]);
  const [audits, setAudits] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [r, a] = await Promise.all([fetchBoundaryRules(false), fetchAuditLogs(80)]);
      setRules(r);
      setAudits(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

  async function toggleActive(rule: BoundaryRule) {
    try {
      await patchBoundaryRule(rule.id, !rule.active);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={`ctx-panel ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="ctx-panel__toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Rules &amp; Audit</span>
        <span className="ctx-panel__chev">{open ? '▾' : '▸'}</span>
        {open && (
          <span className="ctx-panel__counts">
            {rules.filter((r) => r.active).length} active · {audits.length} audits
          </span>
        )}
      </button>
      {open && (
        <div className="ctx-panel__body">
          <div className="ctx-panel__tabs">
            <button
              className={`ctx-panel__tab ${tab === 'rules' ? 'is-on' : ''}`}
              onClick={() => setTab('rules')}
            >
              Boundary Rules ({rules.length})
            </button>
            <button
              className={`ctx-panel__tab ${tab === 'audit' ? 'is-on' : ''}`}
              onClick={() => setTab('audit')}
            >
              Audit ({audits.length})
            </button>
            <button
              type="button"
              className="ctx-panel__refresh btn btn--ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? '加载中…' : '↻ 刷新'}
            </button>
          </div>
          {error && <div className="ctx-panel__err">{error}</div>}
          {tab === 'rules' && <RulesList rules={rules} onToggle={toggleActive} />}
          {tab === 'audit' && <AuditList audits={audits} />}
        </div>
      )}
    </div>
  );
}

// MVP10.1 §6.4：把 active rule 按 autonomy 分组成 自动 / 必问 / 不可逆 三栏
const AUTONOMY_LABEL: Record<BoundaryRule['autonomy'], string> = {
  local_auto: '自动（本地、可逆）',
  local_with_audit: '本地 · 留痕',
  external_always_confirm: '必问（涉及对外）',
};

function RulesList({
  rules,
  onToggle,
}: {
  rules: BoundaryRule[];
  onToggle: (r: BoundaryRule) => void;
}) {
  if (rules.length === 0) {
    return <div className="ctx-panel__empty">还没有 boundary rule。在卡片上点"以后自动"来创建。</div>;
  }
  const groups: Array<{ key: BoundaryRule['autonomy']; rules: BoundaryRule[] }> = [
    { key: 'local_auto', rules: rules.filter((r) => r.autonomy === 'local_auto') },
    { key: 'external_always_confirm', rules: rules.filter((r) => r.autonomy === 'external_always_confirm') },
    { key: 'local_with_audit', rules: rules.filter((r) => r.autonomy === 'local_with_audit') },
  ];
  const irreversible = rules.filter((r) => !r.reversible);
  return (
    <div className="rules-by-autonomy">
      {groups.map((g) =>
        g.rules.length > 0 ? (
          <section key={g.key} className={`rules-group rules-group--${g.key}`}>
            <h5 className="rules-group__title">
              {AUTONOMY_LABEL[g.key]} · {g.rules.length}
            </h5>
            <ul className="rules-list">
              {g.rules.map((r) => (
                <RuleRow key={r.id} rule={r} onToggle={onToggle} />
              ))}
            </ul>
          </section>
        ) : null
      )}
      {irreversible.length > 0 && (
        <section className="rules-group rules-group--irreversible">
          <h5 className="rules-group__title">不可逆 · {irreversible.length}</h5>
          <ul className="rules-list">
            {irreversible.map((r) => (
              <RuleRow key={r.id} rule={r} onToggle={onToggle} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RuleRow({ rule, onToggle }: { rule: BoundaryRule; onToggle: (r: BoundaryRule) => void }) {
  return (
    <li className={`rule-row ${rule.active ? '' : 'is-off'}`}>
      <div className="rule-row__head">
        <span className={`rule-source rule-source--${rule.source}`}>{rule.source}</span>
        <span className="rule-action">{rule.allowedAction}</span>
        <span className={`rule-autonomy rule-autonomy--${rule.autonomy}`}>
          {AUTONOMY_LABEL[rule.autonomy]}
        </span>
        {rule.impactScope === 'shared' && (
          <span className="rule-tag rule-tag--shared">shared</span>
        )}
        {!rule.reversible && <span className="rule-tag rule-tag--irreversible">不可逆</span>}
        {rule.migrated && <span className="rule-tag rule-tag--migrated">需复核</span>}
        <button
          type="button"
          className="btn btn--ghost rule-toggle"
          onClick={() => onToggle(rule)}
        >
          {rule.active ? '关闭' : '启用'}
        </button>
      </div>
      <div className="rule-row__cond">{describeCondition(rule)}</div>
    </li>
  );
}

function describeCondition(r: BoundaryRule): string {
  const c = r.condition;
  const parts: string[] = [];
  if (c.priorityAtMost) parts.push(`优先级 ≤${c.priorityAtMost}`);
  if (c.source && c.source.length) parts.push(`来源 ${c.source.join('/')}`);
  if (c.scope && c.scope.length) parts.push(`scope ${c.scope.join('/')}`);
  if (c.kind && c.kind.length) parts.push(`kind ${c.kind.join('/')}`);
  if (c.triggerType && c.triggerType.length) parts.push(`trigger ${c.triggerType.join('/')}`);
  if (c.entityRef) {
    parts.push(`entity ${c.entityRef.type}${c.entityRef.nameLike ? ` ~${c.entityRef.nameLike}` : ''}`);
  }
  if (parts.length === 0 && c.rawDescription) return c.rawDescription.slice(0, 100);
  return parts.join(' · ') || '(无结构化条件)';
}

function AuditList({ audits }: { audits: AuditLog[] }) {
  if (audits.length === 0) {
    return <div className="ctx-panel__empty">还没有 audit log。boundary 命中或学习时会写入。</div>;
  }
  return (
    <ul className="audit-list">
      {audits.map((a) => (
        <li key={a.id} className="audit-row">
          <div className="audit-row__head">
            <span className={`audit-action audit-action--${a.action}`}>{a.action}</span>
            <span className="audit-time">{shortTime(a.created_at)}</span>
          </div>
          <div className="audit-reason">{a.reason}</div>
        </li>
      ))}
    </ul>
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
