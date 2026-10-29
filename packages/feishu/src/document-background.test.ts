import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {OpenClawPluginApi} from "openclaw/plugin-sdk/channel-entry-contract";
const mocks=vi.hoisted(()=>({valid:true,session:"current",enabled:true,create:vi.fn(),write:vi.fn(),permission:vi.fn(),prepare:vi.fn(),edit:vi.fn()}));
vi.mock("./source-task.js",()=>({isCompletionSourceCurrent:()=>mocks.valid}));
vi.mock("./accounts.js",()=>({resolveFeishuRuntimeAccount:()=>({configured:true,accountId:"a",config:{documentDelivery:{enabled:mocks.enabled}},domain:"feishu"})}));
vi.mock("./client.js",()=>({createFeishuClient:()=>({drive:{permissionMember:{create:mocks.permission}}})}));
vi.mock("./docx.js",()=>({createDoc:mocks.create,writeDoc:mocks.write}));
vi.mock("./send.js",()=>({editMessageFeishu:mocks.edit}));
vi.mock("./document-delivery.js",async importOriginal=>({...await importOriginal<typeof import("./document-delivery.js")>(),prepareFeishuDocumentDelivery:mocks.prepare}));
import {stageBackgroundDocument,activateBackgroundDocument,registerDocumentBackground} from "./document-background.js";
import {pendingDocumentText} from "./document-delivery.js";
import {bindAsyncTaskCard,acceptAsyncCardResult,readAsyncTaskCard} from "./async-task-card.js";
let root:string,file:string,service:{start:()=>void;stop:()=>void}|undefined;
const source={taskId:"task",revision:0,accountId:"a",chatId:"chat",sessionKey:"agent:main:feishu:group:chat",senderId:"sender",sourceMessageIds:["request"]};
function start() {
 const api={runtime:{state:{resolveStateDir:()=>root},config:{current:()=>({})},agent:{session:{resolveStorePath:()=>"mock",getSessionEntry:()=>({sessionId:mocks.session})}},media:{}},registerService:(s:typeof service)=>{service=s;}} as unknown as OpenClawPluginApi;
 registerDocumentBackground(api);service!.start();
}
async function stage(completionJobId?:string) {return (await stageBackgroundDocument({cfg:{},stateDir:root,source,agentId:"main",sessionId:"current",to:"chat:chat",text:`核验总结\n[完整报告](<${file}>)`,completionJobId}))!;}
function rows():{id:string;status:string;documentId:string;messageId?:string}[] {const db=new DatabaseSync(join(root,"feishu-document-uploads","uploads.sqlite"));try{return (db.prepare("SELECT payload FROM uploads").all() as {payload:string}[]).map(row=>JSON.parse(row.payload));}finally{db.close();}}
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),"doc-background-"));file=join(root,"report.md");writeFileSync(file,"# 完整报告");
 mocks.valid=true;mocks.session="current";mocks.enabled=true;vi.clearAllMocks();
 mocks.create.mockResolvedValue({document_id:"cloud"});mocks.write.mockResolvedValue({});mocks.permission.mockResolvedValue({code:0});mocks.edit.mockResolvedValue({messageId:"original"});
 mocks.prepare.mockResolvedValue({text:"核验总结\n[完整报告](https://feishu.cn/docx/cloud)",documentId:"cloud"});
});
afterEach(async()=>{service?.stop();service=undefined;await new Promise(r=>setTimeout(r,20));rmSync(root,{recursive:true,force:true});});
it("preserves local report labels while replacing targets and retaining signed downloads and code examples",()=>{
 const signed="https://download.test/a.zip?sign=x%2Fy%3D";
 const text=`总结 [业务下载](${signed}) [报告](${file})\n证据 \`./a.csv\`\n\`\`\`md\n[例子](${file})\n\`\`\``;
 const result=pendingDocumentText(text,"https://feishu.cn/docx/cloud",root);
 expect(result).toContain(`[业务下载](${signed})`);expect(result).toContain("[报告](https://feishu.cn/docx/cloud)");expect(result).toContain("`./a.csv`");expect(result).not.toContain("上传中");
 expect(result).toContain(`\`\`\`md\n[例子](${file})`);expect(result).not.toContain(`[报告](${file})`);
});
it("creates a readable target-scoped placeholder without loading the full report",async()=>{
 const pending=await stage();expect(pending.text).toBe("核验总结\n[完整报告](https://feishu.cn/docx/cloud)");
 expect(mocks.write).toHaveBeenCalledWith(expect.anything(),"cloud",expect.stringContaining("上传中"),expect.any(Number),expect.any(Number));
 expect(mocks.permission).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({member_type:"openchat",member_id:"chat"}),params:{type:"docx",need_notification:false}}));
 expect(mocks.prepare).not.toHaveBeenCalled();expect(rows()[0].status).toBe("draft");
 expect(mocks.create).toHaveBeenCalledWith(expect.anything(),'report.md',undefined,{grantToRequester:false});
});
it('names the placeholder after its Worker session and Beijing completion date before uploading',async()=>{
 const workerReport={sessionName:'订单导出排查',finishedAt:Date.parse('2026-10-28T16:05:00Z')};
 const pending=(await stageBackgroundDocument({cfg:{},stateDir:root,source,agentId:'main',sessionId:'current',to:'chat:chat',text:`总结 [报告](${file})`,workerReport}))!;
 expect(mocks.create).toHaveBeenCalledWith(expect.anything(),'订单导出排查 2026-10-29',undefined,{grantToRequester:false});
 activateBackgroundDocument(root,pending,'original');start();
 await vi.waitFor(()=>expect(rows()[0].status).toBe('done'));
 expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({existingDocumentId:'cloud'}));
 expect(mocks.create).toHaveBeenCalledOnce();
});
it.each(['p2p','private'] as const)('shares a %s placeholder with its trusted requester and carries the same grant into upload',async chatType=>{
 const privateSource={...source,chatType,senderId:'ou_requester'};
 const pending=(await stageBackgroundDocument({cfg:{},stateDir:root,source:privateSource,agentId:'main',sessionId:'current',to:'chat:chat',text:`总结 [报告](${file})`}))!;
 expect(mocks.permission).toHaveBeenCalledWith(expect.objectContaining({data:{member_type:'openid',member_id:'ou_requester',perm:'view'}}));
 activateBackgroundDocument(root,pending,'original');start();
 await vi.waitFor(()=>expect(rows()[0].status).toBe('done'));
 expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({recipientContext:privateSource,confirmedGrant:{documentId:'cloud',memberType:'openid',memberId:'ou_requester',permission:'view'}}));
 expect(mocks.permission).toHaveBeenCalledOnce();
});
it('records the failing staging phase and API code without retaining SDK credentials',async()=>{
 const secret='MUST_NOT_STORE';
 mocks.permission.mockRejectedValue(Object.assign(Error(secret),{response:{data:{code:1063002,msg:secret},config:{headers:{Authorization:secret}}}}));
 const onFailure=vi.fn();
 await expect(stageBackgroundDocument({cfg:{},stateDir:root,source,agentId:'main',to:'chat:chat',text:`总结 [报告](${file})`,onFailure})).rejects.toThrow(secret);
 expect(rows()[0]).toMatchObject({status:'staging_failed',uploadFailure:{stage:'grant_access',code:1063002}});
 expect(onFailure).toHaveBeenCalledWith({stage:'grant_access',code:1063002});expect(JSON.stringify(rows())).not.toContain(secret);
 start();await new Promise(r=>setTimeout(r,300));expect(mocks.prepare).not.toHaveBeenCalled();
});
it("skips disabled delivery and nonexistent files before creating cloud documents",async()=>{
 mocks.enabled=false;expect(await stage()).toBeUndefined();mocks.enabled=true;rmSync(file);expect(await stage()).toBeUndefined();expect(mocks.create).not.toHaveBeenCalled();
});
it("does not start uploads until the summary receipt; upload cannot block subsequent work",async()=>{
 let release!:(v:unknown)=>void;mocks.prepare.mockImplementation(()=>new Promise(r=>release=r));
 const pending=await stage();start();await new Promise(r=>setTimeout(r,300));expect(mocks.prepare).not.toHaveBeenCalled();
 activateBackgroundDocument(root,pending,"original");await vi.waitFor(()=>expect(mocks.prepare).toHaveBeenCalledOnce());
 expect(rows()[0].status).toBe("working");expect(mocks.edit).not.toHaveBeenCalled();
 expect(pending.text).toContain("[完整报告](https://feishu.cn/docx/cloud)");expect(pending.text).not.toContain("上传中");
 release({text:"核验总结\n[完整报告](https://feishu.cn/docx/cloud)",documentId:"cloud"});
 await vi.waitFor(()=>expect(rows()[0].status).toBe("done"));
 expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({existingDocumentId:"cloud",agentId:"main",confirmedGrant:{documentId:"cloud",memberType:"openchat",memberId:"chat",permission:"view"}}));
 expect(mocks.create).toHaveBeenCalledOnce();expect(mocks.permission).toHaveBeenCalledOnce();expect(mocks.edit).not.toHaveBeenCalled();
});
it("does not PATCH an unchanged result or overwrite newer siblings on a shared card",async()=>{
 bindAsyncTaskCard(root,source,["one","two"],{messageId:"original"});
 const pending=await stage("one");acceptAsyncCardResult(root,readAsyncTaskCard(root,"one",source)!,pending.text);
 activateBackgroundDocument(root,pending,"original");
 acceptAsyncCardResult(root,readAsyncTaskCard(root,"two",source)!,"第二个任务已完成");
 start();await vi.waitFor(()=>expect(rows()[0].status).toBe("done"));
 expect(mocks.edit).not.toHaveBeenCalled();expect(readAsyncTaskCard(root,"two",source)!.result).toBe("第二个任务已完成");
});
it.each(["recall","session"])("blocks stale upload/card writes after %s invalidation",async kind=>{
 const pending=await stage();activateBackgroundDocument(root,pending,"original");if(kind==="recall")mocks.valid=false;else mocks.session="new";
 start();await vi.waitFor(()=>expect(rows()[0].status).toBe("cancelled"));expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.edit).not.toHaveBeenCalled();
});
it("keeps the delivered summary and reports upload failure in both document and original card",async()=>{
 mocks.prepare.mockResolvedValue({text:"fallback",mediaUrls:[]});const pending=await stage();activateBackgroundDocument(root,pending,"original");start();
 await vi.waitFor(()=>expect(mocks.edit).toHaveBeenCalledOnce());expect(JSON.stringify(mocks.edit.mock.calls)).toContain("上传未完成");expect(JSON.stringify(mocks.edit.mock.calls)).toContain("核验总结");expect(JSON.stringify(mocks.edit.mock.calls)).toContain("[完整报告](https://feishu.cn/docx/cloud)");expect(mocks.write.mock.calls.at(-1)![2]).toContain("上传未完成");
});
it('updates the original card with oversized attachment explanations while completing the document',async()=>{
 const pending=await stage();
 mocks.prepare.mockResolvedValue({text:pending.text+'\n\n附件未上传说明：\n- large.zip：超过 1GB（1024MB），已跳过上传。',documentId:'cloud'});
 activateBackgroundDocument(root,pending,'original');start();
 await vi.waitFor(()=>expect(rows()[0].status).toBe('done'));
 expect(mocks.edit).toHaveBeenCalledOnce();expect(JSON.stringify(mocks.edit.mock.calls)).toContain('large.zip');
 expect(JSON.stringify(mocks.edit.mock.calls)).toContain('已跳过上传');expect(mocks.write).toHaveBeenCalledOnce();
});
it('preserves skipped-file reasons on the card and status page even when another upload fails',async()=>{
 const notice='\n\n附件未上传说明：\n- huge.zip：超过 1GB（1024MB），已跳过上传。';
 mocks.prepare.mockResolvedValue({text:'文字结果',mediaUrls:[],skippedAttachmentNotice:notice});
 const pending=await stage();activateBackgroundDocument(root,pending,'original');start();
 await vi.waitFor(()=>expect(rows()[0].status).toBe('done'));
 expect(mocks.write.mock.calls.at(-1)![2]).toContain(notice);
 expect(JSON.stringify(mocks.edit.mock.calls)).toContain('huge.zip');expect(JSON.stringify(mocks.edit.mock.calls)).toContain('上传未完成');
});
it("restart resumes queued uploads but does not repeat uncertain interrupted writes",async()=>{
 const pending=await stage();activateBackgroundDocument(root,pending,"original");
 const db=new DatabaseSync(join(root,"feishu-document-uploads","uploads.sqlite"));const row=db.prepare("SELECT payload FROM uploads").get() as {payload:string};const job=JSON.parse(row.payload);job.status="working";db.prepare("UPDATE uploads SET payload=?,status=\'working\'").run(JSON.stringify(job));db.close();
 start();await vi.waitFor(()=>expect(mocks.edit).toHaveBeenCalledOnce());expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.write.mock.calls.at(-1)![2]).toContain("服务重启");expect(JSON.stringify(mocks.edit.mock.calls)).toContain("上传未完成");
});

