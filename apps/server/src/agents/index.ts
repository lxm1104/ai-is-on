/**
 * MVP3 agent bootstrap. Called once on server startup to register handlers.
 *
 * MVP8.1：track_commitment / prepare_meeting / sync_draft 改成 sliced packet 路径；
 * caring / daily_digest 暂留旧路径，MVP8.2 一起迁。
 */
import { registerAgent } from './agentRegistry.js';
import { trackCommitmentHandler } from './commitmentAgent.js';
import { prepareMeetingHandler } from './prepareMeetingAgent.js';
import { caringHandler } from './caringAgent.js';
import { syncDraftHandler } from './syncDraftAgent.js';
import { dailyDigestHandler } from './dailyDigestAgent.js';
import { recapActionItemsHandler } from './recapActionItemsAgent.js';

let bootstrapped = false;

export function bootstrapAgents() {
  if (bootstrapped) return;
  bootstrapped = true;

  // MVP15B M8: slices 加 'graphContext'，让 commitmentAgent 文案能用 decisionPath /
  // expectedButMissing / activeBlockers / projectPhase。其它 agent 走 MVP15B.x 独立 PR。
  registerAgent('track_commitment', {
    handler: trackCommitmentHandler,
    packetSliceVersion: 2,
    slices: ['focalUnit', 'latestActionResult', 'boundary', 'subject', 'spaces', 'graphContext'],
  });

  registerAgent('prepare_meeting', {
    handler: prepareMeetingHandler,
    packetSliceVersion: 1,
    slices: [
      'focalUnit',
      'spaces',
      'goals',
      'uncertainties',
      'relatedContext',
      'stakeholders',
      'boundary',
      'subject',
      'missingInfo',
    ],
  });

  registerAgent('sync_draft', {
    handler: syncDraftHandler,
    packetSliceVersion: 1,
    slices: ['focalUnit', 'spaces', 'stakeholders', 'boundary'],
  });

  // MVP8.2：caring/daily_digest 也走声明式注册。它们 system-level，没有 focal unit，
  // 但 packet 仍会装配（slices=[] 时 packet 只剩骨架 + agent_run_id + trigger 元信息）。
  registerAgent('caring', {
    handler: caringHandler,
    packetSliceVersion: 1,
    slices: ['boundary'],
  });
  registerAgent('daily_digest', {
    handler: dailyDigestHandler,
    packetSliceVersion: 1,
    slices: ['boundary'],
  });

  // MVP11.1：会议纪要抽 action items，调 LLM，写 ask 卡片
  registerAgent('recap_action_items', {
    handler: recapActionItemsHandler,
    packetSliceVersion: 1,
    slices: ['focalUnit', 'spaces', 'goals', 'stakeholders', 'subject', 'boundary'],
  });

  // MVP14 Step3.5：docCommentAgent 已删除。文档评论由 enrichment 写成
  // context_units（kind=event with semanticTags），由 attention engine 在 packet
  // 里看到，按需提到顶部，不再单独出 doc-only 卡片。

  console.log(
    '[agents] registered: track_commitment, prepare_meeting, sync_draft, caring, daily_digest, recap_action_items'
  );
}
