// Task admission is delegation, not a grant of every business operation.
// Registered operations are authorized separately; native paths are not a sandbox.
const workerActions = Object.freeze({
  queues: ['read'], projects: ['read'], list: ['read'], status: ['read'], wait: ['read'],
  tag: ['update'], cancel: ['update'], await_user: ['update', 'transfer'],
  run: ['delegate'], reply: ['delegate'], steer: ['delegate'],
});
const taskControlActions = new Set(['run', 'reply', 'steer']);
const resourceId = action => 'tool://agent-worker/agent_worker/' + action;

export function workerAuthorizationResources(agentId) {
  return [{id:'delivery://agent-worker/result',agentId,provider:'agent-worker',kind:'delivery',name:'Worker result delivery',actions:['transfer'],status:'active',verification:'verified',enforcement:'enforced',labels:['worker','delivery'],behavior:{access:'write',externalEffect:'present',sensitivity:'sensitive',atomicity:'unknown',recovery:'irreversible',idempotency:'unknown'},definition:{adapter:'agent-worker-delivery-v1'}},...Object.entries(workerActions).map(([action, actions]) => {
    const taskControl = taskControlActions.has(action), readOnly = actions.length === 1 && actions[0] === 'read';
    return {
      id: resourceId(action), agentId, provider: 'agent-worker', kind: 'tool',
      name: 'agent_worker ' + action, actions: [...new Set(['discover', 'execute', ...actions])],
      status: 'active', verification: 'verified', enforcement: 'enforced',
      labels: taskControl ? ['worker', 'task-control'] : ['worker'],
      behavior: {access: readOnly ? 'read' : 'mixed', atomicity: readOnly ? 'not-applicable' : 'unknown',
        recovery: readOnly ? 'not-applicable' : 'unknown', idempotency: 'unknown',
        externalEffect: readOnly ? 'none' : 'present', sensitivity: 'sensitive'},
      definition: {adapter: taskControl ? 'agent-worker-task-control-v2' : 'agent-worker-v1', toolName: 'agent_worker', action,
        ...(taskControl ? {authorizationScope:'task-admission',confinement:'none-added'} : {})},
    };
  })];
}

export function workerAuthorizationOperation(event) {
  if(event.toolName==='agent_worker_result_delivery')return {requirements:[{resourceId:'delivery://agent-worker/result',action:'transfer'}]};
  if (event.toolName !== 'agent_worker' || !Object.hasOwn(workerActions, event.params?.action)) return undefined;
  const action = event.params.action;
  return {requirements: [...new Set(['execute', ...workerActions[action]])].map(permission => ({resourceId: resourceId(action), action: permission}))};
}
