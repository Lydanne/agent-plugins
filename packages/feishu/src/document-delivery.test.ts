import {beforeEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadWebMedia} from "openclaw/plugin-sdk/web-media";
const mocks=vi.hoisted(()=>({mediaSend:vi.fn(),stat:vi.fn(),account:vi.fn(),load:vi.fn(),create:vi.fn(),write:vi.fn(),childrenCreate:vi.fn(),childrenGet:vi.fn(),upload:vi.fn(),patch:vi.fn(),permission:vi.fn(),messageCreate:vi.fn(),messageReply:vi.fn(),messageGet:vi.fn(),messagePatch:vi.fn()}));
vi.mock("./media.js",()=>({sendMediaFeishu:mocks.mediaSend}));
vi.mock("node:fs/promises",async importOriginal=>({...await importOriginal<typeof import("node:fs/promises")>(),stat:mocks.stat}));
vi.mock("./accounts.js",()=>({resolveFeishuRuntimeAccount:mocks.account}));
vi.mock("./docx.js",()=>({createDoc:mocks.create,writeDoc:mocks.write}));
vi.mock("./runtime.js",()=>({getFeishuRuntime:()=>({media:{loadWebMedia:mocks.load}})}));
vi.mock("./client.js",()=>({createFeishuClient:()=>({im:{message:{create:mocks.messageCreate,reply:mocks.messageReply,get:mocks.messageGet,patch:mocks.messagePatch}},docx:{documentBlockChildren:{create:mocks.childrenCreate,get:mocks.childrenGet},documentBlock:{patch:mocks.patch}},drive:{media:{uploadAll:mocks.upload},permissionMember:{create:mocks.permission}}})}));
import {findLocalFileReferences,prepareFeishuDocumentDelivery,attachDocumentFile} from "./document-delivery.js";
import {withFeishuSendContext} from "./send-context.js";
import {createFeishuClient} from "./client.js";
import {sendMessageFeishu,sendCardFeishu,editMessageFeishu} from "./send.js";
let sequence=0;
beforeEach(()=>{
 vi.clearAllMocks();mocks.stat.mockReset().mockResolvedValue({isFile:()=>true});mocks.account.mockReturnValue({accountId:`a-${++sequence}`,appId:"test",domain:"feishu",configured:true,config:{documentDelivery:{workspaceDir:"/workspace"}}});
 mocks.load.mockImplementation(async(path:string)=>({buffer:Buffer.from(path.endsWith('.md')?'# Report\nVerified':'binary file'),fileName:path.split('/').at(-1)}));
 mocks.create.mockResolvedValue({document_id:"doc-test"});mocks.write.mockResolvedValue({success:true});
 mocks.childrenCreate.mockResolvedValue({code:0,data:{children:[{block_type:23,block_id:"file-block"}]}});
 mocks.childrenGet.mockResolvedValue({code:0,data:{items:[{block_type:23,block_id:"inner-file"}]}});
 mocks.messageCreate.mockResolvedValue({code:0,data:{message_id:"message-test"}});mocks.messageReply.mockResolvedValue({code:0,data:{message_id:"reply-test"}});mocks.messagePatch.mockResolvedValue({code:0});mocks.messageGet.mockResolvedValue({code:0,data:{items:[{message_id:"original",chat_id:"oc_target",msg_type:"text",body:{content:"{}"}}]}});
 mocks.upload.mockResolvedValue({file_token:"file-token"});mocks.patch.mockResolvedValue({code:0});mocks.permission.mockResolvedValue({code:0});
});
describe("local artifact detection",()=>{
 it("finds only explicit local Markdown links and ignores prose and code paths",()=>{
  const refs=findLocalFileReferences('[Report](/tmp/report.md:12) [space](</tmp/my report.md>) [URI](file:///tmp/a%20b.pdf) `./evidence.csv` file:///tmp/a%20b.pdf\n/tmp/raw.xlsx','/workspace');
  expect(refs.map(r=>r.path)).toEqual(['/tmp/report.md','/tmp/my report.md','/tmp/a b.pdf']);
 });
 it("does not scan remote links, code examples or directories",()=>{
  expect(findLocalFileReferences('https://example.test/tmp/a.md [remote](https://example.test/a.pdf)\n```sh\ncat /tmp/example.md\n```\n/tmp/dir')).toEqual([]);
 });
 it("ignores prose sizes and numeric ratios while retaining explicit numeric file links",()=>{
  expect(findLocalFileReferences('4 秒 /1.681776MB；2 秒 /1.060560MB；体积 /4.874865MB；比例 /0.95；速率 /100KB')).toEqual([]);
  expect(findLocalFileReferences('[numeric file](/1.681776MB) /2026.csv /0.5.png').map(ref=>ref.path)).toEqual(['/1.681776MB']);
 });
 it("does not reinterpret the tail of a home or relative reference as a filesystem-root path",()=>{
  expect(findLocalFileReferences('MEDIA:~/.openclaw/media/example.png')).toEqual([]);
  expect(findLocalFileReferences('无效前缀:~/file.md 无效前缀:./file.md 无效前缀:../file.md','/workspace')).toEqual([]);
  expect(findLocalFileReferences('[file](./file.md) [other](../other.md)','/workspace').map(ref=>ref.path)).toEqual(['/workspace/file.md','/other.md']);
 });
});
it("leaves ordinary replies and disabled document delivery unchanged",async()=>{
 expect(await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'Confirmed'})).toBeUndefined();expect(mocks.load).not.toHaveBeenCalled();
 mocks.account.mockReturnValue({accountId:'disabled',config:{documentDelivery:{enabled:false}}});
 expect(await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[report](/tmp/report.md)'})).toBeUndefined();expect(mocks.load).not.toHaveBeenCalled();
});
it("combines the body, report content and all attachments into one document before granting target-only access",async()=>{
 const input={cfg:{},to:'chat:oc_target',text:'Results: [report](/tmp/report.md)',mediaUrls:['/tmp/report.md','/tmp/evidence.csv']};
 const result=await prepareFeishuDocumentDelivery(input);
 expect(result).toMatchObject({text:'Results: [report](https://feishu.cn/docx/doc-test)',mediaUrls:[]});
 expect(mocks.load).toHaveBeenCalledTimes(2);
 expect(mocks.write.mock.calls[0][2]).toContain('# Report\nVerified');expect(mocks.write.mock.calls[0][2]).not.toContain('/tmp/');
 expect(mocks.upload.mock.calls.map(([r])=>r.data.file_name)).toEqual(['report.md','evidence.csv']);
 expect(mocks.upload.mock.calls[0][0].data).toMatchObject({parent_type:'docx_file',parent_node:'file-block'});
 expect(mocks.patch.mock.calls[0][0].data).toEqual({replace_file:{token:'file-token'}});
 expect(mocks.permission).toHaveBeenCalledWith(expect.objectContaining({data:{member_type:'openchat',member_id:'oc_target',perm:'view'},params:{type:'docx',need_notification:false}}));
 expect(mocks.patch.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.permission.mock.invocationCallOrder[0]);
 await prepareFeishuDocumentDelivery(input);expect(mocks.create).toHaveBeenCalledTimes(1);
});
it('preserves the main summary and signed downloads while replacing only the report link',async()=>{
 const download='https://download.test/workspace/report.md?sign=a%2Fb%3D&expires=123';
 const summary=`核验结论：已完成 aaa。\nOpenID：business-openid-full\n[业务下载](${download})\n[完整报告](/workspace/report.md)`;
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:summary});
 expect(result?.text).toBe(summary.replace('[完整报告](/workspace/report.md)','[完整报告](https://feishu.cn/docx/doc-test)'));
 expect(mocks.write.mock.calls[0][2]).toContain(download);expect(mocks.write.mock.calls[0][2]).toContain('# Report\nVerified');
 expect(result?.text).not.toContain('# Report');
});
it('does not rewrite fenced examples sharing the same path as the uploaded report',async()=>{
 const example='```md\n[完整报告](/workspace/report.md)\n```';
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:`结论\n[完整报告](/workspace/report.md)\n${example}`});
 expect(result?.text).toBe(`结论\n[完整报告](https://feishu.cn/docx/doc-test)\n${example}`);
 expect(mocks.load).toHaveBeenCalledOnce();expect(mocks.write.mock.calls[0][2]).toContain(example);
});
it('publishes one entry for multiple reports while retaining both full report bodies',async()=>{
 mocks.load.mockImplementation(async(path:string)=>({buffer:Buffer.from(path.endsWith('report.md')?'# Worker evidence':'# Host audit'),fileName:path.split('/').at(-1)}));
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'核验总结\n\n[完整报告](/workspace/report.md)\n\n[完整报告](/workspace/completion.md)'});
 expect(result?.text).toBe('核验总结\n\n[完整报告](https://feishu.cn/docx/doc-test)');
 expect(mocks.load).toHaveBeenCalledTimes(2);
 expect(mocks.write.mock.calls[0][2]).toContain('# Worker evidence');
 expect(mocks.write.mock.calls[0][2]).toContain('# Host audit');
});
it('converts encoded local links while leaving prose and inline code paths untouched',async()=>{
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'资料：[空格报告](/workspace/my%20report.md)，证据 `./evidence.csv`；原件 /workspace/source.txt。'});
 expect(result?.text).toBe('资料：[空格报告](https://feishu.cn/docx/doc-test)，证据 `./evidence.csv`；原件 /workspace/source.txt。');
 expect(mocks.load.mock.calls.map(([path])=>path)).toEqual(['/workspace/my report.md']);
});
it('appends the configured document link without deleting a summary when files arrive as media',async()=>{
 mocks.account.mockReturnValue({accountId:'summary-media',domain:'feishu',config:{documentDelivery:{linkTemplate:'[完整报告]({url})'}}});
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'核验结论与未完成事项。',mediaUrls:['/workspace/report.md']});
 expect(result?.text).toBe('核验结论与未完成事项。\n\n[完整报告](https://feishu.cn/docx/doc-test)');
});
it('retains the summary while distinguishing a missing reference from an uploaded report',async()=>{
 mocks.load.mockImplementation(async(path:string)=>{if(path.endsWith('missing.md'))throw Object.assign(Error('missing'),{code:'ENOENT'});return {buffer:Buffer.from('# Full report'),fileName:'report.md'};});
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'结果已核验。\n[旧报告](/workspace/missing.md)\n[完整报告](/workspace/report.md)'});
 expect(result?.text).toBe('结果已核验。\n旧报告 (missing.md)\n[完整报告](https://feishu.cn/docx/doc-test)');
 expect(mocks.upload).toHaveBeenCalledOnce();
});
it("resolves wrapped file blocks rather than treating drive upload as document insertion",async()=>{
 mocks.childrenCreate.mockResolvedValue({code:0,data:{children:[{block_type:33,block_id:'view'}]}});
 await attachDocumentFile(createFeishuClient({} as never),'doc',{buffer:Buffer.from('data'),name:'data.csv'});
 expect(mocks.childrenGet).toHaveBeenCalledWith({path:{document_id:'doc',block_id:'view'}});
 expect(mocks.upload.mock.calls[0][0].data.parent_node).toBe('inner-file');
 expect(mocks.patch.mock.calls[0][0].path.block_id).toBe('inner-file');
});
it("falls back to text before cloud writes on inaccessible or oversized local input",async()=>{
 mocks.load.mockRejectedValue(new Error('local root denied'));
 expect(await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[report](/tmp/report.md)'})).toEqual({text:'report (report.md)\n\n附件未成功交付，已改为文字结果。',mediaUrls:[]});expect(mocks.create).not.toHaveBeenCalled();
 mocks.load.mockResolvedValue({buffer:Buffer.alloc(21*1024*1024),fileName:'large.zip'});
 expect(await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',mediaUrls:['/tmp/large.zip']})).toEqual({text:'附件未成功交付，已改为文字结果。',mediaUrls:[]});expect(mocks.create).not.toHaveBeenCalled();
});

it("skips missing local files and nested references while uploading the files that exist",async()=>{
 mocks.load.mockImplementation(async(path:string)=>{
  if(path.endsWith('missing.md') || path.endsWith('missing.csv'))throw Object.assign(new Error('missing'),{code:'not-found'});
  return {buffer:Buffer.from('# Existing report\n[Missing evidence](./missing.csv)'),fileName:path.split('/').at(-1)};
 });
 await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'结论 [missing](/workspace/missing.md) [report](/workspace/report.md)'});
 expect(mocks.load.mock.calls.map(([path])=>path)).toEqual(['/workspace/missing.md','/workspace/report.md','/workspace/missing.csv']);
 expect(mocks.upload.mock.calls.map(([request])=>request.data.file_name)).toEqual(['report.md']);
 expect(mocks.write.mock.calls[0][2]).toContain('# Existing report');
});

