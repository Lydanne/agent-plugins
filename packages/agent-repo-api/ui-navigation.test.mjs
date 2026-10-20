import {test} from 'node:test';
import assert from 'node:assert/strict';
import {currentUiTarget,projectInspectionTarget,registerWorkerNavigation,subscribeWorkerNavigation,canOpenWorkerProject,openWorkerProject} from './ui-navigation.mjs';
test('cross-plugin navigation preserves validated Agent/session/project and survives provider replacement',()=>{
 const target={agentId:'main',sessionKey:'agent:main:test',projectId:'a'},opened=[];let changes=0;
 const unsubscribe=subscribeWorkerNavigation(()=>changes++),stopOld=registerWorkerNavigation(()=>assert.fail('old provider')),stop=registerWorkerNavigation(value=>opened.push(value));stopOld();assert.equal(canOpenWorkerProject(),true);
 openWorkerProject({...target,cwd:'/not-allowed'});assert.deepEqual(opened,[target]);
 assert.throws(()=>openWorkerProject({...target,sessionKey:'agent:other:test'}));assert.throws(()=>openWorkerProject({...target,projectId:'../other'}));
 stop();assert.equal(canOpenWorkerProject(),false);assert.throws(()=>openWorkerProject(target),/尚未加载/);assert.equal(changes,3);unsubscribe();
 const host={agents:{selectedId:'other',defaultId:'main'},connection:{assistantAgentId:'main'},sessions:{selectedKey:'agent:main:test'}};
 assert.deepEqual(currentUiTarget({host,props:{}}),{agentId:'other',sessionKey:undefined});assert.deepEqual(currentUiTarget({host,props:target}),{agentId:'main',sessionKey:'agent:main:test'});
});

test('catalog request routing stays separate from the actual selected Worker conversation',()=>{
 const host={agents:{selectedId:'other'},connection:{},sessions:{selectedKey:'agent:main:test'}};
 const context={host,props:{}};
 assert.deepEqual(projectInspectionTarget(context),{agentId:'other',sessionKey:'agent:other:agent-repo-catalog'});
 assert.equal(currentUiTarget(context).sessionKey,undefined);
 host.sessions.selectedKey='agent:other:real';assert.equal(projectInspectionTarget(context).sessionKey,'agent:other:real');
 host.agents.selectedId='../bad';assert.deepEqual(projectInspectionTarget(context),{agentId:undefined,sessionKey:undefined});
});

test('task navigation validates Agent ownership and strips unrelated fields',async()=>{
 const {openWorkerTask}=await import('./ui-navigation.mjs'),opened=[],stop=registerWorkerNavigation(value=>opened.push(value));
 try{const task={agentId:'main',sessionKey:'agent:main:original',topic:'topic',jobId:'11111111-1111-4111-8111-111111111111'};openWorkerTask({...task,cwd:'/not-allowed'});assert.deepEqual(opened,[task]);assert.throws(()=>openWorkerTask({...task,agentId:'other'}));assert.throws(()=>openWorkerTask({...task,jobId:'../wrong'}));}finally{stop();}
});