it('checks recall again after a slow upload and blocks the late card edit',async()=>{
 let release!:(v:unknown)=>void;mocks.prepare.mockImplementation(()=>new Promise(r=>release=r));
 const pending=await stage();activateBackgroundDocument(root,pending,'original');start();await vi.waitFor(()=>expect(mocks.prepare).toHaveBeenCalledOnce());
 mocks.valid=false;release({text:'obsolete',documentId:'cloud'});await vi.waitFor(()=>expect(rows()[0].status).toBe('cancelled'));expect(mocks.edit).not.toHaveBeenCalled();
});
it('retries only the known card edit without repeating a successful document upload',async()=>{
 mocks.prepare.mockResolvedValue({text:'核验总结 [完整报告](https://feishu.cn/docx/cloud)\n附件转换说明',documentId:'cloud'});
 mocks.edit.mockRejectedValueOnce(Error('temporary patch failure')).mockResolvedValue({messageId:'original'});
 const pending=await stage();activateBackgroundDocument(root,pending,'original');start();
 await vi.waitFor(()=>expect(mocks.edit).toHaveBeenCalledTimes(2),{timeout:2500});
 expect(mocks.prepare).toHaveBeenCalledOnce();expect(mocks.create).toHaveBeenCalledOnce();expect(rows()[0].status).toBe('done');
});
it('out-of-order ordinary uploads retain the other final summary on their shared card',async()=>{
 let release!:(v:unknown)=>void;mocks.prepare.mockImplementationOnce(()=>new Promise(r=>release=r)).mockResolvedValue({text:'第二条总结 [报告](https://feishu.cn/docx/cloud)',documentId:'cloud'});
 const first=await stage();activateBackgroundDocument(root,first,'original');
 const second=(await stageBackgroundDocument({cfg:{},stateDir:root,source,agentId:'main',sessionId:'current',to:'chat:chat',text:`第二条总结 [证据](${file})`}))!;activateBackgroundDocument(root,second,'original');
 start();await vi.waitFor(()=>expect(mocks.edit).toHaveBeenCalledOnce());
 release({text:'第一条总结 [报告](https://feishu.cn/docx/cloud)',documentId:'cloud'});await vi.waitFor(()=>expect(mocks.edit).toHaveBeenCalledTimes(2));
 const last=JSON.stringify(mocks.edit.mock.calls.at(-1));expect(last).toContain('第一条总结');expect(last).toContain('第二条总结');expect(last).not.toContain('上传中');
});

