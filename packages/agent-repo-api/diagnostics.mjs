import {randomUUID} from 'node:crypto';
import {trustedAgentId} from './index.mjs';
// Shared only by plugins in the Main process. Detached Workers use a Main adapter.
const registry=globalThis[Symbol.for('openclaw-plugins.diagnostics.v1')]??={sources:new Map(),listeners:new Set()};
const idPattern=/^[a-z0-9][a-z0-9.-]{0,79}$/;
const secret=/token|secret|password|authorization|cookie|api.?key|credential/i;
export function diagnosticSnapshot(value,depth=0,seen=new WeakSet(),budget={left:300}){
 if(--budget.left<0)return '[budget exceeded]';
 if(typeof value==='string')return value.replace(/\bBearer\s+\S+/gi,'Bearer [redacted]').replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi,'$1[redacted]').replace(/([?&](?:token|key|signature|access_token)=)[^&#\s]+/gi,'$1[redacted]').slice(0,4000);
 if(value===null||typeof value==='boolean'||typeof value==='number')return value;
 if(typeof value!=='object')return String(value).slice(0,200);
 if(depth>=6||seen.has(value))return '[truncated]';seen.add(value);
 if(Array.isArray(value)){const items=[];for(let index=0;index<Math.min(value.length,50)&&budget.left>0;index++){const descriptor=Object.getOwnPropertyDescriptor(value,String(index));items.push(descriptor?.get?'[getter omitted]':diagnosticSnapshot(descriptor?.value,depth+1,seen,budget));}return items;}
 const out={};for(const key of Object.keys(value).slice(0,50)){const descriptor=Object.getOwnPropertyDescriptor(value,key);Object.defineProperty(out,key,{value:secret.test(key)?'[redacted]':descriptor?.get?'[getter omitted]':diagnosticSnapshot(descriptor?.value,depth+1,seen,budget),enumerable:true});}return out;
}
function normalize(source,agentId,event){
 const clean=diagnosticSnapshot(event??{}),row={apiVersion:1,eventId:randomUUID(),observedAt:new Date().toISOString(),agentId,sourceId:source.id,pluginId:source.pluginId,level:['debug','info','warn','error'].includes(clean.level)?clean.level:'info',message:String(clean.message??clean.eventName??'日志').slice(0,2000)};
 for(const key of ['time','eventName','category','jobId','traceId','projectId','phase'])if(typeof clean[key]==='string'||key==='time'&&typeof clean[key]==='number')row[key]=typeof clean[key]==='string'?clean[key].slice(0,200):clean[key];
 if(clean.data!==undefined)row.data=clean.data;
 return Buffer.byteLength(JSON.stringify(row))<=16*1024?row:{...row,data:'[payload exceeds 16 KiB]'};
}
async function bounded(work,signal){
 let timer,abort;
 try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return work();}),new Promise((_,reject)=>{abort=()=>reject(Error('Diagnostic capture stopped'));signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>reject(Error('Diagnostic source timeout')),5000);})]);}
 finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
