import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {registerWorkerSourceControl} from '../../agent-repo-api/worker-source.mjs';
const state=vi.hoisted(()=>({dir:''}));
vi.mock('./runtime.js',()=>({getFeishuRuntime:()=>({state:{resolveStateDir:()=>state.dir}})}));
import {recallTaskSource,flushWorkerSourceRecalls,registerSourceRecallDelivery} from './source-task.js';
let dispose:(()=>void)|undefined;
beforeEach(()=>{state.dir=mkdtempSync(join(tmpdir(),'recall-outbox-'));});
afterEach(()=>{dispose?.();dispose=undefined;rmSync(state.dir,{recursive:true,force:true});vi.useRealTimers();});
const event={accountId:'a',chatId:'chat',messageId:'message'};
const pending=()=>{const db=new DatabaseSync(join(state.dir,'feishu-source-tasks','tasks.sqlite'));try{return db.prepare('SELECT count(*) AS n FROM worker_recall_outbox WHERE delivered=0').get()!.n;}finally{db.close();}};
it('retains unavailable and failed delivery, retries after restart, and requires durable acceptance',()=>{
 recallTaskSource(event);expect(pending()).toBe(1);
 let fail=true;const received:unknown[]=[];
 dispose=registerWorkerSourceControl({apiVersion:1,invalidate:e=>{if(fail)throw Error('storage unavailable');received.push(e);return {accepted:true,eventId:e.eventId,jobIds:[]};}},{owner:Symbol()});
 expect(()=>flushWorkerSourceRecalls(state.dir)).toThrow();expect(pending()).toBe(1);
 fail=false;flushWorkerSourceRecalls(state.dir);expect(pending()).toBe(0);expect(received).toHaveLength(1);
 flushWorkerSourceRecalls(state.dir);expect(received).toHaveLength(1);
 recallTaskSource(event);expect(received).toHaveLength(2);expect(received[0]).toEqual(received[1]);
});
it('replays undelivered events on service start and stops its retry timer cleanly',()=>{
 vi.useFakeTimers();recallTaskSource(event);const received:string[]=[];
 dispose=registerWorkerSourceControl({apiVersion:1,invalidate:e=>{received.push(e.eventId);return {accepted:true,eventId:e.eventId,jobIds:[]};}},{owner:Symbol()});
 let service:any;
 registerSourceRecallDelivery({runtime:{state:{resolveStateDir:()=>state.dir}},logger:{warn:vi.fn()},registerService:s=>{service=s;}} as any);
 service.start();expect(received).toHaveLength(1);expect(vi.getTimerCount()).toBe(1);service.start();expect(vi.getTimerCount()).toBe(1);service.stop();expect(vi.getTimerCount()).toBe(0);
});
it('delivers into the real Worker store and protects tasks admitted after acknowledgement',async()=>{
 const {createJobs,writeJson}=await import('../../agent-worker/jobs.mjs');
 const {randomUUID}=await import('node:crypto');
 const {existsSync}=await import('node:fs');
 const root=join(state.dir,'worker-jobs'),jobs=createJobs({root,node:process.execPath,worker:'/unused'});
 dispose=registerWorkerSourceControl({apiVersion:1,invalidate:e=>jobs.invalidateSources(e)},{owner:Symbol()});
 recallTaskSource(event);expect(pending()).toBe(0);
 const id=randomUUID();writeJson(join(root,id+'.json'),{jobId:id,status:'running',provenance:{accountId:'a',chatId:'chat',sourceMessageIds:['message']}});
 jobs.tick();expect(existsSync(join(root,id+'.cancel'))).toBe(true);
});
it('migrates historical recalls into the delivery outbox once',()=>{
 recallTaskSource(event);const path=join(state.dir,'feishu-source-tasks','tasks.sqlite');
 const db=new DatabaseSync(path);db.exec('DROP TABLE worker_recall_outbox; PRAGMA user_version=0');db.close();
 const received:string[]=[];
 dispose=registerWorkerSourceControl({apiVersion:1,invalidate:e=>{received.push(e.eventId);return {accepted:true,eventId:e.eventId,jobIds:[]};}},{owner:Symbol()});
 flushWorkerSourceRecalls(state.dir);expect(received).toHaveLength(1);flushWorkerSourceRecalls(state.dir);expect(received).toHaveLength(1);
});
it('delivers a bounded batch and retries the same payload if its acknowledgement is lost',()=>{
 recallTaskSource(event);recallTaskSource({...event,messageId:'second'});
 const received:unknown[]=[];
 dispose=registerWorkerSourceControl({apiVersion:1,invalidate:e=>{received.push(e);return {accepted:true,eventId:e.eventId,jobIds:[]};}},{owner:Symbol()});
 flushWorkerSourceRecalls(state.dir);expect(received).toHaveLength(1);expect((received[0] as any).sources).toHaveLength(2);
 const db=new DatabaseSync(join(state.dir,'feishu-source-tasks','tasks.sqlite'));db.exec('UPDATE worker_recall_outbox SET delivered=0');db.close();
 flushWorkerSourceRecalls(state.dir);expect(received).toHaveLength(2);expect(received[0]).toEqual(received[1]);
});
it('attempts independent Worker cancellation even when channel persistence fails, while keeping ingress retryable',async()=>{
 const {writeFileSync}=await import('node:fs');
 const received:string[]=[];
 dispose=registerWorkerSourceControl({apiVersion:1,invalidate:e=>{received.push(e.eventId);return {accepted:true,eventId:e.eventId,jobIds:[]};}},{owner:Symbol()});
 const original=state.dir,blocked=join(original,'blocked');writeFileSync(blocked,'not a directory');state.dir=blocked;
 try{expect(()=>recallTaskSource(event)).toThrow('Background recall cancellation failed');expect(received).toHaveLength(1);}
 finally{state.dir=original;}
});
it('does not delay a current revocation behind a historical replay backlog',()=>{
 for(let n=0;n<101;n++)recallTaskSource({...event,messageId:'historical-'+n});
 const received:any[]=[];
 dispose=registerWorkerSourceControl({apiVersion:1,invalidate:e=>{received.push(e);return {accepted:true,eventId:e.eventId,jobIds:[]};}},{owner:Symbol()});
 recallTaskSource({...event,messageId:'current'});
 expect(received).toHaveLength(1);expect(received[0].sources.map((source:any)=>source.id)).toEqual(['current']);expect(pending()).toBe(101);
 flushWorkerSourceRecalls(state.dir);expect(received[1].sources).toHaveLength(100);expect(pending()).toBe(1);
 flushWorkerSourceRecalls(state.dir);expect(pending()).toBe(0);
});
