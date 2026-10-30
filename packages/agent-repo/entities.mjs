import {trustedAgentId} from './dist/agent-repo-api.mjs';
import {createGraphStore} from './graph.mjs';
import {exact,fail} from './graph-schema.mjs';
export {builtinEntityTypes} from './graph-schema.mjs';
export const createEntityStore=createGraphStore;
export const entityReadActions=['entity_types','entities','entity','relation_types','relations','graph','entity_history'];
export const entityParameters={typeId:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,63}$'},source:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,63}$'},fromId:{type:'string'},toId:{type:'string'},sourceId:{type:'string'},status:{type:'string',enum:['active','ended']},depth:{type:'integer',minimum:1,maximum:5},direction:{type:'string',enum:['both','in','out']},typeIds:{type:'array',items:{type:'string'}}};
export function queryEntities(root,params){
 const {action,...input}=params,store=createEntityStore(root);
 if(action==='relation_types'){exact(input,[]);return store.relationTypes();}
 if(action==='relations')return store.relations(input);
 if(action==='graph')return store.traverse(input);
 if(action==='entity_history')return store.history(input);
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
