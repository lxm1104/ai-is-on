/**
 * MVP3 agent bootstrap. Called once on server startup to register handlers.
 */
import { registerAgent } from './agentRegistry.js';
import { trackCommitmentHandler } from './commitmentAgent.js';
import { prepareMeetingHandler } from './prepareMeetingAgent.js';

let bootstrapped = false;

export function bootstrapAgents() {
  if (bootstrapped) return;
  bootstrapped = true;
  registerAgent('track_commitment', trackCommitmentHandler);
  registerAgent('prepare_meeting', prepareMeetingHandler);
  console.log('[agents] registered: track_commitment, prepare_meeting');
}
