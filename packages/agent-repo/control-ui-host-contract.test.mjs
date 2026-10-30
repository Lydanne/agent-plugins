import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAgentSessionKey} from 'openclaw/plugin-sdk/routing';
import {registerProjectInspector} from './project-inspector.mjs';
import {readInspectionResponse} from './dist/inspection-transport.mjs';
import {trustedAgentId} from './dist/agent-repo-api.mjs';
test('public SDK qualified routing binds catalog handlers and rejects standalone or mismatched identity',async()=>{
 const actions=[];registerProjectInspector({registerSessionAction:a=>actions.push(a)},{list:async ctx=>({agentId:trustedAgentId(ctx),projects:[]})});
 const request=async params=>{
  const parsed=params.sessionKey?parseAgentSessionKey(params.sessionKey):null;
  if(parsed&&(!['main','other'].includes(parsed.agentId)||parsed.agentId!==params.agentId))throw Error('Unknown or mismatched Agent');
  return actions.find(a=>a.id==='projects-list').handler({payload:{},client:{scopes:['operator.read']},...(parsed?{agentId:parsed.agentId,sessionKey:params.sessionKey}:{})});
 };
 assert.equal((await request({agentId:'other'})).ok,false);
 await assert.rejects(request({agentId:'other',sessionKey:'agent:main:test'}));
 for(const key of ['agent:other:agent-repo-catalog','agent:other:agent-repo-management','agent:other:real']){
  const result=await readInspectionResponse((action,payload)=>actions.find(a=>a.id==='projects-'+action).handler({payload,client:{scopes:['operator.read']},agentId:'other',sessionKey:key}),'list',{});assert.equal(result.agentId,'other');
 }
});
