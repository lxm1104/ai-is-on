/**
 * MVP3 agent bootstrap. Called once on server startup to register handlers.
 */
import { registerAgent } from './agentRegistry.js';
import { trackCommitmentHandler } from './commitmentAgent.js';
import { prepareMeetingHandler } from './prepareMeetingAgent.js';
import { caringHandler } from './caringAgent.js';

let bootstrapped = false;

export function bootstrapAgents() {
  if (bootstrapped) return;
  bootstrapped = true;
  registerAgent('track_commitment', trackCommitmentHandler);
  registerAgent('prepare_meeting', prepareMeetingHandler);
  registerAgent('caring', caringHandler);
  console.log('[agents] registered: track_commitment, prepare_meeting, caring');
}