it("keeps ordinary prose and does not create a document when all local files are absent",async()=>{
 mocks.load.mockRejectedValue(Object.assign(new Error('file absent'),{code:'ENOENT'}));
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'已核验的结论：[报告](/workspace/missing.md)'});
 expect(result).toEqual({text:'已核验的结论：报告 (missing.md)',mediaUrls:[]});
 expect(mocks.create).not.toHaveBeenCalled();expect(mocks.upload).not.toHaveBeenCalled();
});

it("ignores remote media URLs and retains errors for existing local files with denied access",async()=>{
 expect(await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',mediaUrls:['https://example.test/file.csv']})).toBeUndefined();
 expect(mocks.stat).not.toHaveBeenCalled();expect(mocks.load).not.toHaveBeenCalled();
 mocks.load.mockRejectedValue(Object.assign(new Error('access denied'),{code:'path-not-allowed'}));
 expect((await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[report](/workspace/report.md)'}))?.text).toContain('附件未成功交付');
 expect(mocks.create).not.toHaveBeenCalled();
});
it("does not claim successful delivery when attachment binding or target permissions fail",async()=>{
 mocks.patch.mockResolvedValue({code:1770001,msg:'binding rejected'});
 expect(await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',mediaUrls:['/tmp/a.csv']})).toMatchObject({text:expect.stringContaining('附件未成功交付'),mediaUrls:[]});expect(mocks.permission).not.toHaveBeenCalled();
 mocks.patch.mockResolvedValue({code:0});mocks.permission.mockResolvedValue({code:403,msg:'permission denied'});
 expect(await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',mediaUrls:['/tmp/b.csv']})).toMatchObject({text:expect.stringContaining('附件未成功交付'),mediaUrls:[]});
});
it("honors file roots, neutral templates and Lark document links",async()=>{
 mocks.account.mockReturnValue({accountId:'lark-configured',domain:'lark',config:{documentDelivery:{localRoots:['/allowed'],titleTemplate:'Result {filename}',linkTemplate:'[{title}]({url})',permission:'edit'}}});
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'user:ou_target',mediaUrls:['/allowed/a.csv']});
 expect(mocks.load.mock.calls[0][1].localRoots).toEqual(['/allowed']);
 expect(result?.text).toContain('https://www.larksuite.com/docx/doc-test');
 expect(mocks.permission.mock.calls[0][0].data).toEqual({member_type:'openid',member_id:'ou_target',perm:'edit'});
});
it("checks cancellation between attachment API mutations",async()=>{
 const controller=new AbortController();mocks.upload.mockImplementation(async()=>{controller.abort();return {file_token:'token'};});
 await expect(attachDocumentFile(createFeishuClient({} as never),'doc',{buffer:Buffer.from('x'),name:'x.txt'},()=>controller.signal.throwIfAborted())).rejects.toThrow();
 expect(mocks.patch).not.toHaveBeenCalled();
});

it("converts direct text and native cards before sending the first chat-visible request",async()=>{
 await sendMessageFeishu({cfg:{},to:'chat:oc_target',text:'Results [report](/tmp/report.md)',replyToMessageId:'original'});
 expect(mocks.messageReply).toHaveBeenCalledTimes(1);
 const sent=JSON.stringify(mocks.messageReply.mock.calls[0][0]);expect(sent).toContain('https://feishu.cn/docx/doc-test');expect(sent).not.toContain('/tmp/report.md');
 expect(sent).toContain('Results');
 expect(mocks.permission.mock.invocationCallOrder[0]).toBeLessThan(mocks.messageReply.mock.invocationCallOrder[0]);
 await sendCardFeishu({cfg:{},to:'chat:oc_target',card:{schema:'2.0',body:{elements:[{tag:'markdown',content:'[evidence](/tmp/evidence.csv)'}]}}});
 expect(JSON.stringify(mocks.messageCreate.mock.calls[0][0])).toContain('https://feishu.cn/docx/doc-test');
 expect(JSON.stringify(mocks.messageCreate.mock.calls[0][0])).not.toContain('/tmp/evidence.csv');
});
it("resolves the original chat when converting an edited result card",async()=>{
 await editMessageFeishu({cfg:{},messageId:'original',card:{schema:'2.0',body:{elements:[{tag:'markdown',content:'[report](/tmp/report.md)'}]}}});
 expect(mocks.messageGet).toHaveBeenCalled();
 expect(mocks.permission.mock.calls[0][0].data.member_id).toBe('oc_target');
 expect(JSON.stringify(mocks.messagePatch.mock.calls[0][0])).toContain('https://feishu.cn/docx/doc-test');
});
it("sends a sanitized text reply when conversion fails",async()=>{
 mocks.load.mockRejectedValue(new Error('file inaccessible'));
 await sendMessageFeishu({cfg:{},to:'chat:oc_target',text:'[report](/tmp/report.md)'});
 expect(mocks.messageCreate).toHaveBeenCalledOnce();expect(mocks.messageReply).not.toHaveBeenCalled();
 const sent=JSON.stringify(mocks.messageCreate.mock.calls[0][0]);expect(sent).not.toContain('/tmp/report.md');expect(sent).toContain('附件未成功交付');
});

it("includes local attachments referenced from the report without leaving local image URLs in converted markdown",async()=>{
 mocks.load.mockImplementation(async(path:string)=>({buffer:Buffer.from(path.endsWith('.md')?'# Report\n![Chart](./chart.png) [Evidence](./evidence.csv)':'binary'),fileName:path.split('/').at(-1)}));
 await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[Report](/workspace/report.md)'});
 expect(mocks.load.mock.calls.map(([path])=>path)).toEqual(['/workspace/report.md','/workspace/chart.png','/workspace/evidence.csv']);
 expect(mocks.write.mock.calls[0][2]).not.toContain('./chart.png');
 expect(mocks.write.mock.calls[0][2]).not.toContain('![Chart]');expect(mocks.upload).toHaveBeenCalledTimes(3);
});

it("converts a report containing slash-prefixed measurements without loading them as attachments",async()=>{
 mocks.load.mockImplementation(async(path:string)=>({buffer:Buffer.from('# Report\n4 秒 /1.681776MB；2 秒 /1.060560MB；合计 /4.874865MB'),fileName:path.split('/').at(-1)}));
 await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[Report](/workspace/report.md)'});
 expect(mocks.load.mock.calls.map(([path])=>path)).toEqual(['/workspace/report.md']);
 expect(mocks.write.mock.calls[0][2]).toContain('/1.681776MB');
 expect(mocks.upload).toHaveBeenCalledOnce();
});

it("accepts encoded Markdown paths, parentheses in filenames and explicit extensionless attachments",async()=>{
 expect(findLocalFileReferences('[Report](/tmp/report(1).md) [Space](/tmp/my%20report.md)')).toMatchObject([{path:'/tmp/report(1).md'},{path:'/tmp/my report.md'}]);
 await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',mediaUrls:['/tmp/artifact']});
 expect(mocks.upload.mock.calls[0][0].data.file_name).toBe('artifact');
});

it("reads the owning agent's external workspace through the bound runtime while denying unrelated files",async()=>{
 const root=mkdtempSync(join(tmpdir(),'feishu-agent-report-'));
 const unrelated=mkdtempSync(join(tmpdir(),'feishu-unrelated-'));
 const report=join(root,'report.md'), other=join(unrelated,'other.md');
 writeFileSync(report,'# Verified report');writeFileSync(other,'# Unrelated');
 const mediaRuntime={loadWebMedia:vi.fn(loadWebMedia)};
 const cfg={agents:{defaults:{workspace:root}}};
 try {
  await prepareFeishuDocumentDelivery({cfg,agentId:'main',mediaRuntime,to:'chat:oc_target',text:`[Report](${report})`});
  expect(mediaRuntime.loadWebMedia.mock.calls[0][1]?.localRoots).toContain(realpathSync(root));
  expect(mocks.load).not.toHaveBeenCalled();expect(mocks.write.mock.calls[0][2]).toContain('# Verified report');
  const missing=await prepareFeishuDocumentDelivery({cfg,agentId:'main',mediaRuntime,to:'chat:oc_target',text:`[Missing](${join(root,'absent.md')})`});
  expect(missing).toEqual({text:'Missing (absent.md)',mediaUrls:[]});expect(mocks.create).toHaveBeenCalledOnce();
  expect((await prepareFeishuDocumentDelivery({cfg,agentId:'main',mediaRuntime,to:'chat:oc_target',text:`[Other](${other})`}))?.text).toContain('附件未成功交付');
  expect(mocks.create).toHaveBeenCalledOnce();
  mocks.account.mockReturnValue({accountId:'restricted',config:{documentDelivery:{localRoots:[unrelated]}}});
  expect((await prepareFeishuDocumentDelivery({cfg,agentId:'main',mediaRuntime,to:'chat:oc_target',text:`[Report](${report})`}))?.text).toContain('附件未成功交付');
 } finally {rmSync(root,{recursive:true,force:true});rmSync(unrelated,{recursive:true,force:true});}
});

it.each(['create','write','upload','bind','share'] as const)('delivers the full text and signed downloads when document %s fails',async(stage)=>{
 const reject=new Error('private SDK failure must not enter the reply');
 if(stage==='create')mocks.create.mockRejectedValue(reject);
 if(stage==='write')mocks.write.mockRejectedValue(reject);
 if(stage==='upload')mocks.upload.mockRejectedValue(reject);
 if(stage==='bind')mocks.patch.mockResolvedValue({code:403,msg:'binding denied'});
 if(stage==='share')mocks.permission.mockResolvedValue({code:403,msg:'sharing denied'});
 const url='https://example.test/_cos/result.zip?signature=abc%2Bdef&expires=123';
 await sendMessageFeishu({cfg:{},to:'chat:oc_target',text:`已核验结论 aaa\n[下载](${url})\n[报告](/tmp/report.md)`,replyToMessageId:'original'});
 expect(mocks.messageReply).toHaveBeenCalledOnce();
 const sent=JSON.stringify(mocks.messageReply.mock.calls[0][0]);
 expect(sent).toContain('已核验结论 aaa');expect(sent).toContain(url);
 if(stage==='write'){expect(sent).toContain('原始 Markdown 已附');expect(sent).toContain('https://feishu.cn/docx/');}
 else {expect(sent).toContain('附件未成功交付');expect(sent).not.toContain('https://feishu.cn/docx/');}
 expect(sent).not.toContain('/tmp/report.md');expect(sent).not.toContain(reject.message);
 expect(sent).not.toContain('# Report');
});

it('updates the original card with readable results when an upload fails',async()=>{
 mocks.upload.mockRejectedValue(new Error('upload rejected'));
 await editMessageFeishu({cfg:{},messageId:'original',card:{schema:'2.0',body:{elements:[{tag:'markdown',content:'结果 bbb\n[报告](/tmp/report.md)'}]}}});
 expect(mocks.messagePatch).toHaveBeenCalledOnce();
 const card=JSON.stringify(mocks.messagePatch.mock.calls[0][0]);
 expect(card).toContain('结果 bbb');expect(card).toContain('附件未成功交付');expect(card).not.toContain('https://feishu.cn/docx/');
 expect(mocks.messageCreate).not.toHaveBeenCalled();expect(mocks.messageReply).not.toHaveBeenCalled();
});

it('keeps native cards sendable and media-only results visible on preparation failure',async()=>{
 mocks.load.mockRejectedValue(new Error('attachment access denied'));
 await sendCardFeishu({cfg:{},to:'chat:oc_target',card:{schema:'2.0',body:{elements:[{tag:'markdown',content:'结论 ccc\n[证据](/tmp/evidence.csv)'}]}}});
 expect(mocks.messageCreate).toHaveBeenCalledOnce();
 expect(JSON.stringify(mocks.messageCreate.mock.calls[0][0])).toContain('结论 ccc');
 expect(await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',mediaUrls:['/tmp/only.zip']})).toEqual({text:'附件未成功交付，已改为文字结果。',mediaUrls:[]});
});

it('never converts cancellation or withdrawn send authority into a text fallback',async()=>{
 const controller=new AbortController();
 mocks.upload.mockImplementation(async()=>{controller.abort();throw new Error('upload interrupted');});
 await expect(prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[报告](/tmp/report.md)',signal:controller.signal})).rejects.toThrow();
 expect(mocks.messageCreate).not.toHaveBeenCalled();expect(mocks.permission).not.toHaveBeenCalled();
 let retired=false;
 mocks.load.mockImplementation(async()=>{retired=true;throw new Error('load failed');});
 await expect(withFeishuSendContext({assertDirectAdapterHandoff:()=>{if(retired)throw new Error('authority withdrawn');}},()=>sendMessageFeishu({cfg:{},to:'chat:oc_target',text:'[报告](/tmp/report.md)'}))).rejects.toThrow('retired');
 expect(mocks.messageCreate).not.toHaveBeenCalled();
});

it('does not swallow actual message rejection after a successful text fallback',async()=>{
 mocks.upload.mockRejectedValue(new Error('upload failed'));
 mocks.messageCreate.mockResolvedValue({code:403,msg:'message denied'});
 await expect(sendMessageFeishu({cfg:{},to:'chat:oc_target',text:'结论 [报告](/tmp/report.md)'})).rejects.toThrow();
 expect(mocks.messageCreate).toHaveBeenCalledOnce();
});

it.each(['create','upload','bind','share'] as const)('keeps referenced reports and role manuals out of the chat when document %s fails',async(stage)=>{
 mocks.load.mockImplementation(async(path:string)=>({buffer:Buffer.from(path.endsWith('SOUL.md')
  ? '# ROLE_MANUAL_MUST_NOT_APPEAR\n'+ 'role rules '.repeat(4000)+'\nMEDIA:~/media/example.png'
  : '# FULL_REPORT_MUST_NOT_APPEAR\n'+'| long table | internal evidence |\n'.repeat(2000)),fileName:path.split('/').at(-1)}));
 if(stage==='create')mocks.create.mockRejectedValue(new Error('create failed'));
 if(stage==='upload')mocks.upload.mockRejectedValue(new Error('upload failed'));
 if(stage==='bind')mocks.patch.mockResolvedValue({code:403,msg:'binding denied'});
 if(stage==='share')mocks.permission.mockResolvedValue({code:403,msg:'sharing denied'});
 const onFailure=vi.fn();
 const text='原始核验结论。\n[报告](/workspace/report.md)\n依据 [SOUL.md](/workspace/SOUL.md) 中的一条规则。';
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text,onFailure});
 const phases={create:'create_document',upload:'upload_attachment',bind:'bind_attachment',share:'grant_access'};
 expect(onFailure).toHaveBeenCalledWith({stage:phases[stage],code:['bind','share'].includes(stage)?403:'OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED'});
 expect(JSON.stringify(onFailure.mock.calls)).not.toContain('MUST_NOT_APPEAR');
 expect(result).toEqual({text:'原始核验结论。\n报告 (report.md)\n依据 SOUL.md (SOUL.md) 中的一条规则。\n\n附件未成功交付，已改为文字结果。',mediaUrls:[]});
 expect(result?.text).not.toContain('MUST_NOT_APPEAR');expect(result?.text).not.toContain('MEDIA:');
 if(stage!=='create')expect(mocks.write.mock.calls[0][2]).toContain('FULL_REPORT_MUST_NOT_APPEAR');
});

it('keeps a short final result on the original card despite large referenced files and failed upload',async()=>{
 mocks.load.mockResolvedValue({buffer:Buffer.from('# LARGE_REFERENCED_FILE\n'+'report content '.repeat(6000)),fileName:'report.md'});
 mocks.upload.mockRejectedValue(new Error('upload failed'));
 await editMessageFeishu({cfg:{},messageId:'original',card:{schema:'2.0',body:{elements:[{tag:'markdown',content:'短结论\n[报告](/workspace/report.md)'}]}}});
 expect(mocks.messagePatch).toHaveBeenCalledOnce();expect(mocks.messageCreate).not.toHaveBeenCalled();expect(mocks.messageReply).not.toHaveBeenCalled();
 const sent=JSON.stringify(mocks.messagePatch.mock.calls[0][0]);
 expect(sent).toContain('短结论');expect(sent).toContain('附件未成功交付');expect(sent).not.toContain('LARGE_REFERENCED_FILE');expect(sent.length).toBeLessThan(1000);
});

it('fills the existing placeholder document without creating another document or changing its URL',async()=>{
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'总结 [完整报告](/workspace/report.md)',existingDocumentId:'original-placeholder'});
 expect(mocks.create).not.toHaveBeenCalled();expect(mocks.write.mock.calls[0][1]).toBe('original-placeholder');
 expect(result?.url).toBe('https://feishu.cn/docx/original-placeholder');expect(result?.text).toContain('[完整报告](https://feishu.cn/docx/original-placeholder)');
});

it('records API rejection codes without retaining transport secrets or report content',async()=>{
 const onFailure=vi.fn();
 mocks.upload.mockRejectedValue({response:{data:{code:1061002,msg:'secret-token private report'},headers:{authorization:'secret-token'}},config:{data:'private report'}});
 await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[报告](/tmp/report.md)',onFailure});
 expect(onFailure).toHaveBeenCalledWith({stage:'upload_attachment',code:1061002});
 expect(JSON.stringify(onFailure.mock.calls)).not.toContain('secret');
 expect(JSON.stringify(onFailure.mock.calls)).not.toContain('private report');
});

it('falls back to original files in the same document when Markdown body writing fails',async()=>{
 mocks.write.mockRejectedValue(new Error('unsupported table'));
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',existingDocumentId:'placeholder',text:'核验总结 [完整报告](/workspace/report.md) [CSV](/workspace/orders.csv)'});
 expect(mocks.create).not.toHaveBeenCalled();expect(mocks.write).toHaveBeenCalledOnce();
 expect(result).toMatchObject({documentId:'placeholder',url:'https://feishu.cn/docx/placeholder',mediaUrls:[]});
 expect(result?.text).toContain('[完整报告](https://feishu.cn/docx/placeholder)');
 expect(result?.text).toContain('原始 Markdown 已附在文档内');expect(result?.text).not.toContain('上传未完成');
 expect(result?.text).not.toContain('# Report');
 expect(mocks.childrenCreate.mock.calls[0][0].data.children[0]).toMatchObject({block_type:2});
 expect(mocks.upload.mock.calls.map(([request])=>request.data.file_name)).toEqual(['report.md','orders.csv']);
 expect(mocks.upload.mock.calls[0][0].data.file).toEqual(Buffer.from('# Report\nVerified'));
 expect(mocks.patch).toHaveBeenCalledTimes(2);expect(mocks.permission).toHaveBeenCalledOnce();
});
it('attaches the Markdown file when expanded body exceeds the text limit',async()=>{
 mocks.account.mockReturnValue({accountId:'text-limit-fallback',appId:'test',domain:'feishu',config:{documentDelivery:{maxTextChars:1}}});
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[报告](/workspace/report.md)'});
 expect(mocks.write).not.toHaveBeenCalled();expect(mocks.upload).toHaveBeenCalledOnce();expect(result?.documentId).toBe('doc-test');
});
it('does not report successful fallback when original file binding fails',async()=>{
 mocks.write.mockRejectedValue(new Error('conversion failed'));mocks.patch.mockResolvedValue({code:403,msg:'binding denied'});
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'结论 [报告](/workspace/report.md)'});
 expect(result?.documentId).toBeUndefined();expect(result?.text).toContain('附件未成功交付');expect(result?.text).not.toContain('Markdown 已附');
});
it('does not perform fallback mutations after body writing is cancelled',async()=>{
 const controller=new AbortController();
 mocks.write.mockImplementation(async()=>{controller.abort();throw new Error('cancelled');});
 await expect(prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[报告](/workspace/report.md)',signal:controller.signal})).rejects.toThrow();
 expect(mocks.childrenCreate).not.toHaveBeenCalled();expect(mocks.upload).not.toHaveBeenCalled();
});

it('retains text-only failure handling when no Markdown source is available',async()=>{
 mocks.write.mockRejectedValue(new Error('write failed'));
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[文本](/workspace/report.txt)'});
 expect(result?.documentId).toBeUndefined();expect(mocks.upload).not.toHaveBeenCalled();
});
it('does not claim attachment fallback when its document notice cannot be written',async()=>{
 mocks.write.mockRejectedValue(new Error('write failed'));mocks.childrenCreate.mockResolvedValue({code:403,msg:'access denied'});
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[报告](/workspace/report.md)'});
 expect(result?.documentId).toBeUndefined();expect(mocks.upload).not.toHaveBeenCalled();
});

it('does not mistake API routes concatenated with source descriptions for bare file attachments',()=>{
 expect(findLocalFileReferences('/applet/dp/getMembers在controllers/dianping.js:311附近调用Pet.checkAndGetMemberPetsByClass')).toEqual([]);
 expect(findLocalFileReferences('/tmp/报告.md /workspace/source.ts:311')).toEqual([]);
});
it.each([false,true])('retains the primary report when supplementary evidence does not exist (conversion failure=%s)',async conversionFails=>{
 mocks.load.mockImplementation(async(path:string)=>{
  if(path==='/workspace/report.md')return {buffer:Buffer.from('# 核验报告\n[关联附件](/denied/evidence.png)'),fileName:'report.md'};
  throw Error('missing attachment must never reach loader');
 });
 mocks.stat.mockImplementation(async(path:string)=>{if(path==='/denied/evidence.png')throw Object.assign(Error('missing'),{code:'ENOENT'});return {isFile:()=>true};});
 if(conversionFails)mocks.write.mockRejectedValue(Error('conversion failed'));
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'核验总结 [完整报告](/workspace/report.md)',existingDocumentId:'cloud'});
 expect(result?.documentId).toBe('cloud');expect(result?.text).toContain('[完整报告](https://feishu.cn/docx/cloud)');
 expect(mocks.load).toHaveBeenCalledOnce();expect(result?.text).not.toContain('上传未完成');
 expect(mocks.upload).toHaveBeenCalledOnce();expect(mocks.upload.mock.calls[0][0].data.file_name).toBe('report.md');
 expect(mocks.patch).toHaveBeenCalledOnce();
 if(conversionFails)expect(result?.text).toContain('原始 Markdown 已附');
 else expect(mocks.write.mock.calls[0][2]).toContain('# 核验报告');
});
it('records the underlying local file rejection code rather than the generic dispatch wrapper',async()=>{
 mocks.load.mockRejectedValue(Object.assign(Error('private report'),{code:'path-not-allowed'}));
 const onFailure=vi.fn();await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[报告](/denied/report.md)',onFailure});
 expect(onFailure).toHaveBeenCalledWith({stage:'read_files',code:'path-not-allowed'});
 expect(mocks.write).not.toHaveBeenCalled();expect(mocks.upload).not.toHaveBeenCalled();
});

