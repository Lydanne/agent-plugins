import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const fixture=vi.hoisted(()=>({root:'',config:{channels:{feishu:{appSecret:'private-secret',cli:{autoUpdate:true,version:'1.0.98',updateCheckIntervalHours:24}}},unrelated:'keep'},version:'1.0.98',updates:0,updateTarget:undefined as string|undefined}));
vi.mock('openclaw/plugin-sdk/state-paths',()=>({resolveStateDir:()=>fixture.root}));
vi.mock('openclaw/plugin-sdk/config-runtime',()=>({mutateConfigFile:async({mutate}:{mutate:(draft:typeof fixture.config)=>void})=>{const draft=structuredClone(fixture.config);mutate(draft);fixture.config=draft;}}));
vi.mock('./cli-manager.js',()=>({FeishuCliManager:class {
 options;constructor(_root:string,options:{autoUpdate:boolean;version?:string;updateCheckIntervalHours:number}){this.options=options;}
 async status(){return {active:{id:fixture.version,version:fixture.version,skills:[{name:'lark-doc',description:'docs'}]},autoUpdate:this.options.autoUpdate,pinnedVersion:this.options.version,updateCheckIntervalHours:this.options.updateCheckIntervalHours,enabled:true,previous:null};}
 async update(){fixture.updates++;fixture.updateTarget=this.options.version;fixture.version='1.0.99';}async check(){}async rollback(){}stop(){}
}}));
import {registerCliMaintenance} from './cli-maintenance.js';
import {maintenanceCatalog,runMaintenance} from '../../agent-repo-api/maintenance.mjs';
import type {OpenClawPluginApi} from '../runtime-api.js';
let stop:(()=>Promise<void>)|undefined;
afterEach(async()=>{await stop?.();stop=undefined;if(fixture.root)await rm(fixture.root,{recursive:true,force:true});});
const ctx={agentId:'main',sessionKey:'agent:main:maintenance',client:{scopes:['operator.read','operator.write']}};
async function setup(){fixture.root=await mkdtemp(join(tmpdir(),'cli-maintenance-'));fixture.version='1.0.98';fixture.updates=0;
 registerCliMaintenance({runtime:{config:{current:()=>fixture.config}},registerService(service:{stop:()=>Promise<void>}){stop=service.stop;}} as unknown as OpenClawPluginApi);
 return (await maintenanceCatalog(ctx)).providers[0];}
async function settled(){for(let i=0;i<50;i++){const status=(await maintenanceCatalog(ctx)).providers[0];if(status.history?.[0]?.status!=='running')return status;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('operation did not settle');}
it('generic skills interface exposes shared CLI dependencies without account credentials and preserves idempotency',async()=>{
 const initial=await setup();expect(initial.scope).toContain('宿主共享');expect(initial.skills[0].name).toBe('lark-doc');expect(JSON.stringify(initial)).not.toContain('private-secret');
 const input={providerId:'feishu.cli',action:'update',expectedRevision:initial.revision!,requestId:randomUUID(),confirmed:true as const};
 await expect(runMaintenance({...ctx,client:{scopes:['operator.read']}},input)).rejects.toThrow('写入权限');
 const operation=await runMaintenance(ctx,input);await settled();expect(fixture.updates).toBe(1);expect(fixture.updateTarget).toBe(initial.versions?.available);
 expect((await runMaintenance(ctx,input)).id).toBe(operation.id);expect(fixture.updates).toBe(1);
 await expect(runMaintenance(ctx,{...input,requestId:randomUUID()})).rejects.toThrow('已变化');
});
it('policy changes preserve unrelated configuration and pins unless explicitly cleared',async()=>{
 let status=await setup();
 const run=async(settings:Record<string,unknown>)=>{const result=await runMaintenance(ctx,{providerId:'feishu.cli',action:'configure',expectedRevision:status.revision!,requestId:randomUUID(),confirmed:true,settings});status=await settled();return result;};
 await run({autoUpdate:false});expect(fixture.config.channels.feishu.cli.version).toBe('1.0.98');expect(fixture.config.channels.feishu.cli.autoUpdate).toBe(false);expect(fixture.config.unrelated).toBe('keep');expect(fixture.config.channels.feishu.appSecret).toBe('private-secret');
 await run({version:''});expect(fixture.config.channels.feishu.cli.version).toBeUndefined();
 await expect(run({version:'../../file'})).rejects.toThrow('参数无效');await expect(run({appSecret:'new'})).rejects.toThrow('参数无效');
});
