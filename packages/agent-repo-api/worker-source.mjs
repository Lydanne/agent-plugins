// Host-only, versioned Worker control contract. Not a model-facing tool.
// Channels push explicit revocations; Worker never queries a channel provider.
const key=Symbol.for('openclaw-plugins.worker-source-control.v1');
const state=globalThis[key]??={record:undefined};
export function normalizeSourceRevocation(event){
 if(event?.apiVersion!==1||typeof event.eventId!=='string'||!event.eventId||event.eventId.length>200||typeof event.reason!=='string'||!event.reason||event.reason.length>200||!Array.isArray(event.sources)||!event.sources.length||event.sources.length>100)throw Error('Invalid source revocation');
 const sources=event.sources.map(source=>{
  if(!source||['namespace','scope','id'].some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>2000))throw Error('Invalid source reference');
  return {namespace:source.namespace,scope:source.scope,id:source.id};
 });
 return {apiVersion:1,eventId:event.eventId,reason:event.reason,sources};
}
export function registerWorkerSourceControl(service,{owner}={}){
 if(!owner||service?.apiVersion!==1||typeof service.invalidate!=='function')throw Error('Unsupported Worker source service');
 if(state.record&&state.record.owner!==owner)throw Error('Worker source service already registered');
 const record={owner,service};state.record=record;
 return ()=>{if(state.record===record)state.record=undefined;};
}
export function revokeWorkerSources(event){
 const input=normalizeSourceRevocation(event),service=state.record?.service;
 if(!service)return {accepted:false,reason:'unavailable'};
 const receipt=service.invalidate(input);
 if(receipt?.accepted!==true||receipt.eventId!==input.eventId)throw Error('Invalid Worker source receipt');
 return receipt;
}