it.each(['ENOENT','ENOTDIR','directory'])('skips %s local links before media loading',async state=>{
 if(state==='directory')mocks.stat.mockResolvedValue({isFile:()=>false});
 else mocks.stat.mockRejectedValue(Object.assign(Error('missing'),{code:state}));
 await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'总结 [报告](/workspace/report.md)'});
 expect(mocks.load).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();expect(mocks.upload).not.toHaveBeenCalled();
});
it('does not treat a stat permission failure as a missing file',async()=>{
 mocks.stat.mockRejectedValue(Object.assign(Error('denied'),{code:'EACCES'}));const onFailure=vi.fn();
 await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[报告](/workspace/report.md)',onFailure});
 expect(onFailure).toHaveBeenCalledWith({stage:'read_files',code:'EACCES'});expect(mocks.load).not.toHaveBeenCalled();
});

it.each(['same','document','target','permission','missing'])('reuses only the confirmed matching placeholder grant (%s)',async variant=>{
 const text='报告 [完整报告](/workspace/grant-report.md)';
 mocks.stat.mockResolvedValue({isFile:()=>true});mocks.load.mockResolvedValue({buffer:Buffer.from('# 完整证据'),fileName:'grant-report.md',mimeType:'text/markdown'});
 const grant={documentId:'grant-placeholder',memberType:'openchat',memberId:'oc_target',permission:'view'};
 if(variant==='document')grant.documentId='different-document';
 if(variant==='target')grant.memberId='different-target';
 if(variant==='permission')grant.permission='edit';
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text,existingDocumentId:'grant-placeholder',confirmedGrant:variant==='missing'?undefined:grant});
 expect(result?.documentId).toBe('grant-placeholder');
 expect(mocks.permission).toHaveBeenCalledTimes(variant==='same'?0:1);
});

