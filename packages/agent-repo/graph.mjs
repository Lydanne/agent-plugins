import {isDeepStrictEqual} from 'node:util';
import {graphTransaction,sourceRecord,putNode,nodeById,audit,hash,revision,now} from './graph-storage.mjs';
import {builtinEntityTypes,key,text,exact,object,definition,attributes,fail} from './graph-schema.mjs';
const parse=row=>row?JSON.parse(row.value):null;
const values=(db,table)=>db.prepare(`SELECT value FROM ${table}`).all().map(parse);
const time=value=>{text(value,40);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value||Date.parse(value)>Date.now()+300000)fail('同步时间无效');return value;};
const page=(input,all,keyName)=>{const {offset=0,limit=20}=input;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('分页参数无效');return {[keyName]:all.slice(offset,offset+limit),total:all.length,offset,limit,nextOffset:offset+limit<all.length?offset+limit:null};};
const types=db=>[...builtinEntityTypes.map(t=>({...t,builtin:true})),...values(db,'entity_types').map(t=>({...t,builtin:false}))];
export const builtinRelationTypes=[
 {id:'member_of',label:'隶属部门',fromTypes:['person'],toTypes:['department'],fields:{role:{label:'职位',type:'string'}},rules:{sameSource:true,noSelf:true}},
 {id:'primary_department',label:'主部门',fromTypes:['person'],toTypes:['department'],fields:{},rules:{sameSource:true,noSelf:true,maxOutgoing:1}},
 {id:'belongs_to',label:'所属组织',fromTypes:['department','person'],toTypes:['organization'],fields:{},rules:{sameSource:true,noSelf:true,maxOutgoing:1}},
 {id:'parent_department',label:'上级部门',fromTypes:['department'],toTypes:['department'],fields:{},rules:{sameSource:true,noSelf:true,acyclic:true,maxOutgoing:1}},
 {id:'manages',label:'管理',fromTypes:['person'],toTypes:['person','department'],fields:{},rules:{sameSource:true,noSelf:true}},
 {id:'maintains',label:'维护',fromTypes:['person','organization','department'],toTypes:['service','asset'],fields:{},rules:{noSelf:true}},
];
const relationTypes=db=>[...builtinRelationTypes.map(t=>({...t,builtin:true})),...values(db,'graph_relation_types').map(t=>({...t,builtin:false}))];
function evidence(value,grant,{ending=false}={}){
 exact(value,['kind','id','reason']);if(!['event','snapshot','manual','observation'].includes(value.kind))fail('缺少变更证据');text(value.id,200);if(value.kind==='manual'){if(!grant.manual)fail('没有人工变更权限');text(value.reason,500);}
 if(ending&&value.kind==='observation')fail('普通观察不能作为断联依据');
}
function observed(old,next){if(old&&next.observedAt<old.observedAt)fail('拒绝过期同步');if(old&&next.observedAt===old.observedAt){if(isDeepStrictEqual({...next,revision:old.revision,updatedAt:old.updatedAt},old))return true;fail('同一同步时间的内容冲突');}return false;}
function putEdge(db,e){db.prepare('INSERT INTO graph_edges VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value').run(e.id,e.typeId,e.sourceId,e.source.externalId,e.fromId,e.toId,e.status,JSON.stringify(e));}
function relationConditions(db,type,edge,action){
 const scope={from:nodeById(db,edge.fromId),to:nodeById(db,edge.toId),relation:edge,source:edge.source};
 for(const condition of type.rules.conditions?.[action]??[]){const actual=condition.field.split('.').reduce((value,key)=>value&&Object.hasOwn(value,key)?value[key]:undefined,scope);const ok=condition.op==='present'?actual!==undefined&&actual!==null:condition.op==='equals'?isDeepStrictEqual(actual,condition.value):condition.value.some(value=>isDeepStrictEqual(value,actual));if(!ok)fail('关系业务条件不满足：'+condition.field);}
}
function checkGraph(db){
 const edges=values(db,'graph_edges').filter(e=>e.status==='active');
 for(const type of relationTypes(db)){
  const list=edges.filter(e=>e.typeId===type.id),rules=type.rules;
  for(const e of list){const from=nodeById(db,e.fromId),to=nodeById(db,e.toId);if(!from||!to||from.status!=='active'||to.status!=='active')fail('关系端点不可用');
   if(!type.fromTypes.includes(from.typeId)||!type.toTypes.includes(to.typeId))fail('关系端点类型不匹配');
   if(rules.noSelf&&from.id===to.id)fail('关系禁止自关联');if(rules.sameSource&&(from.sourceId!==to.sourceId||from.sourceId!==e.sourceId))fail('关系租户或来源范围不一致');
  }
  for(const [field,max] of [['fromId',rules.maxOutgoing],['toId',rules.maxIncoming]])if(max){const counts=new Map();for(const e of list){const k=e[field];counts.set(k,(counts.get(k)??0)+1);if(counts.get(k)>max)fail('关系数量约束冲突');}}
  if(rules.acyclic){const links=new Map();for(const e of list){if(!links.has(e.fromId))links.set(e.fromId,[]);links.get(e.fromId).push(e.toId);}const visiting=new Set(),done=new Set();function visit(id){if(visiting.has(id))fail('关系不能成环');if(done.has(id))return;visiting.add(id);for(const target of links.get(id)??[])visit(target);visiting.delete(id);done.add(id);}for(const id of links.keys())visit(id);}
 }
}
export function createGraphStore(root){
 const run=callback=>graphTransaction(root,callback);
 function forSource(grant){
  exact(grant,['kind','namespace','scope','actor','manual','types','relations','schema']);if(!['channel','program','ai','manual'].includes(grant.kind))fail('来源类别无效');key(grant.namespace);text(grant.scope,400);text(grant.actor,200);
  if(grant.kind!=='channel'&&/^(feishu|channel)([-_]|$)/.test(grant.namespace))fail('渠道来源不可冒充');
  // The producer holds this capability. No payload can replace its source or grants.
  grant=structuredClone(grant);for(const field of ['types','relations'])if(!Array.isArray(grant[field])||grant[field].length>100||grant[field].some(v=>typeof v!=='string'))fail('来源授权范围无效');
  const source={kind:grant.kind,namespace:grant.namespace,scope:grant.scope};
  const allowed=(type,edge=false)=>{if(!(edge?grant.relations:grant.types).includes(type))fail('类型不在来源授权范围');};
  let snapshotApplying=false;
  function apply(db,changes){
   if(!Array.isArray(changes)||changes.length<1||changes.length>1000)fail('批量变更数量无效');const sourceId=sourceRecord(db,source),results=[],checks=[];
   for(const change of changes){
    exact(change,['action','record','id','revision','observedAt','evidence']);if(change.evidence?.kind==='snapshot'&&!snapshotApplying)fail('快照证据只能由完整同步生成');evidence(change.evidence,grant,{ending:['end','delete'].includes(change.action)});
    if(change.action==='upsert'){
     const input=change.record;exact(input,['typeId','externalId','name','summary','attributes','observedAt','revision','validFrom','validTo']);allowed(input.typeId);const type=types(db).find(t=>t.id===input.typeId);if(!type)fail('先注册实体类型');
     const externalId=text(input.externalId,320),existing=parse(db.prepare('SELECT value FROM graph_nodes WHERE type_id=? AND source_id=? AND external_id=?').get(input.typeId,sourceId,externalId));
     if(existing?.legacyPersonId)fail('飞书人员专用字段请使用人员兼容接口');
     if(input.revision!==undefined&&input.revision!==existing?.revision)fail('实体资料已变化');
     const node={id:existing?.id??'entity:'+hash([input.typeId,source.kind,source.namespace,source.scope,externalId]),typeId:input.typeId,name:text(input.name),summary:input.summary===undefined?existing?.summary??'':text(input.summary,1000,true),attributes:{...existing?.attributes,...attributes(input.attributes??{},type)},sourceId,source:{...source,externalId},status:'active',observedAt:time(input.observedAt),updatedAt:now(),revision:revision(),...(input.validFrom?{validFrom:time(input.validFrom)}:{}),...(input.validTo?{validTo:time(input.validTo)}:{})};
     if(node.validFrom&&node.validTo&&node.validFrom>=node.validTo)fail('有效时间范围无效');const unchanged=observed(existing,node);if(!unchanged){if(!existing&&db.prepare('SELECT count(*) AS n FROM graph_nodes').get().n>=10000)fail('实体数量达到上限');putNode(db,node);audit(db,grant.actor,'upsert',node.id,existing,node,change.evidence);}results.push({entity:unchanged?existing:node,created:!existing,unchanged});
    }else if(change.action==='connect'){
     const input=change.record;exact(input,['typeId','externalId','fromId','toId','attributes','observedAt','revision','validFrom','validTo']);allowed(input.typeId,true);const type=relationTypes(db).find(t=>t.id===input.typeId);if(!type)fail('关系类型未注册');if(type.rules.connectEvidence&&!type.rules.connectEvidence.includes(change.evidence.kind))fail('关联证据不满足关系规则');const externalId=text(input.externalId,320),old=parse(db.prepare('SELECT value FROM graph_edges WHERE type_id=? AND source_id=? AND external_id=?').get(input.typeId,sourceId,externalId));
     if(old&&(old.fromId!==input.fromId||old.toId!==input.toId))fail('关系端点不可改写，请先结束旧关系');if(input.revision!==undefined&&input.revision!==old?.revision)fail('关系资料已变化');
     const edge={id:old?.id??'relation:'+hash([input.typeId,sourceId,externalId]),typeId:input.typeId,fromId:text(input.fromId,100),toId:text(input.toId,100),attributes:{...old?.attributes,...attributes(input.attributes??{},type)},sourceId,source:{...source,externalId},status:'active',observedAt:time(input.observedAt),updatedAt:now(),revision:revision(),...(input.validFrom?{validFrom:time(input.validFrom)}:{}),...(input.validTo?{validTo:time(input.validTo)}:{})};
     if(edge.validFrom&&edge.validTo&&edge.validFrom>=edge.validTo)fail('有效时间范围无效');checks.push({type,edge,action:'connect'});const unchanged=observed(old,edge);if(!unchanged){if(!old&&db.prepare('SELECT count(*) AS n FROM graph_edges').get().n>=50000)fail('关系数量达到上限');putEdge(db,edge);audit(db,grant.actor,'connect',edge.id,old,edge,change.evidence);}results.push({relation:unchanged?old:edge,created:!old,unchanged});
    }else if(change.action==='end'||change.action==='delete'){
     const edge=change.action==='end',old=edge?parse(db.prepare('SELECT value FROM graph_edges WHERE id=?').get(text(change.id,100))):nodeById(db,text(change.id,100));if(!old||old.sourceId!==sourceId)fail('记录不属于当前来源');allowed(old.typeId,edge);if(edge){const type=relationTypes(db).find(t=>t.id===old.typeId);checks.push({type,edge:old,action:'end'});const rules=type.rules;if(rules.endEvidence&&!rules.endEvidence.includes(change.evidence.kind))fail('断联证据不满足关系规则');}if(!change.revision||old.revision!==change.revision)fail('资料已变化');if(!edge&&old.legacyPersonId)fail('飞书人员请使用人员管理删除');const at=time(change.observedAt);if(at<=old.observedAt)fail('拒绝过期或同时间撤销');
     const next={...old,status:edge?'ended':'deleted',observedAt:at,updatedAt:now(),revision:revision(),...(edge?{validTo:at}:{})};if(edge)putEdge(db,next);else putNode(db,next);audit(db,grant.actor,change.action,old.id,old,next,change.evidence);results.push(next);
    }else fail('变更动作无效');
   }
   for(const check of checks)relationConditions(db,check.type,check.edge,check.action);checkGraph(db);return results;
  }
  function batch(input,dryRun=false){exact(input,['requestId','changes']);const id='operation:'+hash([source,input.requestId]);text(input.requestId,200);return graphTransaction(root,db=>{
   const body=JSON.stringify(input),prior=db.prepare('SELECT request,result FROM graph_operations WHERE id=?').get(id);if(prior){if(prior.request!==body)fail('幂等请求内容冲突');return JSON.parse(prior.result);}
   const result={results:apply(db,input.changes)};if(!dryRun)db.prepare('INSERT INTO graph_operations VALUES(?,?,?)').run(id,body,JSON.stringify(result));return result;
  },{dryRun});}
  return {
   applyRelationChanges:input=>batch(input),validateRelationChange:input=>{try{return {allowed:true,...batch(input,true)};}catch(e){return {allowed:false,reason:e.message};}},
   upsert:input=>batch({requestId:revision(),changes:[{action:'upsert',record:input,evidence:{kind:'observation',id:'upsert'}}]}).results[0],
   connect:(input,proof)=>batch({requestId:revision(),changes:[{action:'connect',record:input,evidence:proof}]}).results[0],
   end:input=>batch({requestId:revision(),changes:[{action:'end',...input}]}).results[0],
   remove:input=>batch({requestId:revision(),changes:[{action:'delete',...input}]}).results[0],
   syncSnapshot(input){
    exact(input,['requestId','observedAt','complete','relationTypes','changes']);if(input.complete!==true)fail('完整同步未完成，禁止清理');const at=time(input.observedAt);if(!Array.isArray(input.relationTypes)||!input.relationTypes.length)fail('缺少同步覆盖范围');input.relationTypes.forEach(t=>allowed(t,true));
    if(!Array.isArray(input.changes)||input.changes.some(c=>!['upsert','connect'].includes(c.action)||c.record.observedAt!==at||c.action==='connect'&&!input.relationTypes.includes(c.record.typeId)))fail('快照内容或采集时间不一致');
    return run(db=>{const sourceId=sourceRecord(db,source),id='snapshot:'+hash([source,input.requestId]),body=JSON.stringify(input),previous=db.prepare('SELECT value FROM graph_snapshots WHERE id=?').get(id);if(previous){const p=JSON.parse(previous.value);if(p.request!==body)fail('快照幂等冲突');return p.result;}
     // Serialize overlapping snapshots and reject older input; snapshots cover whole relation types of this source.
     for(const row of db.prepare('SELECT value FROM graph_snapshots WHERE source_id=?').all(sourceId)){const old=JSON.parse(row.value);if(old.types.some(t=>input.relationTypes.includes(t))&&old.at>=at)fail('快照版本过期');}
     const changes=input.changes.map(c=>({...c,evidence:{kind:'snapshot',id:input.requestId}}));const keep=new Set(changes.filter(c=>c.action==='connect').map(c=>JSON.stringify([c.record.typeId,c.record.externalId])));
     for(const old of values(db,'graph_edges'))if(old.status==='active'&&old.sourceId===sourceId&&input.relationTypes.includes(old.typeId)&&!keep.has(JSON.stringify([old.typeId,old.source.externalId])))changes.unshift({action:'end',id:old.id,revision:old.revision,observedAt:at,evidence:{kind:'snapshot',id:input.requestId}});
     let result;snapshotApplying=true;try{result={results:changes.length?apply(db,changes):[]};}finally{snapshotApplying=false;}db.prepare('INSERT INTO graph_snapshots VALUES(?,?,?,?)').run(id,sourceId,at,JSON.stringify({request:body,at,types:input.relationTypes,result}));return result;
    });
   },
  };
 }
 const store={
  version:2,forSource,sources:()=>run(db=>({sources:values(db,'graph_sources')})),
  types:()=>run(db=>{const all=values(db,'graph_nodes').filter(e=>e.status==='active');return {sources:[...new Set(all.map(e=>e.source.namespace))].sort().map(namespace=>({namespace,count:all.filter(e=>e.source.namespace===namespace).length})),types:types(db).map(t=>({...t,count:all.filter(e=>e.typeId===t.id).length})),total:all.length};}),
  list(input={}){exact(input,['typeId','query','source','offset','limit']);const q=text(input.query??'',200,true).toLocaleLowerCase();return run(db=>{if(input.typeId&&!types(db).some(t=>t.id===input.typeId))fail('实体类型未注册');return page(input,values(db,'graph_nodes').filter(e=>e.status==='active'&&(!input.typeId||e.typeId===input.typeId)&&(!input.source||e.source.namespace===input.source)&&JSON.stringify(e).toLocaleLowerCase().includes(q)).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)),'entities');});},
  get:id=>run(db=>({entity:nodeById(db,text(id,100))})),
  registerType(input){const type=definition(input);if(builtinEntityTypes.some(t=>t.id===type.id))fail('内置实体类型不可覆盖');return run(db=>{const old=parse(db.prepare('SELECT value FROM entity_types WHERE id=?').get(type.id));if(old&&Object.entries(old.fields).some(([k,v])=>type.fields[k]?.type!==v.type))fail('已有字段不可删除或改写类型');if(!old&&values(db,'entity_types').length>=100)fail('类型达到上限');db.prepare('INSERT OR REPLACE INTO entity_types VALUES(?,?)').run(type.id,JSON.stringify(type));return {...type,builtin:false};});},
  upsert(input){exact(input,['typeId','name','summary','attributes','source','observedAt','revision']);exact(input.source,['kind','namespace','externalId']);if(!['ai','program'].includes(input.source.kind))fail('同步来源无效；渠道身份只能由渠道插件采集');const {source,...record}=input;return forSource({kind:source.kind,namespace:source.namespace,scope:'default',actor:'legacy-'+source.kind,types:[input.typeId],relations:[]}).upsert({...record,externalId:source.externalId});},
  relationTypes:()=>run(db=>({types:relationTypes(db)})),
  registerRelationType(input){exact(input,['id','label','description','fields','fromTypes','toTypes','rules']);const type={...definition({id:input.id,label:input.label,description:input.description,fields:input.fields}),fromTypes:input.fromTypes,toTypes:input.toTypes,rules:input.rules};exact(type.rules,['sameSource','noSelf','acyclic','maxOutgoing','maxIncoming','connectEvidence','endEvidence','conditions']);if(type.rules.conditions!==undefined){exact(type.rules.conditions,['connect','end']);for(const conditions of Object.values(type.rules.conditions)){if(!Array.isArray(conditions)||conditions.length>16)fail('关系条件数量无效');for(const condition of conditions){exact(condition,['field','op','value']);if(!/^(?:(?:from|to)\.(?:typeId|status|attributes\.[a-z][a-z0-9_-]{0,63})|relation\.attributes\.[a-z][a-z0-9_-]{0,63}|source\.(?:kind|namespace|scope))$/.test(condition.field)||!['present','equals','in'].includes(condition.op))fail('关系条件格式无效');const scalar=v=>v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v);if(condition.op==='in'?(!Array.isArray(condition.value)||condition.value.length>50||!condition.value.every(scalar)):condition.op==='equals'&&!scalar(condition.value))fail('关系条件值无效');}}}for(const field of ['connectEvidence','endEvidence'])if(type.rules[field]!==undefined&&(!Array.isArray(type.rules[field])||!type.rules[field].length||type.rules[field].some(k=>!['event','snapshot','manual','observation'].includes(k))||field==='endEvidence'&&type.rules[field].includes('observation')))fail('关系证据规则无效');for(const f of ['sameSource','noSelf','acyclic'])if(type.rules[f]!==undefined&&typeof type.rules[f]!=='boolean')fail('关系规则无效');for(const f of ['maxOutgoing','maxIncoming'])if(type.rules[f]!==undefined&&(!Number.isSafeInteger(type.rules[f])||type.rules[f]<1))fail('关系数量无效');return run(db=>{for(const side of [type.fromTypes,type.toTypes])if(!Array.isArray(side)||!side.length||side.some(t=>!types(db).some(et=>et.id===t)))fail('端点类型无效');if(relationTypes(db).some(t=>t.id===type.id))fail('关系类型已注册，变更规则须新版本');db.prepare('INSERT INTO graph_relation_types VALUES(?,?)').run(key(type.id),JSON.stringify(type));return type;});},
  relations(input={}){exact(input,['id','fromId','toId','typeId','sourceId','status','offset','limit']);return run(db=>page(input,values(db,'graph_edges').filter(e=>['id','fromId','toId','typeId','sourceId','status'].every(k=>input[k]===undefined||e[k]===input[k])).sort((a,b)=>a.id.localeCompare(b.id)),'relations'));},
  traverse(input){exact(input,['id','depth','limit','direction','typeIds']);const {id,depth=1,limit=100,direction='both',typeIds=[]}=input;if(!Number.isSafeInteger(depth)||depth<1||depth>5||!Number.isSafeInteger(limit)||limit<1||limit>500||!['both','in','out'].includes(direction)||!Array.isArray(typeIds))fail('遍历范围无效');return run(db=>{if(!nodeById(db,id))fail('实体不存在');let frontier=[id];const visited=new Set(frontier),found=new Map(),edges=values(db,'graph_edges').filter(e=>e.status==='active'&&(!typeIds.length||typeIds.includes(e.typeId)));let truncated=false;for(let d=0;d<depth&&frontier.length;d++){const next=[];for(const edge of edges){if(!(direction!=='in'&&frontier.includes(edge.fromId)||direction!=='out'&&frontier.includes(edge.toId)))continue;if(found.size>=limit){truncated=true;break;}found.set(edge.id,edge);for(const target of [edge.fromId,edge.toId])if(!visited.has(target)){visited.add(target);next.push(target);}}frontier=next;}return {entities:[...visited].map(v=>nodeById(db,v)),relations:[...found.values()],relationTypes:relationTypes(db),truncated};});},
  history(input={}){exact(input,['id','offset','limit']);return run(db=>page(input,db.prepare('SELECT * FROM graph_audit ORDER BY at DESC,rowid DESC').all().filter(e=>!input.id||e.target_id===input.id).map(e=>({...e,before:JSON.parse(e.before_json),after:JSON.parse(e.after_json),evidence:JSON.parse(e.evidence),before_json:undefined,after_json:undefined})),'history'));},
 };
 return store;
}