it('uses a regular report entry for media-only uploads and keeps custom/escaped report labels',()=>{
 const url='https://feishu.cn/docx/cloud';
 expect(pendingDocumentText('核验总结',url,root)).toBe(`核验总结\n\n[完整报告](${url})`);
 expect(pendingDocumentText(`结论 [诊断\\[附件\\]](<${file}>)`,url,root)).toBe(`结论 [诊断\\[附件\\]](${url})`);
});

it('collapses Worker and host report entries pointing at the same cloud document',()=>{
 const url='https://feishu.cn/docx/cloud';
 const text=`核验总结\n\n[完整报告](<${file}>)\n\n[完整报告](<${join(root,'completion-report.md')}>)`;
 expect(pendingDocumentText(text,url,root)).toBe(`核验总结\n\n[完整报告](${url})`);
});

it('keeps an existing cloud report entry without appending another fallback',()=>{
 const url='https://feishu.cn/docx/cloud';
 const text=`核验总结\n\n[完整报告](${url})`;
 expect(pendingDocumentText(text,url,root)).toBe(text);
 expect(pendingDocumentText(text+`\n\n[完整报告](${url})`,url,root)).toBe(text);
});

it('preserves distinct labels, inline citations, other URLs and fenced examples during entry deduplication',()=>{
 const url='https://feishu.cn/docx/cloud',signed='https://download.test/a.zip?sign=x%2Fy%3D';
 const text=`正文 [完整报告](${url})\n\n[完整报告](${file})\n\n[完整报告](${file})\n\n[诊断报告](${file})\n\n[完整报告](${signed})\n\n\`\`\`md\n[完整报告](${url})\n\n[完整报告](${url})\n\`\`\``;
 expect(pendingDocumentText(text,url,root)).toBe(`正文 [完整报告](${url})\n\n[完整报告](${url})\n\n[诊断报告](${url})\n\n[完整报告](${signed})\n\n\`\`\`md\n[完整报告](${url})\n\n[完整报告](${url})\n\`\`\``);
});

