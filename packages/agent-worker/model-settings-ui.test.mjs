import test from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,settle,uiContext,select,click,deferred} from '../../scripts/control-ui-test.mjs';
const initialModels=[{id:'quick',harness:'codex',model:'fixture-quick',name:'常规',thinkingProfiles:{6:{reasoningEffort:'max',speed:'fast'}}},{id:'deep',harness:'codex',model:'fixture-deep'}];
function snapshot(models=initialModels,defaultModelId='quick'){return {valid:true,hash:'revision-1',config:{plugins:{entries:{'agent-worker':{config:{models,defaultModelId,model:'fixture-legacy',reasoningEffort:'high',state:'/private/worker',businessDataPolicy:'DO_NOT_LEAK'}}}},env:{secret:'DO_NOT_LEAK'}}};}
function change(f,label,value){const input=f.container.querySelector(`[aria-label="${label}"]`);assert.ok(input,'Missing field '+label);input.value=value;input.dispatchEvent(new f.window.Event('change'));}
async function fixture(t,{models=initialModels,defaultModelId='quick',request,canAdmin=true}={}){
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),calls=[];
 const ctx=uiContext(async(method,params)=>{calls.push({method,params});return request?request(method,params):method==='config.get'?snapshot(models,defaultModelId):{ok:true};});ctx.host.connection.canWrite=true;ctx.host.connection.canAdmin=canAdmin;
 const view=f.track(f.ui.mountModelSettings(f.container,ctx));await settle();return {...f,ctx,calls,view};
}
test('graphical editor loads all models and tier profiles without rendering unrelated config',async t=>{
 const f=await fixture(t);assert.equal(f.container.querySelectorAll('.cq-model-card').length,2);assert.equal(f.container.querySelector('[aria-label="模型 1 等级 6 推理强度"]').value,'max');assert.ok(!f.container.textContent.includes('DO_NOT_LEAK'));assert.ok(!f.container.textContent.includes('/private/worker'));assert.equal(f.calls.length,1);
});
test('adding and editing multiple models stays a draft until confirmation and patches only model fields',async t=>{
 const f=await fixture(t,{models:[],defaultModelId:''});assert.match(f.container.textContent,/兼容模型 fixture-legacy/);
 click(f.container,'新增模型');change(f,'模型 1 ID','quick');change(f,'模型 1 模型标识','fixture-quick');change(f,'模型 1 名称','常规');click(f.container,'新增模型');change(f,'模型 2 ID','deep');change(f,'模型 2 模型标识','fixture-deep');select(f.window,f.container,'默认模型','deep');select(f.window,f.container,'模型 2 等级 6 推理强度','max');select(f.window,f.container,'模型 2 等级 6 速度','fast');
 assert.equal(f.calls.filter(c=>c.method==='config.patch').length,0);click(f.container,'保存模型配置');assert.equal(f.calls.length,1);click(f.container,'确认保存');await settle();
 const patch=f.calls.find(c=>c.method==='config.patch').params;assert.equal(patch.baseHash,'revision-1');assert.deepEqual(patch.replacePaths,['plugins.entries.agent-worker.config.models']);
 const raw=JSON.parse(patch.raw);assert.deepEqual(Object.keys(raw),['plugins']);const saved=raw.plugins.entries['agent-worker'].config;assert.deepEqual(Object.keys(saved),['models','defaultModelId']);assert.equal(saved.models.length,2);assert.equal(saved.defaultModelId,'deep');assert.deepEqual(saved.models[1].thinkingProfiles,{6:{reasoningEffort:'max',speed:'fast'}});assert.match(f.container.textContent,/配置已保存/);assert.match(f.container.textContent,/可能重启/);
});
test('editing IDs preserves automatic default selection and follows an explicitly selected default',async t=>{
 const f=await fixture(t,{defaultModelId:''});change(f,'模型 1 ID','renamed');assert.equal(f.container.querySelector('[aria-label="默认模型"]').value,'');select(f.window,f.container,'默认模型','renamed');change(f,'模型 1 ID','changed-again');assert.equal(f.container.querySelector('[aria-label="默认模型"]').value,'changed-again');
});
test('removing a default model requires confirmation and clears the obsolete default without saving',async t=>{
 const f=await fixture(t);click(f.container,'删除模型');click(f.container,'取消');assert.equal(f.container.querySelectorAll('.cq-model-card').length,2);click(f.container,'删除模型');click(f.container,'确认移除');assert.equal(f.container.querySelectorAll('.cq-model-card').length,1);assert.equal(f.container.querySelector('[aria-label="默认模型"]').value,'');assert.equal(f.calls.length,1);
 click(f.container,'保存模型配置');click(f.container,'确认保存');await settle();const saved=JSON.parse(f.calls.find(c=>c.method==='config.patch').params.raw).plugins.entries['agent-worker'].config;assert.deepEqual(saved.models,[initialModels[1]]);assert.equal(saved.defaultModelId,'');
});
test('duplicate IDs and model targets cannot be saved',async t=>{
 const f=await fixture(t);change(f,'模型 2 ID','quick');click(f.container,'保存模型配置');assert.match(f.container.textContent,/不能重复/);assert.equal(f.calls.length,1);change(f,'模型 2 ID','deep');change(f,'模型 2 模型标识','fixture-quick');click(f.container,'保存模型配置');assert.match(f.container.textContent,/不能重复/);assert.equal(f.calls.length,1);
});
test('saving an empty model list uses an explicit replacement and retains legacy fallback',async t=>{
 const f=await fixture(t,{models:[initialModels[0]]});click(f.container,'删除模型');click(f.container,'确认移除');click(f.container,'保存模型配置');click(f.container,'确认保存');await settle();const patch=f.calls.find(c=>c.method==='config.patch').params;assert.deepEqual(JSON.parse(patch.raw).plugins.entries['agent-worker'].config,{models:[],defaultModelId:''});
});
test('failed writes keep the draft and do not retry automatically or overwrite a newer revision',async t=>{
 const f=await fixture(t,{request:async method=>{if(method==='config.get')return snapshot();throw Error('config base hash mismatch');}});change(f,'模型 1 名称','edited');click(f.container,'保存模型配置');click(f.container,'确认保存');await settle();assert.match(f.container.textContent,/base hash mismatch/);assert.equal(f.container.querySelector('[aria-label="模型 1 名称"]').value,'edited');assert.equal(f.calls.filter(c=>c.method==='config.patch').length,1);
 click(f.container,'放弃草稿并重新读取');assert.equal(f.calls.filter(c=>c.method==='config.get').length,1);click(f.container,'确认重新读取');await settle();assert.equal(f.calls.filter(c=>c.method==='config.get').length,2);assert.equal(f.container.querySelector('[aria-label="模型 1 名称"]').value,'常规');
});
test('write scope alone cannot edit instance config and losing admin dismisses pending confirmation',async t=>{
 const f=await fixture(t,{canAdmin:false});assert.match(f.container.textContent,/operator.admin/);assert.equal([...f.container.querySelectorAll('button')].find(b=>b.textContent==='新增模型').disabled,true);assert.equal(f.calls.length,1);
 f.ctx.host.connection.canAdmin=true;f.ctx.notify();click(f.container,'新增模型');change(f,'模型 3 ID','third');change(f,'模型 3 模型标识','fixture-third');click(f.container,'保存模型配置');f.ctx.host.connection.canAdmin=false;f.ctx.notify();assert.equal(f.container.querySelector('.cq-model-confirm'),null);assert.equal(f.calls.length,1);
});
test('ordinary host updates preserve uncommitted typing and do not reload the draft',async t=>{
 const f=await fixture(t);const input=f.container.querySelector('[aria-label="模型 1 名称"]');input.value='in-progress typing';f.ctx.notify();f.view.update({...f.ctx});assert.equal(f.container.querySelector('[aria-label="模型 1 名称"]'),input);assert.equal(input.value,'in-progress typing');assert.equal(f.calls.length,1);
});
test('read failure is distinct from an empty model list and late reads cannot restore revoked data',async t=>{
 const pending=deferred(),f=await fixture(t,{request:()=>pending.promise});assert.match(f.container.textContent,/正在读取/);f.ctx.host.connection.canRead=false;f.ctx.notify();pending.resolve(snapshot());await settle();assert.match(f.container.textContent,/operator.read/);assert.equal(f.container.querySelectorAll('.cq-model-card').length,0);
});
test('unmount ignores late save receipts without sending another patch',async t=>{
 const pending=deferred(),f=await fixture(t,{request:method=>method==='config.get'?snapshot():pending.promise});change(f,'模型 1 名称','edited');click(f.container,'保存模型配置');click(f.container,'确认保存');f.view.dispose();pending.resolve({ok:true});await settle();assert.equal(f.calls.filter(c=>c.method==='config.patch').length,1);assert.equal(f.container.querySelector('.cq-model-settings'),null);
});

