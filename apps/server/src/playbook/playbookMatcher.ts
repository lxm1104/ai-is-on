/**
 * MVP37 — 召回：给定一件事项，找出它命中的 playbook（这类任务的已知做法）。
 * 用于把 playbook 步骤注入「让 AI 处理」/ 自主排查的 prompt，让 AI 照用户教过/认可的方式做。
 */
import { getPlaybookByType } from './playbookStore.js';
import { deriveTaskTypeKey, type TaskPlaybook } from './PlaybookTypes.js';

/** 按 matter 的中粒度 taskTypeKey 召回 active playbook（无则 null）。 */
export function matchPlaybookForMatter(matter: {
  type: string;
  nextAction?: string | null;
  title?: string;
}): TaskPlaybook | null {
  const key = deriveTaskTypeKey(matter);
  const pb = getPlaybookByType(key);
  return pb && pb.active ? pb : null;
}

/** 把 playbook 渲染成可注入 prompt 的"推荐步骤"文本块（带是否权威的措辞）。 */
export function renderPlaybookForPrompt(pb: TaskPlaybook): string {
  const authoritative = pb.origin === 'user' || pb.approved;
  const head = authoritative
    ? '【这类任务你认可的标准做法，请优先照此处理】'
    : '【这类任务的参考做法（AI 自学草稿，仅供参考，可偏离）】';
  const steps = pb.steps
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => `${s.order}. ${s.intent}${s.toolHint ? `（建议用 ${s.toolHint}）` : ''}${s.note ? ` —— ${s.note}` : ''}`)
    .join('\n');
  return `${head}\n${steps}`;
}
