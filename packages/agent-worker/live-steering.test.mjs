import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {grantLiveSteering,deliverLiveSteering} from './live-steering.mjs';
import {readJson,writeJson} from './jobs.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'worker-live-delivery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'supplements'));
 const id=randomUUID(),sid=randomUUID(),turn={threadId:'thread',turnId:'turn',workerId:'worker'};
 const job={jobId:id,status:'running',workerId:'worker',liveTurn:turn,provenance:{senderId:'alice'}};
 const record={supplementId:sid,jobId:id,kind:'steering',status:'accepted',answer:'extra evidence',admissionSequence:1,attachmentSource:{senderId:'alice',taskId:'new-source'}};
 const file=join(root,'supplements',sid+'.json');writeJson(join(root,id+'.json'),job);writeJson(file,record);
 return {root,id,turn,job,record,file,options:{root,id,workerId:'worker',turn,signal:new AbortController().signal}};
}
test('authorized live delivery is persisted once and adds revocable source to original job',async t=>{
 const f=fixture(t);grantLiveSteering(f.root,f.job,f.record);let calls=0;
 const send=async()=>{calls++;assert.equal(readJson(f.file).liveDelivery.state,'sending');return {turnId:'turn'};};
 await deliverLiveSteering({...f.options,send});await deliverLiveSteering({...f.options,send});
 assert.equal(calls,1);const record=readJson(f.file);assert.equal(record.status,'dispatched');assert.equal(record.childJobId,f.id);assert.equal(record.liveDelivery.state,'delivered');assert.equal(readJson(join(f.root,f.id+'.json')).provenance.attachmentSources[0].taskId,'new-source');
 assert.equal(existsSync(join(f.root,f.record.supplementId+'.json')),false);
});
for(const reason of ['no-grant','stale-worker','cancelled'])test('live delivery refuses '+reason,async t=>{
 const f=fixture(t);if(reason!=='no-grant')grantLiveSteering(f.root,f.job,f.record);
 if(reason==='stale-worker')f.options.workerId='other';if(reason==='cancelled')writeJson(join(f.root,f.id+'.cancel'),{});
 await deliverLiveSteering({...f.options,send:()=>assert.fail('must not send')});
});
for(const definite of [true,false])test('delivery failure preserves '+(definite?'explicit rejection for boundary fallback':'uncertainty without replay'),async t=>{
 const f=fixture(t);grantLiveSteering(f.root,f.job,f.record);let calls=0;
 await deliverLiveSteering({...f.options,send:async()=>{calls++;throw Object.assign(Error('fixture'),{definitelyRejected:definite});}});
 await deliverLiveSteering({...f.options,send:()=>assert.fail('must not retry')});
 const record=readJson(f.file);assert.equal(record.status,definite?'accepted':'blocked');assert.equal(record.liveDelivery.state,definite?'rejected':'unknown');assert.equal(calls,1);
});
test('a recall or cancellation during RPC cannot be overwritten by a late success',async t=>{
 const f=fixture(t);grantLiveSteering(f.root,f.job,f.record);
 await deliverLiveSteering({...f.options,send:async()=>{writeJson(f.file,{...readJson(f.file),status:'suppressed',reason:'source_invalid'});return {turnId:'turn'};}});
 assert.equal(readJson(f.file).status,'suppressed');assert.equal(readJson(f.file).reason,'source_invalid');
});
