import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,uiContext,settle,click,deferred} from '../../scripts/control-ui-test.mjs';
const provider={apiVersion:1,id:'fixture.cli',label:'Fixture CLI',ownerLabel:'Fixture 插件',kind:'cli',scope:'当前宿主共享',state:'available',revision:'a'.repeat(64),versions:{current:'1.0.98',available:'1.0.99'},fields:[{label:'诊断字段',value:'private hash'}],skills:[{name:'fixture-skill',description:'fixture description'}],policy:{autoUpdate:true,version:'1.0.98',updateCheckIntervalHours:24},actions:[{id:'configure',label:'保存更新策略',settings:true},{id:'check',label:'检查更新'},{id:'update',label:'更新 CLI'}],history:[]};
const snapshot={apiVersion:1,observedAt:'2026-10-20T00:00:00Z',providers:[provider]};
const sources=[{source:'agent',directory:'skills',skills:[{name:'repo-skill',description:'仓库技能用途',path:'skills/repo/SKILL.md',updatedCommit:'b'.repeat(40),status:'candidate'}]}];
test('skills and CLI share details, associations navigate both ways, technical fields stay in diagnostics',async t=>{
 const f=await browserFixture(t,new URL('./skill-maintenance-page.mjs',import.meta.url).pathname),calls=[];
 f.track(f.ui.mountSkillMaintenance(f.container,uiContext(async(_m,p)=>{calls.push(p);return {ok:true,result:snapshot};}),'main',{sources}));await settle();
 click(f.container,'fixture-skill');assert.match(f.container.querySelector('aside').textContent,/fixture description/);assert.ok(!f.container.textContent.includes('private hash'));
 click(f.container,'查看 CLI 详情');assert.match(f.container.querySelector('aside').textContent,/1.0.99/);assert.match(f.container.querySelector('aside').textContent,/当前宿主共享/);
 assert.equal(f.container.querySelector('.ar-maintenance-associations').open,false);f.container.querySelector('.ar-maintenance-associations').open=true;const associated=[...f.container.querySelector('aside').querySelectorAll('button')].find(button=>button.textContent.startsWith('fixture-skill'));associated.click();assert.match(f.container.querySelector('aside').getAttribute('aria-label'),/技能详情/);
 click(f.container,'repo-skill');assert.match(f.container.querySelector('aside').textContent,/仓库技能用途/);assert.ok(!f.container.textContent.includes('b'.repeat(40)));click(f.container,'诊断');assert.match(f.container.querySelector('aside').textContent,/skills\/repo/);
 const search=f.container.querySelector('input[type=search]');search.value='skills/repo';search.dispatchEvent(new f.window.Event('input'));assert.equal(f.container.querySelectorAll('tbody tr').length,1);
 assert.ok(calls.every(p=>p.agentId==='main'&&p.sessionKey==='agent:main:agent-repo-management'));
});
test('update settings are edited before confirmation; ambiguous retries reuse the original request',async t=>{
 const f=await browserFixture(t,new URL('./skill-maintenance-page.mjs',import.meta.url).pathname),calls=[];let fail=true;
 const ctx=uiContext(async(_method,request)=>{calls.push(request);if(request.actionId==='projects-maintenance')return {ok:true,result:snapshot};if(fail)throw Error('connection lost');return {ok:true,result:{id:'op',status:'running'}};});ctx.host.connection.canWrite=true;
 f.track(f.ui.mountSkillMaintenance(f.container,ctx,'main'));await settle();click(f.container,'关联 CLI');click(f.container,'Fixture CLI');click(f.container,'更新设置');
 assert.equal(f.container.querySelector('.ar-maintenance-confirm'),null);const checkbox=f.container.querySelector('input[type=checkbox]');assert.equal(checkbox.checked,true);checkbox.checked=false;
 f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));assert.equal(calls.filter(row=>row.actionId==='projects-maintenanceRun').length,0);
 click(f.container,'确认执行');await settle();const first=calls.find(row=>row.actionId==='projects-maintenanceRun');assert.equal(first.payload.settings.autoUpdate,false);assert.equal(first.payload.expectedRevision,provider.revision);assert.equal(first.payload.confirmed,true);
 fail=false;click(f.container,'重试原维护请求');await settle();assert.deepEqual(calls.filter(row=>row.actionId==='projects-maintenanceRun').map(row=>row.payload.requestId),[first.payload.requestId,first.payload.requestId]);assert.match(f.container.textContent,/维护请求已受理/);
});
test('read-only and disposed maintenance pages cannot mutate or accept stale responses',async t=>{
 const f=await browserFixture(t,new URL('./skill-maintenance-page.mjs',import.meta.url).pathname),gate=deferred();
 const view=f.track(f.ui.mountSkillMaintenance(f.container,uiContext(async()=>gate.promise),'main'));view.dispose();gate.resolve({ok:true,result:snapshot});await settle();assert.equal(f.container.textContent,'');
 f.track(f.ui.mountSkillMaintenance(f.container,uiContext(async()=>({ok:true,result:snapshot})),'main'));await settle();click(f.container,'关联 CLI');click(f.container,'Fixture CLI');assert.equal([...f.container.querySelectorAll('button')].find(b=>b.textContent==='更新至 1.0.99').disabled,true);
});
test('integrated project maintenance discards previous Agent data and preserves repository skills on optional provider failures',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),gate=deferred();
 const ctx=uiContext(async(_method,p)=>p.actionId==='projects-maintenance'?p.agentId==='main'?gate.promise:Promise.reject(Error('provider not available')):{ok:true,result:{root:'/fixture',agentId:p.agentId,projects:[],agentSkills:p.agentId==='main'?{state:'available',skills:[]}:{state:'available',skills:sources[0].skills},agentSubagents:{state:'available',subagents:[]},scannedAt:1}},{agentId:'main',sessionKey:'agent:main:panel'});
 const view=f.track(f.ui.mountProjects(f.container,ctx));await settle();view.update({...ctx,props:{agentId:'other',sessionKey:'agent:other:panel'}});gate.resolve({ok:true,result:snapshot});await settle();assert.ok(!f.container.textContent.includes('fixture-skill'));assert.match(f.container.textContent,/repo-skill/);click(f.container,'repo-skill');assert.match(f.container.textContent,/仓库技能用途/);
});

