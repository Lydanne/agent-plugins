import {onBeforeUnmount,watch,type ShallowRef} from 'vue';
import type {ControlUiViewContext} from 'openclaw/plugin-sdk/control-ui';
import {readInspectionResponse} from '../../agent-worker/inspection-transport.mjs';
// A retiring view must still release its original lease or a late start response.
export function useDiagnosticRequest(context:ShallowRef<ControlUiViewContext>,agentId:string,sessionKey='agent:'+agentId+':agent-repo-management'){
 const host=context.value.host;let alive=true;
 onBeforeUnmount(()=>{alive=false;});
 const valid=()=>alive&&context.value.presented&&context.value.host.connection.canRead&&!context.value.signal.aborted;
 watch(()=>context.value.props.agentId??context.value.host.agents.selectedId,owner=>{if(owner&&owner!==agentId)alive=false;},{flush:'sync'});
 async function invoke<T>(action:string,payload:Record<string,unknown>){
  if(action!=='diagnosticStop'&&!valid())throw Error('日志页面已切换或读取权限失效');
  return readInspectionResponse<T>((name,data)=>{if(action!=='diagnosticStop'&&action!=='diagnosticStart'&&!valid())throw Error('日志页面已切换或读取权限失效');return host.request('plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-'+name,agentId,sessionKey,payload:JSON.parse(JSON.stringify(data)) as Record<string,unknown>});},action,payload);
 }
 return {invoke};
}