it('skips oversized direct and nested attachments before reading, and keeps other reports and signed downloads',async()=>{
 const limit=1024**3,signed='https://download.test/large.zip?signature=x%2Fy%3D';
 mocks.account.mockReturnValue({accountId:'oversized-mixed',domain:'feishu',config:{documentDelivery:{maxFiles:1}}});
 mocks.stat.mockImplementation(async(path:string)=>({isFile:()=>true,size:path.endsWith('.zip')?limit+1:10}));
 mocks.load.mockResolvedValue({buffer:Buffer.from('# 原报告\n[大附件](./nested.zip)'),fileName:'report.md'});
 const onFailure=vi.fn();
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:`结论 [业务下载](${signed}) [大文件](/workspace/direct.zip) [完整报告](/workspace/report.md)`,mediaUrls:['/workspace/direct.zip'],onFailure});
 expect(mocks.load.mock.calls.map(([path])=>path)).toEqual(['/workspace/report.md']);
 expect(mocks.upload.mock.calls.map(([r])=>r.data.file_name)).toEqual(['report.md']);
 expect(onFailure).not.toHaveBeenCalled();expect(result?.documentId).toBe('doc-test');
 expect(result?.text).toContain(`[业务下载](${signed})`);expect(result?.text).toContain('[完整报告](https://feishu.cn/docx/doc-test)');
 expect(result?.text).not.toContain('[大文件](https://');expect(result?.text).not.toContain('# 原报告');
 for(const text of [result!.text,mocks.write.mock.calls[0][2]]) {
  expect(text).toContain('附件未上传说明');expect(text).toContain('超过 1GB（1024MB），已跳过上传');
  expect(text.split('direct.zip：')).toHaveLength(2);expect(text.split('nested.zip：')).toHaveLength(2);
  expect(text).toContain(`${limit+1} 字节`);
 }
});
it.each([undefined,'placeholder'])('writes the skip explanation even when every attachment is oversized (document=%s)',async existingDocumentId=>{
 mocks.stat.mockResolvedValue({isFile:()=>true,size:2*1024**3});
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'总结已完成',mediaUrls:['/workspace/only-large.zip'],existingDocumentId});
 expect(mocks.load).not.toHaveBeenCalled();expect(mocks.upload).not.toHaveBeenCalled();
 expect(result?.documentId).toBe(existingDocumentId ?? 'doc-test');expect(result?.text).toContain('only-large.zip');
 expect(mocks.write.mock.calls[0][1]).toBe(existingDocumentId ?? 'doc-test');
 expect(mocks.write.mock.calls[0][2]).toContain('超过 1GB');expect(result?.text).not.toContain('上传未完成');
 expect(mocks.create).toHaveBeenCalledTimes(existingDocumentId?0:1);
});
it.each([1024**3-1,1024**3])('retains existing media size enforcement for files at or below 1GB (%s)',async size=>{
 mocks.stat.mockResolvedValue({isFile:()=>true,size});
 mocks.load.mockRejectedValueOnce(Error('media size limit'));
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[附件](/workspace/boundary.zip)'});
 expect(mocks.load).toHaveBeenCalledOnce();expect(mocks.load.mock.calls[0][1].maxBytes).toBe(20*1024*1024);
 expect(result?.text).not.toContain('超过 1GB');expect(result?.text).toContain('附件未成功交付');
});
it('retains oversized-file explanations when another attachment fails',async()=>{
 mocks.stat.mockImplementation(async(path:string)=>({isFile:()=>true,size:path.endsWith('.zip')?1024**3+1:10}));
 mocks.load.mockRejectedValueOnce(Error('read denied'));
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'结论 [大附件](/workspace/large.zip) [报告](/workspace/report.md)'});
 expect(result?.text).toContain('large.zip：');expect(result?.text).toContain('已跳过上传');
 expect(result?.text).toContain('附件未成功交付');expect(mocks.upload).not.toHaveBeenCalled();
});
it('includes skipped-file reasons in the plain document notice when Markdown conversion fails',async()=>{
 mocks.stat.mockImplementation(async(path:string)=>({isFile:()=>true,size:path.endsWith('.zip')?1024**3+1:10}));
 mocks.write.mockRejectedValueOnce(Error('converter failed'));
 const result=await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'[大附件](/workspace/convert-large.zip) [报告](/workspace/report.md)'});
 const notice=mocks.childrenCreate.mock.calls.find(([r])=>r.data.children[0].block_type===2)?.[0];
 expect(notice.data.children[0].text.elements[0].text_run.content).toContain('convert-large.zip');
 expect(result?.documentId).toBe('doc-test');expect(result?.text).toContain('已跳过上传');expect(mocks.upload).toHaveBeenCalledOnce();
});

