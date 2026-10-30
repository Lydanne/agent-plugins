import {scheduleFeishuDirectorySync} from './entity-directory.js';
import {getPeopleService} from '../../agent-repo-api/people.mjs';
import {registerPeopleResolver,type PeopleLookupRequest,type PeopleLookupResult,type PersonObservation} from '../../agent-repo-api/people.mjs';
import type {OpenClawPluginApi,OpenClawConfig} from '../runtime-api.js';
import {listEnabledFeishuAccounts,resolveFeishuRuntimeAccount} from './accounts.js';
import {createFeishuClient} from './client.js';
import {isFeishuGroupReadAllowed} from './read-policy.js';

/** App identity only. Never borrows another user's login or accepts model credentials. */
export async function resolvePeopleFromFeishu(cfg:OpenClawConfig,input:PeopleLookupRequest):Promise<PeopleLookupResult>{
 const empty=(status:PeopleLookupResult['status'],reason:string,code?:number):PeopleLookupResult=>({status,people:[],reason:code===99991672?'permission_denied':code===41050?'visibility_denied':reason,...(code!==undefined?{code}:{})});
 try{
  const accounts=listEnabledFeishuAccounts(cfg).filter(a=>a.configured);
  if(input.contextAccountId&&input.accountId&&input.contextAccountId!==input.accountId)return empty('unavailable','account_mismatch');
  const selected=input.contextAccountId??input.accountId;
  const candidates=accounts.filter(a=>(!selected||a.accountId===selected)&&(!input.appId||a.appId===input.appId));
  if(candidates.length!==1)return empty(candidates.length?'account_required':'unavailable',candidates.length?'specify_account':'account_unavailable');
  const account=resolveFeishuRuntimeAccount({cfg,accountId:candidates[0].accountId});
  if(!account.appId||!account.configured||!account.enabled||account.accountId!==candidates[0].accountId||account.appId!==candidates[0].appId)return empty('unavailable','account_unavailable');
  const client=createFeishuClient(account),ids=new Set<string>();
  let truncated=false;
  if(input.openId){
   if(!/^ou_[A-Za-z0-9]+$/.test(input.openId))return empty('unsupported','invalid_open_id');
   ids.add(input.openId);
  }else if(input.email){
   if(!/^[^\s@]+@[^\s@]+$/.test(input.email))return empty('unsupported','invalid_email');
   const result=await client.contact.user.batchGetId({params:{user_id_type:'open_id'},data:{emails:[input.email],include_resigned:false}});
   if(result.code!==0)return empty('error','contact_lookup_failed',result.code);
   for(const user of result.data?.user_list??[])if(user.user_id?.startsWith('ou_'))ids.add(user.user_id);
  }else if(input.name){
   const group=/^agent:[^:]+:feishu:group:(oc_[a-zA-Z0-9]+)(?::(?:topic|sender):[^:]+)*$/.exec(input.sessionKey??'')?.[1];
   if(!group)return empty('unsupported','name_requires_current_group_or_openid_email');
   if(!isFeishuGroupReadAllowed(cfg,account,group,false))return empty('unavailable','group_not_allowed');
   let pageToken:string|undefined;const seen=new Set<string>();
   for(let page=0;page<5;page++){
    const result=await client.im.chatMembers.get({path:{chat_id:group},params:{member_id_type:'open_id',page_size:100,page_token:pageToken}});
    if(result.code!==0)return empty('error','group_lookup_failed',result.code);
    for(const member of result.data?.items??[])if(member.member_id?.startsWith('ou_')&&member.name?.toLocaleLowerCase().includes(input.name.toLocaleLowerCase()))ids.add(member.member_id);
    if(ids.size>=10){truncated=Boolean(result.data?.has_more)||ids.size>10;break;}
    if(!result.data?.has_more)break;
    const next=result.data.page_token;
    if(!next||seen.has(next))return empty('error','invalid_pagination');
    seen.add(next);pageToken=next;if(page===4)truncated=true;
   }
  }else return empty('unsupported','requires_openid_email_or_name');
  const people:PersonObservation[]=[];
  for(const openId of [...ids].slice(0,10)){
   const result=await client.contact.user.get({path:{user_id:openId},params:{user_id_type:'open_id',department_id_type:'open_department_id'}});
   if(result.code!==0)return empty('error','contact_lookup_failed',result.code);
   const user=result.data?.user;
   if(!user?.open_id||user.open_id!==openId)return empty('error','invalid_contact_identity');
   const departments=await Promise.all((user.department_ids??[]).slice(0,20).map(async id=>{
    try{const result=await client.contact.department.get({path:{department_id:id},params:{department_id_type:'open_department_id'}});return {id,...(result.code===0&&result.data?.department?.name?{name:result.data.department.name}:{})};}catch{return {id};}
   }));
   const email=user.enterprise_email?.trim()||user.email?.trim();
   people.push({accountId:account.accountId,appId:account.appId,openId,...(user.name?{name:user.name}:{}),...(email?{email}:{}),...(user.department_ids!==undefined?{departments}:{})});
  }
  return {status:people.length?'found':'not_found',people,truncated};
 }catch(error){
  const data=error&&typeof error==='object'?(error as {response?:{data?:unknown}}).response?.data:undefined;
  if(data&&typeof data==='object'){
   const response=data as {code?:unknown;error?:{permission_violations?:Array<{subject?:unknown}>}};
   const code=typeof response.code==='number'?response.code:undefined;
   const scopes=(response.error?.permission_violations??[]).map(item=>item.subject).filter((value):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_.:]{1,99}$/.test(value)).slice(0,10);
   return {...empty('error','feishu_api_error',code),...(scopes.length?{requiredScopes:scopes}:{})};
  }
  return empty('error','feishu_request_failed');
 }
}
export function registerFeishuPeopleResolver(api:OpenClawPluginApi){
 const owner=Symbol.for('openclaw-plugins.feishu-people-resolver');
 const resolve=async(input:PeopleLookupRequest)=>{const result=await resolvePeopleFromFeishu(api.config,input);if(result.status==='found'){const store=getPeopleService(input.agentId);for(const person of result.people)store?.observe(person);const first=result.people[0];if(first){const account=resolveFeishuRuntimeAccount({cfg:api.config,accountId:first.accountId});scheduleFeishuDirectorySync({agentId:input.agentId,account,openIds:result.people.map(p=>p.openId),log:(...args)=>api.logger?.warn?.(args.join(' '))});}}return result;};
 let dispose=registerPeopleResolver(resolve,owner);
 api.registerService({id:'feishu-people-resolver',start:()=>{dispose();dispose=registerPeopleResolver(resolve,owner);},stop:()=>dispose()});
}
