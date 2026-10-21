import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerScheduledWorkerStatus} from './scheduled-status.mjs';
test('scheduled status remains source-scoped and is revoked with its service',()=>{
 let service;const p={agentId:'main',accountId:'a',chatId:'g',sessionKey:'s',senderId:'u'};
 let status='running';registerScheduledWorkerStatus({registerService:s=>service=s},()=>({status:(id,scope)=>{assert.equal(id,'job');assert.equal(scope,'s');return {status,provenance:p};}}));
 const bridge=globalThis[Symbol.for('ada.scheduled-requests.v1')];service.start();
 assert.equal(bridge.jobsActive(['job'],p),true);status='awaiting_user';assert.equal(bridge.jobsActive(['job'],p),true);status='completed';assert.equal(bridge.jobsActive(['job'],p),false);
 assert.throws(()=>bridge.jobsActive(['job'],{...p,senderId:'other'}),/mismatch/);service.stop();assert.equal(bridge.jobsActive,undefined);
});
