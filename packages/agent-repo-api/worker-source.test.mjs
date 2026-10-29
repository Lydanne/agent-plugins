import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerWorkerSourceControl,revokeWorkerSources} from './worker-source.mjs';
const event={apiVersion:1,eventId:'e',reason:'recalled',sources:[{namespace:'example',scope:'account/chat',id:'message'}]};
test('Worker source endpoint is versioned, host-owned, disposable and protected from stale cleanup',()=>{
 assert.equal(revokeWorkerSources(event).accepted,false);
 const owner=Symbol(),service={apiVersion:1,invalidate:e=>({accepted:true,eventId:e.eventId,jobIds:['job']})};
 const old=registerWorkerSourceControl(service,{owner});
 assert.deepEqual(revokeWorkerSources(event).jobIds,['job']);
 assert.throws(()=>registerWorkerSourceControl(service,{owner:Symbol()}),/already registered/);
 const current=registerWorkerSourceControl(service,{owner});old();assert.equal(revokeWorkerSources(event).accepted,true);current();assert.equal(revokeWorkerSources(event).accepted,false);
 for(const patch of [{apiVersion:2},{sources:[]},{sources:[{namespace:'x',scope:'',id:'m'}]}])assert.throws(()=>revokeWorkerSources({...event,...patch}));
});
