import {permissionActions} from './authorization-policy.mjs';

// The external Worker harness has host authority, not an object-scoped sandbox.
// Starting, resuming or steering it therefore requires explicit broad authority.
const workerActions = Object.freeze({
  queues: ['read'], projects: ['read'], list: ['read'], status: ['read'], wait: ['read'],
  tag: ['update'], cancel: ['update'], await_user: ['update', 'transfer'],
  run: permissionActions, reply: permissionActions, steer: permissionActions,
});
const broadActions = new Set(['run', 'reply', 'steer']);
const resourceId = action => 'tool://agent-worker/agent_worker/' + action;

export function workerAuthorizationResources(agentId) {
  return [{id:'delivery://agent-worker/result',agentId,provider:'agent-worker',kind:'delivery',name:'Worker result delivery',actions:['transfer'],status:'active',verification:'verified',enforcement:'enforced',labels:['worker','delivery'],behavior:{access:'write',externalEffect:'present',sensitivity:'sensitive',atomicity:'unknown',recovery:'irreversible',idempotency:'unknown'},definition:{adapter:'agent-worker-delivery-v1'}},...Object.entries(workerActions).map(([action, actions]) => {
    const broad = broadActions.has(action), readOnly = actions.length === 1 && actions[0] === 'read';
    return {
      id: resourceId(action), agentId, provider: 'agent-worker', kind: broad ? 'executor' : 'tool',
      name: 'agent_worker ' + action, actions: [...new Set(['discover', 'execute', ...actions])],
      status: 'active', verification: 'verified', enforcement: 'enforced',
      ...(broad ? {defaultAuthorization: 'explicit-only'} : {}),
      labels: broad ? ['worker', 'broad-execution'] : ['worker'],
      behavior: {access: readOnly ? 'read' : 'mixed', atomicity: readOnly ? 'not-applicable' : 'unknown',
        recovery: readOnly ? 'not-applicable' : 'unknown', idempotency: 'unknown',
        externalEffect: readOnly ? 'none' : 'present', sensitivity: 'sensitive'},
      definition: {adapter: 'agent-worker-v1', toolName: 'agent_worker', action,
        ...(broad ? {requiresAllActions: true, confinement: 'none-added'} : {})},
    };
  })];
}

export function workerAuthorizationOperation(event) {
  if(event.toolName==='agent_worker_result_delivery')return {requirements:[{resourceId:'delivery://agent-worker/result',action:'transfer'}]};
  if (event.toolName !== 'agent_worker' || !Object.hasOwn(workerActions, event.params?.action)) return undefined;
  const action = event.params.action;
  return {requirements: [...new Set(['execute', ...workerActions[action]])].map(permission => ({resourceId: resourceId(action), action: permission}))};
}
