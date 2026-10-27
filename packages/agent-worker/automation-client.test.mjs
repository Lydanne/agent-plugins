import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAutomationClient} from './automation-client.mjs';
test('client uses assigned stable session key; polling never dispatches work',async()=>{
 const calls=[];let reads=0;const client=createAutomationClient(async(method,p)=>{calls.push({method,p});if(method.endsWith('submit'))return {taskId:'t',phase:'waiting_session',sessionKey:'agent:a:automation:t'};if(method==='sessions.create')return {};return {taskId:'t',state:++reads===2?'completed':'running'};});
 await client.submit({agentId:'a'});assert.deepEqual(calls[1],{method:'sessions.create',p:{key:'agent:a:automation:t',agentId:'a'}});
 assert.equal((await client.wait('t',{delay:async()=>{}})).state,'completed');assert.equal(calls.filter(c=>c.method.endsWith('submit')).length,1);
 await assert.rejects(()=>client.wait('t',{timeoutMs:0}),e=>e.code==='AUTOMATION_WAIT_TIMEOUT'&&e.taskId==='t');assert.equal(calls.filter(c=>c.method.endsWith('cancel')).length,0);
});
test('lost session creation response retains accepted task identifier',async()=>{const c=createAutomationClient(async method=>{if(method.endsWith('submit'))return {taskId:'t',phase:'waiting_session',sessionKey:'s'};throw Error('network');});await assert.rejects(()=>c.submit({agentId:'a'}),e=>e.taskId==='t'&&e.task.taskId==='t');});
