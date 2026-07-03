import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { config } from './config.js';
import { attachWebSocket } from './ws.js';
import { claudeRuntime } from './claude/ClaudeRuntime.js';
import { syncOpencodeAgents } from './opencode/agents.js';
import { startMessageBus } from './messageBus.js';
import { chatRouter } from './routes/chat.js';
import { runtimeRouter } from './routes/runtime.js';
import { speechRouter } from './routes/speech.js';
import { cardsRouter } from './routes/cards.js';
import { collectorsRouter } from './routes/collectors.js';
import { debugRouter } from './routes/debug.js';
import { contextRouter } from './routes/context.js';
import { triggersRouter } from './routes/triggers.js';
import { agentRunsRouter } from './routes/agentRuns.js';
import { caringRouter } from './routes/caring.js';
import { manualEventRouter } from './routes/manualEvent.js';
import { contextSpacesRouter } from './routes/contextSpaces.js';
import { boundaryRouter } from './routes/boundary.js';
import { bootstrapRouter } from './routes/bootstrap.js';
import { correctionRouter } from './routes/correction.js';
import { actionItemsRouter } from './routes/actionItems.js';
import { resolveRouter } from './routes/resolve.js';
import { adminSuggestionRouter } from './routes/adminSuggestion.js';
import { attentionRouter } from './routes/attention.js';
import { larkTasksRouter } from './routes/larkTasks.js';
import { larkReplyRouter } from './routes/larkReply.js';
import { playbooksRouter } from './routes/playbooks.js';
import { problemClassesRouter } from './routes/problemClasses.js';
import { investigationTraceRouter } from './routes/investigationTrace.js';
import { graphRouter } from './routes/graph.js';
import { projectsRouter } from './routes/projects.js';
import { toneProfileRouter } from './routes/toneProfile.js';
import { mattersRouter } from './routes/matters.js';
import { settingsRouter } from './routes/settings.js';
import { runGraphInducer } from './structure/derived/graphInducer.js';
import { startCollectorScheduler, stopCollectorScheduler } from './collectors/scheduler.js';
import {
  startFreshnessWatchdog,
  stopFreshnessWatchdog,
} from './collectors/freshnessWatchdog.js';
import { startMatterTracker, stopMatterTracker } from './matter/matterScheduler.js';
import { startTriggerScheduler, stopTriggerScheduler } from './triggers/triggerScheduler.js';
import { startAttentionScheduler, stopAttentionScheduler } from './attention/attentionEngine.js';
import { startInvestigationDispatcher, stopInvestigationDispatcher } from './investigation/investigationDispatcher.js';
import { armNotifyService, startDailyWorkReportJob, stopDailyWorkReportJob } from './lark/larkNotifyService.js';
import { startBotReplyLoop, stopBotReplyLoop } from './lark/botReplyLoop.js';
import { startBacklogSweepJob, stopBacklogSweepJob } from './matter/backlogSweeper.js';
import { bootstrapAgents } from './agents/index.js';
import { migrateUserRulesIfNeeded } from './boundary/migration.js';
import { runStartupRecovery } from './startupRecovery.js';
import { startChatConclusionService } from './matter/chatConclusionService.js';
import { startMatterVerifyService, stopMatterVerifyService } from './matter/matterVerifyService.js';
import { recoverUnconsumedObservations } from './matter/matterObservationConsumer.js';
import { startMaintenance, stopMaintenance } from './maintenance.js';

const app = express();
app.use(cors({ origin: config.webOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, runtime: claudeRuntime.getStatus() });
});

app.use('/api', chatRouter);
app.use('/api', runtimeRouter);
app.use('/api', speechRouter);
app.use('/api', cardsRouter);
app.use('/api', collectorsRouter);
app.use('/api', debugRouter);
app.use('/api', contextRouter);
app.use('/api', triggersRouter);
app.use('/api', agentRunsRouter);
app.use('/api', caringRouter);
app.use('/api', manualEventRouter);
app.use('/api', contextSpacesRouter);
app.use('/api', boundaryRouter);
app.use('/api', bootstrapRouter);
app.use('/api', correctionRouter);
app.use('/api', actionItemsRouter);
app.use('/api', resolveRouter);
app.use('/api', adminSuggestionRouter);
app.use('/api', attentionRouter);
app.use('/api', larkTasksRouter);
app.use('/api', larkReplyRouter);
app.use('/api', playbooksRouter);
app.use('/api', problemClassesRouter);
app.use('/api', investigationTraceRouter);
app.use('/api', graphRouter);
app.use('/api', projectsRouter);
app.use('/api', toneProfileRouter);
app.use('/api', mattersRouter);
app.use('/api', settingsRouter);

