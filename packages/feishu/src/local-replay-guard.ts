import type { ChannelReplayClaimHandle } from 'openclaw/plugin-sdk/persistent-dedupe';
import { localStatePath, localTransaction } from './local-state.js';

type Options={namespace?:string;now?:number;onDiskError?:(error:unknown)=>void};
export function createLocalReplayGuard(path=()=>localStatePath(),clock=Date.now) {
  const active=new Map<string,{promise:Promise<boolean>;resolve:(value:boolean)=>void}>();
  const scope=(options?:Options)=>JSON.stringify(['replay',options?.namespace??'global']);
  const ownerKey=(key:string,options?:Options)=>JSON.stringify([scope(options),key]);
  const ttl=86400000;
  const hasRecent=async(key:string|null|undefined,options?:Options)=>{if(!key?.trim())return false;return localTransaction(path(),db=>{
    const now=options?.now??clock();
    db.prepare('DELETE FROM plugin_records WHERE scope=? AND stamp<=?').run(scope(options),now-ttl);
    return Boolean(db.prepare('SELECT 1 FROM plugin_records WHERE scope=? AND id=?').get(scope(options),key));
  });};
  return {
    async claim(raw:string|null|undefined,options?:Options) {
      const key=raw?.trim();if(!key)return {kind:'invalid' as const};
      const owner=ownerKey(key,options);const inflight=active.get(owner);if(inflight)return {kind:'inflight' as const,pending:inflight.promise};
      // Install ownership before yielding, so two callers cannot both pass the disk lookup.
      let resolve!:(value:boolean)=>void;const promise=new Promise<boolean>(r=>{resolve=r;});const entry={promise,resolve};active.set(owner,entry);
      try {if(await hasRecent(key,options)){active.delete(owner);resolve(true);return {kind:'duplicate' as const};}}
      catch(error){active.delete(owner);resolve(false);throw error;}
      const handle:ChannelReplayClaimHandle={keys:[key],
        commit:async(overrides)=>{
          if(active.get(owner)!==entry)return false;
          try {localTransaction(path(),db=>{
            db.prepare('INSERT INTO plugin_records VALUES (?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET stamp=excluded.stamp').run(scope(options),key,'seen',overrides?.now??options?.now??clock(),'{}');
            db.prepare('DELETE FROM plugin_records WHERE scope=? AND id NOT IN (SELECT id FROM plugin_records WHERE scope=? ORDER BY stamp DESC LIMIT 10000)').run(scope(options),scope(options));
          });active.delete(owner);resolve(true);return true;}
          catch(error){active.delete(owner);resolve(false);throw error;}
        },
        release:()=>{if(active.get(owner)===entry){active.delete(owner);resolve(false);}},
      };
      return {kind:'claimed' as const,handle};
    },
    hasRecent,
    async forget(key:string|null|undefined,options?:Options){if(!key?.trim())return false;const owner=ownerKey(key,options);active.get(owner)?.resolve(false);active.delete(owner);return localTransaction(path(),db=>Number(db.prepare('DELETE FROM plugin_records WHERE scope=? AND id=?').run(scope(options),key).changes)>0);},
    async warmup(namespace?:string, _onError?:(error:unknown)=>void){return localTransaction(path(),db=>{
      db.prepare('DELETE FROM plugin_records WHERE scope=? AND stamp<=?').run(scope({namespace}),clock()-ttl);
      return Number((db.prepare('SELECT count(*) AS n FROM plugin_records WHERE scope=?').get(scope({namespace})) as {n:number}).n);
    });},
    clearMemory(){for(const item of active.values())item.resolve(false);active.clear();},
  };
}
