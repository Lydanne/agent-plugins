import {syncFeishuDirectory} from './entity-directory.js';
import {randomUUID} from 'node:crypto';
import {getPeopleService,getPeopleGroupSync,registerPeopleGroupSync,type PeopleGroupContext,type PeopleGroupSyncRun,type PeopleJoinEvent,type PeopleLookupResult,type PeopleGroupSyncService} from '../../agent-repo-api/people.mjs';
import type {OpenClawPluginApi,OpenClawConfig} from '../runtime-api.js';
import {listEnabledFeishuAccounts} from './accounts.js';
import {createFeishuClient} from './client.js';
import {resolveAgentRoute} from 'openclaw/plugin-sdk/routing';
import {isFeishuGroupReadAllowed} from './read-policy.js';
import {resolvePeopleFromFeishu} from './people-resolver.js';
import {raceWithTimeoutAndAbort} from './async.js';
const groupId=(sessionKey:string)=>/^agent:[^:]+:feishu:group:(oc_[a-zA-Z0-9]+)(?::(?:topic|sender):[^:]+)*$/.exec(sessionKey)?.[1];
const openId=(value:unknown):value is string=>typeof value==='string'&&/^ou_[a-zA-Z0-9]+$/.test(value);
export function createPeopleGroupSync(getConfig:()=>OpenClawConfig,route=(cfg:OpenClawConfig,accountId:string,chatId:string)=>resolveAgentRoute({cfg,channel:'feishu',accountId,peer:{kind:'group',id:chatId}}).agentId):PeopleGroupSyncService{
 const runs=new Map<string,Job>(),events=new Map<string,number>();let stopped=false;
 type Job={result:PeopleGroupSyncRun;pending:Map<string,string|undefined>;seen:Set<string>;full:boolean;controller:AbortController;done:Promise<void>};
 const copy=(job:Job)=>structuredClone(job.result);
 function scope(input:PeopleGroupContext){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.agentId)||!input.sessionKey.startsWith('agent:'+input.agentId+':'))throw Error('人员同步 Agent 范围无效');
  const chatId=groupId(input.sessionKey);if(!chatId)throw Error('请先切换到飞书群聊');
  const cfg=getConfig(),accounts=listEnabledFeishuAccounts(cfg).filter(account=>account.configured&&(!input.accountId||account.accountId===input.accountId)&&isFeishuGroupReadAllowed(cfg,account,chatId,false)&&route(cfg,account.accountId,chatId)===input.agentId);
  if(!getPeopleService(input.agentId))throw Error('当前 Agent 人员资料不可用');
  return {cfg,chatId,accounts};
 }
 const key=(agentId:string,accountId:string,chatId:string)=>JSON.stringify([agentId,accountId,chatId]);
 const error=(job:Job,reason:string,details:Partial<PeopleGroupSyncRun['errors'][number]>={})=>{if(job.result.errors.length<10)job.result.errors.push({...details,reason});};
 async function run(job:Job,cfg:OpenClawConfig,account:ReturnType<typeof listEnabledFeishuAccounts>[number]){
  const result=job.result,store=getPeopleService(result.agentId)!;const deadline=Date.now()+600000;
  const check=()=>{const currentCfg=getConfig(),current=listEnabledFeishuAccounts(currentCfg).find(a=>a.accountId===account.accountId);if(stopped||job.controller.signal.aborted||Date.now()>deadline||getPeopleService(result.agentId)!==store||!current||current.appId!==account.appId||!isFeishuGroupReadAllowed(currentCfg,current,result.chatId,false)||route(getConfig(),account.accountId,result.chatId)!==result.agentId)throw Error('sync_interrupted');};
  const add=(id:string,name?:string)=>{if(!job.seen.has(id)){job.seen.add(id);job.pending.set(id,name);result.discovered++;}};
  try{
   // A new join can be merged into a running full sync, avoiding dropped join events.
   while(job.full||job.pending.size){
    check();
    if(job.full){
     job.full=false;let token:string|undefined;const tokens=new Set<string>();
     const client=createFeishuClient(account);
     for(let page=0;page<100;page++){
      check();
      const response=await raceWithTimeoutAndAbort(client.im.chatMembers.get({path:{chat_id:result.chatId},params:{member_id_type:'open_id',page_size:100,page_token:token}}),{timeoutMs:20000,abortSignal:job.controller.signal});
      check();if(response.status!=='resolved')throw Error(response.status==='timeout'?'member_list_timeout':'sync_interrupted');
      const data=response.value;if(data.code!==0){error(job,'member_list_failed',{code:data.code});throw Error('member_list_failed');}
      for(const member of data.data?.items??[])if(openId(member.member_id))add(member.member_id,member.name);
      if(!data.data?.has_more)break;
      const next=data.data.page_token;if(!next||tokens.has(next))throw Error('invalid_member_pagination');tokens.add(next);token=next;
      if(page===99){error(job,'member_list_truncated');result.reason='member_list_truncated';}
     }
    }
    while(job.pending.size){
     check();const batch=[...job.pending].slice(0,4);for(const [id] of batch)job.pending.delete(id);
     const batchResults=await Promise.allSettled(batch.map(async([id,name])=>{
      const response=await raceWithTimeoutAndAbort(resolvePeopleFromFeishu(cfg,{agentId:result.agentId,accountId:account.accountId,appId:account.appId,openId:id}),{timeoutMs:20000,abortSignal:job.controller.signal});
      check();const lookup:PeopleLookupResult=response.status==='resolved'?response.value:{status:'error',people:[],reason:'profile_lookup_timeout'};
      const identity={accountId:account.accountId,appId:account.appId!,openId:id},prior=store.lookup(identity);
      if(lookup.status==='found'&&lookup.people.length===1&&lookup.people[0].accountId===identity.accountId&&lookup.people[0].appId===identity.appId&&lookup.people[0].openId===id){store.observe(lookup.people[0]);result.profiled++;const graphResult=await syncFeishuDirectory({agentId:result.agentId,account,openIds:[id],log:()=>{}});check();if(graphResult.status==='partial'){result.failed++;const detail=graphResult.errors?.[0];error(job,'entity_directory_'+(detail?.stage??'partial'),{openId:id,...(detail?.code!==undefined?{code:detail.code}:{}),...(detail?.requiredScopes?{requiredScopes:detail.requiredScopes}:{})});}}
      else{store.observe({...identity,...(name?{name}:{})});result.identityOnly++;result.failed++;error(job,lookup.reason??'profile_unavailable',{openId:id,...(lookup.code!==undefined?{code:lookup.code}:{}),...(lookup.requiredScopes?{requiredScopes:lookup.requiredScopes}:{})});}
      result.saved++;result.processed++;if(prior)result.updated++;else result.created++;
     }));
     if(batchResults.some(item=>item.status==='rejected'))throw Error('sync_interrupted');
    }
   }
   result.status=result.failed||result.reason?'partial':'completed';
  }catch(cause){
   result.reason=cause instanceof Error&&['sync_interrupted','member_list_timeout','member_list_failed','invalid_member_pagination'].includes(cause.message)?cause.message:'group_sync_failed';
   error(job,result.reason);result.status=stopped||job.controller.signal.aborted?'cancelled':result.saved?'partial':'failed';
  }finally{result.finishedAt=new Date().toISOString();}
 }
 function start(input:PeopleGroupContext,source:PeopleGroupSyncRun['source']='button',members?:PeopleJoinEvent['users']){
  if(stopped)throw Error('人员同步服务已停止');
  const {cfg,chatId,accounts}=scope(input);if(accounts.length!==1)throw Error(accounts.length?'请选择飞书账号后同步':'当前群没有可用的飞书账号');
  const account=accounts[0],id=key(input.agentId,account.accountId,chatId),existing=runs.get(id);
  const append=(job:Job)=>{if(!members)job.full=true;else for(const member of members){const oid=member.user_id?.open_id;if(openId(oid)&&!job.seen.has(oid)){job.seen.add(oid);job.pending.set(oid,member.name);job.result.discovered++;}}};
  if(existing?.result.status==='running'){if(source!=='button'||existing.result.source==='member_join')append(existing);return copy(existing);}
  if([...runs.values()].filter(job=>job.result.status==='running').length>=4)throw Error('人员同步任务较多，请稍后重试');
  for(const [k,job] of runs)if(runs.size>=100&&job.result.status!=='running')runs.delete(k);
  const job:Job={result:{id:randomUUID(),agentId:input.agentId,accountId:account.accountId,chatId,source,status:'running',discovered:0,processed:0,saved:0,profiled:0,identityOnly:0,failed:0,created:0,updated:0,startedAt:new Date().toISOString(),errors:[]},pending:new Map(),seen:new Set(),full:!members,controller:new AbortController(),done:Promise.resolve()};
  append(job);runs.set(id,job);job.done=Promise.resolve().then(()=>run(job,cfg,account));return copy(job);
 }
 return {
  info(input){try{const {accounts}=scope(input);return {available:accounts.length>0,accounts:accounts.map(a=>({accountId:a.accountId,appId:a.appId})),onJoin:accounts.some(a=>a.config.peopleSyncOnJoin!==false),...(accounts.length?{}:{reason:'当前群未启用或未绑定此 Agent'})};}catch(cause){return {available:false,accounts:[],reason:cause instanceof Error?cause.message:'无法读取群同步状态'};}},
  start:input=>start(input),
  status(input){const {chatId,accounts}=scope(input);if(accounts.length!==1)return null;const job=runs.get(key(input.agentId,accounts[0].accountId,chatId));return job?copy(job):null;},
  join(accountId,event,kind){
   if(stopped||!event.chat_id||!/^oc_[A-Za-z0-9]+$/.test(event.chat_id))return;
   const cfg=getConfig(),account=listEnabledFeishuAccounts(cfg).find(a=>a.accountId===accountId);
   if(!account||account.config.peopleSyncOnJoin===false||event.app_id&&event.app_id!==account.appId)return;
   const agentId=route(cfg,accountId,event.chat_id);if(!getPeopleService(agentId)||!isFeishuGroupReadAllowed(cfg,account,event.chat_id,false))return;
   const eventKey=event.event_id?accountId+':'+event.event_id:undefined;
   const now=Date.now();for(const [id,at] of events)if(at<now-86400000||events.size>2000)events.delete(id);
   if(eventKey&&events.has(eventKey))return;
   if(kind==='member_join'&&!event.users?.some(member=>openId(member.user_id?.open_id)))return;
   start({agentId,sessionKey:'agent:'+agentId+':feishu:group:'+event.chat_id,accountId},kind,kind==='member_join'?event.users:undefined);
   if(eventKey)events.set(eventKey,now);
  },
  async stop(){stopped=true;for(const job of runs.values())job.controller.abort();await Promise.allSettled([...runs.values()].map(job=>job.done));},
 };
}
export function registerFeishuPeopleGroupSync(api:OpenClawPluginApi){
 const owner=Symbol.for('openclaw-plugins.feishu-people-group-sync');let service=createPeopleGroupSync(()=>api.config),dispose=registerPeopleGroupSync(service,owner);
 api.registerService({id:'feishu-people-group-sync',start:()=>{dispose();service=createPeopleGroupSync(()=>api.config);dispose=registerPeopleGroupSync(service,owner);},stop:async()=>{dispose();await service.stop();}});
}
/** Called only from the SDK-authenticated account event dispatcher. */
export function handlePeopleJoin(accountId:string,event:PeopleJoinEvent,kind:'bot_join'|'member_join'){
 getPeopleGroupSync()?.join(accountId,event,kind);
}
