import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {presentContributorApproval,renderContributorCard,readContributorCard,handleContributorAction,updateContributorReceipt,WORKER_CONTRIBUTOR_APPROVE,type ContributorEvent} from './worker-contributor.js';
import {workerQuestionBridge} from './worker-question.js';
import {handleFeishuCardAction} from './card-action.js';
const mocks=vi.hoisted(()=>({send:vi.fn(),edit:vi.fn(),message:vi.fn()}));
vi.mock('./send.js',()=>({sendCardFeishu:mocks.send,editMessageFeishu:mocks.edit,sendMessageFeishu:mocks.message}));
vi.mock('./accounts.js',()=>({resolveFeishuRuntimeAccount:()=>({accountId:'a',config:{}})}));
vi.mock('./bot.js',()=>({handleFeishuMessage:vi.fn()}));
vi.mock('./client.js',()=>({createFeishuClient:vi.fn()}));
let stateDir:string,event:ContributorEvent;
const callback=(mode='worker')=>({operator:{open_id:'alice'},token:'contributor-'+Math.random(),context:{chat_id:'chat',open_message_id:'approval-card'},action:{tag:'button',value:{oc:'ocf1' as const,k:'button' as const,a:WORKER_CONTRIBUTOR_APPROVE,m:{requestId:'permission',mode},c:{u:'alice',h:'chat',s:event.provenance.sessionKey,e:event.request.expiresAt,t:'group' as const}}}});
const present=()=>presentContributorApproval({cfg:{},stateDir,event,authorize:()=>true});
beforeEach(()=>{
 stateDir=mkdtempSync(join(tmpdir(),'contributor-card-'));mocks.send.mockReset().mockResolvedValue({messageId:'approval-card'});mocks.edit.mockReset().mockResolvedValue({});mocks.message.mockReset().mockResolvedValue({});
 event={jobId:'job',provenance:{taskId:'task',revision:0,accountId:'a',chatId:'chat',chatType:'group',sessionKey:'agent:main:feishu:chat',senderId:'alice',sourceMessageIds:['original'],requestMessageIds:['original']},request:{requestId:'permission',questionId:'q',source:{senderId:'bob',sourceMessageIds:['hint']},answer:'hint <script>untrusted</script>',status:'pending',expiresAt:Date.now()+60000}};
 workerQuestionBridge.contributorRead=()=>({job:{provenance:event.provenance},request:event.request});workerQuestionBridge.contributorDecide=vi.fn(async p=>({mode:p.mode,resumed:true}));
});
afterEach(()=>{workerQuestionBridge.contributorRead=undefined;workerQuestionBridge.contributorDecide=undefined;workerQuestionBridge.contributorAction=undefined;rmSync(stateDir,{recursive:true,force:true});});
it('renders three choices targeting A and escapes contributor content',()=>{
 const card=renderContributorCard(event),raw=JSON.stringify(card),elements=(card.body as {elements:{tag:string;text?:{content:string};behaviors?:{value:{c:{u:string}}}[]}[]}).elements,buttons=elements.filter(e=>e.tag==='button');
 expect(buttons.map(b=>b.text!.content)).toEqual(['允许一次','一直允许','允许这轮（Worker）']);expect(buttons.every(b=>b.behaviors![0].value.c.u==='alice')).toBe(true);expect(raw).toContain('&lt;script&gt;');expect(raw).toContain('不改变原任务目标');
});
it('persists one card receipt across concurrent and repeated requests',async()=>{
 await Promise.all([present(),present()]);await present();expect(mocks.send).toHaveBeenCalledOnce();expect(readContributorCard(stateDir,'permission')?.messageId).toBe('approval-card');expect(workerQuestionBridge.contributorDecide).not.toHaveBeenCalled();
});
it.each(['once','always','worker'])('routes callback and durably records %s without duplicate resume',async mode=>{
 await present();workerQuestionBridge.contributorAction=p=>handleContributorAction({...p,stateDir});
 await handleFeishuCardAction({cfg:{},accountId:'a',event:callback(mode)});await handleFeishuCardAction({cfg:{},accountId:'a',event:callback(mode)});
 expect(workerQuestionBridge.contributorDecide).toHaveBeenCalledOnce();expect(workerQuestionBridge.contributorDecide).toHaveBeenCalledWith(expect.objectContaining({actor:{senderId:'alice',accountId:'a'},mode}));expect(readContributorCard(stateDir,'permission')?.mode).toBe(mode);expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).not.toContain('behaviors');
});
it.each(['user','chat','account','message','mode'])('rejects forged %s callbacks using stored bindings',async kind=>{
 await present();const e=callback();let accountId='a';if(kind==='user')e.operator.open_id='bob';if(kind==='chat')e.context.chat_id='other';if(kind==='account')accountId='other';if(kind==='message')e.context.open_message_id='other';if(kind==='mode')e.action.value.m.mode='admin';
 await expect(handleContributorAction({cfg:{},stateDir,accountId,event:e})).rejects.toThrow();expect(workerQuestionBridge.contributorDecide).not.toHaveBeenCalled();
});
it('retains uncertain sends instead of producing duplicate authorization cards',async()=>{
 mocks.send.mockRejectedValueOnce(Error('transport lost after acceptance'));await expect(present()).rejects.toThrow();await expect(present()).rejects.toThrow('uncertain');expect(mocks.send).toHaveBeenCalledOnce();
});
it('does not confirm failed grants and allows the same callback token to retry',async()=>{
 await present();workerQuestionBridge.contributorAction=p=>handleContributorAction({...p,stateDir});const decide=vi.fn().mockRejectedValueOnce(Error('source unavailable')).mockResolvedValue({mode:'once',resumed:true});workerQuestionBridge.contributorDecide=decide;
 const e=callback('once');await expect(handleFeishuCardAction({cfg:{},accountId:'a',event:e})).rejects.toThrow();expect(readContributorCard(stateDir,'permission')?.mode).toBeUndefined();await handleFeishuCardAction({cfg:{},accountId:'a',event:e});expect(decide).toHaveBeenCalledTimes(2);
});
it('retains approval after card edit failure without granting again',async()=>{
 await present();mocks.edit.mockRejectedValueOnce(Error('edit failed'));await expect(handleContributorAction({cfg:{},stateDir,accountId:'a',event:callback()})).rejects.toThrow();await handleContributorAction({cfg:{},stateDir,accountId:'a',event:callback()});expect(workerQuestionBridge.contributorDecide).toHaveBeenCalledOnce();
});

