import {test,onTestFinished} from 'vitest';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {browserFixture,uiContext,settle,click,select,deferred} from '../../../scripts/control-ui-test.mjs';
const entry={path:'guide.md',title:'知识指南',uid:'guide',excerpt:'附件持久化'};
const scope={available:true,complete:true,knowledgePath:'/project/wiki',normalized:true,metadataNamespace:'x_xgj'};
const listing={...scope,entries:[entry],total:1,offset:0,nextOffset:null};
const doc={...scope,found:true,entry,content:'# 知识指南\n<script>SECRET</script>',startLine:1,endLine:2,totalLines:3,nextLine:3,sha256:'a',lineTruncated:false};
async function fixture(handler){
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),calls=[];
 const ctx=uiContext(async(method,p)=>{calls.push(p);assert.equal(method,'plugins.sessionAction');assert.equal(p.sessionKey,'agent:'+p.agentId+':agent-repo-management');return {ok:true,result:await handler(p)};},{section:'knowledge'});ctx.host.connection.canWrite=false;ctx.host.redact=value=>String(value).replaceAll('SECRET','[redacted]');
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();return {...f,ctx,calls};
}
const catalog={projects:[{projectId:'one',name:'项目一'}]};
function submit(f,value){const input=f.container.querySelector('[aria-label="搜索知识库"]');input.value=value;input.dispatchEvent(new f.window.Event('input'));input.closest('form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));}
test('read-only management browses, searches, paginates, reads escaped redacted content and validates the configured namespace',async()=>{
 const f=await fixture(async p=>p.actionId==='projects-knowledgeCatalog'?catalog:p.actionId==='projects-knowledgeRead'?{...doc,...(p.payload.startLine===3?{content:'第三行',startLine:3,endLine:3,nextLine:null}:{})}:p.actionId==='projects-knowledgeValidate'?{...scope,valid:true,errors:[],warnings:[]}:p.payload.offset===20?{...listing,offset:20,total:21}:{...listing,total:21,nextOffset:20});
 assert.match(f.container.textContent,/x_xgj/);assert.match(f.container.textContent,/知识指南/);assert.equal(f.calls[1].actionId,'projects-knowledgeList');
 click(f.container,'下一页');await settle();assert.equal(f.calls.at(-1).payload.offset,20);click(f.container,'上一页');await settle();
 submit(f,'附件');await settle();assert.equal(f.calls.at(-1).actionId,'projects-knowledgeSearch');assert.equal(f.calls.at(-1).payload.query,'附件');
 f.ctx.host.redact=value=>String(value).replaceAll('SECRET','[redacted]');f.container.querySelector('.kb-entry').click();await settle();
 assert.match(f.container.querySelector('pre').textContent,/<script>\[redacted\]<\/script>/);assert.equal(f.container.querySelector('.kb-reader script'),null);
 click(f.container,'加载后续内容');await settle();assert.match(f.container.querySelector('pre').textContent,/第三行/);assert.equal(f.calls.at(-1).payload.startLine,3);
 click(f.container,'校验结构');await settle();assert.match(f.container.textContent,/结构校验通过/);
 submit(f,'');await settle();assert.equal(f.calls.at(-1).actionId,'projects-knowledgeList');assert.equal(f.container.querySelector('pre'),null);
 assert.ok(f.calls.every(p=>/^projects-knowledge/.test(p.actionId)));assert.ok(f.calls.every(p=>p.agentId==='main'));
});
test('requires a project selection and drops pending project or document results',async()=>{
 const pending=deferred(),read=deferred();let first=true;
 const f=await fixture(async p=>p.actionId==='projects-knowledgeCatalog'?{projects:[...catalog.projects,{projectId:'two',name:'项目二'}]}:p.actionId==='projects-knowledgeRead'?read.promise:p.payload.projectId==='one'&&first?(first=false,pending.promise):{...listing,entries:[{...entry,title:'项目二条目'}]});
 assert.equal(f.calls.length,1);select(f.window,f.container,'知识库项目','one');await settle();select(f.window,f.container,'知识库项目','two');await settle();pending.resolve({...listing,entries:[{...entry,title:'过期结果'}]});await settle();assert.ok(!f.container.textContent.includes('过期结果'));
 f.container.querySelector('.kb-entry').click();await settle();select(f.window,f.container,'知识库项目','');await settle();read.resolve(doc);await settle();assert.equal(f.container.querySelector('pre'),null);
 select(f.window,f.container,'知识库项目','two');await settle();f.ctx.host.connection.canRead=false;f.ctx.notify();await settle();assert.equal(f.container.querySelector('.ar-knowledge'),null);
});
test('exposes missing, partial, empty and retry states without silently presenting success',async()=>{
 let mode='missing';const f=await fixture(async p=>{if(p.actionId==='projects-knowledgeCatalog')return catalog;if(mode==='error')throw Error('private details');return mode==='missing'?{...scope,available:false}:mode==='empty'?{...listing,entries:[],total:0}:{...listing,complete:false};});
 assert.match(f.container.textContent,/尚无知识库目录/);mode='error';click(f.container,'刷新知识库');await settle();assert.match(f.container.textContent,/知识库读取失败/);assert.ok(!f.container.textContent.includes('private details'));
 mode='empty';click(f.container,'重试列表');await settle();assert.match(f.container.textContent,/暂无 Markdown/);mode='partial';click(f.container,'刷新知识库');await settle();assert.match(f.container.textContent,/扫描未完成/);
});
test('does not concatenate changed document revisions or paint a stale Agent response',async()=>{
 const pending=deferred();const f=await fixture(async p=>p.actionId==='projects-knowledgeCatalog'?catalog:p.actionId==='projects-knowledgeRead'?{...doc,...(p.payload.startLine===3?{sha256:'b',content:'新版尾部'}:{})}:p.agentId==='other'?pending.promise:listing);
 f.container.querySelector('.kb-entry').click();await settle();click(f.container,'加载后续内容');await settle();assert.match(f.container.textContent,/条目已更新/);assert.ok(!f.container.querySelector('pre').textContent.includes('新版尾部'));
 f.ctx.host.agents.selectedId='other';f.ctx.notify();await settle();f.ctx.host.connection.canRead=false;f.ctx.notify();pending.resolve({...listing,total:999});await settle();assert.equal(f.container.querySelector('.ar-knowledge'),null);assert.ok(!f.container.textContent.includes('999'));
});