const server = http.createServer(app);
attachWebSocket(server);

startMessageBus();

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[server] listening on http://127.0.0.1:${config.port}`);
  try {
    syncOpencodeAgents();
    console.log('[server] opencode agents synced');
  } catch (err) {
    console.error('[server] failed to sync opencode agents:', err);
  }
  claudeRuntime
    .start()
    .then(() => console.log('[server] opencode chat runtime ready'))
    .catch((err) =>
      console.error('[server] failed to start chat runtime:', err)
    );
  migrateUserRulesIfNeeded();
  try {
    const recovery = runStartupRecovery();
    console.log(
      `[recovery] 孤儿 attention run ${recovery.orphanedAttentionRuns}、agent run ${recovery.orphanedAgentRuns}；` +
        `事件销账 ${recovery.eventsWrittenOff}、回灌 triage ${recovery.eventsRequeued}、遗留 ${recovery.eventsLeftBehind}；` +
        `聊天 turn 续跑 ${recovery.chatTurnsResumed}`
    );
  } catch (err) {
    console.error('[recovery] startup recovery failed:', err);
  }
  bootstrapAgents();
  startCollectorScheduler();
  // 2026-06-12：采集"沉默式停摆"看门狗（authWatchdog 只管报错，这个管不出声）。
  startFreshnessWatchdog();
  // MVP27 §10.2：Matter tracker 注册在 trigger/attention 之前，先归并事项状态。
  startMatterTracker();
  // MVP31：ask_agent 对话结论 → 办结提案回流
  startChatConclusionService();
  // MVP32：mark_done 办结核实（恢复扫描补排重启丢失的 timer）
  startMatterVerifyService();
  // MVP33 U2：观察消费补扫（fire-and-forget 在重启时丢的 in-flight 观察）。
  // 延后 30s：等 collector/triage 启动稳定，且每条消费走 opencode 单并发闸门不抢主链路。
  setTimeout(() => {
    recoverUnconsumedObservations().catch((err) => {
      console.warn(
        `[matter-obs] startup recovery failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }, 30_000);
  // 日常维护：opencode 一次性 session 清理（防 db 无限增长拖垮 checkpoint）
  startMaintenance();
  startTriggerScheduler();
  startAttentionScheduler();
  startInvestigationDispatcher(); // MVP36：默认关，opt-in 才自动派发只读排查
  // MVP77：飞书推送通道只在服务进程 arm（测试 import 升卡函数时天然 no-op，绝不误发）。
  armNotifyService();
  startDailyWorkReportJob();
  // MVP78：回复闭环（你在 bot 会话回一句就推进）+ 积压大扫除（清单待你一句话确认，绝不自动清）。
  startBotReplyLoop();
  startBacklogSweepJob();
  // MVP15A §7.2.1: 10s 后台预热 graph inducer（首次 LLM project taxonomy 慢，
  // 这样 /api/graph/* 第一次访问命中缓存）。失败不阻塞 server。
  setTimeout(() => {
    runGraphInducer({ force: true }).catch((err) => {
      console.warn(
        `[server] graph inducer warmup failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }, 10_000);
});

const shutdown = async (signal: string) => {
  console.log(`[server] received ${signal}, shutting down`);
  try {
    stopCollectorScheduler();
  } catch {}
  try {
    stopInvestigationDispatcher();
  } catch {}
  try {
    stopDailyWorkReportJob();
  } catch {}
  try {
    stopBotReplyLoop();
  } catch {}
  try {
    stopBacklogSweepJob();
  } catch {}
  try {
    stopFreshnessWatchdog();
  } catch {}
  try {
    stopMaintenance();
  } catch {}
  try {
    stopMatterTracker();
  } catch {}
  try {
    stopMatterVerifyService();
  } catch {}
  try {
    stopTriggerScheduler();
  } catch {}
  try {
    stopAttentionScheduler();
  } catch {}
  try {
    await claudeRuntime.stop();
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