it('persists safe upload diagnostics separately from successful failure-notice delivery',async()=>{
 mocks.prepare.mockImplementation(async(params)=>{params.onFailure({stage:'upload_attachment',code:1061002});return {text:'fallback',mediaUrls:[]};});
 const pending=await stage();activateBackgroundDocument(root,pending,'original');start();
 await vi.waitFor(()=>expect(rows()[0].status).toBe('done'));
 expect(rows()[0]).toMatchObject({uploadFailure:{stage:'upload_attachment',code:1061002}});
 expect(mocks.edit).toHaveBeenCalledOnce();
});

it('keeps successful attachment-only delivery instead of replacing it with an upload-failure page',async()=>{
 mocks.prepare.mockImplementation(async(params)=>{
  params.onFailure({stage:'write_content',code:'DOCX_BLOCK_LIMIT'});
  return {text:'核验总结 [完整报告](https://feishu.cn/docx/cloud)\n正文转换未完成，原始 Markdown 已附在文档内，请下载查看。',documentId:'cloud',mediaUrls:[]};
 });
 const pending=await stage();activateBackgroundDocument(root,pending,'original');start();
 await vi.waitFor(()=>expect(rows()[0].status).toBe('done'));
 expect(mocks.write).toHaveBeenCalledOnce(); // Only the initial placeholder.
 expect(JSON.stringify(mocks.edit.mock.calls)).toContain('原始 Markdown 已附');
 expect(JSON.stringify(mocks.edit.mock.calls)).not.toContain('完整报告上传未完成');
});

