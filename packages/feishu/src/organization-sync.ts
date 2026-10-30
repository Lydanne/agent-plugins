import {randomUUID} from 'node:crypto';
import {resolveAgentRoute} from 'openclaw/plugin-sdk/routing';
import {getGraphService,registerEntitySyncProvider,type EntitySyncContext,type EntitySyncProvider,type DirectorySyncRun} from '../../agent-repo-api/entities.mjs';
import type {OpenClawConfig,OpenClawPluginApi} from '../runtime-api.js';
import {listEnabledFeishuAccounts,resolveFeishuRuntimeAccount} from './accounts.js';
import {directoryProducer,synchronizeOrganization} from './organization-directory.js';
export function createOrganizationSync(getConfig:()=>OpenClawConfig,route=(cfg:OpenClawConfig,accountId:string)=>resolveAgentRoute({cfg,channel:'feishu',accountId}).agentId):EntitySyncProvider{
 const jobs=new Map<string,{result:DirectorySyncRun;done:Promise<void>}>();let stopped=false;
 function accounts(input:EntitySyncContext){
  if(!getGraphService(input))throw Error('当前 Agent 的实体服务不可用');
  const cfg=getConfig();return listEnabledFeishuAccounts(cfg).filter(a=>a.configured&&(!input.accountId||a.accountId===input.accountId)&&(route(cfg,a.accountId)===input.agentId||(cfg.bindings??[]).some(b=>b.agentId===input.agentId&&b.match.channel==='feishu'&&(!b.match.accountId||b.match.accountId==='*'||b.match.accountId===a.accountId))));
 }
 function info(input:EntitySyncContext){
  try{const list=accounts(input),selected=list.length===1?list[0]:null,producer=selected?directoryProducer(input.agentId,selected):undefined,live=selected?jobs.get(JSON.stringify([input.agentId,selected.accountId,selected.appId])):undefined;let run=live?.result??producer?.syncStatus()??null;
   if(selected&&!producer)return {available:false,accounts:list.map(a=>({accountId:a.accountId,appId:a.appId})),run:null,reason:'AgentRepo 版本不支持全量组织同步'};if(run?.status==='running'&&!live)run={...run,status:'unknown',errors:[...run.errors,{stage:'runtime',reason:'previous_sync_requires_review'}]};return {available:list.length>0,accounts:list.map(a=>({accountId:a.accountId,appId:a.appId})),run,...(list.length?{}:{reason:'当前 Agent 未绑定可用飞书账号'})};
  }catch{return {available:false,accounts:[],run:null,reason:'实体服务或账号绑定不可用'};}
 }
 return {
  info,
  start(input,requestId){
   if(stopped)throw Error('组织同步服务已停止');if(typeof requestId!=='string'||!requestId||requestId.length>120)throw Error('同步请求 ID 无效');
   const list=accounts(input);if(list.length!==1)throw Error(list.length?'请选择飞书账号':'当前 Agent 没有可用飞书账号');const account=resolveFeishuRuntimeAccount({cfg:getConfig(),accountId:list[0].accountId});
   const key=JSON.stringify([input.agentId,account.accountId,account.appId]),producer=directoryProducer(input.agentId,account);if(!producer)throw Error('AgentRepo 版本不支持全量组织同步');const existing=producer.syncStatus({requestId});if(existing)return existing.status==='running'&&!jobs.has(key)?{...existing,status:'unknown'}:existing;
   const current=jobs.get(key);if(current?.result.status==='running')return structuredClone(current.result);if([...jobs.values()].filter(j=>j.result.status==='running').length>=4)throw Error('组织同步任务较多，请稍后重试');
   const initial:DirectorySyncRun={requestId,status:'running',startedAt:new Date().toISOString(),departments:0,storedDepartments:0,organizationId:null,relations:0,coverage:'none',errors:[]};producer.recordSync(initial);const job={result:initial,done:Promise.resolve()};jobs.set(key,job);
   job.done=Promise.resolve().then(async()=>{try{job.result=await synchronizeOrganization({agentId:input.agentId,account,requestId,startedAt:initial.startedAt,check:()=>{if(!accounts(input).some(a=>a.accountId===account.accountId&&a.appId===account.appId))throw Error('account_binding_changed');},progress:run=>{job.result=structuredClone(run);}});}catch{job.result={...job.result,status:'failed',finishedAt:new Date().toISOString(),errors:[{stage:'runtime',reason:'directory_service_unavailable'}]};try{producer.recordSync(job.result);}catch{ /* Keep the original durable receipt if generation changed. */ }}});
   return structuredClone(initial);
  },
  async stop(){stopped=true;await Promise.allSettled([...jobs.values()].map(j=>j.done));},
 };
}
export function registerOrganizationSync(api:OpenClawPluginApi){
 const owner=Symbol.for('openclaw-plugins.feishu-organization-sync');let service=createOrganizationSync(()=>api.config),dispose=registerEntitySyncProvider('feishu',service,owner);
 api.registerService({id:'feishu-organization-sync',start:()=>{dispose();service=createOrganizationSync(()=>api.config);dispose=registerEntitySyncProvider('feishu',service,owner);
  // Initial catalog collection is independent of whether a department has spoken to the bot.
  for(const account of listEnabledFeishuAccounts(api.config)){
   const targets=new Set([resolveAgentRoute({cfg:api.config,channel:'feishu',accountId:account.accountId}).agentId,...(api.config.bindings??[]).filter(b=>b.match.channel==='feishu'&&(!b.match.accountId||b.match.accountId==='*'||b.match.accountId===account.accountId)).map(b=>b.agentId)]);
   for(const agentId of targets){const context={agentId,sessionKey:'agent:'+agentId+':agent-repo-entities',accountId:account.accountId};if(getGraphService(context)&&service.info(context).available&&service.info(context).run===null)try{service.start(context,'bootstrap:organization-v1:'+randomUUID());}catch{api.logger?.warn?.('feishu: initial organization sync unavailable');}}
  }
 },stop:async()=>{dispose();await service.stop();}});
}
