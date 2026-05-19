/**
 * MVP3 agent bootstrap. Called once on server startup to register handlers.
 */
import { registerAgent } from './agentRegistry.js';
import { trackCommitmentHandler } from './commitmentAgent.js';

let bootstrapped = false;

export function bootstrapAgents() {
  if (bootstrapped) return;
  bootstrapped = true;
  registerAgent('track_commitment', trackCommitmentHandler);
  // 'prepare_meeting' lands in MVP3.E
  console.log('[agents] registered: track_commitment');
}
