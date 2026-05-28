import { useEffect, useMemo, useState } from 'react';
import {
  confirmWorkMap,
  fetchWorkMapCurrent,
  generateWorkMapDraft,
  type CurrentWorkMap,
  type OrgRoleFromMe,
  type StakeholderOrgInfo,
  type WorkMapDraft,
  type WorkMapDraftResponse,
  type WorkMapProjectDraft,
  type WorkMapWriteSummary,
} from '../lib/api';

const DRAFT_STORAGE_KEY = 'aiis.workmap.draft.v1';
// MVP21 S3: 拆分视图开关。默认 'on'（开启 Identity / Project Intent 两 tab）；
// 用户设置 'off' 切回 MVP7 经典视图（所有 section 一条流）。
const SPLIT_UI_STORAGE_KEY = 'aiis.mvp21.workMapSplit';
function loadSplitUi(): boolean {
  try {
    return localStorage.getItem(SPLIT_UI_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}
function saveSplitUi(on: boolean): void {
  try {
    localStorage.setItem(SPLIT_UI_STORAGE_KEY, on ? 'on' : 'off');
  } catch {}
}

type WorkMapTab = 'identity' | 'projectIntent';

const EMPTY_PROJECT: WorkMapProjectDraft = {
  name: '',
  description: '',
  goals: [],
  authoritativeDocs: [],
  upcomingDeadlines: [],
  risks: [],
};

const EMPTY_DRAFT: WorkMapDraft = {
  profile: { roleTitle: '', teamName: '', responsibilities: [] },
  projects: [],
  stakeholders: [],
  preferences: [],
  boundaries: [],
};

function loadDraft(): WorkMapDraft {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<WorkMapDraft>;
    return { ...EMPTY_DRAFT, ...parsed };
  } catch {
    return EMPTY_DRAFT;
  }
}

function saveDraft(d: WorkMapDraft) {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(d));
  } catch {}
}

export type WorkMapPanelProps = {
  onBootstrapChange?: (completedAt: string | null) => void;
};

