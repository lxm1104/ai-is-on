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
import { docCommentHandler } from './docCommentAgent.js';
import { recapActionItemsHandler } from './recapActionItemsAgent.js';

let bootstrapped = false;

export function bootstrapAgents() {
  if (bootstrapped) return;
  bootstrapped = true;

  registerAgent('track_commitment', {
    handler: trackCommitmentHandler,
    packetSliceVersion: 1,
    slices: ['focalUnit', 'latestActionResult', 'boundary', 'subject', 'spaces'],
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

  // MVP11.0-b：文档评论 attention，零 LLM，只读 focalUnit + boundary
  registerAgent('doc_comment', {
    handler: docCommentHandler,
    packetSliceVersion: 1,
    slices: ['focalUnit', 'boundary', 'subject'],
  });

  // MVP11.1：会议纪要抽 action items，调 LLM，写 ask 卡片
  registerAgent('recap_action_items', {
    handler: recapActionItemsHandler,
    packetSliceVersion: 1,
    slices: ['focalUnit', 'spaces', 'goals', 'stakeholders', 'subject', 'boundary'],
  });

  console.log(
    '[agents] registered (all sliced): track_commitment, prepare_meeting, sync_draft, caring, daily_digest, doc_comment, recap_action_items'
  );
}
