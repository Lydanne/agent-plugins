import {builtinAuthorizationResources} from './authorization-builtins.mjs';
import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=value=>typeof value==='string'?value.slice(0,8000):'';
/** Scan descriptive metadata only. Neither names nor provider hints prove safety. */
export function scanPermissionResources(store,{plugins,catalog,skills=[],commands=[],adapted=[]},{actor}={}){
 if(catalog?.agentId!==store.agentId||!Array.isArray(catalog.groups)||!Array.isArray(plugins?.plugins)||!Array.isArray(skills))throw Error('Invalid authorization inventory');
 const active=new Map(plugins.plugins.filter(p=>p.runtime?.state==='active').map(p=>[p.id,p]));
 const candidates=new Map();
 function add(kind,provider,name,definition){
  if(!name||!provider||candidates.size>=10000)throw Error('Invalid or excessive resource inventory');
  const id=kind+'://'+encodeURIComponent(provider)+'/'+encodeURIComponent(name);
  if(candidates.has(id))throw Error('Duplicate resource identity');
  candidates.set(id,{id,agentId:store.agentId,kind,provider,name,actions:['discover','read','execute'],definition,definitionHash:digest(definition),status:'pending',verification:'pending',enforcement:'missing',labels:[],behavior:{atomicity:'unknown',recovery:'unknown',idempotency:'unknown',externalEffect:'unknown',sensitivity:'unknown'}});
 }
 for(const group of catalog.groups){
  if(!Array.isArray(group.tools))throw Error('Incomplete tool inventory');
  if(group.source!=='core'&&(group.source!=='plugin'||!active.has(group.pluginId)))continue;
  const provider=group.source==='core'?'openclaw':group.pluginId;
  for(const tool of group.tools){
   if(typeof tool.id!=='string'||!tool.id)throw Error('Invalid tool identity');
   add('tool',provider,tool.id,{toolName:tool.id,description:text(tool.description),version:text(active.get(provider)?.version),parameters:tool.parameters??tool.inputSchema??null});
  }
 }
 for(const skill of skills){if(typeof skill.name!=='string'||typeof skill.provider!=='string'||typeof skill.revision!=='string')throw Error('Invalid skill inventory');add('skill',skill.provider,skill.name,{description:text(skill.description),revision:skill.revision,path:text(skill.path)});}
 for(const entry of commands){
  if(!active.has(entry.pluginId))continue;
  for(const tool of entry.tools??[]){
   const actions=tool.actions?.length?tool.actions:[null];
   for(const action of actions){const command=[tool.command??tool.name,action].filter(Boolean).join(' ');add('cli',entry.pluginId,command,{transport:'tool',toolName:tool.name,action,version:text(active.get(entry.pluginId)?.version)});}
  }
  for(const action of entry.management??[])add('cli',entry.pluginId,'management '+action,{transport:'management',action,prefix:entry.prefix,version:text(active.get(entry.pluginId)?.version)});
  for(const action of entry.automation??[])add('cli',entry.pluginId,'automation '+(typeof action==='string'?action:action.id),{transport:'automation',action:typeof action==='string'?action:action.id});
  for(const action of entry.local??[])add('cli',entry.pluginId,'local '+action,{transport:'local',action});
 }
 function contractHash(descriptor,discovered){
  return digest({definition:descriptor.definition,adapter:descriptor.adapter,actions:descriptor.actions,
   behavior:descriptor.behavior,defaultAuthorization:descriptor.defaultAuthorization,
   kind:descriptor.kind,provider:descriptor.provider,labels:descriptor.labels,
   status:descriptor.status,verification:descriptor.verification,enforcement:descriptor.enforcement,
   providerVersion:text(active.get(descriptor.provider)?.version),discoveredDefinition:discovered?.definition});
 }
 for(const descriptor of builtinAuthorizationResources(store.agentId)){
  if(active.has(descriptor.provider)||descriptor.provider==='openclaw'&&candidates.has(descriptor.id)){
   const discovered=candidates.get(descriptor.id);
   candidates.set(descriptor.id,{...descriptor,definitionHash:contractHash(descriptor,discovered)});
  }
 }
 for(const descriptor of adapted){
  if(candidates.has(descriptor.id)||descriptor.agentId!==store.agentId||!descriptor.adapter)throw Error('Invalid adapted resource');
  candidates.set(descriptor.id,{...descriptor,definitionHash:contractHash(descriptor)});
 }
 // Commit the entire inventory, its defaults and audits together. Absence is not proof of removal.
 return store.transaction(()=>{
 const results=[];
 for(const candidate of candidates.values()){
  const old=store.get('resources',candidate.id);
  if(old?.definitionHash===candidate.definitionHash){results.push({id:candidate.id,status:'unchanged',revision:old.revision});continue;}
  const saved=store.saveResource(candidate,{expectedRevision:old?.revision??0,actor});
  if(saved.defaultAuthorization!=='explicit-only'&&saved.verification==='verified'&&saved.enforcement==='enforced')store.applyDefaults(saved.id,{actor});
  results.push({id:saved.id,status:old?'changed':'discovered',revision:saved.revision});
 }
 return {resources:results,discovered:results.filter(r=>r.status==='discovered').length,changed:results.filter(r=>r.status==='changed').length};
 });
}