test('save starts disabled until a draft changes and clearing an optional tier field is persisted',async t=>{
 const f=await fixture(t);assert.equal(f.container.querySelector('.cq-model-submit').disabled,true);select(f.window,f.container,'模型 1 等级 6 速度','');assert.equal(f.container.querySelector('.cq-model-submit').disabled,false);select(f.window,f.container,'模型 1 等级 6 推理强度','');click(f.container,'保存模型配置');click(f.container,'确认保存');await settle();const saved=JSON.parse(f.calls.find(c=>c.method==='config.patch').params.raw).plugins.entries['agent-worker'].config;assert.equal(saved.models[0].thinkingProfiles,undefined);
});
test('sidebar model configuration entry uses the public plugin page navigation',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),targets=[];
 const ctx=uiContext(async()=>({ok:true,result:{sessions:[],projectIds:[],counts:{},groupCounts:{},hasMore:false}}),{sessionKey:'chat'});ctx.host.navigation={openPage:target=>targets.push(target)};
 f.track(f.ui.mountPanel(f.container,ctx));await settle();click(f.container,'模型配置');assert.deepEqual(targets,[{id:'models'}]);
});

test('adding the first explicit model clears a legacy default ID instead of leaving an invisible invalid selection',async t=>{
 const f=await fixture(t,{models:[],defaultModelId:'default'});click(f.container,'新增模型');change(f,'模型 1 ID','first');change(f,'模型 1 模型标识','fixture-first');assert.equal(f.container.querySelector('[aria-label="默认模型"]').value,'');click(f.container,'保存模型配置');click(f.container,'确认保存');await settle();assert.equal(JSON.parse(f.calls.find(c=>c.method==='config.patch').params.raw).plugins.entries['agent-worker'].config.defaultModelId,'');
});

test('an operator can discard a draft and reread after losing admin permission',async t=>{
 const f=await fixture(t);change(f,'模型 1 名称','edited');f.ctx.host.connection.canAdmin=false;f.ctx.notify();click(f.container,'放弃草稿并重新读取');click(f.container,'确认重新读取');await settle();assert.equal(f.container.querySelector('[aria-label="模型 1 名称"]').value,'常规');assert.equal(f.calls.filter(c=>c.method==='config.patch').length,0);assert.equal(f.calls.filter(c=>c.method==='config.get').length,2);
});
