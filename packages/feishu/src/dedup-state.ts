import { createLocalReplayGuard } from './local-replay-guard.js';
// The standalone plugin owns its dedupe database; host trust-restricted stores are not used.
export const feishuDedupeState = {
  guard:createLocalReplayGuard(),
  reset(){this.guard.clearMemory();this.guard=createLocalReplayGuard();},
};