test('long skill instructions stay searchable and complete in detail without expanding list summaries',async t=>{
 const f=await browserFixture(t,new URL('./skill-maintenance-page.mjs',import.meta.url).pathname);
 const description='飞书应用开发与托管。'+ '管理应用创建、发布、监控、成员与自动化触发器。'.repeat(40)+'末尾搜索标记';
 const longProvider={...provider,skills:[{name:'long-skill-name-for-application-management',description}]};
 f.track(f.ui.mountSkillMaintenance(f.container,uiContext(async()=>({ok:true,result:{...snapshot,providers:[longProvider]}})),'main'));await settle();
 const summary=f.container.querySelector('.ar-maintenance-summary');assert.ok(summary.textContent.length<=101);assert.ok(!summary.textContent.includes('末尾搜索标记'));
 assert.equal(f.container.querySelectorAll('thead th').length,2);
 const search=f.container.querySelector('input[type=search]');search.value='末尾搜索标记';search.dispatchEvent(new f.window.Event('input'));assert.equal(f.container.querySelectorAll('tbody tr').length,1);
 click(f.container,longProvider.skills[0].name);assert.equal(f.container.querySelector('.ar-maintenance-description').textContent,description);
 click(f.container,'返回列表');assert.equal(f.container.querySelector('.ar-maintenance-detail'),null);assert.equal(f.window.document.activeElement.dataset.itemKey,'fixture.cli:'+longProvider.skills[0].name);
});
