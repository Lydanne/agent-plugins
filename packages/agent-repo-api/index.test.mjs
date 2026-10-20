import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerAgentRepoService,getAgentRepoService,trustedAgentId} from './index.mjs';
const service=agentId=>({apiVersion:1,agentId,root:'/fixture/'+agentId,listProjects:async()=>({projects:[]}),inspectProject:async()=>({}),prepareExecutionScope:async()=>({})});
test('Agent API ownership and lifecycle are isolated and old releases cannot remove replacements',()=>{
 const a=service('a'),b=service('b'),owner={};
 const stopA=registerAgentRepoService(a,{owner}),stopB=registerAgentRepoService(b,{owner:{}});
 try{
  assert.equal(getAgentRepoService({agentId:'a',sessionKey:'agent:a:chat'}),a);
  assert.equal(getAgentRepoService({agentId:'b'}),b);
  assert.throws(()=>getAgentRepoService({agentId:'a',sessionKey:'agent:b:chat'}),{code:'AGENT_CONTEXT_MISMATCH'});
  assert.throws(()=>registerAgentRepoService(service('a'),{owner:{}}),{code:'AGENT_REPO_DUPLICATE'});
  const replacement=service('a'),stopReplacement=registerAgentRepoService(replacement,{owner});
  stopA();assert.equal(getAgentRepoService({agentId:'a'}),replacement);
  stopReplacement();assert.equal(getAgentRepoService({agentId:'a'},{required:false}),undefined);
  assert.throws(()=>getAgentRepoService({agentId:'a'}),{code:'AGENT_REPO_UNAVAILABLE'});
 }finally{stopA();stopB();}
});
test('invalid or unsupported API does not publish a provider',()=>{
 assert.throws(()=>registerAgentRepoService({...service('bad'),apiVersion:2},{owner:{}}),{code:'API_VERSION_UNSUPPORTED'});
 for(const context of [{},{agentId:'../a'},{agentId:'a',sessionKey:'untrusted'}])assert.throws(()=>trustedAgentId(context));
 assert.equal(getAgentRepoService({agentId:'late'},{required:false}),undefined);
 const stop=registerAgentRepoService(service('late'),{owner:{}});
 assert.equal(getAgentRepoService({agentId:'late'}).apiVersion,1);stop();
});
