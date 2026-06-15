/**
 * MVP37 能力二「流程记忆」类型 + 任务归类键。
 *
 * 目标（用户原话）：对于重复类型的任务，记住应该如何完成这类任务的部分或全部工作。
 * 做法：从真实处理采集**操作轨迹**(TaskTrace)，按"任务类型"归类，同类够多就蒸馏成可复用 **playbook**。
 *
 * 任务类型键(taskTypeKey)用**中粒度**：matterType + 粗动作意图。
 * 不用 canonicalKey 那种细到具体人/对象的签名——否则"发评测集给鲁升纲"和"发给张三"算两类，
 * 样本永远凑不齐（对抗审查明确指出的坑）。中粒度让同类任务跨不同人/项目累积。
 */

export type TraceStepKind = 'read' | 'draft' | 'send' | 'create' | 'other';

export type TraceStep = {
  order: number;
  kind: TraceStepKind;
  tool?: string;        // 用的工具/动作名（如 search_im_messages / send_reply / lark_doc）
  summary: string;      // 这步做了什么/查到什么（一句话）
  params?: Record<string, unknown>; // 关键参数（去敏后），供蒸馏看"怎么填的"
};

export type TaskTrace = {
  id: string;
  taskTypeKey: string;
  matterId: string | null;
  source: 'investigation' | 'execution' | 'chat';
  title: string;
  steps: TraceStep[];
  outcome: string | null;
  createdAt: string;
};

export type PlaybookTier = 'suggest' | 'semi_auto' | 'auto';

export type PlaybookStep = {
  order: number;
  intent: string;       // 这步要达成什么（自然语言，执行时由 LLM 现场翻译成具体工具调用）
  toolHint?: string;    // 倾向用哪个工具（可选提示）
  note?: string;
};

export type TaskPlaybook = {
  id: string;
  taskTypeKey: string;
  title: string;
  steps: PlaybookStep[];
  tier: PlaybookTier;
  traceCount: number;
  successCount: number;
  correctionCount: number;
  confidence: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

// 粗动作意图：从 nextAction/标题归纳出这类任务的核心动作，作为 taskTypeKey 的第二段。
export function coarseIntent(text: string): string {
  const t = (text || '').toLowerCase();
  if (/(是否|核实|查证|查清|确认.*(进展|完成|收到))/.test(t)) return 'verify';
  if (/(回复|答复|回应|回邮件|回消息)/.test(t)) return 'reply';
  if (/(交付|提交|发出|发给|发送|上线|交稿)/.test(t)) return 'deliver';
  if (/(跟进|催|推动|盯)/.test(t)) return 'chase';
  if (/(评审|审阅|review|审核|把关)/.test(t)) return 'review';
  if (/(协调|对齐|安排|排期|拉群|约)/.test(t)) return 'coordinate';
  if (/(决定|拍板|定方案|选型)/.test(t)) return 'decide';
  return 'other';
}

/** 中粒度任务类型键：`<matterType>:<coarseIntent>`。纯函数。 */
export function deriveTaskTypeKey(matter: { type: string; nextAction?: string | null; title?: string }): string {
  const intent = coarseIntent(matter.nextAction || matter.title || '');
  return `${matter.type}:${intent}`;
}
