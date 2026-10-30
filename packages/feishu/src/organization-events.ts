import type {FeishuIngressLifecycle} from './feishu-ingress.js';
import {getEntitySyncProvider} from '../../agent-repo-api/entities.mjs';
import {resolveFeishuRuntimeAccount} from './accounts.js';
import type {OpenClawConfig} from '../runtime-api.js';
type Event={event_id?:string;app_id?:string;tenant_key?:string;object?:{open_department_id?:string};old_object?:{open_department_id?:string;parent_department_id?:string}};
/** Called only after the existing SDK transport has admitted the Feishu event. */
export function organizationEventHandlers(cfg:OpenClawConfig,accountId:string,resolveLifecycle?:(data:unknown)=>FeishuIngressLifecycle|undefined){
 const handle=(operation:'created'|'updated'|'deleted')=>async(event:Event)=>{const account=resolveFeishuRuntimeAccount({cfg,accountId});const settle=async()=>{const lifecycle=resolveLifecycle?.(event);lifecycle?.onAdoptionFinalizing();await lifecycle?.onAdopted();return {kind:'completed' as const};};if(account.config.directorySync?.enabled===false)return settle();const provider=getEntitySyncProvider('feishu');if(!provider?.enqueue)throw Error('Organization sync provider unavailable');if(!event.event_id||!event.tenant_key||event.app_id&&event.app_id!==account.appId)throw Object.assign(Error('Invalid organization event origin'),{status:403});const id=event.object?.open_department_id??event.old_object?.open_department_id;if(!id||id==='0')throw Error('Missing department identity');provider.enqueue({accountId,appId:account.appId,tenantKey:event.tenant_key,eventId:event.event_id,kind:operation==='deleted'?'department-delete':operation==='updated'&&event.old_object?.parent_department_id!==undefined?'full':'department',externalIds:operation==='updated'&&event.old_object?.parent_department_id!==undefined?[]:[id]});return settle();};
 return {'contact.department.created_v3':handle('created'),'contact.department.updated_v3':handle('updated'),'contact.department.deleted_v3':handle('deleted')};
}