export function registerDiagnosticSource(source,owner){
 if(!owner||source?.apiVersion!==1||!idPattern.test(source.id)||!idPattern.test(source.pluginId)||typeof source.label!=='string'||source.label.length>100||source.open!==undefined&&typeof source.open!=='function')throw Error('Invalid diagnostic source');
 const previous=registry.sources.get(source.id);if(previous&&previous.owner!==owner)throw Error('Diagnostic source already registered');
 if(previous)for(const listener of [...registry.listeners])listener.removed(source.id);
 source=Object.freeze({...source});const entry={source,owner};registry.sources.set(source.id,entry);
 return {
  log(context,event){
   const agentId=trustedAgentId(context);if(registry.sources.get(source.id)!==entry)return false;
   const listeners=[...registry.listeners].filter(listener=>listener.accepts(agentId,source.id));if(!listeners.length)return false;
   try{const row=normalize(source,agentId,typeof event==='function'?event():event);for(const listener of listeners)listener.push(row);return true;}catch{return false;}
  },
  dispose(){if(registry.sources.get(source.id)===entry){registry.sources.delete(source.id);for(const listener of registry.listeners)listener.removed(source.id);}},
 };
}
export function createDiagnosticHub({now=()=>Date.now(),ttlMs=20000,maxRows=2000,maxBytes=5*1024*1024}={}){
 const leases=new Map();let timer,disposed=false;
 const context=(ctx,write=false)=>{const agentId=trustedAgentId(ctx),scopes=ctx.client?.scopes??[];if(!scopes.some(scope=>(write?['operator.write','operator.admin']:['operator.read','operator.write','operator.admin']).includes(scope)))throw Error('诊断接口权限不足');return {agentId,connId:ctx.client?.connId};};
 const owner=ctx=>{const scope=context(ctx);if(typeof scope.connId!=='string'||!scope.connId)throw Error('实时调试需要可信连接身份');return scope;};
 const release=lease=>{leases.delete(lease.id);lease.controller.abort();registry.listeners.delete(lease.listener);for(const value of lease.captures.values())try{value.capture.close?.();}catch{}lease.captures.clear();if(!leases.size){clearInterval(timer);timer=undefined;}};
 const prune=()=>{for(const lease of leases.values())if(lease.expiresAt<=now())release(lease);};
 const get=ctx=>{prune();const scope=owner(ctx),lease=leases.get(ctx.payload?.leaseId);if(!lease||lease.agentId!==scope.agentId||lease.connId!==scope.connId)throw Error('实时调试会话已停止或不属于此连接');return lease;};
 const append=(lease,row)=>{if(!leases.has(lease.id)||lease.expiresAt<=now())return;const value={...row,captureId:lease.id,seq:++lease.seq},bytes=Buffer.byteLength(JSON.stringify(value));lease.rows.push({value,bytes});lease.bytes+=bytes;while(lease.rows.length>maxRows||lease.bytes>maxBytes){lease.bytes-=lease.rows.shift().bytes;lease.dropped++;}};
 const parameters=(ctx,keys)=>{if(Object.keys(ctx.payload??{}).some(key=>!keys.includes(key)))throw Error('无效诊断参数');};
 const actions={
  async diagnosticSources(ctx){context(ctx);parameters(ctx,[]);return {apiVersion:1,sources:[...registry.sources.values()].map(({source})=>({id:source.id,pluginId:source.pluginId,label:source.label,live:true}))};},
  async diagnosticStart(ctx){
   parameters(ctx,['sourceIds']);const scope=owner(ctx);context(ctx,true);prune();if(disposed)throw Error('诊断服务已停止');
   const ids=ctx.payload?.sourceIds??[...registry.sources.keys()];if(!Array.isArray(ids)||!ids.length||ids.length>32||new Set(ids).size!==ids.length||ids.some(id=>!registry.sources.has(id)))throw Error('选择已注册日志来源');
   if(leases.size>=32||[...leases.values()].filter(lease=>lease.connId===scope.connId).length>=4)throw Error('实时调试会话数量超限');
   const lease={...scope,id:randomUUID(),seq:0,rows:[],bytes:0,dropped:0,expiresAt:now()+ttlMs,controller:new AbortController(),captures:new Map(),busy:false};
   lease.listener={accepts:(agent,id)=>leases.has(lease.id)&&lease.expiresAt>now()&&agent===scope.agentId&&ids.includes(id),push:row=>append(lease,row),removed:id=>{if(ids.includes(id))release(lease);}};
   leases.set(lease.id,lease);registry.listeners.add(lease.listener);timer??=setInterval(prune,1000);timer.unref?.();
   // Opening a source initializes its cursor at EOF; no historical backfill.
   try{for(const id of ids){const entry=registry.sources.get(id);if(entry.source.open){const opening=Promise.resolve().then(()=>{lease.controller.signal.throwIfAborted();return entry.source.open({agentId:scope.agentId,signal:lease.controller.signal});});opening.then(capture=>{if(lease.controller.signal.aborted)try{capture.close?.();}catch{}},()=>{});const capture=await bounded(()=>opening,lease.controller.signal);if(typeof capture?.read!=='function')throw Error('Invalid capture');if(!leases.has(lease.id)||lease.controller.signal.aborted||registry.sources.get(id)!==entry){capture.close?.();throw Error('实时调试启动已中断');}lease.captures.set(id,{entry,capture});}}}catch{release(lease);throw Error('实时调试启动失败');}
   return {apiVersion:1,agentId:scope.agentId,leaseId:lease.id,expiresAt:lease.expiresAt,ttlMs,sourceIds:ids};
  },
  async diagnosticRead(ctx){
   parameters(ctx,['leaseId','afterSeq']);const lease=get(ctx),after=ctx.payload.afterSeq??0;if(!Number.isInteger(after)||after<0||after>lease.seq)throw Error('无效日志游标');if(lease.busy)throw Error('日志读取仍在进行');lease.busy=true;
   try{
    for(const [id,{entry,capture}] of lease.captures){if(registry.sources.get(id)!==entry)continue;const events=await bounded(()=>capture.read({signal:lease.controller.signal}),lease.controller.signal);if(!leases.has(lease.id)||lease.expiresAt<=now())throw Error('实时调试已停止');for(const event of (events??[]).slice(0,100))append(lease,normalize(entry.source,lease.agentId,event));}
    if(!leases.has(lease.id))throw Error('实时调试已停止');
    const rows=lease.rows.filter(row=>row.value.seq>after).slice(0,20).map(row=>row.value);return {apiVersion:1,agentId:lease.agentId,leaseId:lease.id,rows,nextSeq:rows.at(-1)?.seq??Math.max(after,lease.seq),dropped:lease.dropped,gap:lease.rows.length>0&&after<lease.rows[0].value.seq-1};
   }catch(error){release(lease);throw error;}finally{lease.busy=false;}
  },
  async diagnosticRenew(ctx){parameters(ctx,['leaseId']);context(ctx,true);const lease=get(ctx);lease.expiresAt=now()+ttlMs;return {expiresAt:lease.expiresAt};},
  async diagnosticStop(ctx){parameters(ctx,['leaseId']);const scope=owner(ctx),lease=leases.get(ctx.payload?.leaseId);if(lease){if(lease.agentId!==scope.agentId||lease.connId!==scope.connId)throw Error('实时调试会话归属无效');release(lease);}return {stopped:true};},
 };
 return {actions,canReadTransfer(ctx,leaseId){try{get({...ctx,payload:{leaseId}});return true;}catch{return false;}},start(){disposed=false;},dispose(){disposed=true;for(const lease of [...leases.values()])release(lease);}};
}
