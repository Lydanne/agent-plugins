import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChannelIngressQueue, ChannelIngressQueueRecord, ChannelIngressQueueClaim, ChannelIngressQueueClaimRef } from 'openclaw/plugin-sdk/channel-outbound';
import { localStatePath, localTransaction } from './local-state.js';

type Status='pending'|'claimed'|'completed'|'failed';
type RecordRow<T> = ChannelIngressQueueRecord<T> & {
  laneReleased?: boolean;
  claim?: ChannelIngressQueueClaim<T>['claim']; completedAt?:number; failedAt?:number; reason?:string; message?:string;
};
type Row<T> = {status:Status; value:RecordRow<T>};
export type LocalIngressQueue<T> = ChannelIngressQueue<T> & {
  /** Token-fenced handoff: retain durable custody while freeing transport admission. */
  releaseLane: (ref: ChannelIngressQueueClaimRef) => boolean;
};
export function openLocalIngressQueue<T>(accountId:string,path=localStatePath(),now=Date.now):LocalIngressQueue<T> {
  const scope=JSON.stringify(['ingress',accountId]);
  const tx=<R>(fn:(db:DatabaseSync)=>R)=>localTransaction(path,fn);
  const get=(db:DatabaseSync,id:string):Row<T>|undefined=>{
    const row=db.prepare('SELECT status,value FROM plugin_records WHERE scope=? AND id=?').get(scope,id) as {status:Status;value:string}|undefined;
    return row ? {status:row.status,value:JSON.parse(row.value)} : undefined;
  };
  const list=(db:DatabaseSync,status:Status):RecordRow<T>[] => (db.prepare('SELECT value FROM plugin_records WHERE scope=? AND status=? ORDER BY stamp,id').all(scope,status) as {value:string}[]).map(r=>JSON.parse(r.value));
  const put=(db:DatabaseSync,status:Status,value:RecordRow<T>)=>db.prepare('INSERT INTO plugin_records VALUES (?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET status=excluded.status,stamp=excluded.stamp,value=excluded.value').run(scope,value.id,status,value.updatedAt,JSON.stringify(value));
  const owned=(row:Row<T>|undefined,ref:string|ChannelIngressQueueClaimRef)=>row && (typeof ref==='string' ? row.status==='pending' : row.status==='claimed' && row.value.claim?.token===ref.claim.token);
  const claimRow=(db:DatabaseSync,row:RecordRow<T>,ownerId='local')=>{
    const value={...row,laneReleased:false,updatedAt:now(),claim:{token:randomUUID(),ownerId,claimedAt:now()}};
    put(db,'claimed',value); return value;
  };
  const settle=(ref:string|ChannelIngressQueueClaimRef,fn:(db:DatabaseSync,value:RecordRow<T>)=>void)=>tx(db=>{
    const row=get(db,typeof ref==='string'?ref:ref.id);if(!owned(row,ref))return false;
    fn(db,row!.value);return true;
  });
  return {
    releaseLane: (ref) => settle(ref,(db,value)=>{value.laneReleased=true;put(db,'claimed',value);}),
    async enqueue(id,payload,options={}) {return tx(db=>{
      const old=get(db,id);
      if(old) return {kind:old.status,duplicate:true,record:old.value} as Awaited<ReturnType<ChannelIngressQueue<T>['enqueue']>>;
      const value:RecordRow<T>={id,channelId:'feishu',accountId,queueName:'ingress',payload,metadata:options.metadata,receivedAt:options.receivedAt??now(),updatedAt:now(),laneKey:options.laneKey,attempts:0};
      put(db,'pending',value);return {kind:'accepted' as const,duplicate:false as const,record:value};
    });},
    async listPending(options={}) {return tx(db=>{
      const rows=list(db,'pending').sort(options.orderBy==='id'?(a,b)=>a.id.localeCompare(b.id):(a,b)=>a.receivedAt-b.receivedAt||a.id.localeCompare(b.id));
      return options.limit==='all'?rows:rows.slice(0,options.limit??100);
    });},
    async listClaims(){return tx(db=>list(db,'claimed') as ChannelIngressQueueClaim<T>[]);},
    async claim(id,options={}) {return tx(db=>{const row=get(db,id);return row?.status==='pending'?claimRow(db,row.value,options.ownerId):null;});},
    async claimNext(options={}) {return tx(db=>{
      const blocked=new Set(options.blockedLaneKeys??[]);
      // Active claims own their lanes even across separate queue handles.
      for(const row of list(db,'claimed')) if(row.laneKey&&!row.laneReleased)blocked.add(row.laneKey);
      const candidates=options.candidateIds?new Set(options.candidateIds):undefined;
      const pending=list(db,'pending').sort(options.orderBy==='id'?(a,b)=>a.id.localeCompare(b.id):(a,b)=>a.receivedAt-b.receivedAt||a.id.localeCompare(b.id));
      for(const row of pending.slice(0,options.scanLimit??pending.length)) {
        if(candidates&&!candidates.has(row.id))continue;
        const derived=options.deriveLaneKey?.(row);
        if(derived && row.laneKey && derived!==row.laneKey && !options.reconcileStoredLaneKey?.(row,row.laneKey,derived))continue;
        const lane=derived??row.laneKey;
        if(lane&&blocked.has(lane))continue;
        return claimRow(db,{...row,laneKey:lane},options.ownerId);
      }
      return null;
    });},
    async refreshClaim(ref,options={}){return settle(ref,(db,value)=>{value.claim!.claimedAt=options.refreshedAt??now();value.updatedAt=now();put(db,'claimed',value);});},
    async complete(ref,options={}){return settle(ref,(db,value)=>{
      // Scrub message content after adoption, retaining only the duplicate tombstone.
      const terminal={id:value.id,channelId:'feishu',accountId,queueName:value.queueName,completedAt:options.completedAt??now(),updatedAt:now(),metadata:options.metadata};
      put(db,'completed',terminal as RecordRow<T>);
    });},
    async release(ref,options={}){return settle(ref,(db,value)=>{
      delete value.claim;value.updatedAt=options.releasedAt??now();
      if(options.recordAttempt!==false){value.attempts++;value.lastAttemptAt=value.updatedAt;}
      if(options.lastError)value.lastError=options.lastError;
      put(db,'pending',value);
    });},
    async fail(ref,options){return settle(ref,(db,value)=>{
      delete value.claim;value.failedAt=options.failedAt??now();value.updatedAt=value.failedAt;value.reason=options.reason;value.message=options.message;put(db,'failed',value);
    });},
    async delete(ref){return tx(db=>{
      const id=typeof ref==='string'?ref:ref.id;const row=get(db,id);
      if(!row)return false;
      if(typeof ref!=='string'&&'claim' in ref && !owned(row,ref))return false;
      if((typeof ref==='string'||!('claim' in ref))&&row.status==='claimed')return false;
      return db.prepare('DELETE FROM plugin_records WHERE scope=? AND id=?').run(scope,id).changes>0;
    });},
    async recoverStaleClaims(options={}) {
      const cutoff=(options.now??now())-(options.staleMs??60000);
      const claims=tx(db=>list(db,'claimed') as ChannelIngressQueueClaim<T>[]);
      let count=0;
      for(const claim of claims){
        if(claim.claim.claimedAt>cutoff || (options.shouldRecover && !await options.shouldRecover(claim)))continue;
        // Check token and heartbeat again after any asynchronous recovery predicate.
        count+=tx(db=>{const row=get(db,claim.id);if(!owned(row,claim)||row!.value.claim!.claimedAt>cutoff)return 0;const value=row!.value;delete value.claim;value.updatedAt=now();put(db,'pending',value);return 1;});
      }
      return count;
    },
    async prune(options={}) {return tx(db=>{
      const protectedIds=new Set(options.protectIds??[]);let count=0;
      for(const status of ['pending','completed','failed'] as const){
        const ttl=options[`${status}TtlMs`];const cap=options[`${status}MaxEntries`];
        const rows=list(db,status).sort((a,b)=>b.updatedAt-a.updatedAt);let retained=0;
        for(const row of rows){if(protectedIds.has(row.id))continue;
          if((ttl!==undefined&&(options.now??now())-row.updatedAt>=ttl)||(cap!==undefined&&retained>=cap)) count+=Number(db.prepare('DELETE FROM plugin_records WHERE scope=? AND id=?').run(scope,row.id).changes);
          else retained++;
        }
      }
      return count;
    });},
  };
}
