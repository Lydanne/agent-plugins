import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalIngressQueue } from './local-ingress-queue.js';
import { createLocalReplayGuard } from './local-replay-guard.js';
import { localStore } from './local-state.js';
const dirs:string[]=[];
function setup(){const dir=mkdtempSync(join(tmpdir(),'feishu-queue-'));dirs.push(dir);let time=1000;const path=join(dir,'state.sqlite');return {path,clock:()=>time,setTime:(v:number)=>{time=v;},queue:openLocalIngressQueue<string>('account',path,()=>time)};}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('persists accepted events, claim fencing and terminal dedupe across reopen',async()=>{
 const {queue,path}=setup();expect((await queue.enqueue('one','hello')).kind).toBe('accepted');
 const reopened=openLocalIngressQueue<string>('account',path);expect((await reopened.enqueue('one','changed')).kind).toBe('pending');
 const claim=(await reopened.claim('one'))!;expect(claim.payload).toBe('hello');
 expect(await queue.complete({id:'one',claim:{token:'wrong'}})).toBe(false);
 expect(await queue.release(claim,{recordAttempt:false})).toBe(true);
 const claim2=(await queue.claim('one'))!;expect(await queue.complete(claim)).toBe(false);expect(await queue.complete(claim2)).toBe(true);
 expect((await reopened.enqueue('one','again')).kind).toBe('completed');
});
it('serializes lanes and isolates accounts',async()=>{
 const {queue,path}=setup();await queue.enqueue('a','first',{laneKey:'lane',receivedAt:1});await queue.enqueue('b','second',{laneKey:'lane',receivedAt:2});await queue.enqueue('c','other',{laneKey:'other',receivedAt:3});
 const a=(await queue.claimNext())!;expect(a.id).toBe('a');expect((await queue.claimNext())?.id).toBe('c');expect(await queue.claimNext()).toBe(null);
 await queue.complete(a);expect((await queue.claimNext())?.id).toBe('b');expect((await openLocalIngressQueue('different',path).enqueue('a','new')).kind).toBe('accepted');
});
it('recovers abandoned claims but does not steal a refreshed claim',async()=>{
 const {queue,setTime}=setup();await queue.enqueue('a','x');const claim=(await queue.claim('a'))!;setTime(2000);
 expect(await queue.recoverStaleClaims({staleMs:1,shouldRecover:async()=>{await queue.refreshClaim!(claim);return true;}})).toBe(0);
 setTime(3000);expect(await queue.recoverStaleClaims({staleMs:1})).toBe(1);expect((await queue.listPending())[0].id).toBe('a');
});
it('records retry attempts and terminal failures, prunes without deleting active claims',async()=>{
 const {queue,setTime}=setup();await queue.enqueue('a','x');const claim=(await queue.claimNext())!;await queue.release(claim,{lastError:'retry'});expect((await queue.listPending())[0].attempts).toBe(1);
 const second=(await queue.claimNext())!;await queue.fail(second,{reason:'invalid'});expect((await queue.enqueue('a','x')).kind).toBe('failed');
 await queue.enqueue('active','x');await queue.claim('active');setTime(9000);expect(await queue.prune({failedTtlMs:1000,pendingTtlMs:1})).toBe(1);expect(await queue.listClaims()).toHaveLength(1);
});
it('persists identity cache without any trusted host store',async()=>{const {path}=setup();await localStore('identity',path).register('account',{id:'bot'});expect(await localStore('identity',path).lookup('account')).toEqual({id:'bot'});});
it('logical replay claims share waiters, release for retry, and survive restart',async()=>{
 const {path,clock}=setup();const guard=createLocalReplayGuard(()=>path,clock);const a=await guard.claim('message');expect(a.kind).toBe('claimed');
 const b=await guard.claim('message');expect(b.kind).toBe('inflight');if(a.kind==='claimed')a.handle.release();if(b.kind==='inflight')expect(await b.pending).toBe(false);
 const retry=await guard.claim('message');if(retry.kind==='claimed')await retry.handle.commit();expect((await createLocalReplayGuard(()=>path,clock).claim('message')).kind).toBe('duplicate');
});
it('releases only the token-owned admission lane and retains durable replay custody',async()=>{
 const {queue,setTime}=setup();
 await queue.enqueue('a','first',{laneKey:'lane',receivedAt:1});
 await queue.enqueue('b','second',{laneKey:'lane',receivedAt:2});
 const a=(await queue.claimNext())!;
 expect(queue.releaseLane({id:a.id,claim:{token:'wrong'}})).toBe(false);
 expect(await queue.claimNext()).toBeNull();
 expect(queue.releaseLane(a)).toBe(true);
 expect((await queue.claimNext())?.id).toBe('b');
 expect(await queue.listClaims()).toHaveLength(2);
 setTime(3000);await queue.recoverStaleClaims({staleMs:1});
 const again=(await queue.claimNext())!;
 expect(queue.releaseLane(a)).toBe(false);
 expect(await queue.claimNext()).toBeNull();
 expect(await queue.complete(again)).toBe(true);
 expect((await queue.claimNext())?.id).toBe('b');
});