it('labels long hints as excerpts and leaves stored input complete',()=>{
 event.request.answer='长'.repeat(2000);const raw=JSON.stringify(renderContributorCard(event));expect(raw).toContain('补充内容（摘录）');expect(raw).toContain('完整补充已保存');expect(event.request.answer).toHaveLength(2000);
});

it.each(['blocked','suppressed','dispatched'])('persists and renders durable steering outcome %s',async state=>{
 event.request.kind='steering';await present();workerQuestionBridge.contributorDecide=vi.fn(async p=>({mode:p.mode,resumed:state==='dispatched',queued:false,state,reason:state==='dispatched'?undefined:'original_session_missing'}));
 await handleContributorAction({cfg:{},stateDir,accountId:'a',event:callback()});
 const card=readContributorCard(stateDir,'permission')!;expect(card.state).toBe(state);expect(card.reason).toBe(state==='dispatched'?undefined:'original_session_missing');
 const raw=JSON.stringify(mocks.edit.mock.calls.at(-1));expect(raw).not.toContain('将在原 Worker 当前轮次结束后接续');
 if(state==='dispatched'){expect(raw).toContain('已交回原 Worker');expect(raw).not.toContain('业务已完成');}else{expect(raw).toContain('原 Worker 会话不可用');expect(raw).toContain('引导未执行');}
});
it('updates a granted queued steering card when background continuation becomes unavailable',async()=>{
 event.request.kind='steering';await present();workerQuestionBridge.contributorDecide=vi.fn(async p=>({mode:p.mode,resumed:false,queued:true,state:'accepted'}));
 await handleContributorAction({cfg:{},stateDir,accountId:'a',event:callback()});
 const update={cfg:{},stateDir,jobId:event.jobId,provenance:event.provenance,supplementId:event.request.questionId,kind:'supplement_unavailable',status:'blocked',reason:'original_session_missing'};
 await updateContributorReceipt(update);expect(readContributorCard(stateDir,'permission')?.state).toBe('blocked');expect(readContributorCard(stateDir,'permission')?.queued).toBe(false);expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).toContain('原 Worker 会话不可用');
 const calls=mocks.edit.mock.calls.length;await updateContributorReceipt({...update,provenance:{...event.provenance,accountId:'other'}});expect(mocks.edit).toHaveBeenCalledTimes(calls);
});