export function WorkMapPanel({ onBootstrapChange }: WorkMapPanelProps) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<CurrentWorkMap | null>(null);
  const [draft, setDraft] = useState<WorkMapDraft>(() => loadDraft());
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<WorkMapWriteSummary | null>(null);
  const [lastDraftMeta, setLastDraftMeta] = useState<Omit<WorkMapDraftResponse, 'draft'> | null>(
    null
  );
  const [seedText, setSeedText] = useState('');
  const [mode, setMode] = useState<'full' | 'incremental'>('full');
  // MVP21 S3: 视图切换
  const [splitUi, setSplitUi] = useState<boolean>(() => loadSplitUi());
  const [tab, setTab] = useState<WorkMapTab>('identity');

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  async function load() {
    try {
      const c = await fetchWorkMapCurrent();
      setCurrent(c);
      onBootstrapChange?.(c.bootstrapCompletedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await confirmWorkMap(draft);
      setLastSummary(r.summary);
      setCurrent(r.current);
      onBootstrapChange?.(r.current.bootstrapCompletedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onResetDraft() {
    if (!confirm('清空本地编辑中的 draft？（已确认写入的 Work Map 不会被删除）')) return;
    setDraft(EMPTY_DRAFT);
    try {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {}
  }

  async function onGenerateDraft() {
    setDrafting(true);
    setError(null);
    try {
      const r = await generateWorkMapDraft({ seedText: seedText.trim() || undefined, mode });
      setLastDraftMeta({
        tokenEstimate: r.tokenEstimate,
        itemsConsidered: r.itemsConsidered,
        itemsTruncated: r.itemsTruncated,
        rawText: r.rawText,
      });
      // 替换还是合并？MVP7.1 简单替换 —— 用户在 panel 里再改。
      // 若 draft 已有内容，提示一下。
      const hasExisting =
        draft.profile.roleTitle ||
        draft.profile.responsibilities.length ||
        draft.projects.length ||
        draft.stakeholders.length ||
        draft.preferences.length ||
        draft.boundaries.length;
      if (
        hasExisting &&
        !confirm('生成新草稿会覆盖当前正在编辑的字段（已确认写入的 Work Map 不受影响）。继续？')
      ) {
        return;
      }
      setDraft(r.draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  }

  const bootstrapped = !!current?.bootstrapCompletedAt;
  const counts = useMemo(() => {
    if (!current) return null;
    return {
      role: current.role ? 1 : 0,
      resp: current.responsibilities.length,
      goals: current.goals.length,
      commits: current.commitments.length,
      risks: current.risks.length,
      prefs: current.preferences.length,
      stake: current.relationships.length,
      spaces: current.spaces.length,
      rules: current.boundaryRules.length,
    };
  }, [current]);

  return (
    <div className={`ctx-panel ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="ctx-panel__toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Work Map（MVP7）</span>
        <span className="ctx-panel__chev">{open ? '▾' : '▸'}</span>
        <span className="ctx-panel__counts">
          {bootstrapped
            ? `已写入 · 更新于 ${shortTime(current!.bootstrapCompletedAt!)}`
            : '未启动'}
        </span>
      </button>
      {open && (
        <div className="ctx-panel__body">
          {error && <div className="ctx-panel__err">{error}</div>}
          {counts && (
            <div className="wm-counts">
              role:{counts.role} · resp:{counts.resp} · goals:{counts.goals} ·
              commits:{counts.commits} · risks:{counts.risks} · prefs:{counts.prefs} ·
              stake:{counts.stake} · spaces:{counts.spaces} · rules:{counts.rules}
            </div>
          )}
          {/* MVP21 S3: 视图切换 + tab 栏 */}
          {splitUi && (
            <div className="wm-tabbar">
              <button
                type="button"
                className={`wm-tab ${tab === 'identity' ? 'is-on' : ''}`}
                onClick={() => setTab('identity')}
                title="我是谁 / 我的工作世界结构（半年级稳定）"
              >
                我是谁
              </button>
              <button
                type="button"
                className={`wm-tab ${tab === 'projectIntent' ? 'is-on' : ''}`}
                onClick={() => setTab('projectIntent')}
                title="项目种子（项目长期意图 — 季度级稳定）"
              >
                项目种子
              </button>
              <button
                type="button"
                className="btn btn--ghost wm-tab__toggle"
                onClick={() => {
                  saveSplitUi(false);
                  setSplitUi(false);
                }}
                title="切回 MVP7 经典视图（一条流）"
              >
                ↗ 经典视图
              </button>
            </div>
          )}
          {!splitUi && (
            <div className="wm-row" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  saveSplitUi(true);
                  setSplitUi(true);
                }}
                title="拆成『我是谁』+『项目种子』两个 tab"
              >
                ↗ 分屏视图
              </button>
            </div>
          )}

          <section className="wm-section">
            <h4>从近期 context 生成草稿</h4>
            <textarea
              className="wm-input"
              rows={3}
              placeholder="可选：用 5-8 行自然语言描述自己（角色 / 项目 / 不希望被打扰的事）"
              value={seedText}
              onChange={(e) => setSeedText(e.target.value)}
            />
            <div className="wm-row">
              <select
                className="wm-input wm-input--short"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'full' | 'incremental')}
              >
                <option value="full">全量</option>
                <option value="incremental">增量</option>
              </select>
              <button
                type="button"
                className="btn btn--primary"
                disabled={drafting}
                onClick={() => void onGenerateDraft()}
              >
                {drafting ? '生成中…（LLM 可能耗时 1-2 分钟）' : '生成草稿'}
              </button>
            </div>
            {lastDraftMeta && (
              <div className="wm-summary">
                上次草稿：候选 {lastDraftMeta.itemsConsidered} 条，截掉{' '}
                {lastDraftMeta.itemsTruncated} 条，输入 ~{lastDraftMeta.tokenEstimate} tokens
              </div>
            )}
          </section>

          {/* MVP21 S3 §6.1: identity tab = 身份层（半年级稳定）；
              projectIntent tab = 项目种子（季度级，含 deadlines/risks 但有 deprecation 提示） */}
          {(!splitUi || tab === 'identity') && (
            <>
              <ProfileEditor
                value={draft.profile}
                onChange={(profile) => setDraft({ ...draft, profile })}
              />
              <StakeholdersEditor
                value={draft.stakeholders}
                onChange={(stakeholders) => setDraft({ ...draft, stakeholders })}
                orgRoles={current?.stakeholderOrgRoles}
              />
              <StringListEditor
                label="工作偏好（preference）"
                value={draft.preferences}
                placeholder="如：上午专注，下午开会..."
                onChange={(preferences) => setDraft({ ...draft, preferences })}
              />
              <BoundariesEditor
                value={draft.boundaries}
                onChange={(boundaries) => setDraft({ ...draft, boundaries })}
              />
            </>
          )}
          {(!splitUi || tab === 'projectIntent') && (
            <ProjectsEditor
              value={draft.projects}
              onChange={(projects) => setDraft({ ...draft, projects })}
              splitUi={splitUi}
            />
          )}

          <div className="wm-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void onConfirm()}
            >
              {busy ? '写入中…' : '确认写入'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={onResetDraft}
            >
              清空 draft
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void load()}
            >
              ↻ 重新拉取
            </button>
          </div>
          {lastSummary && (
            <div className="wm-summary">
              本次：unitsWritten={lastSummary.unitsWritten}, unitsUpdated=
              {lastSummary.unitsUpdated}, spacesWritten={lastSummary.spacesWritten},
              rulesWritten={lastSummary.rulesWritten}, rulesTouched=
              {lastSummary.rulesTouched}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProfileEditor({
  value,
  onChange,
}: {
  value: WorkMapDraft['profile'];
  onChange: (v: WorkMapDraft['profile']) => void;
}) {
  return (
    <section className="wm-section">
      <h4>我的角色 / 职责</h4>
      <input
        className="wm-input"
        placeholder="角色，例：产品经理 / Tech Lead"
        value={value.roleTitle ?? ''}
        onChange={(e) => onChange({ ...value, roleTitle: e.target.value })}
      />
      <input
        className="wm-input"
        placeholder="团队，例：AI is ON 产品组"
        value={value.teamName ?? ''}
        onChange={(e) => onChange({ ...value, teamName: e.target.value })}
      />
      <StringListEditor
        label="职责（每行一条）"
        value={value.responsibilities}
        placeholder="如：负责 MVP 路线规划..."
        onChange={(responsibilities) => onChange({ ...value, responsibilities })}
      />
    </section>
  );
}

function ProjectsEditor({
  value,
  onChange,
  splitUi = false,
}: {
  value: WorkMapProjectDraft[];
  onChange: (v: WorkMapProjectDraft[]) => void;
  splitUi?: boolean;
}) {
  function patch(idx: number, p: Partial<WorkMapProjectDraft>) {
    const next = value.slice();
    next[idx] = { ...next[idx], ...p };
    onChange(next);
  }
  return (
    <section className="wm-section">
      <h4>当前项目</h4>
      {splitUi && (
        <div className="wm-section__hint">
          这里填的是项目<strong>长期意图</strong>（季度级稳定）：项目名、简述、目标、权威文档。
          DDL 临期的承诺与当下风险不需要在这里手动维护——系统会从 IM / 日历 / 文档实时抽出来。
        </div>
      )}
      {value.map((p, idx) => (
        <div key={idx} className="wm-project">
          <input
            className="wm-input"
            placeholder="项目名（如：AI is ON）"
            value={p.name}
            onChange={(e) => patch(idx, { name: e.target.value })}
          />
          <input
            className="wm-input"
            placeholder="项目简述（可选）"
            value={p.description ?? ''}
            onChange={(e) => patch(idx, { description: e.target.value })}
          />
          <StringListEditor
            label="目标（项目长期目标，季度级）"
            value={p.goals}
            placeholder="本季度目标..."
            onChange={(goals) => patch(idx, { goals })}
          />
          <StringListEditor
            label="权威文档（URL）"
            value={p.authoritativeDocs}
            placeholder="https://..."
            onChange={(authoritativeDocs) => patch(idx, { authoritativeDocs })}
          />
          {/* MVP21 S3 §6.1: deadlines/risks 是动态信号，不该在静态 Work Map 维护。
              S4 计划移除写入路径；这里加 deprecation 提示但仍允许编辑（兼容期保留）。 */}
          <div className="wm-deprecation">
            <div className="wm-deprecation__hint">
              ⚠️ 以下字段（deadline / 风险）流速是周级，跟 IM/triage 抽出来的同名信号在 attention 里抢位置；
              MVP21 S4 计划停写。**建议留空**，让 attention 从近期消息自然识别。
            </div>
            <DeadlinesEditor
              value={p.upcomingDeadlines}
              onChange={(upcomingDeadlines) => patch(idx, { upcomingDeadlines })}
            />
            <StringListEditor
              label="风险 / 担心（不建议在此维护）"
              value={p.risks}
              placeholder="担心的问题..."
              onChange={(risks) => patch(idx, { risks })}
            />
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onChange(value.filter((_, i) => i !== idx))}
          >
            删除项目
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => onChange([...value, { ...EMPTY_PROJECT }])}
      >
        + 新增项目
      </button>
    </section>
  );
}

function DeadlinesEditor({
  value,
  onChange,
}: {
  value: Array<{ title: string; dueAt?: string }>;
  onChange: (v: Array<{ title: string; dueAt?: string }>) => void;
}) {
  return (
    <div className="wm-deadlines">
      <div className="wm-sublabel">近期承诺 / deadline</div>
      {value.map((d, i) => (
        <div key={i} className="wm-row">
          <input
            className="wm-input"
            placeholder="承诺标题"
            value={d.title}
            onChange={(e) => {
              const n = value.slice();
              n[i] = { ...n[i], title: e.target.value };
              onChange(n);
            }}
          />
          <input
            className="wm-input wm-input--short"
            type="datetime-local"
            value={d.dueAt ? toLocalDatetime(d.dueAt) : ''}
            onChange={(e) => {
              const n = value.slice();
              n[i] = { ...n[i], dueAt: e.target.value ? fromLocalDatetime(e.target.value) : undefined };
              onChange(n);
            }}
          />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => onChange([...value, { title: '' }])}
      >
        + 加 deadline
      </button>
    </div>
  );
}

function StakeholdersEditor({
  value,
  onChange,
  orgRoles,
}: {
  value: Array<{ name: string; note?: string }>;
  onChange: (v: Array<{ name: string; note?: string }>) => void;
  // MVP15 §4: 服务端已确认 stakeholder 的 orgRole + 解析后 business/functionLabel；按 name 匹配 chip。
  orgRoles?: Record<string, StakeholderOrgInfo>;
}) {
  return (
    <section className="wm-section">
      <h4>关键相关人</h4>
      {value.map((s, i) => {
        const info = s.name ? orgRoles?.[s.name] : undefined;
        return (
          <div key={i} className="wm-row">
            <input
              className="wm-input wm-input--short"
              placeholder="姓名"
              value={s.name}
              onChange={(e) => {
                const n = value.slice();
                n[i] = { ...n[i], name: e.target.value };
                onChange(n);
              }}
            />
            <input
              className="wm-input"
              placeholder="备注（如：产品 lead）"
              value={s.note ?? ''}
              onChange={(e) => {
                const n = value.slice();
                n[i] = { ...n[i], note: e.target.value };
                onChange(n);
              }}
            />
            {info && <OrgRoleChip info={info} />}
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => onChange([...value, { name: '' }])}
      >
        + 加相关人
      </button>
    </section>
  );
}

// MVP15 §4: orgRole chip。read-only，含三种信息：
//   - 角色类别（同部门 / 同业务跨职能 / 跨部门 / 外部 / 上级 / 下属）→ 颜色
//   - business + functionLabel 作为二级信息，跟在主标签后面（如有）
const ORG_ROLE_LABEL: Record<OrgRoleFromMe, { text: string; cls: string }> = {
  peer_same_dept: { text: '同部门', cls: 'wm-chip--peer' },
  same_business_cross_function: { text: '同业务', cls: 'wm-chip--same-biz' },
  cross_dept: { text: '跨部门', cls: 'wm-chip--cross' },
  external: { text: '外部', cls: 'wm-chip--ext' },
  manager_of_me: { text: '上级', cls: 'wm-chip--manager' },
  report_of_me: { text: '下属', cls: 'wm-chip--report' },
};
function OrgRoleChip({ info }: { info: StakeholderOrgInfo }) {
  const meta = ORG_ROLE_LABEL[info.role];
  if (!meta) return null;
  // 二级信息：业务 / 职能；都有时拼成"Lark Base · Engineering"
  const subParts: string[] = [];
  if (info.business) subParts.push(info.business);
  if (info.functionLabel) subParts.push(info.functionLabel);
  const sub = subParts.length ? ` · ${subParts.join(' / ')}` : '';
  return (
    <span
      className={`wm-chip ${meta.cls}`}
      title={`飞书推断：${info.role}${info.business ? ` / business=${info.business}` : ''}${info.functionLabel ? ` / fn=${info.functionLabel}` : ''}`}
    >
      {meta.text}
      {sub}
    </span>
  );
}

function BoundariesEditor({
  value,
  onChange,
}: {
  value: WorkMapDraft['boundaries'];
  onChange: (v: WorkMapDraft['boundaries']) => void;
}) {
  return (
    <section className="wm-section">
      <h4>不希望被打扰的事（→ BoundaryRule）</h4>
      {value.map((b, i) => (
        <div key={i} className="wm-boundary">
          <input
            className="wm-input"
            placeholder="描述（如：P2/P3 群消息合并到日报）"
            value={b.description}
            onChange={(e) => {
              const n = value.slice();
              n[i] = { ...n[i], description: e.target.value };
              onChange(n);
            }}
          />
          <div className="wm-row">
            <select
              className="wm-input wm-input--short"
              value={b.priorityAtMost ?? ''}
              onChange={(e) => {
                const n = value.slice();
                const v = e.target.value as 'P0' | 'P1' | 'P2' | 'P3' | '';
                n[i] = { ...n[i], priorityAtMost: v || undefined };
                onChange(n);
              }}
            >
              <option value="">不限优先级</option>
              <option value="P1">≤P1</option>
              <option value="P2">≤P2</option>
              <option value="P3">≤P3</option>
            </select>
            <select
              className="wm-input wm-input--short"
              multiple
              value={b.source ?? []}
              onChange={(e) => {
                const opts = Array.from(e.target.selectedOptions).map(
                  (o) => o.value
                ) as WorkMapDraft['boundaries'][number]['source'];
                const n = value.slice();
                n[i] = { ...n[i], source: opts && opts.length ? opts : undefined };
                onChange(n);
              }}
            >
              <option value="im">im</option>
              <option value="mail">mail</option>
              <option value="calendar">calendar</option>
              <option value="drive">drive</option>
              <option value="agent">agent</option>
              <option value="manual">manual</option>
            </select>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => onChange([...value, { description: '' }])}
      >
        + 加规则
      </button>
    </section>
  );
}

function StringListEditor({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string[];
  placeholder?: string;
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="wm-sublist">
      <div className="wm-sublabel">{label}</div>
      {value.map((s, i) => (
        <div key={i} className="wm-row">
          <input
            className="wm-input"
            placeholder={placeholder}
            value={s}
            onChange={(e) => {
              const n = value.slice();
              n[i] = e.target.value;
              onChange(n);
            }}
          />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => onChange([...value, ''])}
      >
        +
      </button>
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

function toLocalDatetime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

function fromLocalDatetime(s: string): string {
  try {
    const d = new Date(s);
    return d.toISOString();
  } catch {
    return s;
  }
}
