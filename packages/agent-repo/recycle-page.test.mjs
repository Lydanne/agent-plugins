import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,uiContext,settle,click,deferred} from '../../scripts/control-ui-test.mjs';
const entry={id:'plan',name:'日报',kind:'group-schedule',feature:'schedules',provider:'group-schedules',deletedAt:1000,expiresAt:2000,revision:'v1',preview:{schedule:{expr:'0 7 * * *'},task:'Read group'}};
const catalog={agentId:'main',settings:{retentionDays:30,revision:'policy-1'},records:[entry],total:1,nextOffset:null,unavailable:[]};
test('floating recycle control lazily reads, confirms restore with current version and preserves pending outcomes',async t=>{
 const f=await browserFixture(t,new URL('./recycle-page.mjs',import.meta.url).pathname),calls=[];let restored=0,unknown=true;
 const ctx=uiContext(async(method,p)=>{calls.push(p);return {ok:true,result:p.actionId==='projects-recycleBin'?catalog:{status:unknown?'unknown':'succeeded',restored:true}};});ctx.host.connection.canWrite=true;
 f.track(f.ui.mountRecycleBin(f.container,ctx,'main',{onRestored:()=>restored++}));assert.equal(calls.length,0);click(f.container,'回收站');await settle();assert.equal(calls[0].actionId,'projects-recycleBin');assert.match(f.container.textContent,/Read group/);
 f.container.querySelector('[aria-label="恢复日报"]').click();assert.match(f.container.textContent,/保持暂停/);assert.equal(calls.length,1);click(f.container,'确认执行');await settle();assert.equal(restored,0);assert.match(f.container.textContent,/不要新建请求/);const p=calls.at(-1).payload;assert.equal(p.id,'plan');assert.equal(p.provider,'group-schedules');assert.equal(p.expectedRevision,'v1');assert.equal(p.confirmed,true);assert.equal(calls.at(-1).agentId,'main');
 unknown=false;click(f.container,'确认执行');await settle();assert.deepEqual(calls.filter(c=>c.actionId==='projects-recycleRestore').map(c=>c.payload.requestId),[p.requestId,p.requestId]);assert.equal(restored,1);
});
test('retention changes are reviewed before submission and readonly connections cannot restore or configure',async t=>{
 const f=await browserFixture(t,new URL('./recycle-page.mjs',import.meta.url).pathname),calls=[],ctx=uiContext(async(method,p)=>{calls.push(p);return {ok:true,result:p.actionId==='projects-recycleBin'?catalog:{status:'succeeded'}};});ctx.host.connection.canWrite=true;
 const view=f.track(f.ui.mountRecycleBin(f.container,ctx,'main'));click(f.container,'回收站');await settle();const input=f.container.querySelector('[aria-label="回收站保留天数"]');input.value='7';click(f.container,'保存保留期限');assert.match(f.container.textContent,/下次后台清理时永久删除/);assert.equal(calls.length,1);click(f.container,'确认执行');await settle();assert.equal(calls.find(c=>c.actionId==='projects-recycleConfigure').payload.retentionDays,7);assert.equal(calls.find(c=>c.actionId==='projects-recycleConfigure').payload.expectedRevision,'policy-1');
 view.dispose();ctx.host.connection.canWrite=false;f.track(f.ui.mountRecycleBin(f.container,ctx,'main'));click(f.container,'回收站');await settle();assert.equal(f.container.querySelector('[aria-label="恢复日报"]').disabled,true);assert.equal(f.container.querySelector('[aria-label="回收站保留天数"]').disabled,true);
});
test('closing or switching away suppresses delayed trash responses',async t=>{
 const f=await browserFixture(t,new URL('./recycle-page.mjs',import.meta.url).pathname),pending=deferred(),ctx=uiContext(async()=>pending.promise);
 const view=f.track(f.ui.mountRecycleBin(f.container,ctx,'main'));click(f.container,'回收站');view.dispose();pending.resolve({ok:true,result:catalog});await settle();assert.equal(f.container.querySelector('dialog'),null);assert.ok(!f.container.textContent.includes('日报'));
});

test('restoring the last item on a page returns to a valid page instead of displaying a false empty bin',async t=>{
 const f=await browserFixture(t,new URL('./recycle-page.mjs',import.meta.url).pathname),entries=Array.from({length:26},(_,i)=>({...entry,id:'plan-'+i,name:'Plan '+i})),reads=[];
 const ctx=uiContext(async(method,p)=>{if(p.actionId==='projects-recycleRestore'){entries.splice(entries.findIndex(e=>e.id===p.payload.id),1);return {ok:true,result:{status:'succeeded'}};}const {offset,limit}=p.payload;reads.push(offset);return {ok:true,result:{...catalog,records:entries.slice(offset,offset+limit),total:entries.length,nextOffset:offset+limit<entries.length?offset+limit:null}};});ctx.host.connection.canWrite=true;
 f.track(f.ui.mountRecycleBin(f.container,ctx,'main'));click(f.container,'回收站');await settle();click(f.container,'下一页');await settle();f.container.querySelector('[aria-label="恢复Plan 25"]').click();click(f.container,'确认执行');await settle();assert.match(f.container.textContent,/共 25 项/);assert.equal(f.container.querySelectorAll('.ar-recycle-item').length,25);assert.equal(reads.at(-1),0);assert.ok(!f.container.textContent.includes('回收站为空或没有匹配内容'));
});
