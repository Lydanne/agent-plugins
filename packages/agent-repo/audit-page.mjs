import {createApp} from 'vue';
import AuditView from './ui/AuditView.vue';
import {auditFeatures} from './ui/audit-model.ts';
import {readInspectionResponse} from './dist/inspection-transport.mjs';
export {auditFeatures};
// Compatibility mount used by feature dialogs; all rendering belongs to Vue.
export function mountAudit(container,options={}){
 const root=container.ownerDocument.createElement('div');container.append(root);
 const app=createApp(AuditView,options);app.mount(root);
 let disposed=false;
 return {dispose(){if(disposed)return;disposed=true;app.unmount();root.remove();}};
}
export function mountAuditPage(container,context,agentId,filter={}){
 const invoke=(action,payload)=>readInspectionResponse((name,data)=>{context.signal.throwIfAborted();return context.host.request('plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-'+name,agentId,sessionKey:'agent:'+agentId+':agent-repo-management',payload:data});},action,payload);
 return mountAudit(container,{invoke,safe:value=>context.host.redact(String(value??'')),...filter});
}
