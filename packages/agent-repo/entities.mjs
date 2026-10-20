import {trustedAgentId} from './dist/agent-repo-api.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,realpathSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createPeopleStore} from './people.mjs';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=message=>{throw Error(message);};
const text=(value,max=200,empty=false)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f]/.test(value)&&(empty||value.trim())?value.trim():fail('实体资料字段格式无效');
const key=value=>{const normalized=text(value,64);return /^[a-z][a-z0-9_-]{0,63}$/.test(normalized)?normalized:fail('实体类型或来源标识无效');};
const exact=(input,keys)=>{if(!object(input)||Object.keys(input).some(k=>!keys.includes(k)))fail('实体资料参数无效');};
const field=(label,type='string')=>({label,type});
export const builtinEntityTypes=[
 {id:'person',label:'人员资源',description:'联系人、身份资料与账号关联',fields:{email:field('邮箱'),department:field('部门'),role:field('职位')}},
 {id:'organization',label:'组织机构',description:'公司、部门、团队及合作单位',fields:{website:field('网站'),contact:field('联系方式')}},
 {id:'service',label:'系统服务',description:'应用、接口与运行服务的资料',fields:{url:field('服务地址'),owner:field('负责人'),environment:field('环境')}},
 {id:'asset',label:'资产资源',description:'设备、资源与其他可管理资产',fields:{serialNumber:field('资产编号'),location:field('位置'),owner:field('负责人')}},
];
function definition(input){
 exact(input,['id','label','description','fields']);const result={id:key(input.id),label:text(input.label,80),description:text(input.description??'',500,true),fields:{}};
 if(!object(input.fields)||Object.keys(input.fields).length>32)fail('实体字段定义无效');
 for(const [name,spec] of Object.entries(input.fields)){key(name);if(['__proto__','constructor','prototype'].includes(name))fail('实体字段名称无效');exact(spec,['label','type']);if(!['string','number','boolean','strings'].includes(spec.type))fail('实体字段类型无效');result.fields[name]={label:text(spec.label,80),type:spec.type};}
 return result;
}
function attributes(input,type){
 if(!object(input)||Object.keys(input).length>32)fail('实体属性无效');const result={};
 for(const [name,value] of Object.entries(input)){
  if(!Object.hasOwn(type.fields,name))fail('未注册的实体属性：'+name);
  const kind=type.fields[name].type;
  if(value===null)result[name]=null;
  else if(kind==='string')result[name]=text(value,2000,true);
  else if(kind==='number'&&typeof value==='number'&&Number.isFinite(value))result[name]=value;
  else if(kind==='boolean'&&typeof value==='boolean')result[name]=value;
  else if(kind==='strings'&&Array.isArray(value)&&value.length<=50)result[name]=value.map(v=>text(v,200));
  else fail('实体属性类型不匹配：'+name);
 }
 return result;
}
function database(root){
 let directory=realpathSync(root);
 for(const part of ['.runtime','entities']){directory=join(directory,part);mkdirSync(directory,{recursive:true,mode:0o700});const stat=lstatSync(directory);if(stat.isSymbolicLink()||!stat.isDirectory())fail('实体存储目录无效');chmodSync(directory,0o700);}
 const file=join(directory,'entities.sqlite');try{const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())fail('实体存储文件无效');}catch(error){if(error.code!=='ENOENT')throw error;}
 const db=new DatabaseSync(file);try{chmodSync(file,0o600);db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS entity_types (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, value TEXT NOT NULL)');return db;}catch(error){db.close();throw error;}
}
function personEntity(person){
 return {id:'person:'+person.id,typeId:'person',name:person.name||'姓名未知',summary:person.departments.map(d=>d.name||d.id).join('、'),attributes:{email:person.email,department:person.departments.map(d=>d.name||d.id).join('、'),giteaUsername:person.giteaUsername,giteaSource:person.giteaSource},source:{kind:'channel',namespace:'feishu',externalId:JSON.stringify([person.accountId,person.appId,person.openId])},observedAt:person.observedAt,updatedAt:person.updatedAt,revision:person.revision,legacyPersonId:person.id};
}
const compare=(a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id);
export function createEntityStore(root){
 function read(callback,write=false){const db=database(root);try{if(write)db.exec('BEGIN IMMEDIATE');const result=callback(db);if(write)db.exec('COMMIT');return result;}finally{db.close();}}
 const types=db=>[...builtinEntityTypes.map(type=>({...type,builtin:true})),...db.prepare('SELECT value FROM entity_types ORDER BY id').all().map(row=>({...JSON.parse(row.value),builtin:false}))];
 const records=db=>[...createPeopleStore(root).all().map(personEntity),...db.prepare('SELECT value FROM entities ORDER BY id').all().map(row=>JSON.parse(row.value))];
 return {
  types(){return read(db=>{const all=records(db),sources=[...new Set(all.map(record=>record.source.namespace))].sort().map(namespace=>({namespace,count:all.filter(record=>record.source.namespace===namespace).length}));return {sources,types:types(db).map(type=>({...type,count:all.filter(record=>record.typeId===type.id).length})),total:all.length};});},
  list(input={}){
   exact(input,['typeId','query','source','offset','limit']);const {offset=0,limit=20}=input;
   if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('实体分页参数无效');
   if(input.typeId!==undefined)key(input.typeId);if(input.source!==undefined)key(input.source);const query=text(input.query??'',200,true).toLocaleLowerCase();
   return read(db=>{if(input.typeId&&!types(db).some(type=>type.id===input.typeId))fail('实体类型未注册');const all=records(db).filter(record=>(!input.typeId||record.typeId===input.typeId)&&(!input.source||record.source.namespace===input.source)&&(!query||[record.name,record.summary,record.source.namespace,record.source.externalId,...Object.values(record.attributes).flat()].join(' ').toLocaleLowerCase().includes(query))).sort(compare);return {entities:all.slice(offset,offset+limit),total:all.length,offset,limit,nextOffset:offset+limit<all.length?offset+limit:null};});
  },
  get(id){id=text(id,100);return read(db=>({entity:records(db).find(record=>record.id===id)??null}));},
  registerType(input){const type=definition(input);if(builtinEntityTypes.some(t=>t.id===type.id))fail('内置实体类型不可覆盖');return read(db=>{
   const row=db.prepare('SELECT value FROM entity_types WHERE id=?').get(type.id),old=row?JSON.parse(row.value):null;
   if(!old&&db.prepare('SELECT count(*) AS n FROM entity_types').get().n>=100)fail('自定义实体类型达到上限');
   if(old&&Object.entries(old.fields).some(([name,spec])=>!Object.hasOwn(type.fields,name)||type.fields[name].type!==spec.type))fail('已有实体类型的字段不可删除或改写类型，请注册新类型');
   db.prepare('INSERT OR REPLACE INTO entity_types VALUES (?,?)').run(type.id,JSON.stringify(type));return {...type,builtin:false};
  },true);},
  upsert(input){
   exact(input,['typeId','name','summary','attributes','source','observedAt','revision']);exact(input.source,['kind','namespace','externalId']);
   const typeId=key(input.typeId),source={kind:input.source.kind,namespace:key(input.source.namespace),externalId:text(input.source.externalId,320)};
   if(!['ai','program'].includes(source.kind)||/^(?:feishu|channel)(?:[-_]|$)/.test(source.namespace))fail('同步来源无效；渠道身份只能由渠道插件采集');
   const name=text(input.name),summary=input.summary===undefined?undefined:text(input.summary,1000,true),observedAt=text(input.observedAt,40);
   if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observedAt)||!Number.isFinite(Date.parse(observedAt))||new Date(observedAt).toISOString()!==observedAt||Date.parse(observedAt)>Date.now()+300000)fail('同步时间无效');
   if(input.revision!==undefined)text(input.revision,100);
   const id='entity:'+createHash('sha256').update(JSON.stringify([typeId,source.kind,source.namespace,source.externalId])).digest('hex');
   return read(db=>{
    const type=types(db).find(t=>t.id===typeId);if(!type)fail('先注册实体类型');const data=attributes(input.attributes??{},type),row=db.prepare('SELECT value FROM entities WHERE id=?').get(id),old=row?JSON.parse(row.value):null;
    if(!old&&db.prepare('SELECT count(*) AS n FROM entities').get().n>=10000)fail('实体记录达到上限');
    if(input.revision!==undefined&&input.revision!==old?.revision)fail('实体资料已变化，请刷新后重试');
    if(old&&observedAt<old.observedAt)fail('拒绝过期同步');
    const next={id,typeId,name,summary:summary??old?.summary??'',attributes:{...old?.attributes,...data},source,observedAt};
    if(old&&observedAt===old.observedAt){if(JSON.stringify({...next,updatedAt:old.updatedAt,revision:old.revision})===JSON.stringify(old))return {entity:old,created:false,unchanged:true};fail('同一同步时间的内容冲突');}
    const entity={...next,updatedAt:new Date().toISOString(),revision:randomUUID()};db.prepare('INSERT OR REPLACE INTO entities VALUES (?,?)').run(id,JSON.stringify(entity));return {entity,created:!old,unchanged:false};
   },true);
  },
 };
}
export const entityReadActions=['entity_types','entities','entity'];
export const entityParameters={typeId:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,63}$'},source:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,63}$'}};
export function queryEntities(root,params){
 const {action,...input}=params,store=createEntityStore(root);
 if(action==='entity_types'){exact(input,[]);return store.types();}
 if(action==='entity'){exact(input,['id']);return store.get(input.id);}
 if(action==='entities')return store.list(input);
 fail('实体查询动作无效');
}
export function entitySyncTool(context,binding){
 return {name:'agent_entity_sync',label:'同步实体资料',description:'仅在本轮用户或已授权同步任务要求时写入当前 Agent 的实体资料库。register_type 注册自定义类型及字段；upsert 按类型、AI 来源命名空间与外部 ID 幂等同步。来源固定为 ai，不证明资料真实、身份已核验或取得业务操作授权；不得存凭证、聊天正文或猜测身份。先用 agent_repo entity_types 查询类型；未知字段不能写入。observedAt 为真实资料采集时间的 UTC ISO 毫秒格式。缺省属性保留，null 清空。写入不会执行任务、改变权限或发送消息。',parameters:{type:'object',properties:{action:{type:'string',enum:['register_type','upsert']},definition:{type:'object',properties:{id:{type:'string'},label:{type:'string'},description:{type:'string'},fields:{type:'object',additionalProperties:{type:'object',properties:{label:{type:'string'},type:{type:'string',enum:['string','number','boolean','strings']}},required:['label','type'],additionalProperties:false}}},required:['id','label','fields'],additionalProperties:false},typeId:entityParameters.typeId,name:{type:'string',maxLength:200},summary:{type:'string',maxLength:1000},attributes:{type:'object',additionalProperties:{anyOf:[{type:'string'},{type:'number'},{type:'boolean'},{type:'array',items:{type:'string'}},{type:'null'}]}},namespace:{type:'string'},externalId:{type:'string'},observedAt:{type:'string'},revision:{type:'string'}},required:['action'],additionalProperties:false},async execute(_id,params){
  trustedAgentId(context);const store=createEntityStore(binding.repo);let result;
  if(params?.action==='register_type'){exact(params,['action','definition']);result=store.registerType(params.definition);}
  else if(params?.action==='upsert'){exact(params,['action','typeId','name','summary','attributes','namespace','externalId','observedAt','revision']);const {action,namespace,externalId,...input}=params;result=store.upsert({...input,source:{kind:'ai',namespace,externalId}});}
  else fail('实体同步动作无效');
  return {content:[{type:'text',text:JSON.stringify({agentId:context.agentId,...result})}]};
 }};
}
