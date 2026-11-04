import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleResources,scheduleOperation} from './authorization-schedules.mjs';
import {scheduledRequestToolParameters} from './scheduled-requests.mjs';
test('all schedule tool actions have distinct enforced resources and execution requirements',()=>{
 const resources=scheduleResources('ada');
 for(const action of scheduledRequestToolParameters.properties.action.enum){
  const operation=scheduleOperation({toolName:'agent_schedule',params:{action}});assert.ok(operation);
  assert.equal(operation.requirements[0].action,'execute');
  for(const requirement of operation.requirements){const resource=resources.find(r=>r.id===requirement.resourceId);assert.ok(resource.actions.includes(requirement.action));assert.equal(resource.enforcement,'enforced');}
 }
 assert.deepEqual(scheduleOperation({toolName:'agent_schedule',params:{action:'run'}}).requirements.map(r=>r.action),['execute','delegate']);
 assert.deepEqual(scheduleOperation({toolName:'agent_schedule_dispatch'}).requirements.map(r=>r.action),['execute','delegate','transfer']);
 assert.equal(scheduleOperation({toolName:'agent_schedule',params:{action:'restore'}}),undefined);
});
