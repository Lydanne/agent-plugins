/** Trusted in-process adapters only. Never expose registration to model tool arguments. */
const registry=globalThis[Symbol.for('openclaw-plugins.authorization-adapters.v1')]??=new Map();
export function registerAuthorizationAdapter(id,adapter,owner){
 if(typeof id!=='string'||!id||!owner||typeof adapter?.match!=='function'||typeof adapter?.resolve!=='function')throw Error('Invalid authorization adapter');
 const prior=registry.get(id);if(prior&&prior.owner!==owner)throw Error('Authorization adapter already registered');
 if(adapter.resources!==undefined&&(typeof adapter.resources!=='function'||typeof adapter.revision!=='string'||!adapter.revision))throw Error('Resource adapters require a revision');
 const record={id,adapter,owner};registry.set(id,record);return ()=>{if(registry.get(id)===record)registry.delete(id);};
}
export function authorizationAdapterClaims(event,context){return [...registry.values()].some(({adapter})=>adapter.match(event,context));}
export async function resolveAuthorizedOperation(event,context){
 const matches=[...registry.values()].filter(({adapter})=>adapter.match(event,context));
 if(matches.length!==1)return undefined;
 const selected=matches[0],operation=await selected.adapter.resolve(event,context);
 return operation?{...operation,...(selected.adapter.resources?{adapter:{id:selected.id,revision:selected.adapter.revision}}:{})}:undefined;
}

const scopes=globalThis[Symbol.for('openclaw-plugins.authorization-scopes.v1')]??=new Map();
const scopeKey=context=>JSON.stringify([context.agentId,context.sessionKey,context.runId,context.toolCallId]);
/** Host-owned scope lease for one invocation; callers cannot inject it through tool params. */
export function bindAuthorizationScope(context,jobId){
 if(!context.agentId||!context.sessionKey||!context.runId||!context.toolCallId||typeof jobId!=='string'||!jobId)throw Error('Invalid task scope binding');
 const key=scopeKey(context);if(scopes.has(key))throw Error('Invocation scope already bound');
 const record={scopeId:JSON.stringify(['worker-job',context.sessionKey,jobId])};scopes.set(key,record);
 return ()=>{if(scopes.get(key)===record)scopes.delete(key);};
}
export function getAuthorizationScope(context){return scopes.get(scopeKey(context))?.scopeId;}

export async function authorizationAdapterResources(context){
 const resources=[],ids=new Set();
 for(const {id,adapter} of registry.values()){
  if(!adapter.resources)continue;
  const entries=await adapter.resources(context);if(!Array.isArray(entries)||entries.length>10000)throw Error('Invalid adapter resource catalog');
  for(const resource of entries){
   if(!resource||typeof resource.id!=='string'||!resource.id.startsWith('adapter://'+encodeURIComponent(id)+'/')||resource.agentId!==context.agentId||ids.has(resource.id))throw Error('Invalid or duplicate adapter resource');
   ids.add(resource.id);resources.push({...structuredClone(resource),adapter:{id,revision:adapter.revision},status:'active',verification:'verified',enforcement:'enforced'});
  }
 }
 return resources;
}

const taskAuthorities=globalThis[Symbol.for('openclaw-plugins.authorization-tasks.v1')]??=new Map();
/** AgentRepo owns policy; Worker supplies only its already verified task provenance. */
export function registerTaskAuthorization(agentId,authority,owner){
 if(typeof agentId!=='string'||!agentId||typeof authority?.admit!=='function'||!owner)throw Error('Invalid task authorization authority');
 const prior=taskAuthorities.get(agentId);if(prior?.owner!==undefined&&prior.owner!==owner)throw Error('Task authorization already registered');
 const record={owner,authority};taskAuthorities.set(agentId,record);
 return ()=>{if(taskAuthorities.get(agentId)===record)taskAuthorities.set(agentId,{owner,authority:null});};
}
export async function admitAuthorizedTask(task){
 const record=taskAuthorities.get(task.agentId);
 if(!record)return undefined; // Standalone Worker without an AgentRepo permission domain.
 if(!record.authority)throw Error('Task authorization authority unavailable');
 return record.authority.admit(task);
}
