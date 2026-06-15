/**
 * MVP36 — 把自主排查结论安全回写到 Matter。
 *
 * 保守原则（与办结核实/observation 同philosophy）：**绝不自动改 status**——排查只"补事实+给判断"，
 * 真正的办结/重开仍由用户确认或既有保守通道决定（避免误判已完成伤信任）。本回写只做两件确定性的事：
 *   ① 把"AI 查到的事实 + 证据"落成一条 action_result ContextUnit，挂到 Matter 作证据（用户可见 AI 查了什么）；
 *   ② 把 factSummary 并进 Matter.currentSummary（让卡片直接显示排查结论）。
 * verdict=resolved 高置信时**只记一句提示**进 nextAction（"经排查疑似已完成，待确认"），不动 status。
 */
import { upsertContextUnit } from '../context/contextStore.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';
import { attachMatterContextLink, getMatterById, saveMatter } from '../matter/matterStore.js';
import { writeAudit } from '../boundary/auditLog.js';
import { broadcast } from '../ws.js';
import type { InvestigationConclusion } from './investigationPrompt.js';

export type InvestigationWritebackResult = {
  ok: boolean;
  matterId: string;
  resultUnitId?: string;
  summaryUpdated: boolean;
  error?: string;
};

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 把排查结论安全回写到 matter（只补证据 + 更新摘要，不自动改 status）。 */
export function applyInvestigationResult(input: {
  matterId: string;
  conclusion: InvestigationConclusion;
  toolSummary?: string; // 用了哪些只读工具的一行摘要，便于追溯
}): InvestigationWritebackResult {
  const matter = getMatterById(input.matterId);
  if (!matter) return { ok: false, matterId: input.matterId, summaryUpdated: false, error: 'matter not found' };

  const c = input.conclusion;
  const now = new Date().toISOString();
  const factLine = c.factSummary?.trim() || '（未得出明确结论）';

  // ① 排查事实 → silent action_result unit（挂 matter 作证据；幂等：同 matter+事实合并）
  const entities: ContextEntityRef[] = [];
  let resultUnitId: string | undefined;
  try {
    const unit = upsertContextUnit({
      kind: 'action_result',
      title: clip(`AI 排查：${factLine}`, 60),
      content: [
        `AI 自主排查结论（${c.verdict}，置信 ${c.confidence.toFixed(2)}）：`,
        factLine,
        c.evidence.length ? '\n证据：' : '',
        ...c.evidence.slice(0, 6).map((e) => `· ${clip(e, 180)}`),
        input.toolSummary ? `\n（排查用：${clip(input.toolSummary, 120)}）` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      entities,
      scope: matter.scope,
      origin: { kind: 'agent_run', refId: `investigation:${matter.id}` },
      actionability: 'record',
      confidence: c.confidence,
      mergeHint: `investigation:${matter.id}:${clip(factLine, 40)}`,
      silent: true, // 状态已由本服务确定性处理，不再触发 reducer echo
    }).unit;
    resultUnitId = unit.id;
    attachMatterContextLink({
      matterId: matter.id,
      contextUnitId: unit.id,
      relation: 'evidence',
      effect: 'no_change', // 保守：只作证据，不改 status
      confidence: c.confidence,
      reason: `AI 自主排查（${c.verdict}）`,
      now,
    });
  } catch (err) {
    return { ok: false, matterId: matter.id, summaryUpdated: false, error: err instanceof Error ? err.message : String(err) };
  }

  // ② 更新 currentSummary（让卡片直接显示排查结论）；高置信 resolved 在 nextAction 留一句提示但不改 status
  const summaryAddon = `［AI 排查］${factLine}`;
  const newSummary = matter.currentSummary && !matter.currentSummary.includes(summaryAddon)
    ? clip(`${summaryAddon}｜${matter.currentSummary}`, 400)
    : matter.currentSummary || summaryAddon;
  const newNextAction =
    c.verdict === 'resolved' && c.confidence >= 0.7
      ? '经 AI 排查疑似已完成，请确认是否办结'
      : c.verdict === 'blocked'
        ? clip(`排查发现受阻：${factLine}`, 60)
        : matter.nextAction ?? null;

  saveMatter({
    ...matter,
    currentSummary: newSummary,
    nextAction: newNextAction,
    lastEvidenceContextUnitId: resultUnitId ?? matter.lastEvidenceContextUnitId,
    lastEvidenceAt: now,
    version: matter.version + 1,
    updatedAt: now,
  });

  writeAudit({
    action: 'investigation_written_back',
    reason: `AI 排查结论回写 matter（${c.verdict}）：${clip(factLine, 60)}`,
    payload: { matterId: matter.id, verdict: c.verdict, confidence: c.confidence, resultUnitId },
  });

  try {
    broadcast({ type: 'matter_updated', matterId: matter.id });
  } catch {}

  return { ok: true, matterId: matter.id, resultUnitId, summaryUpdated: true };
}
