import {getGraphService,type GraphChange} from '../../agent-repo-api/entities.mjs';
import {getPeopleService} from '../../agent-repo-api/people.mjs';
import {createFeishuClient} from './client.js';
import type {ResolvedFeishuAccount} from './types.js';
/** App/tenant scope is bound by the admitted route; never called with model-supplied credentials. */
export async function syncFeishuDirectory(input:{agentId:string;account:ResolvedFeishuAccount;openIds:string[];log:(...args:unknown[])=>void}){
 const graph=getGraphService({agentId:input.agentId}),people=getPeopleService(input.agentId);
 if(!graph||!people||!input.account.appId)return {status:'unavailable' as const};
 const {account}=input,scope=JSON.stringify([account.accountId,account.appId]);
 const producer=graph.forSource({kind:'channel',namespace:'feishu',scope,actor:'feishu-directory',types:['organization','department'],relations:['member_of','belongs_to','parent_department']});
 const client=createFeishuClient(account);let failures=0;
 const check=()=>{if(getGraphService({agentId:input.agentId})!==graph||getPeopleService(input.agentId)!==people)throw Error('directory_generation_changed');};
 // No global directory scan. Enrich only admitted people and their department ancestry.
 for(const openId of [...new Set(input.openIds)].slice(0,21))try{
  const stamp=new Date().toISOString(),proof={kind:'event' as const,id:'contact-observation:'+openId+':'+stamp},changes:GraphChange[]=[];
  const response=await client.contact.user.get({path:{user_id:openId},params:{user_id_type:'open_id',department_id_type:'open_department_id'}});
  check();if(response.code!==0||response.data?.user?.open_id!==openId)throw Error('contact_unavailable');
  const user=response.data.user,person=people.lookup({accountId:account.accountId,appId:account.appId!,openId});if(!person)continue;
  let organization:string|undefined;
  try{const result=await client.tenant.tenant.query({});const tenant=result.data?.tenant;check();if(result.code===0&&tenant?.tenant_key&&tenant.name){organization=producer.upsert({typeId:'organization',externalId:'tenant:'+tenant.tenant_key,name:tenant.name,observedAt:stamp}).entity.id;}else failures++;}catch{failures++;}
  const departmentNodes=new Map<string,string>(),parents=new Map<string,string>(),seen=new Set<string>();
  async function department(id:string,depth=0):Promise<string|undefined>{
   if(id==='0')return undefined;if(departmentNodes.has(id))return departmentNodes.get(id);if(seen.has(id)||depth>=20)throw Error('department_hierarchy_incomplete');seen.add(id);
   const result=await client.contact.department.get({path:{department_id:id},params:{department_id_type:'open_department_id'}}),data=result.data?.department;
   check();if(result.code!==0||!data?.name||data.open_department_id!==id)throw Error('department_unavailable');
   const node=producer.upsert({typeId:'department',externalId:id,name:data.name,observedAt:stamp}).entity.id;departmentNodes.set(id,node);
   if(data.parent_department_id&&data.parent_department_id!=='0'){const parent=await department(data.parent_department_id,depth+1);if(parent)parents.set(node,parent);}
   return node;
  }
  const ids=user.department_ids;if(ids===undefined||ids.length>100)throw Error('department_membership_incomplete');
  for(const id of ids)await department(id);
  const memberships=new Set([...ids].map(id=>departmentNodes.get(id)).filter((id):id is string=>Boolean(id)));
  const active=graph.relations({fromId:'person:'+person.id,typeId:'member_of',status:'active',limit:100});if(active.nextOffset!==null)throw Error('membership_truncated');
  for(const old of active.relations)if(old.source.scope===scope&&!memberships.has(old.toId))changes.push({action:'end',id:old.id,revision:old.revision,observedAt:stamp,evidence:proof});
  for(const target of memberships)changes.push({action:'connect',record:{typeId:'member_of',externalId:JSON.stringify([person.id,target]),fromId:'person:'+person.id,toId:target,observedAt:stamp},evidence:proof});
  for(const [id,node] of departmentNodes){
   if(organization)changes.push({action:'connect',record:{typeId:'belongs_to',externalId:id,fromId:node,toId:organization,observedAt:stamp},evidence:proof});
   const parent=parents.get(node),oldParents=graph.relations({fromId:node,typeId:'parent_department',status:'active',limit:100});if(oldParents.nextOffset!==null)throw Error('parent_relation_truncated');
   for(const old of oldParents.relations)if(old.source.scope===scope&&old.toId!==parent)changes.push({action:'end',id:old.id,revision:old.revision,observedAt:stamp,evidence:proof});
   if(parent)changes.push({action:'connect',record:{typeId:'parent_department',externalId:JSON.stringify([id,parent]),fromId:node,toId:parent,observedAt:stamp},evidence:proof});
  }
  check();if(changes.length)producer.applyRelationChanges({requestId:'directory:'+openId+':'+stamp,changes});
 }catch{failures++;if(getGraphService({agentId:input.agentId})!==graph||getPeopleService(input.agentId)!==people)break;}
 if(failures)input.log('feishu: entity directory sync partial; relations retained on incomplete reads');
 return {status:failures?'partial' as const:'completed' as const,failures};
}

const pending=new Map<string,Promise<unknown>>();
/** Coalesced background enrichment keeps admitted message delivery responsive. */
export function scheduleFeishuDirectorySync(input:Parameters<typeof syncFeishuDirectory>[0]){
 const key=JSON.stringify([input.agentId,input.account.accountId,input.account.appId,...input.openIds.slice().sort()]);
 if(pending.has(key))return;if(pending.size>=4){input.log('feishu: entity directory background capacity reached; enrichment deferred until a later observation');return;}
 const run=syncFeishuDirectory(input).catch(()=>input.log('feishu: entity directory sync failed')).finally(()=>pending.delete(key));pending.set(key,run);
}
