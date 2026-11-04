import {canReviewResource,reviewResource} from './authorization-reviewed.mjs';
import {authorizationAdapterResources} from './dist/authorization-api.mjs';
import {registeredCliCapabilities} from './dist/plugin-cli.mjs';
import {createAuthorizationGraphReader} from './authorization-graph.mjs';
import {createAuthorizationService} from './authorization-service.mjs';
import {scanAuthorizationSkills} from './authorization-skill-scan.mjs';
import {scanPermissionResources} from './authorization-catalog.mjs';
import {permissionActions} from './authorization-policy.mjs';
import {createEntityStore} from './entities.mjs';
/** Operator administration is an out-of-band bootstrap boundary, never a model tool. */
export function registerAuthorizationManagement(api,config,runtime,{openGraph=createEntityStore,readCatalog}={}){
 const register=api.session?.controls?.registerSessionAction?.bind(api.session.controls)??api.registerSessionAction?.bind(api);
 if(!register)return;
 for(const action of ['catalog','save','mode','defaults','scan','classify','review','simulate','publish','previewDefaults','recomputeDefaults'])register({id:'authorization-'+action,description:'Current Agent permission administration',requiredScopes:[action==='catalog'?'operator.read':'operator.admin'],handler:async ctx=>{
  try{
   const id=ctx.agentId,binding=config.agents[id];if(!binding)throw Error('Unknown Agent');
   const scopes=ctx.client?.scopes??[];if(!scopes.includes('operator.admin')&&!scopes.includes(action==='catalog'?'operator.read':'operator.admin'))throw Error('Permission administration requires operator.admin');
   const store=runtime.storeFor(id),actor='operator:'+String(ctx.client?.connId??'unknown');
   if(action==='catalog')return {ok:true,result:{agentId:id,mode:store.mode(),canAdmin:scopes.includes('operator.admin'),actions:permissionActions,groups:store.list('groups'),resources:store.list('resources').map(resource=>({...resource,reviewEligible:canReviewResource(resource)})),rules:store.list('rules'),bindings:store.list('bindings'),audit:store.history(),policyVersions:store.policyVersions()}};
   const p=ctx.payload??{};
   if(['previewDefaults','recomputeDefaults'].includes(action)){if(Object.keys(p).some(k=>!['resourceId','context','expectedRevision'].includes(k)))throw Error('Invalid default preview arguments');return {ok:true,result:store[action](p.resourceId,{context:p.context??{},expectedRevision:p.expectedRevision,actor})};}
   if(action==='publish'){if(Object.keys(p).some(k=>!['id','expectedRevision'].includes(k)))throw Error('Invalid publish arguments');return {ok:true,result:store.publishPolicy(p.id,{expectedRevision:p.expectedRevision,actor})};}
   if(action==='simulate'){
    if(Object.keys(p).some(k=>!['entityId','requirements','context','parameters'].includes(k))||!Array.isArray(p.requirements)||!p.requirements.length||p.requirements.length>100)throw Error('Invalid simulation');
    const graph=openGraph(binding.repo),entity=graph.get(p.entityId).entity;if(!entity||entity.typeId!=='person')throw Error('Simulation requires an active person');
    const reader=createAuthorizationGraphReader(graph,id),subject={id:entity.id,agentId:id,sourceId:entity.sourceId,verified:true};
    const service=createAuthorizationService({store,resolveIdentity:()=>subject,readMembership:reader.readMembership,resolveOperation:()=>({requirements:p.requirements,context:p.context??{}})});
    return {ok:true,result:await service.decide({params:p.parameters??{}}, {})};
   }
   if(action==='review'){
    if(Object.keys(p).some(key=>!['resourceId','expectedRevision','confirmed'].includes(key))||p.confirmed!==true)throw Error('Explicit resource review confirmation required');
    return {ok:true,result:store.transaction(()=>{
     const resource=store.get('resources',p.resourceId),saved=store.saveResource(reviewResource(resource,actor),{expectedRevision:p.expectedRevision,actor});
     store.applyDefaults(saved.id,{actor});return saved;
    })};
   }
   if(action==='classify'){
    if(Object.keys(p).some(k=>!['resourceId','expectedRevision','labels','behavior'].includes(k)))throw Error('Invalid resource classification');
    const resource=store.get('resources',p.resourceId);if(!resource)throw Error('Unknown resource');
    if(!Array.isArray(p.labels)||p.labels.length>50||p.labels.some(label=>typeof label!=='string'||!label||label.length>100))throw Error('Invalid resource labels');
    const values={access:['read','write','mixed','unknown'],atomicity:['guaranteed','not-guaranteed','unknown','not-applicable'],recovery:['reversible','compensatable','irreversible','unknown','not-applicable'],idempotency:['guaranteed','not-guaranteed','unknown','not-applicable'],externalEffect:['none','present','unknown'],sensitivity:['ordinary','sensitive','restricted','unknown']};
    if(!p.behavior||Object.entries(p.behavior).some(([key,value])=>!values[key]?.includes(value)))throw Error('Invalid behavior classification');
    // Editing an operator attestation requires a fresh review before execution.
    const saved=store.saveResource({...resource,...(resource.review?{review:undefined,status:'pending',verification:'pending'}:{}),labels:p.labels,behavior:{...resource.behavior,...p.behavior}},{expectedRevision:p.expectedRevision,actor});
    if(saved.verification==='verified'&&saved.enforcement==='enforced')store.applyDefaults(saved.id,{actor});
    return {ok:true,result:saved};
   }
   if(action==='scan'){if(Object.keys(p).length||!readCatalog)throw Error('Resource scanning unavailable');const [plugins,catalog]=await Promise.all([readCatalog('plugins.list',{}),readCatalog('tools.catalog',{agentId:id,includePlugins:true})]);const source=await scanAuthorizationSkills(binding,{agentId:id,hostConfig:api.config??{},knowledgeDefaults:config.knowledge});return {ok:true,result:{...scanPermissionResources(store,{plugins,catalog,skills:source.skills,commands:registeredCliCapabilities(),adapted:await authorizationAdapterResources({agentId:id})},{actor}),complete:source.complete,failures:source.failures}};}
   if(action==='mode'){if(Object.keys(p).some(k=>k!=='mode'))throw Error('Invalid mode arguments');return {ok:true,result:store.setMode(p.mode,{actor})};}
   if(action==='defaults'){if(Object.keys(p).some(k=>!['resourceId','context'].includes(k)))throw Error('Invalid default arguments');return {ok:true,result:{grants:store.applyDefaults(p.resourceId,{actor,context:p.context??{}})}};}
   if(Object.keys(p).some(k=>!['kind','value','expectedRevision'].includes(k))||!p.value||!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<0)throw Error('Invalid save arguments');
   const methods={groups:'saveGroup',rules:'draftRule',bindings:'saveBinding'};
   if(!Object.hasOwn(methods,p.kind))throw Error('Invalid collection');
   if(p.kind==='bindings'){
    const entity=openGraph(binding.repo).get(p.value.entityId).entity;
    if(!entity||entity.typeId!==p.value.entityType)throw Error('Entity reference is missing or has a different type');
   }
   const value={...p.value};delete value.revision;
   if(['bindings','resources'].includes(p.kind))value.agentId=id;
   return {ok:true,result:store[methods[p.kind]](value,{expectedRevision:p.expectedRevision,actor})};
  }catch(error){return {ok:false,code:'AUTHORIZATION_MANAGEMENT_FAILED',error:error.message};}
 }});
}
