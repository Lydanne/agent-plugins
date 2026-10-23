import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {git,readSkillSource} from './repository-skills.mjs';
import {resolveConfiguration} from './configuration.mjs';
import {createProjectInspector,registerProjectInspector} from './project-inspector.mjs';
import {readInspectionResponse} from './dist/inspection-transport.mjs';
async function commit(root){await git(root,['add','.']);await git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','fixture']);}
async function skill(root,directory,name,metadata=''){const folder=join(root,directory,name);await mkdir(folder,{recursive:true});await writeFile(join(folder,'SKILL.md'),`---\nname: ${name}\ndescription: Fixture\n${metadata}---\nUse this skill.\n`);}
async function fixture(t){
 const base=fileURLToPath(new URL('../../.tmp/project-inspector-tests/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'agent-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await git(root,['init','-b','main']);await writeFile(join(root,'.gitignore'),'projects/\n');await skill(root,'skills','role');await skill(root,'skills','shared');
 const projects={};for(const id of ['a','b']){const path=join(root,'projects',id);await mkdir(path,{recursive:true});await git(path,['init','-b','main']);await writeFile(join(path,'.gitignore'),'repositories/\n');await skill(path,'.agents/skills','common');await skill(path,'.agents/skills','shared');await skill(path,'.agents/skills',id);await commit(path);await git(path,['remote','add','origin','https://example.invalid/'+id]);projects[id]={name:id,url:'https://example.invalid/'+id,branch:'main',repository:'projects/'+id,skills:['projects/'+id+'/.agents/skills']};}
 const child=join(root,'projects/a/repositories/frontend');await mkdir(child,{recursive:true});await git(child,['init','-b','main']);await skill(child,'.agents/skills','common');await skill(child,'.agents/skills','frontend');await skill(child,'.agents/skills','manual','disable-model-invocation: true\n');await commit(child);
 await writeFile(join(root,'projects.json'),JSON.stringify({schemaVersion:1,projects}));await commit(root);
 const host={agents:{list:[{id:'main'}]},skills:{entries:{frontend:{enabled:false}}}},config=resolveConfiguration({agents:{main:{repo:root}}}),inspector=createProjectInspector(config,()=>host,()=>123);
 return {root,child,host,inspector,ctx:{agentId:'main',sessionKey:'agent:main:test'}};
}
test('catalog follows trusted Agent and scopes, overlays and disabled candidates match runtime rules',async t=>{
 const f=await fixture(t),before=await git(f.root,['status','--porcelain']),list=await f.inspector.list(f.ctx);
 assert.deepEqual(list.projects.map(p=>p.projectId),['a','b']);assert.equal(list.registrationCommitted,true);assert.equal(list.scannedAt,123);
 const result=await f.inspector.detail({...f.ctx,payload:{projectId:'a',repository:'projects/a/repositories/frontend'}});
 assert.equal(result.cwd,f.root+'/projects/a');assert.equal(result.scopes.length,2);assert.ok(!JSON.stringify(result).includes('projects/b/.agents'));
 const [project,child,role]=result.sources;
 assert.equal(project.skills.find(s=>s.name==='common').status,'shadowed');assert.equal(child.skills.find(s=>s.name==='common').status,'candidate');assert.equal(project.skills.find(s=>s.name==='shared').overriddenBy,'skills/shared/SKILL.md');assert.equal(role.skills.find(s=>s.name==='shared').status,'candidate');
 assert.equal(child.skills.find(s=>s.name==='frontend').disabledReason,'宿主配置已禁用');assert.equal(child.skills.find(s=>s.name==='manual').status,'disabled');
 assert.equal(child.skills.find(s=>s.name==='common').updatedAt,(await git(f.child,['log','-1','--format=%cI','--','.agents/skills/common'])).trim());
 f.host.agents.list[0].skills=['role'];assert.equal((await f.inspector.detail({...f.ctx,payload:{projectId:'a'}})).sources[0].skills[0].status,'disabled');
 assert.equal(await git(f.root,['status','--porcelain']),before);
 await assert.rejects(f.inspector.list({agentId:'other'}));await assert.rejects(f.inspector.list({...f.ctx,sessionKey:'agent:other:test'}));await assert.rejects(f.inspector.list({...f.ctx,payload:{agentId:'other'}}));
 await assert.rejects(f.inspector.detail({...f.ctx,payload:{projectId:'a',repository:'projects/b'}}));await assert.rejects(f.inspector.detail({...f.ctx,payload:{projectId:'a',cwd:'/tmp'}}));
 await mkdir(join(f.child,'.agents/skills/common/references'));await writeFile(join(f.child,'.agents/skills/common/references/notes.md'),'Updated reference');await commit(f.child);
 const changed=await f.inspector.detail({...f.ctx,payload:{projectId:'a',repository:'projects/a/repositories/frontend'}});assert.equal(changed.sources[1].skills.find(s=>s.name==='common').updatedCommit,(await git(f.child,['rev-parse','HEAD'])).trim());
 await rm(join(f.root,'projects/b'),{recursive:true});const missing=await f.inspector.detail({...f.ctx,payload:{projectId:'b'}});assert.equal(missing.inspection.git.state,'missing');assert.equal(missing.sources[0].state,'unavailable');
});
test('dirty inspection shows committed metadata without loading changes or following linked sibling scopes',async t=>{
 const f=await fixture(t),file=join(f.child,'.agents/skills/common/SKILL.md'),original=await readFile(file,'utf8');await writeFile(file,original.replace('Fixture','Uncommitted description'));
 await symlink(join(f.root,'projects/b'),join(f.root,'projects/a/repositories/linked'));
 const detail=await f.inspector.detail({...f.ctx,payload:{projectId:'a',repository:'projects/a/repositories/frontend'}}),source=detail.sources[1];
 assert.equal(source.state,'dirty');assert.equal(source.skills.find(s=>s.name==='common').description,'Fixture');assert.equal(source.skills.find(s=>s.name==='common').status,'pending_commit');assert.ok(!detail.scopes.some(s=>s.label==='linked'));
 await assert.rejects(readSkillSource(f.child,'.agents/skills',f.root,'repository'),/must be committed/);
 await skill(f.child,'.agents/skills/manual/nested','hidden');await commit(f.child);assert.ok(!(await readSkillSource(f.child,'.agents/skills',f.root,'repository',{inspection:true})).entries.some(s=>s.name==='hidden'));
});
test('native actions require read scope and chunk ownership includes Agent and conversation',async()=>{
 let clock=0;const actions=[];registerProjectInspector({registerSessionAction:a=>actions.push(a)},{list:async()=>({text:'x'.repeat(80000)}),detail:async()=>{throw Error('secret-path');}},{now:()=>clock});
 assert.deepEqual(actions.filter(a=>!['projects-workspacePoolSave','projects-scheduleManage','projects-clearRepositoryLogs','projects-syncPeople','projects-updatePerson','projects-deletePerson','projects-maintenanceRun'].includes(a.id)).map(a=>a.requiredScopes),Array(14).fill(['operator.read']));assert.deepEqual(actions.find(a=>a.id==='projects-clearRepositoryLogs').requiredScopes,['operator.write']);assert.deepEqual(actions.find(a=>a.id==='projects-syncPeople').requiredScopes,['operator.write']);assert.deepEqual(actions.find(a=>a.id==='projects-maintenanceRun').requiredScopes,['operator.write']);const ctx={agentId:'main',sessionKey:'agent:main:test'};
 const actual=await readInspectionResponse((action,payload)=>actions.find(a=>a.id==='projects-'+action).handler({...ctx,payload}),'list',{});assert.equal(actual.text.length,80000);
 const first=await actions[0].handler(ctx),transferId=first.result.transferId;
 for(const extra of [{agentId:'other',sessionKey:'agent:other:test'},{sessionKey:'agent:main:other'},{payload:{transferId,index:-1}},{payload:{transferId,index:3}}])assert.equal((await actions[2].handler({...ctx,payload:{transferId,index:1},...extra})).ok,false);
 clock=120001;assert.equal((await actions[2].handler({...ctx,payload:{transferId,index:1}})).ok,false);assert.ok(!JSON.stringify(await actions[1].handler(ctx)).includes('secret-path'));
});

test('subagent inspection stays within trusted registered project and chosen subrepository',async t=>{
 const f=await fixture(t),define=async(root,name)=>{await mkdir(join(root,'.agents/agents'),{recursive:true});await writeFile(join(root,'.agents/agents/review.md'),`---\nname: ${name}\ndescription: Scope fixture\n---\nReview`);await commit(root);};
 await define(f.root,'shared-review');await define(join(f.root,'projects/a'),'review');await define(join(f.root,'projects/b'),'foreign-review');await define(f.child,'review');
 const list=await f.inspector.list(f.ctx);assert.deepEqual(list.agentSubagents.subagents.map(a=>a.name),['shared-review']);assert.ok(!JSON.stringify(list.agentSubagents).includes('foreign-review'));
 const root=await f.inspector.detail({...f.ctx,payload:{projectId:'a'}});assert.equal(root.candidateSubagentCount,2);assert.equal(root.subagentSources.length,2);assert.ok(!JSON.stringify(root.subagentSources).includes('repositories/frontend'));
 const child=await f.inspector.detail({...f.ctx,payload:{projectId:'a',repository:'projects/a/repositories/frontend'}});assert.equal(child.candidateSubagentCount,2);assert.equal(child.subagentSources[0].subagents[0].status,'shadowed');assert.equal(child.subagentSources[1].subagents[0].status,'candidate');assert.ok(!JSON.stringify(child.subagentSources).includes('foreign-review'));
});


test('sync history is scoped to trusted Agent, read only, and accepts only a receipt date',async t=>{
 const f=await fixture(t),file=join(f.root,'.git/agent-repo-daily-sync-main-2026-10-14.json');
 await writeFile(file,JSON.stringify({agentId:'main',date:'2026-10-14',status:'failed',startedAt:'2026-10-14T00:00:00Z',finishedAt:'2026-10-14T00:00:01Z',result:{ok:false,failures:[{projectId:'a',reason:'frontend 有本地改动'}]},logs:[{time:'2026-10-14T00:00:01Z',stage:'检查',status:'failed',projectId:'a',reason:'frontend 有本地改动',privateField:'excluded'}]}));
 const before=await readFile(file,'utf8'),catalog=await f.inspector.list(f.ctx);
 assert.equal(catalog.syncHistory.records[0].status,'failed');assert.equal(catalog.syncHistory.records[0].logs,undefined);
 const record=await f.inspector.syncRecord({...f.ctx,payload:{date:'2026-10-14'}});
 assert.equal(record.logs[0].reason,'frontend 有本地改动');assert.equal(record.logs[0].privateField,undefined);
 for(const payload of [{date:'../secret'},{date:'2026-10-14',agentId:'other'},{date:'2026-10-14',path:'/tmp/log'}])await assert.rejects(f.inspector.syncRecord({...f.ctx,payload}));
 await assert.rejects(f.inspector.syncRecord({...f.ctx,agentId:'other',payload:{date:'2026-10-14'}}));
 assert.equal(await readFile(file,'utf8'),before);
});


test('task record selector binds legacy receipts to the trusted Agent task and rejects foreign or arbitrary selectors',async t=>{
 const f=await fixture(t),file=join(f.root,'.git/agent-repo-daily-sync-main-2026-10-14.json');
 await writeFile(file,JSON.stringify({agentId:'main',date:'2026-10-14',status:'failed',result:{reason:'local changes'}}));
 const result=await f.inspector.taskRecord({...f.ctx,payload:{taskId:'repo-sync:main',runId:'repo-sync:main:2026-10-14'}});assert.equal(result.taskId,'repo-sync:main');assert.equal(result.runId,'repo-sync:main:2026-10-14');
 const tasks=(await f.inspector.list(f.ctx)).scheduledTasks;assert.equal(tasks.length,1);assert.equal(tasks[0].readOnly,true);assert.equal(tasks[0].enabled,false);assert.equal(tasks[0].records[0].runId,result.runId);
 for(const payload of [{taskId:'repo-sync:other',runId:'repo-sync:other:2026-10-14'},{taskId:'repo-sync:main',runId:'repo-sync:other:2026-10-14'},{taskId:'repo-sync:main',runId:'repo-sync:main:../private'},{taskId:'repo-sync:main',runId:result.runId,path:'/tmp/private'}])await assert.rejects(f.inspector.taskRecord({...f.ctx,payload}));
 assert.equal(JSON.parse(await readFile(file,'utf8')).taskId,undefined);
});

test('repository logs reject foreign Agents and arbitrary payload scopes',async t=>{
 const f=await fixture(t),{writeRepositoryLog}=await import('./repository-log.mjs');
 await writeRepositoryLog(f.root,'main',{status:'skipped',reason:'local work'});
 const logs=await f.inspector.repositoryLogs(f.ctx);assert.equal(logs.agentId,'main');assert.equal(logs.records[0].reason,'local work');
 for(const payload of [{agentId:'other'},{path:'/tmp/private'},{projectId:'a'}])await assert.rejects(f.inspector.repositoryLogs({...f.ctx,payload}));
 await assert.rejects(f.inspector.repositoryLogs({...f.ctx,agentId:'other'}));
});

test('log clearing requires trusted Agent, operator write and explicit confirmation',async t=>{
 const f=await fixture(t),{writeRepositoryLog}=await import('./repository-log.mjs');await writeRepositoryLog(f.root,'main',{reason:'diagnostic'});
 const ctx={...f.ctx,client:{scopes:['operator.write']},payload:{confirmed:true}};
 for(const extra of [{client:{scopes:['operator.read']}},{payload:{}},{payload:{confirmed:false}},{payload:{confirmed:true,agentId:'other'}},{agentId:'other'}])await assert.rejects(f.inspector.clearRepositoryLogs({...ctx,...extra}));
 assert.equal((await f.inspector.repositoryLogs(f.ctx)).records.length,1);
 const cleared=await f.inspector.clearRepositoryLogs(ctx);assert.equal(cleared.cleared,1);assert.deepEqual(cleared.records,[]);
});
test('linked task inspection uses trusted Agent and refuses foreign task records',async t=>{
 const {scheduledRequestBridge}=await import('./scheduled-requests.mjs');const previous=scheduledRequestBridge.inspect;t.after(()=>{if(previous)scheduledRequestBridge.inspect=previous;else delete scheduledRequestBridge.inspect;});
 const f=await fixture(t),seen=[];const record={taskId:'scheduled-request:owned',runId:'scheduled-request:owned:1',status:'submitted',logs:[]};scheduledRequestBridge.inspect=async agentId=>{seen.push(agentId);return [{taskId:record.taskId,records:[record]}];};
 assert.equal((await f.inspector.list(f.ctx)).scheduledTasks.at(-1).taskId,record.taskId);assert.deepEqual(await f.inspector.taskRecord({...f.ctx,payload:{taskId:record.taskId,runId:record.runId}}),record);assert.ok(seen.every(id=>id==='main'));await assert.rejects(f.inspector.taskRecord({...f.ctx,payload:{taskId:'scheduled-request:foreign',runId:'scheduled-request:foreign:1'}}));
});
test('schedule management actions enforce writer scope and trusted agent before invoking bridge',async t=>{
 const {scheduledRequestBridge}=await import('./scheduled-requests.mjs'),saved={...scheduledRequestBridge};t.after(()=>{delete scheduledRequestBridge.catalog;delete scheduledRequestBridge.administer;Object.assign(scheduledRequestBridge,saved);});
 const f=await fixture(t),calls=[];scheduledRequestBridge.catalog=async agentId=>({agentId,tasks:[{id:'one',projectId:'a'}]});scheduledRequestBridge.administer=async(...args)=>{calls.push(args);return {status:'succeeded'};};
 await assert.rejects(f.inspector.scheduleManage({...f.ctx,payload:{action:'pause'}}),/写入权限/);assert.equal(calls.length,0);
 await f.inspector.scheduleManage({...f.ctx,client:{scopes:['operator.write']},payload:{action:'pause',id:'one'}});assert.equal(calls[0][0],'main');
 await assert.rejects(f.inspector.scheduleCatalog({...f.ctx,payload:{agentId:'other'}}),/范围/);
 const actions=[];registerProjectInspector({registerSessionAction:a=>actions.push(a)},f.inspector);assert.deepEqual(actions.find(a=>a.id==='projects-scheduleManage').requiredScopes,['operator.write']);assert.deepEqual(actions.find(a=>a.id==='projects-scheduleCatalog').requiredScopes,['operator.read']);
});
test('repository schedule catalog and mutation stay bound to trusted Agent and writer permission',async t=>{
 const {repositoryScheduleBridge}=await import('./scheduled-tasks.mjs'),saved={...repositoryScheduleBridge};t.after(()=>{for(const k of Object.keys(repositoryScheduleBridge))delete repositoryScheduleBridge[k];Object.assign(repositoryScheduleBridge,saved);});
 const f=await fixture(t),calls=[];repositoryScheduleBridge.catalog=async id=>[{id:'repo-sync:'+id,kind:'repository-sync',operations:[]}];repositoryScheduleBridge.administer=async(...args)=>{calls.push(args);return {status:'succeeded'};};
 const catalog=await f.inspector.scheduleCatalog(f.ctx);assert.equal(catalog.tasks[0].id,'repo-sync:main');
 await assert.rejects(f.inspector.scheduleManage({...f.ctx,payload:{id:'repo-sync:main',action:'pause'}}),/写入/);await f.inspector.scheduleManage({...f.ctx,client:{scopes:['operator.write']},payload:{id:'repo-sync:main',action:'pause'}});assert.equal(calls[0][0],'main');assert.equal(calls.length,1);
});

test('workspace management scopes reads and writes, detects stale config and preserves occupied slots',async t=>{
 const f=await fixture(t),ctx={...f.ctx,payload:{projectId:'a'}},before=await f.inspector.workspacePool(ctx);
 assert.equal(before.config.enabled,false);assert.deepEqual(before.slots,[]);
 const payload={projectId:'a',revision:before.revision,enabled:true,maxSize:2};
 await assert.rejects(f.inspector.workspacePoolSave({...ctx,payload}),/写入权限/);
 const write={...ctx,client:{scopes:['operator.write']},payload};
 const after=await f.inspector.workspacePoolSave(write);assert.equal(after.config.maxSize,2);assert.equal(after.pendingCommit,true);
 const syncLock=join(f.root,'.git/ada-workspace-sync.lock');await writeFile(syncLock,String(process.pid));await assert.rejects(f.inspector.workspacePoolSave({...write,payload:{...payload,revision:after.revision,maxSize:3}}),/同步/);await rm(syncLock);
 const unchanged=await readFile(join(f.root,'projects.json'),'utf8');const noop=await f.inspector.workspacePoolSave({...write,payload:{...payload,revision:after.revision}});assert.equal(noop.revision,after.revision);assert.equal(await readFile(join(f.root,'projects.json'),'utf8'),unchanged);
 await assert.rejects(f.inspector.workspacePoolSave(write),/刷新/);
 await mkdir(join(f.root,'workspace'));const state={version:1,workspaces:{'a-0':{id:'a-0',projectId:'a',status:'running',owner:'job-a'},'b-0':{id:'b-0',projectId:'b',status:'blocked',owner:'private-b'}}};
 await writeFile(join(f.root,'workspace/state.json'),JSON.stringify(state));
 const current=await f.inspector.workspacePool(ctx);assert.equal(current.slots.length,1);assert.equal(current.occupied,1);assert.ok(!JSON.stringify(current).includes('private-b'));
 await f.inspector.workspacePoolSave({...write,payload:{...payload,revision:current.revision,enabled:false,maxSize:1}});
 assert.deepEqual(JSON.parse(await readFile(join(f.root,'workspace/state.json'))),state);
 await assert.rejects(f.inspector.workspacePool({...ctx,payload:{projectId:'missing'}}));
 await assert.rejects(f.inspector.workspacePoolSave({...write,payload:{...payload,maxSize:0}}));
 const actions=[];registerProjectInspector({registerSessionAction:a=>actions.push(a)},f.inspector);assert.deepEqual(actions.find(a=>a.id==='projects-workspacePoolSave').requiredScopes,['operator.write']);
 const latest=await f.inspector.workspacePool(ctx),results=await Promise.allSettled([2,3].map(maxSize=>f.inspector.workspacePoolSave({...write,payload:{...payload,revision:latest.revision,maxSize}})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 await writeFile(join(f.root,'workspace/state.json'),'{corrupt');await assert.rejects(f.inspector.workspacePool(ctx),/状态不可读取/);
 const saved=await readFile(join(f.root,'projects.json'),'utf8');await assert.rejects(f.inspector.workspacePoolSave({...write,payload:{...payload,revision:(await import('node:crypto')).createHash('sha256').update(saved).digest('hex'),maxSize:4}}),/状态不可读取/);assert.equal(await readFile(join(f.root,'projects.json'),'utf8'),saved);

});
