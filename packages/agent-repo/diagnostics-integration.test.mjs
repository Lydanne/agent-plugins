import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticHub,registerDiagnosticSource} from './dist/diagnostics-api.mjs';
import {registerProjectInspector} from './project-inspector.mjs';
import {inspectionChunkSize} from './dist/inspection-transport.mjs';
const ctx=(payload={},connId='page-one')=>({agentId:'main',sessionKey:'agent:main:agent-repo-management',client:{connId,scopes:['operator.read','operator.write']},payload});
test('public session actions enforce live permissions and bind large diagnostic transfers to the same connection',async t=>{
 const hub=createDiagnosticHub(),source=registerDiagnosticSource({apiVersion:1,id:'integration.events',pluginId:'integration',label:'Integration'},Symbol());t.after(()=>{hub.dispose();source.dispose();});const actions=new Map();registerProjectInspector({registerSessionAction:action=>actions.set(action.id,action)},hub.actions,{isDiagnosticTransferActive:hub.canReadTransfer});
 assert.deepEqual(actions.get('projects-diagnosticStart').requiredScopes,['operator.write']);assert.deepEqual(actions.get('projects-diagnosticRead').requiredScopes,['operator.read']);
 const start=await actions.get('projects-diagnosticStart').handler(ctx({sourceIds:['integration.events']}));assert.equal(start.ok,true);const lease=JSON.parse(start.result.chunk);for(let i=0;i<20;i++)source.log(ctx(),{message:'row '+i,data:{payload:'x'.repeat(4000)}});
 const read=await actions.get('projects-diagnosticRead').handler(ctx({leaseId:lease.leaseId}));assert.equal(read.ok,true);assert.ok(read.result.totalChunks>1);assert.equal(read.result.chunk.length,inspectionChunkSize);
 const transfer={transferId:read.result.transferId,index:1};assert.equal((await actions.get('projects-chunk').handler(ctx(transfer,'other-page'))).ok,false);assert.equal((await actions.get('projects-chunk').handler(ctx(transfer))).ok,true);
 await actions.get('projects-diagnosticStop').handler(ctx({leaseId:lease.leaseId}));assert.equal((await actions.get('projects-chunk').handler(ctx(transfer))).ok,false);
 const denied=await actions.get('projects-diagnosticStart').handler({...ctx(),client:{connId:'readonly',scopes:['operator.read']}});assert.equal(denied.ok,false);assert.equal(denied.code,'DIAGNOSTICS_UNAVAILABLE');
});
