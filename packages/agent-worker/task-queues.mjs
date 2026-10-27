import {hermesVariablesSchema,validateHermesVariables} from './hermes-templates.mjs';
export const queueIdPattern='^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
export const defaultTaskQueues={
 short:{hermesTemplateId:'codex',hermesVariables:{},name:'短任务',description:'常规查询及短时间执行',timeoutMs:1800000,maxConcurrentJobs:3,maxQueuedJobs:100},
 long:{hermesTemplateId:'codex',hermesVariables:{},name:'长任务',description:'需要较长时间的分析、构建或处理',timeoutMs:10800000,maxConcurrentJobs:1,maxQueuedJobs:100},
};
export const taskQueuesSchema={type:'object',propertyNames:{type:'string',pattern:queueIdPattern},additionalProperties:{type:'object',required:['name','timeoutMs','maxConcurrentJobs','maxQueuedJobs'],additionalProperties:false,default:{name:'新队列',timeoutMs:1800000,maxConcurrentJobs:1,maxQueuedJobs:100},properties:{hermesTemplateId:{type:'string',pattern:queueIdPattern},hermesVariables:hermesVariablesSchema,name:{type:'string',pattern:'\\S',maxLength:160},description:{type:'string',maxLength:2000},timeoutMs:{type:'integer',minimum:1000,maximum:86400000},maxConcurrentJobs:{type:'integer',minimum:1,maximum:10},maxQueuedJobs:{type:'integer',minimum:1,maximum:1000}}}};
export function resolveTaskQueues(config={}){
 const queues=config.taskQueues===undefined?{
  short:{...defaultTaskQueues.short,timeoutMs:config.timeoutMs??1800000,maxConcurrentJobs:config.maxConcurrentJobs??3,maxQueuedJobs:config.maxQueuedJobs??100},
  long:{...defaultTaskQueues.long,timeoutMs:config.longTimeoutMs??10800000,maxConcurrentJobs:config.maxConcurrentLongJobs??1,maxQueuedJobs:config.maxQueuedLongJobs??100},
 }:config.taskQueues;
 if(!queues||typeof queues!=='object'||Array.isArray(queues)||Object.keys(queues).length<1||Object.keys(queues).length>50)throw Error('Invalid taskQueues');
 for(const [id,q] of Object.entries(queues)){
  if(!new RegExp(queueIdPattern).test(id)||!q||typeof q!=='object'||Array.isArray(q)||typeof q.name!=='string'||!q.name.trim()||q.name.length>160||q.description!==undefined&&(typeof q.description!=='string'||q.description.length>2000)||Object.keys(q).some(k=>!['name','description','timeoutMs','maxConcurrentJobs','maxQueuedJobs','hermesTemplateId','hermesVariables'].includes(k)))throw Error('Invalid task queue: '+id);
  if(q.hermesTemplateId!==undefined&&(typeof q.hermesTemplateId!=='string'||!new RegExp(queueIdPattern).test(q.hermesTemplateId)))throw Error('Invalid Hermes template ID');
  validateHermesVariables(q.hermesVariables??{});
  for(const [key,max] of [['timeoutMs',86400000],['maxConcurrentJobs',10],['maxQueuedJobs',1000]])if(!Number.isInteger(q[key])||q[key]<(key==='timeoutMs'?1000:1)||q[key]>max)throw Error('Invalid task queue '+id+'.'+key);
 }
 const defaultQueueId=config.defaultQueueId===undefined?'short':config.defaultQueueId;
 if(typeof defaultQueueId!=='string'||!Object.hasOwn(queues,defaultQueueId))throw Error('defaultQueueId must name a configured queue');
 return {taskQueues:structuredClone(queues),defaultQueueId};
}
export function requestedQueueId(params){
 if(params.taskClass!==undefined&&!['short','long'].includes(params.taskClass))throw Error('Invalid taskClass');
 if(params.queueId!==undefined&&(typeof params.queueId!=='string'||!new RegExp(queueIdPattern).test(params.queueId)))throw Error('Invalid queueId');
 if(params.queueId!==undefined&&params.taskClass!==undefined&&params.queueId!==params.taskClass)throw Error('queueId conflicts with taskClass');
 return params.queueId??params.taskClass;
}
export function queueFields(id){return {queueId:id,...(['short','long'].includes(id)?{taskClass:id}:{})};}
