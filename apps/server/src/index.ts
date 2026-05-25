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
import { startCollectorScheduler, stopCollectorScheduler } from './collectors/scheduler.js';
import { startTriggerScheduler, stopTriggerScheduler } from './triggers/triggerScheduler.js';
import { startAttentionScheduler, stopAttentionScheduler } from './attention/attentionEngine.js';
import { bootstrapAgents } from './agents/index.js';
import { migrateUserRulesIfNeeded } from './boundary/migration.js';

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
  bootstrapAgents();
  startCollectorScheduler();
  startTriggerScheduler();
  startAttentionScheduler();
});

const shutdown = async (signal: string) => {
  console.log(`[server] received ${signal}, shutting down`);
  try {
    stopCollectorScheduler();
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
