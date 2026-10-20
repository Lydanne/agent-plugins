const registry=globalThis[Symbol.for('openclaw-plugins.worker-ui-navigation.v1')]??={record:null,listeners:new Set()};
const id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const validId=value=>typeof value==='string'&&id.test(value);
function changed(){for(const listener of registry.listeners)try{listener();}catch{ /* One stale view cannot interrupt another plugin's lifecycle. */ }}
export function currentUiTarget(context){
 const agentId=context.props.agentId??context.host.agents.selectedId??context.host.connection.assistantAgentId??context.host.agents.defaultId;
 if(!validId(agentId))return {agentId:undefined,sessionKey:undefined};
 const sessionKey=context.props.sessionKey??context.host.sessions.selectedKey;
 return {agentId,sessionKey:typeof sessionKey==='string'&&sessionKey.startsWith('agent:'+agentId+':')?sessionKey:undefined};
}
// Session actions resolve trusted Agent identity only when given an Agent-qualified key.
// This read-only routing anchor does not select, read, or create a conversation.
export function projectInspectionTarget(context){
 const target=currentUiTarget(context);
 return {...target,sessionKey:target.sessionKey??(target.agentId?'agent:'+target.agentId+':agent-repo-catalog':undefined)};
}
export function registerWorkerNavigation(open){
 const record={open};registry.record=record;changed();
 return ()=>{if(registry.record!==record)return;registry.record=null;changed();};
}
export function subscribeWorkerNavigation(listener){registry.listeners.add(listener);return ()=>registry.listeners.delete(listener);}
export function canOpenWorkerProject(){return !!registry.record;}
export function openWorkerProject(target){
 if(!validId(target?.agentId)||!validId(target?.projectId)||typeof target.sessionKey!=='string'||!target.sessionKey.startsWith('agent:'+target.agentId+':'))throw Error('请选择该 Agent 的会话后打开 Worker 项目');
 if(!registry.record)throw Error('Agent Worker 项目页面尚未加载');
 registry.record.open({agentId:target.agentId,sessionKey:target.sessionKey,projectId:target.projectId});
}

export function openWorkerTask(target){
 if(!validId(target?.agentId)||typeof target.sessionKey!=='string'||!target.sessionKey.startsWith('agent:'+target.agentId+':')||typeof target.topic!=='string'||!target.topic||target.topic.length>160||!/^[a-f0-9-]{36}$/i.test(target.jobId??'')||target.projectId!=null&&!validId(target.projectId)||target.executionScope!=null&&!/^[a-f0-9]{64}$/.test(target.executionScope))throw Error('无效的 Worker 任务定位');
 if(!registry.record)throw Error('Agent Worker 项目页面尚未加载');
 registry.record.open({agentId:target.agentId,sessionKey:target.sessionKey,topic:target.topic,jobId:target.jobId,...(target.projectId?{projectId:target.projectId}:{}),...(target.executionScope?{executionScope:target.executionScope}:{})});
}
