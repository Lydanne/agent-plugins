import {computed,shallowRef,type InjectionKey,type ShallowRef} from 'vue';
import type {ControlUiViewContext} from 'openclaw/plugin-sdk/control-ui';

function absolutePath(value:string){
 if(/[\u0000\r\n]/.test(value))return;
 const drive=/^([a-z]):[\\/]/i.exec(value),unc=/^\\\\([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/.exec(value);
 const windows=!!drive||!!unc,volume=drive?drive[1]!.toLowerCase()+':':unc?'//'+unc[1]!.toLowerCase()+'/'+unc[2]!.toLowerCase():value.startsWith('/')?'/':undefined;
 if(!volume)return;
 const body=drive?value.slice(3):unc?value.slice(unc[0].length):value.slice(1),parts:string[]=[];
 for(const part of body.split(windows?/[\\/]/:/\//)){if(!part||part==='.')continue;if(part==='..')parts.pop();else parts.push(part);}
 return {volume,windows,parts};
}

/** Presentation only. Keep canonical API values for navigation, copying and mutations. */
export function relativeRepositoryPath(root:string,value:string){
 const base=absolutePath(root),target=absolutePath(value);if(!base||!target||base.volume!==target.volume)return value;
 let common=0;while(common<base.parts.length&&common<target.parts.length&&(base.windows?base.parts[common]!.toLowerCase()===target.parts[common]!.toLowerCase():base.parts[common]===target.parts[common]))common++;
 return [...base.parts.slice(common).map(()=>'..'),...target.parts.slice(common)].join('/')||'.';
}

export function createRepositoryPaths(context:ShallowRef<ControlUiViewContext>){
 const state=shallowRef<{agentId:string;path:string}>();
 const agentId=()=>context.value.props.agentId??context.value.host.agents.selectedId??context.value.host.connection.assistantAgentId??context.value.host.agents.defaultId??'';
 const allowed=()=>context.value.presented&&context.value.host.connection.canRead&&!context.value.signal.aborted;
 const root=computed(()=>allowed()&&state.value?.agentId===agentId()?state.value.path:undefined);
 function accept(owner:string|undefined,value:unknown){const id=owner??agentId();if(!allowed()||!id||id!==agentId()||typeof value!=='string'||!absolutePath(value)||state.value?.agentId===id&&state.value.path===value)return;state.value={agentId:id,path:value};}
 return {root,accept,
  consume(owner:string|undefined,response:unknown){if(response&&typeof response==='object'&&(response as {ok?:unknown}).ok===true)accept(owner,(response as {agentRepoRoot?:unknown}).agentRepoRoot);},
  sync(){if(!allowed()||state.value?.agentId!==agentId())state.value=undefined;},
  display(value:unknown){const text=String(value??'');return root.value?relativeRepositoryPath(root.value,text):text;},
 };
}
export type RepositoryPaths=ReturnType<typeof createRepositoryPaths>;
export const repositoryPathsKey:InjectionKey<RepositoryPaths>=Symbol('control-ui-repository-paths');
