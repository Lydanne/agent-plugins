import {defineComponent,h} from 'vue';
import {mountVueView} from '@openclaw-plugins/control-ui-kit';
import AuditView from './ui/AuditView.vue';
import {auditFeatures} from './ui/audit-model.ts';
import {readInspectionResponse} from './dist/inspection-transport.mjs';
export {auditFeatures};
// Compatibility mount used by feature dialogs; all rendering belongs to Vue.
export function mountAudit(container,options={}){
 if(!options.context)throw Error('审计视图需要宿主上下文');
 const {context,...props}=options;
 return mountVueView(defineComponent({setup:()=>()=>h(AuditView,props)}))(container,context);
}
export function mountAuditPage(container,context,agentId,filter={}){
 const invoke=(action,payload)=>readInspectionResponse((name,data)=>{context.signal.throwIfAborted();return context.host.request('plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-'+name,agentId,sessionKey:'agent:'+agentId+':agent-repo-management',payload:data});},action,payload);
 return mountAudit(container,{context,invoke,safe:value=>context.host.redact(String(value??'')),...filter});
}