it("keeps message images out of documents and extracts inline images for native delivery",async()=>{
 expect(await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'Hello',mediaUrls:['~/.openclaw/media/received.png']})).toBeUndefined();
 expect(await prepareFeishuDocumentDelivery({cfg:{},to:'chat:oc_target',text:'Hello\n![收到](/workspace/received.gif)'})).toEqual({text:'Hello',mediaUrls:['/workspace/received.gif']});
 expect(mocks.create).not.toHaveBeenCalled();expect(mocks.load).not.toHaveBeenCalled();
});
it("preserves native images alongside a report document, including when upload fails",async()=>{
 const params={cfg:{},to:'chat:oc_target',text:'Hello [报告](/workspace/report.md) ![图](/workspace/received.png)',mediaUrls:['/workspace/received.png']};
 const result=await prepareFeishuDocumentDelivery(params);
 expect(result).toMatchObject({documentId:'doc-test',mediaUrls:['/workspace/received.png']});
 expect(mocks.load.mock.calls.map(([path])=>path)).toEqual(['/workspace/report.md']);
 expect(mocks.upload).toHaveBeenCalledOnce();
 mocks.load.mockRejectedValueOnce(Error('denied'));
 expect(await prepareFeishuDocumentDelivery({...params,text:'Other '+params.text})).toMatchObject({mediaUrls:['/workspace/received.png'],text:expect.stringContaining('附件未成功交付')});
});

it("sends inline message images through native media after the acknowledged text or card",async()=>{
 await sendMessageFeishu({cfg:{},to:'chat:oc_target',text:'Hello ![收到](/workspace/received.png)'});
 expect(mocks.mediaSend).toHaveBeenCalledWith(expect.objectContaining({mediaUrl:'/workspace/received.png',replyToMessageId:'message-test'}));
 expect(mocks.create).not.toHaveBeenCalled();
});
