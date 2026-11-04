import test from 'node:test';
import assert from 'node:assert/strict';
import {workerAuthorizationOperation,workerAuthorizationResources} from './authorization-worker.mjs';
import {evaluatePermissions} from './authorization-policy.mjs';
import {workerToolActions} from '../agent-worker/cli-capabilities.mjs';
import {resolveBuiltinAuthorization} from './authorization-builtins.mjs';

test('Worker catalog covers every current action and unknown actions fail closed',()=>{
 const resources=workerAuthorizationResources('ada').filter(r=>r.definition.toolName==='agent_worker');
 assert.deepEqual(resources.map(r=>r.definition.action).sort(),[...workerToolActions].sort());
 for(const resource of resources)assert.ok(resolveBuiltinAuthorization({toolName:'agent_worker',params:{action:resource.definition.action}}));
 for(const action of ['unknown','__proto__',undefined])assert.equal(workerAuthorizationOperation({toolName:'agent_worker',params:{action}}),undefined);
});
test('starting, resuming and steering require delegation without granting business writes',()=>{
 for(const action of ['run','reply','steer']){
  const resource=workerAuthorizationResources('ada').find(r=>r.definition.action===action);
  assert.equal(resource.definition.authorizationScope,'task-admission');assert.equal(resource.definition.confinement,'none-added');
  const operation=workerAuthorizationOperation({toolName:'agent_worker',params:{action}});
  assert.deepEqual(operation.requirements.map(r=>r.action),['execute','delegate']);
  const rule={id:'delegate',groupId:'internal',effect:'allow',selector:{resourceIds:[resource.id]},actions:['execute']};
  const request={agentId:'ada',subject:{id:'person',agentId:'ada',verified:true},groups:['internal'],requirements:operation.requirements.map(r=>({resource,action:r.action})),rules:[rule]};
  assert.equal(evaluatePermissions(request).allowed,false);
  rule.actions.push('delegate');assert.equal(evaluatePermissions(request).allowed,true);
  assert.equal(resource.actions.some(action=>['create','update','delete','grant'].includes(action)),false);
 }
});
test('task observation and mutation have distinct permission requirements',()=>{
 const required=action=>workerAuthorizationOperation({toolName:'agent_worker',params:{action}}).requirements.map(r=>r.action);
 assert.deepEqual(required('status'),['execute','read']);
 assert.deepEqual(required('cancel'),['execute','update']);
 assert.deepEqual(required('await_user'),['execute','update','transfer']);
});
