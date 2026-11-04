import test from 'node:test';
import assert from 'node:assert/strict';
import {workerAuthorizationOperation,workerAuthorizationResources} from './authorization-worker.mjs';
import {permissionActions,evaluatePermissions} from './authorization-policy.mjs';
import {workerToolActions} from '../agent-worker/cli-capabilities.mjs';
import {resolveBuiltinAuthorization} from './authorization-builtins.mjs';

test('Worker catalog covers every current action and unknown actions fail closed',()=>{
 const resources=workerAuthorizationResources('ada');
 assert.deepEqual(resources.map(r=>r.definition.action).sort(),[...workerToolActions].sort());
 for(const resource of resources)assert.ok(resolveBuiltinAuthorization({toolName:'agent_worker',params:{action:resource.definition.action}}));
 for(const action of ['unknown','__proto__',undefined])assert.equal(workerAuthorizationOperation({toolName:'agent_worker',params:{action}}),undefined);
});
test('starting, resuming and steering external execution requires explicit broad authority',()=>{
 for(const action of ['run','reply','steer']){
  const resource=workerAuthorizationResources('ada').find(r=>r.definition.action===action);
  assert.equal(resource.defaultAuthorization,'explicit-only');assert.equal(resource.definition.confinement,'none-added');
  const operation=workerAuthorizationOperation({toolName:'agent_worker',params:{action}});
  assert.deepEqual(operation.requirements.map(r=>r.action).sort(),[...permissionActions].sort());
  const rule={id:'delegate',groupId:'internal',effect:'allow',selector:{resourceIds:[resource.id]},actions:['execute','delegate']};
  const request={agentId:'ada',subject:{id:'person',agentId:'ada',verified:true},groups:['internal'],requirements:operation.requirements.map(r=>({resource,action:r.action})),rules:[rule]};
  assert.equal(evaluatePermissions(request).allowed,false);
  rule.actions=[...permissionActions];assert.equal(evaluatePermissions(request).allowed,true);
 }
});
test('task observation and mutation have distinct permission requirements',()=>{
 const required=action=>workerAuthorizationOperation({toolName:'agent_worker',params:{action}}).requirements.map(r=>r.action);
 assert.deepEqual(required('status'),['execute','read']);
 assert.deepEqual(required('cancel'),['execute','update']);
 assert.deepEqual(required('await_user'),['execute','update','transfer']);
});
