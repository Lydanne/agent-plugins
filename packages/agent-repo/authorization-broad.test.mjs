import test from 'node:test';
import assert from 'node:assert/strict';
import {broadExecutorResources,broadExecutorOperation} from './authorization-broad.mjs';
import {evaluatePermissions,permissionActions} from './authorization-policy.mjs';
test('broad executors require every privilege and cannot be allowed by a read-only grant',()=>{
 const resource=broadExecutorResources('ada').find(r=>r.definition.toolName==='exec');
 assert.equal(resource.defaultAuthorization,'explicit-only');
 const operation=broadExecutorOperation({toolName:'exec'});assert.equal(operation.requirements.length,9);
 const input={agentId:'ada',subject:{agentId:'ada',id:'person',verified:true},groups:['administrator'],requirements:operation.requirements.map(r=>({resource,action:r.action})),rules:[{id:'r',groupId:'administrator',effect:'allow',selector:{resourceIds:[resource.id]},actions:['execute','read']}]};
 assert.equal(evaluatePermissions(input).allowed,false);input.rules[0].actions=[...permissionActions];assert.equal(evaluatePermissions(input).allowed,true);
});