it('recombines newer sibling results when the uploaded result actually changes',async()=>{
 bindAsyncTaskCard(root,source,['one','two'],{messageId:'original'});
 const pending=await stage('one');acceptAsyncCardResult(root,readAsyncTaskCard(root,'one',source)!,pending.text);
 activateBackgroundDocument(root,pending,'original');acceptAsyncCardResult(root,readAsyncTaskCard(root,'two',source)!,'另一个任务的最新结果');
 mocks.prepare.mockResolvedValue({text:pending.text+'\n附件转换说明',documentId:'cloud'});
 start();await vi.waitFor(()=>expect(rows()[0].status).toBe('done'));
 expect(mocks.edit).toHaveBeenCalledOnce();expect(JSON.stringify(mocks.edit.mock.calls)).toContain('另一个任务的最新结果');
 expect(JSON.stringify(mocks.edit.mock.calls)).toContain('附件转换说明');
});

it("does not create a document placeholder for message images or capture mixed reply images",async()=>{
 for(const text of ['Hello ![收到](/workspace/received.png)',`总结 [报告](${file}) ![图](/workspace/received.gif)`]) {
  expect(await stageBackgroundDocument({cfg:{},stateDir:root,source,agentId:'main',to:'chat:chat',text})).toBeUndefined();
 }
 expect(mocks.create).not.toHaveBeenCalled();
});

it('does not reinsert a report delivered in the reminder after upload',async()=>{
 const pending=await stage();
 mocks.prepare.mockResolvedValue({text:'核验总结\n\n[完整报告](https://feishu.cn/docx/cloud)\n\n附件说明',documentId:'cloud'});
 activateBackgroundDocument(root,pending,'original',true,'',true);start();
 await vi.waitFor(()=>expect(rows()[0].status).toBe('done'));
 expect(JSON.stringify(mocks.edit.mock.calls)).toContain('附件说明');
 expect(JSON.stringify(mocks.edit.mock.calls)).not.toContain('[完整报告]');
 expect(rows()[0].finalText).toBe('核验总结\n\n附件说明');
});
