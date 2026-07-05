/**
 * MVP81 —— 征询习惯引擎：把 consult_choice 的「记录」变成「会用」。
 *
 * 用户目标（2026-07-04 goal）：AI 要"明确知道什么时候需要我确认，不需要我确认的时候可以持续自主推进"，
 * 且学习能力要"能复用泛化到其他用户其他人的业务场景"。
 *
 * 因此本模块是**纯函数、零项目依赖**：不 import db / config / lark / matter 任何东西。
 * 输入 = 一串历史选择事件（谁类事 + 对谁 + 用户当时选了什么）+ 参数；输出 = 这次该问还是该照惯例直接办。
 * 换一个用户/换一套业务（邮件、工单、CRM…），只要把「事件」映射成同样的形状，引擎原样可用——
 * 泛化靠两层作用域：具体对象层（同一请求人）优先，通用类型层（同类任务跨请求人）兜底，
 * 与 playbook 的中粒度 taskTypeKey 同一个泛化哲学（MVP37：样本要跨人/跨项目才凑得齐）。
 *
 * 安全铁律（不由参数放开）：
 *  - 只有调用方显式列入 autoSafeChoices 的动作才可能自动执行（本项目只放 draft/investigate——
 *    起草只给草稿不代发、排查只读，都可逆；ignore 会归档事项、instruct 无法复现原话，永远要问）。
 *  - 惯例必须**连续一致**（最近 N 次全同一选择，中间出现任何别的选择就断掉重数）——
 *    比"多数票"保守，宁可多问一次，绝不把偶然当习惯。
 *  - 用户说过「先问我」的键（pausedKeys，或 'all'）永不自动，只提示不代办。
 */

export type HabitChoiceEvent = {
  /** 泛化任务类型键（本项目 = playbook 的中粒度 taskTypeKey，如 `follow_up:chase`）。 */
  key: string;
  /** 具体对象键（本项目 = 请求人实体 id 排序拼接）；缺省表示只参与通用层。 */
  subjectId?: string | null;
  /** 用户当时的选择（如 draft / investigate / ignore / instruct）。 */
  choice: string;
  /** ISO 时间。 */
  at: string;
};

export type HabitParams = {
  /** 连续同一选择 ≥ 这个数才够格自动办（默认 3）。 */
  autoMinStreak?: number;
  /** 允许自动执行的选择白名单（默认空 = 永不自动，只给提示）。 */
  autoSafeChoices?: readonly string[];
  /** 用户按过刹车的作用域键（具体键 / 通用键 / 'all'）——命中永不自动。 */
  pausedKeys?: readonly string[];
  /** 事件有效期（天，默认 90）——太老的习惯不作数。 */
  maxEventAgeDays?: number;
  /** 判定时刻（ISO，默认取事件里最新的 at；纯函数不读系统时钟）。 */
  now?: string;
};

export type HabitDecision =
  | {
      mode: 'auto';
      choice: string;
      /** 命中的作用域键（具体键或通用键），审计/暂停用。 */
      habitKey: string;
      /** 连续一致的证据条数。 */
      evidenceCount: number;
    }
  | {
      mode: 'ask';
      /** 有历史可提示时：猜用户会选什么（连续一致的最近选择）；无历史 = null。 */
      hintedChoice: string | null;
      habitKey: string | null;
      evidenceCount: number;
    };

const DAY_MS = 86_400_000;

/** 最近连续同一选择的 streak（事件须已按时间倒序）。 */
function latestStreak(events: HabitChoiceEvent[]): { choice: string; count: number } | null {
  if (events.length === 0) return null;
  const choice = events[0].choice;
  let count = 0;
  for (const e of events) {
    if (e.choice !== choice) break;
    count += 1;
  }
  return { choice, count };
}

/** 具体对象作用域键。与 pausedKeys 里的写法保持同一约定：`<subjectId>|<key>`。 */
export function specificHabitKey(subjectId: string, key: string): string {
  return `${subjectId}|${key}`;
}

/**
 * 决策：这次是问（可带提示）还是照惯例直接办。
 * 作用域优先级：具体对象层（同请求人同类事）> 通用类型层（同类事跨请求人）。
 * 具体层有任何历史时以具体层为准（个体差异覆盖通用惯例——张三的事你总让先查，
 * 不因为对别人总选起草就对张三自动起草）。
 */
export function decideConsultHabit(
  events: readonly HabitChoiceEvent[],
  target: { key: string; subjectId?: string | null },
  params: HabitParams = {}
): HabitDecision {
  const autoMin = Math.max(1, params.autoMinStreak ?? 3);
  const safe = new Set(params.autoSafeChoices ?? []);
  const paused = new Set(params.pausedKeys ?? []);
  const maxAgeDays = params.maxEventAgeDays ?? 90;

  const sorted = events
    .filter((e) => e.key === target.key && !!e.choice)
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at));
  const nowMs = Date.parse(params.now ?? sorted[0]?.at ?? '') || 0;
  const fresh = sorted.filter((e) => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) && nowMs - t <= maxAgeDays * DAY_MS;
  });

  const scopes: Array<{ habitKey: string; events: HabitChoiceEvent[] }> = [];
  if (target.subjectId) {
    scopes.push({
      habitKey: specificHabitKey(target.subjectId, target.key),
      events: fresh.filter((e) => e.subjectId === target.subjectId),
    });
  }
  scopes.push({ habitKey: target.key, events: fresh });

  for (const scope of scopes) {
    const streak = latestStreak(scope.events);
    if (!streak) continue; // 该层无历史 → 看下一层
    const pausedHere = paused.has('all') || paused.has(scope.habitKey) || paused.has(target.key);
    if (streak.count >= autoMin && safe.has(streak.choice) && !pausedHere) {
      return { mode: 'auto', choice: streak.choice, habitKey: scope.habitKey, evidenceCount: streak.count };
    }
    // 具体层只要有历史就定调（不再落到通用层），不够自动就作为提示。
    return { mode: 'ask', hintedChoice: streak.choice, habitKey: scope.habitKey, evidenceCount: streak.count };
  }
  return { mode: 'ask', hintedChoice: null, habitKey: null, evidenceCount: 0 };
}
