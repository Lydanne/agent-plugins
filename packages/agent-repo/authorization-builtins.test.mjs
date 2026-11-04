import test from 'node:test';
import assert from 'node:assert/strict';
import {builtinAuthorizationResources,resolveBuiltinAuthorization} from './authorization-builtins.mjs';
import {evaluatePermissions} from './authorization-policy.mjs';

test('project and knowledge reads require both entry and independent data grants',()=>{
 const resources=builtinAuthorizationResources('ada');
 for(const [action,domain] of [['list','projects'],['inspect','projects'],['knowledge_list','knowledge'],['knowledge_search','knowledge'],['knowledge_read','knowledge'],['knowledge_validate','knowledge'],['knowledge_graph','knowledge'],['entity','entities']]){
  const operation=resolveBuiltinAuthorization({toolName:'agent_repo',params:{action,projectId:'xgj'}});
  assert.deepEqual(operation.requirements,[{resourceId:`tool://agent-repo/agent_repo/${action}`,action:'execute'},{resourceId:`data://agent-repo/${domain}`,action:'read'}]);
  const requirements=operation.requirements.map(({resourceId,action})=>({resource:resources.find(r=>r.id===resourceId),action}));
  const entry={id:'entry',groupId:'internal',effect:'allow',actions:['execute'],selector:{resourceIds:[requirements[0].resource.id]}};
  const data={id:'data',groupId:'internal',effect:'allow',actions:['read'],selector:{resourceIds:[requirements[1].resource.id]},parameters:[{path:'projectId',op:'equals',value:'xgj'}]};
  const input={agentId:'ada',subject:{id:'person',agentId:'ada',verified:true},groups:['internal'],requirements,parameters:{projectId:'xgj'}};
  assert.equal(evaluatePermissions({...input,rules:[entry]}).allowed,false);
  assert.equal(evaluatePermissions({...input,rules:[data]}).allowed,false);
  assert.equal(evaluatePermissions({...input,rules:[entry,data]}).allowed,true);
  assert.equal(evaluatePermissions({...input,rules:[entry,data],parameters:{projectId:'other'}}).allowed,false);
 }
});
test('side-effecting and unknown AgentRepo actions cannot borrow read adapters',()=>{
 for(const action of ['skills','sync','worker_skill','people','person','unknown'])assert.equal(resolveBuiltinAuthorization({toolName:'agent_repo',params:{action}}),undefined);
 assert.equal(resolveBuiltinAuthorization({toolName:'other',params:{action:'knowledge_read'}}),undefined);
});
