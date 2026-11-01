import {expect,test} from 'vitest';
import {shallowRef,createApp,defineComponent,h} from 'vue';
import {posix,win32} from 'node:path';
import type {ControlUiViewContext} from 'openclaw/plugin-sdk/control-ui';
import {relativeRepositoryPath,createRepositoryPaths} from '../src/repository-paths';
import {useRepositoryPaths} from '../src/host';
test('standalone path labels preserve originals without guessing a repository root',()=>{
 const container=document.createElement('div'),app=createApp(defineComponent({setup(){const paths=useRepositoryPaths();paths.consume('alice',{ok:true,agentRepoRoot:'/guess'});return ()=>h('code',paths.display('/outside/file'));}}));
 try{app.mount(container);expect(container.textContent).toBe('/outside/file');}finally{app.unmount();}
});
test('filesystem labels are relative to the AgentRepo root and still resolve to the canonical location',()=>{
 const root='/Users/wmc/workspace/agents/alice-agent';
 for(const [input,expected] of [[root,'.'],[root+'/projects/agent-plugins/wiki','projects/agent-plugins/wiki'],[root+'-backup/wiki','../alice-agent-backup/wiki'],['/Users/wmc/.openclaw/cli','../../../.openclaw/cli'],[root+'/projects/中文 文档.md','projects/中文 文档.md']]){
  const displayed=relativeRepositoryPath(root,input!);expect(displayed).toBe(expected);expect(posix.resolve(root,displayed)).toBe(posix.normalize(input!));
 }
 for(const value of ['wiki/README.md','https://example.com/wiki','file:///tmp/a.md','正文\n/Users/wmc/private'])expect(relativeRepositoryPath(root,value)).toBe(value);
});
test('Windows volumes and UNC paths do not invent cross-volume relative paths',()=>{
 expect(relativeRepositoryPath('C:\\Agents\\Alice','c:\\agents\\alice\\projects\\demo')).toBe('projects/demo');
 const value='C:\\Agents\\Other\\wiki';expect(win32.resolve('C:\\Agents\\Alice',relativeRepositoryPath('C:\\Agents\\Alice',value))).toBe(value);
 expect(relativeRepositoryPath('C:\\Agents\\Alice','D:\\data\\wiki')).toBe('D:\\data\\wiki');
 expect(relativeRepositoryPath('\\\\server\\share\\Alice','\\\\server\\share\\Alice\\wiki')).toBe('wiki');
 expect(relativeRepositoryPath('\\\\server\\share\\Alice','\\\\other\\share\\wiki')).toBe('\\\\other\\share\\wiki');
});
test('path metadata is scoped to the visible readable Agent and never changes raw response or action values',()=>{
 const context=shallowRef({props:{},presented:true,signal:new AbortController().signal,host:{connection:{canRead:true},agents:{selectedId:'alice'}}} as unknown as ControlUiViewContext),paths=createRepositoryPaths(context);
 const response={ok:true,agentRepoRoot:'/agents/alice',result:{cwd:'/agents/alice/projects/demo'}},before=JSON.stringify(response);
 paths.consume('alice',response);expect(paths.display(response.result.cwd)).toBe('projects/demo');expect(JSON.stringify(response)).toBe(before);
 context.value={...context.value,host:{...context.value.host,agents:{...context.value.host.agents,selectedId:'bob'}}};paths.sync();expect(paths.root.value).toBeUndefined();paths.consume('alice',response);expect(paths.root.value).toBeUndefined();
 paths.consume('bob',{ok:true,agentRepoRoot:'/agents/bob'});expect(paths.display('/agents/bob/wiki')).toBe('wiki');
 context.value={...context.value,presented:false};paths.sync();expect(paths.root.value).toBeUndefined();context.value={...context.value,presented:true};paths.consume('bob',{ok:false,agentRepoRoot:'/wrong'});paths.consume('bob',{ok:true,agentRepoRoot:'../wrong'});expect(paths.root.value).toBeUndefined();
 paths.consume('bob',{ok:true,agentRepoRoot:'/agents/bob'});context.value={...context.value,host:{...context.value.host,connection:{...context.value.host.connection,canRead:false}}};paths.sync();expect(paths.root.value).toBeUndefined();
});
