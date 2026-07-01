import { Router } from 'express';
import { db, getContextEntityById, listEvents, listTriageResults, matchMatterId, listUserBackfillUnitsForMatter, getMatterOriginHint, listKnownCodeRepos } from '../db.js';
import { raiseMatterProgressProposal } from '../matter/matterResolveProposal.js';
import { backfillUnitRouting } from '../bootstrap/backfillUnitRouting.js';
import { listInducers } from '../structure/inducerRegistry.js';
import { getMatterById, listMatterEntities } from '../matter/matterStore.js';
import { runInvestigation } from '../investigation/investigationLoop.js';
import { getModelCircuitState, getLlmGateStats } from '../triage/backgroundRuntime.js';
import { maybeQueueAutoConversation } from '../chat/chatTopics.js';
import { applyInvestigationResult } from '../investigation/investigationWriteback.js';
import { runInvestigationDispatchTick } from '../investigation/investigationDispatcher.js';
import { captureInvestigationTrace } from '../playbook/playbookCapture.js';
import { matchPlaybookForMatter, renderPlaybookForPrompt } from '../playbook/playbookMatcher.js';
import { resolveProjectProfileForMatter } from '../investigation/projectProfile.js';
import { config } from '../config.js';

export const debugRouter = Router();

// MVP40：把已有的 progressed/blocked 排查结果回填成「进展回执」卡（一次性，让用户立刻看到价值）。
debugRouter.post('/debug/investigation/backfill-progress', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT json_extract(payload_json,'$.matterId') mid,
              json_extract(payload_json,'$.verdict') v,
              MAX(json_extract(payload_json,'$.confidence')) conf
       FROM audit_logs WHERE action='investigation_written_back'
         AND json_extract(payload_json,'$.verdict') IN ('progressed','blocked')
         AND json_extract(payload_json,'$.confidence') >= 0.6
       GROUP BY mid`
    )
    .all() as Array<{ mid: string; v: 'progressed' | 'blocked'; conf: number }>;
  let raised = 0;
  const done: string[] = [];
  for (const row of rows) {
    const m = getMatterById(row.mid);
    if (!m) continue;
    // 从 currentSummary 的「［AI 排查］X｜…」段取 factSummary，取不到退回标题
    const seg = (m.currentSummary || '').match(/［AI 排查］([^｜]+)/);
    const factSummary = (seg?.[1] || m.currentSummary || m.title).trim();
    if (raiseMatterProgressProposal(m, { verdict: row.v, factSummary, evidence: [], confidence: row.conf })) {
      raised++;
      done.push(`${m.title.slice(0, 20)}(${row.v})`);
    }
  }
  res.json({ ok: true, candidates: rows.length, raised, done });
});

// MVP36：查自主排查 dispatcher 状态（确认试运行是否开启）。
debugRouter.get('/debug/investigation/status', (_req, res) => {
  res.json({
    enabled: config.investigationDispatchEnabled,
    tickMs: config.investigationTickMs,
    cooldownMs: config.investigationCooldownMs,
    maxRounds: config.investigationMaxRounds,
  });
});

// 吞吐观测：opencode 模型熔断状态 + LLM 闸门排队（看 glm-5.2 是否被熔断跳过、当前用哪个）。
debugRouter.get('/debug/model-circuit', (_req, res) => {
  res.json({
    enabled: config.opencodeModelCircuitEnabled,
    threshold: config.opencodeModelCircuitThreshold,
    window: config.opencodeModelCircuitWindow,
    cooldownMs: config.opencodeModelCircuitCooldownMs,
    primary: config.opencodeModel,
    chain: [config.opencodeModel, ...config.opencodeFallbackModels],
    circuit: getModelCircuitState(),
    gate: getLlmGateStats(),
  });
});

// MVP75 演示/验证：在 live backend 上触发一次自动推进（开会话+自动起草），让 WS 广播真达到前端。
debugRouter.post('/debug/auto-push', async (req, res) => {
  const body = req.body ?? {};
  const matterId = matchMatterId(body.matterId) ?? body.matterId;
  const m = getMatterById(matterId);
  if (!m) return res.status(404).json({ error: 'matter not found' });
  // 清掉同 matter 旧的 ai_push 会话（幂等闸会挡重复），让本次能重新开。
  db.prepare(`DELETE FROM runtime_messages WHERE topic_id IN (SELECT id FROM chat_topics WHERE source_kind='ai_push' AND source_ref_id=?)`).run(matterId);
  db.prepare(`DELETE FROM chat_topics WHERE source_kind='ai_push' AND source_ref_id=?`).run(matterId);
  const rec = {
    stance: (body.stance as 'do' | 'escalate' | 'decide') ?? 'do',
    advice: String(body.advice ?? '催相关同学把这条阻塞项落地'),
    because: String(body.because ?? '查到该项长期未推进'),
    nextStep: body.nextStep ? String(body.nextStep) : undefined,
  };
  const opened = maybeQueueAutoConversation(m, rec, String(body.factSummary ?? m.currentSummary ?? ''));
  res.json({ ok: true, opened });
});

// MVP36：手动立即跑一次 dispatcher tick（不等定时器；试运行验证用）。
debugRouter.post('/debug/investigation/tick', async (_req, res) => {
  try {
    const dispatched = await runInvestigationDispatchTick();
    res.json({ ok: true, dispatched });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// MVP36：在真实 matter 上跑一次「自主排查」（硬只读，安全）。手动验证用。
debugRouter.post('/debug/investigation/run', async (req, res) => {
  const body = req.body ?? {};
  if (typeof body.matterId !== 'string') return res.status(400).json({ error: 'matterId required' });
  const matterId = matchMatterId(body.matterId) ?? body.matterId;
  const m = getMatterById(matterId);
  if (!m) return res.status(404).json({ error: `matter ${matterId} not found` });
  const entities = listMatterEntities(matterId)
    .map((l) => {
      const e = getContextEntityById(l.entityId);
      return e ? { type: e.type, name: e.name, role: String(l.role) } : null;
    })
    .filter((x): x is { type: string; name: string; role: string } => x !== null)
    .slice(0, 8);
  try {
    // 与 investigationDispatcher 真实派发路径对齐：注入项目排查档案 + 已学做法，
    // 否则手动验证看不到 run_command 该往哪查（项目档案里才有代码库路径/trace 方法）。
    const matchedPb = matchPlaybookForMatter(m);
    const result = await runInvestigation({
      matterTitle: m.title,
      matterType: m.type,
      currentSummary: m.currentSummary,
      nextAction: m.nextAction ?? '确认该事项的当前进展',
      entities,
      maxRounds: typeof body.maxRounds === 'number' ? body.maxRounds : 3,
      priority: true, // 手动验证：走 high 队列尽快拿 gate，不被 attention 饿死
      playbookHint: matchedPb ? renderPlaybookForPrompt(matchedPb) : undefined,
      projectProfile: (await resolveProjectProfileForMatter(m)) ?? undefined,
      userBackfills: listUserBackfillUnitsForMatter(matterId, 5).map((u) => u.content), // MVP71 KEYSTONE：对齐真实派发
      originHint: getMatterOriginHint(matterId) ?? undefined, // 追查链路：源头
      knownCodeRepos: listKnownCodeRepos(), // 追查链路：已知业务代码库（git log 去对的仓）
    });
    let writeback;
    if (body.apply === true) {
      const toolSummary = result.toolLog.map((l) => `${l.tool}:${l.ok ? l.summary : '失败'}`).join('；');
      writeback = applyInvestigationResult({ matterId, conclusion: result.conclusion, toolSummary });
      try {
        captureInvestigationTrace(m, result);
      } catch {}
    }
    res.json({ ok: true, matter: { id: matterId, title: m.title, nextAction: m.nextAction }, ...result, writeback });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

debugRouter.get('/debug/events', (_req, res) => {
  res.json({ events: listEvents(50) });
});

debugRouter.get('/debug/triage-results', (_req, res) => {
  res.json({ triage_results: listTriageResults(50) });
});

// MVP21 S5: inducer 注册表快照。返回所有 import-time 登记过的 inducer 元数据
// 和上次运行的耗时 / 错误。前端可以做"Structure Health"轻量观测面板。
debugRouter.get('/debug/inducers', (_req, res) => {
  res.json({ inducers: listInducers() });
});

// MVP12 §4.1 P1.9：手动触发 unit_sources / unit_routing_cache backfill。
// 升级到 Phase 1 后跑一次即可；幂等。
debugRouter.post('/debug/backfill-unit-routing', (req, res) => {
  const eventLimit =
    typeof req.body?.eventLimit === 'number' ? req.body.eventLimit : undefined;
  try {
    const stats = backfillUnitRouting({ eventLimit });
    res.json({ ok: true, stats });
  } catch (err) {
    res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
