/**
 * MVP13 §6.5 · suggestion 校准报告。
 *
 * 输入 windowDays，输出：
 *   - totals: surfaced / confirmed / rejected / pending
 *   - confusion: decision × action 4x3 矩阵
 *   - reject 原因分布
 *   - rule vs llm 相关性（Pearson 简化版）
 *   - 阈值建议（不自动改阈值）
 */
import {
  db,
  listSuggestionFeedbackForCalibration,
  type ContextSpaceSuggestionFeedbackRow,
  type ContextSpaceSuggestionRow,
} from '../db.js';
import { config } from '../config.js';

export type CalibrationReport = {
  generatedAt: string;
  windowDays: number;
  totals: {
    suggestionsSurfaced: number;
    confirmed: number;
    rejected: number;
    pending: number;
  };
  confusion: Record<
    'strong_accept' | 'accept' | 'maybe' | 'reject',
    { confirmed: number; rejected: number; pending: number }
  >;
  rejectReasonBreakdown: Array<{
    reasonCode: string;
    count: number;
    pctOfReject: number;
  }>;
  ruleVsLlm: {
    correlation: number;
    disagreement: number;
  };
  recommendation: {
    thresholdSuggestionsToReview: Array<{
      field: 'finalScore' | 'llmConfidence';
      current: number;
      suggested: number;
      basis: string;
    }>;
  };
};

function emptyConfusion(): CalibrationReport['confusion'] {
  return {
    strong_accept: { confirmed: 0, rejected: 0, pending: 0 },
    accept: { confirmed: 0, rejected: 0, pending: 0 },
    maybe: { confirmed: 0, rejected: 0, pending: 0 },
    reject: { confirmed: 0, rejected: 0, pending: 0 },
  };
}

export function buildCalibrationReport(windowDays: number): CalibrationReport {
  const cutoff = new Date(
    Date.now() - windowDays * 86400_000
  ).toISOString();

  // 1) 最近窗口期内 ranker_status != 'rule_only' 的 chat_affinity suggestion
  const suggestions = db
    .prepare(
      `SELECT * FROM context_space_suggestions
       WHERE suggestion_type = 'chat_affinity'
         AND updated_at >= ?`
    )
    .all(cutoff) as ContextSpaceSuggestionRow[];
  const surfacedCount = suggestions.length;

  // 状态聚合
  let confirmed = 0;
  let rejected = 0;
  let pending = 0;
  for (const s of suggestions) {
    if (s.status === 'confirmed') confirmed++;
    else if (s.status === 'rejected') rejected++;
    else pending++;
  }

  // 2) confusion: decision × action（取 suggestion 表里的 llm_decision + status）
  const confusion = emptyConfusion();
  for (const s of suggestions) {
    const dec = (s.llm_decision ?? '') as
      | 'strong_accept'
      | 'accept'
      | 'maybe'
      | 'reject';
    if (!confusion[dec]) continue;
    if (s.status === 'confirmed') confusion[dec].confirmed++;
    else if (s.status === 'rejected') confusion[dec].rejected++;
    else confusion[dec].pending++;
  }

  // 3) reject reason breakdown — 来自 feedback 表
  const feedback = listSuggestionFeedbackForCalibration(windowDays);
  const rejectedFb = feedback.filter(
    (f: ContextSpaceSuggestionFeedbackRow) => f.action === 'rejected'
  );
  const reasonAgg = new Map<string, number>();
  for (const f of rejectedFb) {
    reasonAgg.set(f.reason_code, (reasonAgg.get(f.reason_code) ?? 0) + 1);
  }
  const totalReject = rejectedFb.length || 1;
  const rejectReasonBreakdown = Array.from(reasonAgg.entries())
    .map(([reasonCode, count]) => ({
      reasonCode,
      count,
      pctOfReject: count / totalReject,
    }))
    .sort((a, b) => b.count - a.count);

  // 4) ruleVsLlm correlation（简化 Pearson）+ disagreement
  const pairs: Array<{ rule: number; llm: number }> = [];
  let disagreement = 0;
  for (const s of suggestions) {
    if (typeof s.rule_score === 'number' && typeof s.llm_score === 'number') {
      pairs.push({ rule: s.rule_score, llm: s.llm_score });
      if (Math.abs(s.rule_score - s.llm_score) > 0.4) disagreement++;
    }
  }
  let correlation = 0;
  if (pairs.length >= 2) {
    const meanR = pairs.reduce((a, p) => a + p.rule, 0) / pairs.length;
    const meanL = pairs.reduce((a, p) => a + p.llm, 0) / pairs.length;
    let num = 0;
    let dr = 0;
    let dl = 0;
    for (const p of pairs) {
      num += (p.rule - meanR) * (p.llm - meanL);
      dr += (p.rule - meanR) ** 2;
      dl += (p.llm - meanL) ** 2;
    }
    const denom = Math.sqrt(dr) * Math.sqrt(dl);
    correlation = denom === 0 ? 0 : num / denom;
  }

  // 5) 阈值建议（仅提示）
  const recs: CalibrationReport['recommendation']['thresholdSuggestionsToReview'] =
    [];
  const acceptish =
    confusion.accept.confirmed +
    confusion.accept.rejected +
    confusion.strong_accept.confirmed +
    confusion.strong_accept.rejected;
  const acceptishRejected =
    confusion.accept.rejected + confusion.strong_accept.rejected;
  if (acceptish > 0 && acceptishRejected / acceptish > 0.5) {
    recs.push({
      field: 'finalScore',
      current: config.mvp13SurfaceFinalScore,
      suggested: Math.min(0.85, config.mvp13SurfaceFinalScore + 0.05),
      basis: `accept/strong_accept reject rate ${(acceptishRejected / acceptish).toFixed(2)} > 0.50`,
    });
  }
  const strong =
    confusion.strong_accept.confirmed +
    confusion.strong_accept.rejected +
    confusion.strong_accept.pending;
  if (
    strong > 0 &&
    confusion.strong_accept.confirmed / strong > 0.8 &&
    confusion.strong_accept.pending / strong < 0.2
  ) {
    recs.push({
      field: 'finalScore',
      current: config.mvp13SurfaceFinalScore,
      suggested: Math.max(0.5, config.mvp13SurfaceFinalScore - 0.03),
      basis: `strong_accept confirm rate ${(confusion.strong_accept.confirmed / strong).toFixed(2)} > 0.80 且 pending 占比低，可考虑降阈值多召回`,
    });
  }
  if (disagreement > 0 && disagreement / Math.max(pairs.length, 1) > 0.3) {
    recs.push({
      field: 'llmConfidence',
      current: config.mvp13SurfaceLlmConfidence,
      suggested: config.mvp13SurfaceLlmConfidence,
      basis: `rule vs llm 分歧率 ${(disagreement / Math.max(pairs.length, 1)).toFixed(2)} > 0.30，检查 prompt 是否过度否定规则 evidence`,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    totals: {
      suggestionsSurfaced: surfacedCount,
      confirmed,
      rejected,
      pending,
    },
    confusion,
    rejectReasonBreakdown,
    ruleVsLlm: {
      correlation: Number(correlation.toFixed(3)),
      disagreement,
    },
    recommendation: { thresholdSuggestionsToReview: recs },
  };
}
