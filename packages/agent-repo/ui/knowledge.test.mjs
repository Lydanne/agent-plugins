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
 const ctx=uiContext(async(method,p)=>{calls.push(p);assert.equal(method,'plugins.sessionAction');assert.equal(p.sessionKey,'agent:'+p.agentId+':agent-repo-management');return {ok:true,result:{encoding:'json-chunks',transferId:'fixture',totalChunks:1,index:0,agentRepoRoot:p.agentId==='other'?'/other':'/project',chunk:JSON.stringify(await (async()=>{if(p.actionId==='projects-knowledgeIndex')return {...scope,state:'ready',snapshotId:'test-snapshot',totalNodes:1,totalEdges:0};if(p.actionId==='projects-knowledgeNodes')return {snapshotId:'test-snapshot',nodes:[entry],nextCursor:null};if(p.actionId==='projects-knowledgeEdges')return {snapshotId:'test-snapshot',edges:[],nextCursor:null};if(p.actionId==='projects-knowledgeChanges')return {head:'fixture',records:[],total:0,nextCursor:null,complete:true};return handler(p);})())}};},{section:'knowledge'});ctx.host.connection.canWrite=false;ctx.host.redact=value=>String(value).replaceAll('SECRET','[redacted]');
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();return {...f,ctx,calls};
}
const catalog={projects:[{projectId:'one',name:'项目一'}]};
function submit(f,value){const input=f.container.querySelector('[aria-label="搜索知识库"]');input.value=value;input.dispatchEvent(new f.window.Event('input'));input.closest('form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));}
test('read-only management browses, searches, paginates, reads escaped redacted content and validates the configured namespace',async()=>{
 const f=await fixture(async p=>p.actionId==='projects-knowledgeCatalog'?catalog:p.actionId==='projects-knowledgeRead'?{...doc,...(p.payload.startLine===3?{content:'第三行',startLine:3,endLine:3,nextLine:null}:{})}:p.actionId==='projects-knowledgeValidate'?{...scope,valid:true,errors:[],warnings:[]}:p.payload.offset===20?{...listing,offset:20,total:21}:{...listing,total:21,nextOffset:20});
 assert.equal(f.container.querySelector('.kb-location>span').textContent,'wiki');assert.ok(!f.container.querySelector('.kb-location').textContent.includes('x_xgj'));assert.match(f.container.textContent,/知识指南/);assert.ok(f.calls.some(p=>p.actionId==='projects-knowledgeList'));submit(f,'附件');await settle();
 click(f.container,'下一页');await settle();assert.equal(f.calls.at(-1).payload.offset,20);click(f.container,'上一页');await settle();
 submit(f,'附件');await settle();assert.equal(f.calls.at(-1).actionId,'projects-knowledgeSearch');assert.equal(f.calls.at(-1).payload.query,'附件');
 f.ctx.host.redact=value=>String(value).replaceAll('SECRET','[redacted]');(f.container.querySelector('.kb-entry')??f.container.querySelector('.kb-tree button')).click();await settle();
 assert.ok(f.container.querySelector('[aria-label="Markdown 正文"]'),f.container.querySelector('.kb-reader')?.outerHTML);
 assert.match(f.container.querySelector('[aria-label="Markdown 正文"]').textContent,/<script>\[redacted\]<\/script>/);assert.equal(f.container.querySelector('.kb-reader script'),null);
 click(f.container,'加载后续内容');await settle();assert.match(f.container.querySelector('[aria-label="Markdown 正文"]').textContent,/第三行/);assert.equal(f.calls.at(-1).payload.startLine,3);
 click(f.container,'校验结构');await settle();assert.match(f.container.querySelector('[role=dialog]').textContent,/结构校验通过/);click(f.container,'完成');await settle();assert.equal(f.container.querySelector('[role=dialog]'),null);
 submit(f,'');await settle();assert.equal(f.calls.at(-1).actionId,'projects-knowledgeList');assert.equal(f.container.querySelector('[aria-label="Markdown 正文"]'),null);
 assert.ok(f.calls.every(p=>/^projects-knowledge/.test(p.actionId)));assert.ok(f.calls.every(p=>p.agentId==='main'));
});
test('requires a project selection and drops pending project or document results',async()=>{
 const pending=deferred(),read=deferred();let first=true;
 const f=await fixture(async p=>p.actionId==='projects-knowledgeCatalog'?{projects:[...catalog.projects,{projectId:'two',name:'项目二'}]}:p.actionId==='projects-knowledgeRead'?read.promise:p.payload.projectId==='one'&&first?(first=false,pending.promise):{...listing,entries:[{...entry,title:'项目二条目'}]});
 assert.equal(f.container.querySelector('[aria-label="知识库项目"]').value,'one');select(f.window,f.container,'知识库项目','two');await settle();pending.resolve({...listing,entries:[{...entry,title:'过期结果'}]});await settle();assert.ok(!f.container.textContent.includes('过期结果'));
 (f.container.querySelector('.kb-entry')??f.container.querySelector('.kb-tree button')).click();await settle();select(f.window,f.container,'知识库项目','');await settle();read.resolve(doc);await settle();assert.equal(f.container.querySelector('pre'),null);
 select(f.window,f.container,'知识库项目','two');await settle();f.ctx.host.connection.canRead=false;f.ctx.notify();await settle();assert.equal(f.container.querySelector('.ar-knowledge'),null);
});
test('exposes missing, partial, empty and retry states without silently presenting success',async()=>{
 let mode='missing';const f=await fixture(async p=>{if(p.actionId==='projects-knowledgeCatalog')return catalog;if(mode==='error')throw Error('private details');return mode==='missing'?{...scope,available:false}:mode==='empty'?{...listing,entries:[],total:0}:{...listing,complete:false};});
 assert.match(f.container.textContent,/尚无知识库目录/);mode='error';click(f.container,'刷新知识库');await settle();assert.match(f.container.textContent,/知识库读取失败/);assert.ok(!f.container.textContent.includes('private details'));
 mode='empty';click(f.container,'重试列表');await settle();assert.match(f.container.textContent,/暂无 Markdown/);mode='partial';click(f.container,'刷新知识库');await settle();assert.match(f.container.textContent,/扫描未完成/);
});
test('does not concatenate changed document revisions or paint a stale Agent response',async()=>{
 const pending=deferred();const f=await fixture(async p=>p.actionId==='projects-knowledgeCatalog'?catalog:p.actionId==='projects-knowledgeRead'?{...doc,...(p.payload.startLine===3?{sha256:'b',content:'新版尾部'}:{})}:p.agentId==='other'?pending.promise:listing);
 (f.container.querySelector('.kb-entry')??f.container.querySelector('.kb-tree button')).click();await settle();click(f.container,'加载后续内容');await settle();assert.match(f.container.textContent,/条目已更新/);assert.ok(!f.container.querySelector('[aria-label="Markdown 正文"]').textContent.includes('新版尾部'));
 f.ctx.host.agents.selectedId='other';f.ctx.notify();await settle();f.ctx.host.connection.canRead=false;f.ctx.notify();pending.resolve({...listing,total:999});await settle();assert.equal(f.container.querySelector('.ar-knowledge'),null);assert.ok(!f.container.textContent.includes('999'));
});

test('Markdown preview has a TOC, safe scoped document navigation, anchors, back navigation and raw source',async()=>{
 const body='# 知识指南\n\n[同篇](#第二节) · [下一篇](nested/next.md#目标) · [无锚点下一篇](nested/next.md) · [越界](../outside.md) · [缺失](missing.md) · [未加载](#尾部)\n\n## 第二节\n\n**重点**\n\n| 字段 | 值 |\n| --- | --- |\n| UID | `guide` |';
 const f=await fixture(async p=>p.actionId==='projects-knowledgeCatalog'?catalog:p.actionId!=='projects-knowledgeRead'?listing:p.payload.path==='missing.md'?{...scope,found:false}:p.payload.path==='nested/next.md'?{...doc,entry:{...entry,path:'nested/next.md',title:'下一篇'},content:'# 下一篇\n\n## 目标\n\n跳转成功',nextLine:null}:p.payload.startLine===11?{...doc,content:'\n## 尾部\n\n完整结尾',startLine:11,endLine:14,totalLines:14,nextLine:null}:{...doc,content:body,endLine:10,totalLines:14,nextLine:11});
 const link=text=>[...f.container.querySelectorAll('.kb-markdown a')].find(el=>el.textContent===text);
 (f.container.querySelector('.kb-entry')??f.container.querySelector('.kb-tree button')).click();await settle();assert.equal(f.container.querySelectorAll('.kb-toc a').length,2);assert.equal(f.container.querySelectorAll('.kb-markdown td').length,2);
 link('同篇').click();await settle();assert.equal(f.window.document.activeElement.textContent,'第二节');
 const count=f.calls.length;link('越界').click();await settle();assert.equal(f.calls.length,count);assert.match(f.container.textContent,/链接超出当前知识库目录/);
 link('下一篇').click();await settle();assert.equal(f.calls.at(-1).payload.path,'nested/next.md');assert.equal(f.calls.at(-1).payload.projectId,'one');assert.equal(f.window.document.activeElement.textContent,'目标');
 click(f.container,'返回上篇');await settle();assert.equal(f.calls.at(-1).payload.path,'guide.md');
 link('无锚点下一篇').click();await settle();assert.ok(f.window.document.activeElement.classList.contains('kb-renderer'));click(f.container,'返回上篇');await settle();
 link('缺失').click();await settle();assert.match(f.container.textContent,/条目已不存在/);assert.equal(f.container.querySelector('.kb-markdown'),null);click(f.container,'返回上篇');await settle();
 link('未加载').click();await settle();assert.match(f.container.textContent,/目标标题尚未加载/);click(f.container,'加载后续内容');await settle();assert.equal(f.window.document.activeElement.textContent,'尾部');assert.equal(f.container.querySelectorAll('.kb-toc a').length,3);
 click(f.container,'查看原文');await settle();assert.ok(f.container.querySelector('[aria-label="Markdown 原文"]').textContent.startsWith('# 知识指南'));assert.equal(f.container.querySelector('.kb-markdown'),null);click(f.container,'查看预览');await settle();
 f.container.querySelector('.kb-toc a').click();await settle();assert.equal(f.window.document.activeElement.textContent,'知识指南');
 assert.ok(f.calls.filter(p=>p.actionId==='projects-knowledgeRead').every(p=>p.agentId==='main'&&p.payload.projectId==='one'));
});

test('validation is a closeable modal with loading, failure, retry and stale-result isolation',async()=>{
 const pending=deferred();let attempt=0;
 const f=await fixture(async p=>p.actionId==='projects-knowledgeCatalog'?{projects:[...catalog.projects,{projectId:'two',name:'项目二'}]}:p.actionId==='projects-knowledgeValidate'?(++attempt===1?pending.promise:attempt===2?Promise.reject(Error('private details')):{...scope,valid:false,complete:false,errors:[{path:'SECRET.md',code:'missing_title'}],warnings:[{path:'guide.md',code:'link_missing_or_unsafe'}]}):listing);
 select(f.window,f.container,'知识库项目','one');await settle();click(f.container,'校验结构');await settle();let modal=f.container.querySelector('[role=dialog]');assert.match(modal.textContent,/正在校验/);assert.equal(f.container.querySelector('.ar-knowledge .kb-validation'),null);
 click(modal,'关闭');await settle();pending.resolve({...scope,valid:true,errors:[],warnings:[]});await settle();assert.equal(f.container.querySelector('[role=dialog]'),null);assert.ok(!f.container.textContent.includes('结构校验通过'));
 click(f.container,'校验结构');await settle();modal=f.container.querySelector('[role=dialog]');assert.match(modal.textContent,/结构校验失败/);assert.ok(!modal.textContent.includes('private details'));
 click(modal,'重新校验');await settle();modal=f.container.querySelector('[role=dialog]');assert.match(modal.textContent,/存在结构问题/);assert.match(modal.textContent,/1 项错误 \/ 1 项提醒/);assert.match(modal.textContent,/\[redacted\]\.md/);assert.match(modal.textContent,/结果可能不完整/);
 select(f.window,f.container,'知识库项目','two');await settle();assert.equal(f.container.querySelector('[role=dialog]'),null);
 click(f.container,'校验结构');await settle();f.ctx.host.connection.canRead=false;f.ctx.notify();await settle();assert.equal(f.container.querySelector('[role=dialog]'),null);
});


test('choosing another TOC heading cancels an earlier unloaded anchor destination',async()=>{
 const f=await fixture(async p=>p.actionId==='projects-knowledgeCatalog'?catalog:p.actionId!=='projects-knowledgeRead'?listing:p.payload.startLine===3?{...doc,content:'## later',startLine:3,endLine:3,nextLine:null}:{...doc,content:'# start\n\n[稍后](#later)\n\n## current'});
 (f.container.querySelector('.kb-entry')??f.container.querySelector('.kb-tree button')).click();await settle();f.container.querySelector('.kb-markdown a').click();await settle();assert.match(f.container.textContent,/目标标题尚未加载/);
 [...f.container.querySelectorAll('.kb-toc a')].find(el=>el.textContent==='current').click();await settle();assert.equal(f.window.document.activeElement.textContent,'current');
 click(f.container,'加载后续内容');await settle();assert.notEqual(f.window.document.activeElement.textContent,'later');assert.ok(!f.container.textContent.includes('目标标题尚未加载'));
});

test('G6 view uses complete snapshot data, exposes accessible group navigation and stops on permission loss',async()=>{
 const f=await fixture(async p=>p.actionId==='projects-knowledgeCatalog'?catalog:p.actionId==='projects-knowledgeRead'?{...doc,nextLine:null}:listing);
 assert.equal(f.container.querySelector('[role=tab][data-state=active]').textContent,'文档');
 click(f.container,'图谱');await settle();assert.ok(f.container.querySelector('[aria-label="知识图谱画布"]'));assert.match(f.container.textContent,/1 篇文档/);
 assert.equal(f.container.querySelector('.kb-timeline'),null);assert.ok(!f.calls.some(p=>p.actionId==='projects-knowledgeChanges'));click(f.container,'分组导航');await settle();click(f.container,'全部展开');await settle();assert.match(f.container.textContent,/收起 index/);click(f.container,'全部收起');await settle();
 const input=f.container.querySelector('[aria-label="查找图谱文档"]');input.value='知识';input.dispatchEvent(new f.window.Event('input'));await settle();f.container.querySelector('.kb-matches button').click();await settle();click(f.container,'打开文档');await settle();assert.ok(f.container.querySelector('.kb-markdown'));assert.equal(f.calls.at(-1).payload.snapshotId,'test-snapshot');
 click(f.container,'图谱');await settle();f.ctx.host.connection.canRead=false;f.ctx.notify();await settle();assert.equal(f.container.querySelector('.kb-graph'),null);
});
