/**
 * MVP51 — 问题类聚合（case → 问题类台账）的类型 + 纯函数。叶子模块（无副作用、无 DB）。
 *
 * 用户诉求："不要单 case，汇总成一类，记下这一类是哪一种问题引起的"。
 * 关键设计（对抗审查纠错）：**LLM 拥有"类身份"**——同症状不同根因要拆、不同症状同根因要合；
 * 这里的 symptomBucket **只是便宜的召回预分桶（绝不作为类的 key）**。
 */

export type ProblemClassOrigin = 'distilled' | 'user';
export type MemberStatus = 'pending' | 'assigned' | 'rejected';
export type ProblemClassStatus = 'open' | 'fixing' | 'resolved'; // MVP54：根因类的修复生命周期

// MVP56：问题类「系统性分析」——AI 综合这一类所有 case 得出的系统性结论（必须经用户审阅，绝不自动落地）。
export type ClassAnalysisStatus = 'none' | 'pending_review' | 'reviewed';
export type ClassAnalysis = {
  systematicRootCause: string; // 这一类问题系统性的根本原因（综合多 case，而非单 case）
  systematicSolution: string; // 系统性解法/修复方向
  affectedScope: string; // 影响面/涉及组件/范围
  recommendedAction: string; // 建议的下一步（给用户决策，不自动执行）
  verificationCommands?: string[]; // MVP63：确认/证伪该根因的**只读**命令清单(rg/grep/git log/git show/fornax-cli)，给用户(或下一轮排查)跑
  confidence: number;
};

// 成员诊断文本里出现这些 → AI 疑似已查到该类被修复（台账上提示用户可标已修复）
export const RESOLVED_HINT_RE = /已修复|已上线|已合入|合入\s*release|fixed|修复方案已|已发版|已部署/i;

export type ProblemClassMember = {
  matterId: string;
  spaceId: string | null;
  symptomBucket: string;
  diagnosticText: string;
  evidence: string[];
  confidence: number;
  classId: string | null;
  status: MemberStatus;
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProblemClass = {
  id: string;
  spaceId: string | null;
  label: string;
  rootCause: string;
  origin: ProblemClassOrigin;
  approved: boolean;
  memberCount: number;
  systemic: boolean;
  status: ProblemClassStatus;
  analysis: ClassAnalysis | null; // MVP56：系统性分析结论（null=未分析）
  analysisStatus: ClassAnalysisStatus; // 待审阅 / 已审阅
  analyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 人主导：用户写的/已批准的类不被自发蒸馏覆盖（与 playbook 同纪律）。 */
export function isAuthoritativeClass(c: { origin: ProblemClassOrigin; approved: boolean }): boolean {
  return c.origin === 'user' || c.approved;
}

// ---- 通用症状桶（recall-only，项目无关；v2 可由项目 profile 扩展）----
const SYMPTOM_BUCKETS: Array<[string, RegExp]> = [
  ['截断', /截断|truncat|过长|超长|内容不全/i],
  ['鉴权', /鉴权|权限|无权限|未授权|unauthor|403|401|token.{0,4}过期/i],
  ['超时', /超时|timeout|很慢|太慢|卡住|无响应|没反应/i],
  ['格式', /乱码|格式不对|csv|xlsx|编码错|encoding|解析失败/i],
  ['数据缺失', /没取到|取不到|查不到数据|数据.{0,2}(为空|缺失|没有)|未返回|拿不到/i],
  ['发送失败', /发送.{0,4}失败|发不出|可见性|send.{0,6}fail/i],
  ['参数', /参数.{0,4}(错|非法|缺)|argument|invalid.{0,6}(arg|param)|400/i],
  ['报错', /报错|error|异常|exception|崩|panic|失败|fail|bug/i],
];

/** 把诊断文本归到一个通用症状桶（仅用于召回批处理，不是类身份）。 */
export function deriveSymptomBucket(text: string): string {
  const t = text || '';
  for (const [name, re] of SYMPTOM_BUCKETS) if (re.test(t)) return name;
  return '其他';
}

// ---- 诊断信号门：文本是否在描述"哪里坏了/根因"（而非"已完成/在推进"或"查不到进展"）----
const DIAGNOSTIC_RE =
  /根因|根本原因|受阻|导致|致.{0,6}(断|失败|错|不)|因为|未返回|未.{0,3}生效|报错|缺陷|bug|定位到|原因(是|在|出在)|问题(在|是|出在)|截断|乱码|无权限|鉴权失败|超时|没取到|发送失败|非法.{0,4}(调用|参数)/i;
// 排除：纯"已完成/在推进"、以及"查不到某承诺的进展/证据"（那是跟进缺证据，不是 bug 类）
const NON_DIAGNOSTIC_RE =
  /^(已完成|已发送|已回复|已交付|在推进|已确认)|未(查到|找到).{0,12}(进展|证据|记录|后续|交付|完成)|无(相关|任何).{0,8}(进展|记录|沟通|证据)/;

/** 这段结论/摘要是否携带"根因/故障"性质，值得进问题类聚合。纯函数。 */
export function isDiagnostic(text: string): boolean {
  const t = (text || '').trim();
  if (t.length < 8) return false;
  if (NON_DIAGNOSTIC_RE.test(t)) return false;
  return DIAGNOSTIC_RE.test(t);
}

/** 去掉 currentSummary 里的「［AI 排查］…｜」等前缀，取出干净诊断文本（backfill 用）。 */
export function stripSummaryPrefix(summary: string): string {
  return (summary || '')
    .replace(/^［AI (排查|对话)］/, '')
    .split('｜')[0]
    .trim();
}
