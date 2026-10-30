import {createHash} from 'node:crypto';
import {getGraphService,type GraphChange,type DirectorySyncError,type DirectorySyncRun,type SourceCapability} from '../../agent-repo-api/entities.mjs';
import {createFeishuClient} from './client.js';
import {raceWithTimeoutAndAbort} from './async.js';
import type {ResolvedFeishuAccount} from './types.js';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const feishuDirectoryScope=(account:ResolvedFeishuAccount)=>JSON.stringify([account.accountId,account.appId]);
export function directoryProducer(agentId:string,account:ResolvedFeishuAccount){const producer=getGraphService({agentId})?.forSource({kind:'channel',namespace:'feishu',scope:feishuDirectoryScope(account),actor:'feishu-organization-sync',types:['organization','department'],relations:['belongs_to','parent_department']});return typeof producer?.recordSync==='function'&&typeof producer?.syncStatus==='function'?producer:undefined;}
export async function synchronizeOrganization(input:{agentId:string;account:ResolvedFeishuAccount;requestId:string;startedAt:string;check?:()=>void;progress?:(run:DirectorySyncRun)=>void}):Promise<DirectorySyncRun>{
 const graph=getGraphService({agentId:input.agentId}),producer=directoryProducer(input.agentId,input.account);if(!graph||!producer||!input.account.appId)throw Error('Entity graph unavailable');
 const client=createFeishuClient(input.account),scope=feishuDirectoryScope(input.account),deadline=Date.now()+600000,errors:DirectorySyncError[]=[],departments=new Map<string,Department>(),queue=['0'];
 let stage='organization',organizationId:string|null=null,complete=false,storedDepartments=0,relations=0,pages=0;
 const result=(status:DirectorySyncRun['status']):DirectorySyncRun=>({requestId:input.requestId,status,startedAt:input.startedAt,...(status!=='running'?{finishedAt:new Date().toISOString()}:{}),departments:departments.size,storedDepartments,organizationId,relations,coverage:complete&&organizationId&&storedDepartments===departments.size?'full':departments.size||organizationId?'partial':'none',errors});
 const check=()=>{if(Date.now()>deadline)throw Error('directory_deadline');if(getGraphService({agentId:input.agentId})!==graph)throw Error('graph_generation_changed');input.check?.();};
 const call=async<T>(promise:Promise<T>)=>{check();const response=await raceWithTimeoutAndAbort(promise,{timeoutMs:20000});check();if(response.status!=='resolved')throw Error('directory_request_timeout');return response.value;};
 const problem=(cause:unknown)=>{const error=cause as {message?:string;response?:{data?:{code?:number;error?:{permission_violations?:Array<{subject?:unknown}>}}};api?:{code?:number;error?:{permission_violations?:Array<{subject?:unknown}>}}};const response=error?.api??error?.response?.data;const requiredScopes=(response?.error?.permission_violations??[]).map(v=>v.subject).filter((v):v is string=>typeof v==='string'&&/^[a-z][a-z0-9_.:]{1,99}$/.test(v)).slice(0,20);if(errors.length<20)errors.push({stage,reason:/^[a-z][a-z0-9_]{0,99}$/.test(error?.message??'')?error.message:'directory_sync_failed',...(typeof response?.code==='number'?{code:response.code}:{}),...(requiredScopes.length?{requiredScopes}:{})});};
 try{
  const response=await call(client.tenant.tenant.query({})),tenant=response.data?.tenant;
  if(response.code!==0||!tenant?.tenant_key||!tenant.name)throw Object.assign(Error('organization_unavailable'),{api:response});
  for(let offset=0;;){const existing=graph.list({typeId:'organization',source:'feishu',limit:100,offset});if(existing.entities.some(e=>e.source.scope===scope&&e.source.externalId!=='tenant:'+tenant.tenant_key))throw Error('tenant_scope_changed');if(existing.nextOffset===null)break;offset=existing.nextOffset;}
  const organization=producer.upsert({typeId:'organization',externalId:'tenant:'+tenant.tenant_key,name:tenant.name,attributes:{tenantKey:tenant.tenant_key,...(tenant.display_id?{displayId:tenant.display_id}:{}),...(tenant.domain?{domain:tenant.domain}:{})},observedAt:input.startedAt}).entity;if(organization.status!=='active')throw Error('organization_in_recycle_bin');organizationId=organization.id;
 }catch(cause){problem(cause);}
 try{
  // Each parent is paginated independently: no recursive-API 1000-department visibility cap.
  for(let cursor=0;cursor<queue.length;cursor++){
   const parent=queue[cursor];let token:string|undefined;const seenTokens=new Set<string>();
   do{
    stage=parent==='0'?'root_departments':'department_children';if(++pages>20000)throw Error('department_page_limit');
    const response=await call(client.contact.department.children({path:{department_id:parent},params:{department_id_type:'open_department_id',user_id_type:'open_id',fetch_child:false,page_size:50,...(token?{page_token:token}:{})}}));
    const data=response.data;if(response.code!==0)throw Object.assign(Error('department_access_denied'),{api:response});
    if(!data||typeof data.has_more!=='boolean'||data.items!==undefined&&!Array.isArray(data.items)||data.items===undefined&&data.has_more)throw Error('department_page_incomplete');
    for(const item of data.items??[]){const id=item.open_department_id;if(typeof id!=='string'||!id||id==='0'||typeof item.name!=='string'||!item.name||item.parent_department_id&&item.parent_department_id!==parent||departments.has(id)||item.status?.is_deleted)throw Error('department_tree_inconsistent');if(departments.size>=9999)throw Error('department_count_limit');departments.set(id,{...item,parent_department_id:parent});queue.push(id);}
    input.progress?.(result('running'));
    if(!data.has_more)break;const next=data.page_token;if(!next||seenTokens.has(next))throw Error('department_pagination_incomplete');seenTokens.add(next);token=next;
   }while(true);
  }
  stage='snapshot';check();
  const stamp=input.startedAt,changes:GraphChange[]=[],proof={kind:'snapshot' as const,id:input.requestId},existingIds=new Map<string,string>();
  for(let offset=0;;){const existing=graph.list({typeId:'department',source:'feishu',limit:100,offset});for(const node of existing.entities)if(node.source.scope===scope){existingIds.set(node.source.externalId,node.id);if(!departments.has(node.source.externalId)&&node.attributes.inDirectory!==false)changes.push({action:'upsert',record:{typeId:'department',externalId:node.source.externalId,name:node.name,attributes:{inDirectory:false},observedAt:stamp},evidence:proof});}if(existing.nextOffset===null)break;offset=existing.nextOffset;}
  const nodeId=(id:string)=>existingIds.get(id)??'entity:'+digest(['department','channel','feishu',scope,id]);
  for(const [id,d] of departments)changes.push({action:'upsert',record:{typeId:'department',externalId:id,name:d.name,attributes:{inDirectory:true,parentId:d.parent_department_id,parentIdSource:'children_query',...(d.department_id?{code:d.department_id}:{}),...(d.leader_user_id?{leaderIds:[d.leader_user_id]}:{}),...(d.member_count!==undefined?{memberCount:d.member_count}:{}),...(d.order!==undefined?{order:d.order}:{}),...(d.chat_id?{chatId:d.chat_id}:{})},observedAt:stamp},evidence:proof});
  for(const [id,d] of departments){if(organizationId)changes.push({action:'connect',record:{typeId:'belongs_to',externalId:id,fromId:nodeId(id),toId:organizationId,observedAt:stamp},evidence:proof});if(d.parent_department_id!=='0')changes.push({action:'connect',record:{typeId:'parent_department',externalId:JSON.stringify([id,nodeId(d.parent_department_id)]),fromId:nodeId(id),toId:nodeId(d.parent_department_id),observedAt:stamp},evidence:proof});}
  const applied=producer.syncSnapshot({requestId:input.requestId,observedAt:stamp,complete:true,relationTypes:['parent_department',...(organizationId?['belongs_to']:[])],fromTypes:['department'],changes});
  for(const item of applied.results){const row=item as {entity?:{status:string;source:{externalId:string}};relation?:{status:string};trashed?:boolean};if(row.entity?.status==='active'&&departments.has(row.entity.source.externalId))storedDepartments++;if(row.relation?.status==='active')relations++;}
  complete=true;if(storedDepartments!==departments.size)errors.push({stage:'snapshot',reason:'departments_in_recycle_bin'});
 }catch(cause){problem(cause);}
 const finished=result(complete&&organizationId&&storedDepartments===departments.size&&!errors.length?'completed':complete||organizationId?'partial':'failed');producer.recordSync(finished);return finished;
}
type Department=NonNullable<NonNullable<Awaited<ReturnType<ReturnType<typeof createFeishuClient>['contact']['department']['children']>>['data']>['items']>[number];
