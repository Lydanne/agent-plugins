import {onBeforeUnmount,watch,type ShallowRef} from 'vue';
import type {ControlUiViewContext} from 'openclaw/plugin-sdk/control-ui';
import {readInspectionResponse} from '../../agent-worker/inspection-transport.mjs';
export function useManagementRequest(context:ShallowRef<ControlUiViewContext>,agentId:()=>string,pluginId='agent-repo',prefix='projects-'){
 let alive=true,epoch=0;
 function invalidate(){epoch++;}
 watch([agentId,()=>context.value.presented,()=>context.value.host.connection.canRead,()=>context.value.host.connection.canWrite],invalidate,{flush:'sync'});
 onBeforeUnmount(()=>{alive=false;invalidate();});
 function capture(){const token=epoch,id=agentId();return ()=>alive&&epoch===token&&agentId()===id&&context.value.presented&&context.value.host.connection.canRead&&!context.value.signal.aborted;}
 async function invoke<T>(action:string,payload:Record<string,unknown>){const valid=capture(),host=context.value.host;
  return readInspectionResponse<T>((name,data)=>{context.value.signal.throwIfAborted();if(!valid())throw Error('页面已切换或读取权限失效');return host.request('plugins.sessionAction',{pluginId,actionId:prefix+name,agentId:agentId(),sessionKey:'agent:'+agentId()+':agent-repo-management',payload:JSON.parse(JSON.stringify(data)) as Record<string,unknown>});},action,payload);
 }
 return {invoke,capture,invalidate};
}
