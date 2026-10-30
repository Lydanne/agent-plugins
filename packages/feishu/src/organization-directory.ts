import {createHash} from 'node:crypto';
import {getGraphService,type GraphChange,type DirectorySyncError,type DirectorySyncRun,type SourceCapability} from '../../agent-repo-api/entities.mjs';
import {createFeishuClient} from './client.js';
import {directoryRead,refreshTenant} from './organization-refresh.js';
import type {ResolvedFeishuAccount} from './types.js';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const feishuDirectoryScope=(account:ResolvedFeishuAccount)=>JSON.stringify([account.accountId,account.appId]);
export function directoryProducer(agentId:string,account:ResolvedFeishuAccount){const producer=getGraphService({agentId})?.forSource({kind:'channel',namespace:'feishu',scope:feishuDirectoryScope(account),actor:'feishu-organization-sync',types:['organization','department'],relations:['belongs_to','parent_department']});return typeof producer?.recordSync==='function'&&typeof producer?.syncStatus==='function'?producer:undefined;}
export async function synchronizeOrganization(input:{agentId:string;account:ResolvedFeishuAccount;requestId:string;startedAt:string;check?:()=>void;leaseToken?:string;preserveMissing?:boolean;onDepartments?:(ids:string[])=>void;progress?:(run:DirectorySyncRun)=>void}):Promise<DirectorySyncRun>{
 const graph=getGraphService({agentId:input.agentId}),producerBase=directoryProducer(input.agentId,input.account),producer=input.leaseToken?producerBase?.withSyncLease(input.leaseToken):producerBase;if(!graph||!producer||!input.account.appId)throw Error('Entity graph unavailable');
 const client=createFeishuClient(input.account),scope=feishuDirectoryScope(input.account),deadline=Date.now()+600000,errors:DirectorySyncError[]=[],departments=new Map<string,Department>(),queue=['0'];
 let stage='organization',organizationId:string|null=null,complete=false,storedDepartments=0,relations=0,pages=0,missing=false;
 const result=(status:DirectorySyncRun['status']):DirectorySyncRun=>({requestId:input.requestId,status,startedAt:input.startedAt,...(status!=='running'?{finishedAt:new Date().toISOString()}:{}),departments:departments.size,storedDepartments,organizationId,relations,coverage:complete&&organizationId&&storedDepartments===departments.size&&!errors.length?'full':departments.size||organizationId?'partial':'none',errors});
 const check=()=>{if(Date.now()>deadline)throw Error('directory_deadline');if(getGraphService({agentId:input.agentId})!==graph)throw Error('graph_generation_changed');input.check?.();};
 const call=async<T>(read:()=>Promise<T>)=>{check();const response=await directoryRead(input.account,read);check();return response;};
 const problem=(cause:unknown)=>{const error=cause as {message?:string;response?:{data?:{code?:number;error?:{permission_violations?:Array<{subject?:unknown}>}}};api?:{code?:number;error?:{permission_violations?:Array<{subject?:unknown}>}}};const response=error?.api??error?.response?.data;const requiredScopes=(response?.error?.permission_violations??[]).map(v=>v.subject).filter((v):v is string=>typeof v==='string'&&/^[a-z][a-z0-9_.:]{1,99}$/.test(v)).slice(0,20);if(errors.length<20)errors.push({stage,reason:/^[a-z][a-z0-9_]{0,99}$/.test(error?.message??'')?error.message:'directory_sync_failed',...(typeof response?.code==='number'?{code:response.code}:{}),...(requiredScopes.length?{requiredScopes}:{})});};
 try{
  organizationId=(await refreshTenant(input.agentId,input.account,producer,input.startedAt,check)).id;
 }catch(cause){problem(cause);}
 try{
  // Each parent is paginated independently: no recursive-API 1000-department visibility cap.
  for(let cursor=0;cursor<queue.length;cursor++){
   const parent=queue[cursor];let token:string|undefined;const seenTokens=new Set<string>();
   do{
    stage=parent==='0'?'root_departments':'department_children';if(++pages>20000)throw Error('department_page_limit');
    const response=await call(()=>client.contact.department.children({path:{department_id:parent},params:{department_id_type:'open_department_id',user_id_type:'open_id',fetch_child:false,page_size:50,...(token?{page_token:token}:{})}}));
    const data=response.data;if(response.code!==0)throw Object.assign(Error('department_access_denied'),{api:response});
    if(!data||typeof data.has_more!=='boolean'||data.items!==undefined&&!Array.isArray(data.items)||data.items===undefined&&data.has_more)throw Error('department_page_incomplete');
    for(const item of data.items??[]){const id=item.open_department_id;if(typeof id!=='string'||!id||id==='0'||typeof item.name!=='string'||!item.name||item.parent_department_id&&item.parent_department_id!==parent||departments.has(id)||item.status?.is_deleted)throw Error('department_tree_inconsistent');if(departments.size>=9999)throw Error('department_count_limit');departments.set(id,{...item,parent_department_id:parent});queue.push(id);}
    input.progress?.(result('running'));
    if(!data.has_more)break;const next=data.page_token;if(!next||seenTokens.has(next))throw Error('department_pagination_incomplete');seenTokens.add(next);token=next;
   }while(true);
  }
  stage='snapshot';check();
  const stamp=input.startedAt,changes:GraphChange[]=[],proof={kind:'snapshot' as const,id:input.requestId},existingIds=new Map<string,string>();
  for(let offset=0;;){const existing=graph.list({typeId:'department',source:'feishu',limit:100,offset});for(const node of existing.entities)if(node.source.scope===scope){existingIds.set(node.source.externalId,node.id);if(input.preserveMissing&&!departments.has(node.source.externalId)&&node.attributes.deleted!==true)missing=true;if(!departments.has(node.source.externalId)&&!input.preserveMissing&&node.attributes.inDirectory!==false)changes.push({action:'upsert',record:{typeId:'department',externalId:node.source.externalId,name:node.name,attributes:{inDirectory:false},observedAt:stamp},evidence:proof});}if(existing.nextOffset===null)break;offset=existing.nextOffset;}
  const nodeId=(id:string)=>existingIds.get(id)??'entity:'+digest(['department','channel','feishu',scope,id]);
  for(const [id,d] of departments)changes.push({action:'upsert',record:{typeId:'department',externalId:id,name:d.name,attributes:{inDirectory:true,deleted:false,parentId:d.parent_department_id,parentIdSource:'children_query',...(d.department_id?{code:d.department_id}:{}),...(d.leader_user_id?{leaderIds:[d.leader_user_id]}:{}),...(d.member_count!==undefined?{memberCount:d.member_count}:{}),...(d.order!==undefined?{order:d.order}:{}),...(d.chat_id?{chatId:d.chat_id}:{})},observedAt:stamp},evidence:proof});
  for(const [id,d] of departments){if(organizationId)changes.push({action:'connect',record:{typeId:'belongs_to',externalId:id,fromId:nodeId(id),toId:organizationId,observedAt:stamp},evidence:proof});if(d.parent_department_id!=='0')changes.push({action:'connect',record:{typeId:'parent_department',externalId:JSON.stringify([id,nodeId(d.parent_department_id)]),fromId:nodeId(id),toId:nodeId(d.parent_department_id),observedAt:stamp},evidence:proof});}
  if(input.preserveMissing){
   // Missing visibility is not deletion evidence. Keep missing-node edges, but reparent observed nodes normally.
   for(const typeId of ['parent_department',...(organizationId?['belongs_to']:[])])for(let offset=0;;){const page=graph.relations({typeId,status:'active',limit:100,offset});for(const edge of page.relations)if(edge.source.scope===scope){const from=graph.get(edge.fromId).entity;if(from?.typeId==='department'&&!departments.has(from.source.externalId))changes.push({action:'connect',record:{typeId:edge.typeId,externalId:edge.source.externalId,fromId:edge.fromId,toId:edge.toId,attributes:edge.attributes,observedAt:stamp},evidence:proof});}if(page.nextOffset===null)break;offset=page.nextOffset;}
  }
  const applied=producer.syncSnapshot({requestId:input.requestId,observedAt:stamp,complete:true,relationTypes:['parent_department',...(organizationId?['belongs_to']:[])],fromTypes:['department'],changes});
  for(const item of applied.results){const row=item as {entity?:{status:string;source:{externalId:string}};relation?:{status:string};trashed?:boolean};if(row.entity?.status==='active'&&departments.has(row.entity.source.externalId))storedDepartments++;if(row.relation?.status==='active')relations++;}
  input.onDepartments?.([...departments.keys()]);complete=true;if(missing)errors.push({stage:'coverage',reason:'department_visibility_changed'});if(storedDepartments!==departments.size)errors.push({stage:'snapshot',reason:'departments_in_recycle_bin'});
 }catch(cause){problem(cause);}
 const finished=result(complete&&organizationId&&storedDepartments===departments.size&&!errors.length?'completed':complete||organizationId?'partial':'failed');producer.recordSync(finished);return finished;
}
type Department=NonNullable<NonNullable<Awaited<ReturnType<ReturnType<typeof createFeishuClient>['contact']['department']['children']>>['data']>['items']>[number];
