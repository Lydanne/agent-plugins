import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderQuestionCard,parseQuestionSubmission,saveQuestionCard,readQuestionCard,claimQuestionAnswer,questionAction,workerQuestionBridge,WORKER_QUESTION_REOPEN,type QuestionCard} from './worker-question.js';
import {handleWorkerQuestionAction,handleWorkerQuestionTextReply} from './worker-question-action.js';
const mocks=vi.hoisted(()=>({edit:vi.fn(),send:vi.fn(),card:vi.fn()}));
vi.mock('./send.js',()=>({editMessageFeishu:mocks.edit,sendMessageFeishu:mocks.send,sendCardFeishu:mocks.card}));
vi.mock('./accounts.js',()=>({resolveFeishuRuntimeAccount:()=>({accountId:'a',config:{}})}));
vi.mock('./bot.js',()=>({handleFeishuMessage:vi.fn()}));
vi.mock('./client.js',()=>({createFeishuClient:vi.fn()}));
let stateDir:string;
const fixture=():QuestionCard=>({jobId:'job',provenance:{taskId:'task',revision:0,accountId:'a',chatId:'chat',senderId:'alice',sessionKey:'agent:main:feishu:chat',requestMessageIds:['request'],sourceMessageIds:['request']},messageId:'card',status:'waiting',question:{questionId:'q',expiresAt:Date.now()+60000,question:'请确认日期范围',reason:'日期未知',progress:'已确认只读方式',knownValues:{env:'prod'},fields:[{id:'env',label:'环境',type:'single_select',required:true,options:[{label:'生产',value:'prod'},{label:'测试',value:'test'}]},{id:'period',label:'日期',type:'date_range',timezone:'Asia/Shanghai',required:true}],allowFreeText:true}});
const event=(card:QuestionCard,form:Record<string,unknown>)=>({operator:{open_id:'alice'},token:'token',context:{chat_id:'chat',open_message_id:'card'},action:{tag:'button',value:questionAction(card),form_value:form}});
beforeEach(()=>{stateDir=mkdtempSync(join(tmpdir(),'worker-form-'));mocks.card.mockReset().mockResolvedValue({messageId:'supplement-card'});mocks.edit.mockReset().mockResolvedValue({messageId:'card'});mocks.send.mockReset().mockResolvedValue({messageId:'notice'});workerQuestionBridge.read=()=>({status:'awaiting_user',question:fixture().question});workerQuestionBridge.authorize=()=>true;workerQuestionBridge.submit=vi.fn(async card=>saveQuestionCard(stateDir,{...card,status:'accepted',workingMessageId:'new-working'}));});
afterEach(()=>{rmSync(stateDir,{recursive:true,force:true});workerQuestionBridge.read=undefined;workerQuestionBridge.authorize=undefined;workerQuestionBridge.submit=undefined;workerQuestionBridge.reopen=undefined;workerQuestionBridge.supplement=undefined;workerQuestionBridge.acceptSubmission=undefined;});
it('renders missing fields only, with timezone and explicit submit and no GIF',()=>{
 const card=renderQuestionCard(fixture());const raw=JSON.stringify(card);
 expect(raw).toContain('date_picker');expect(raw).toContain('Asia/Shanghai');expect(raw).toContain('form_action_type');expect(raw).not.toContain('select_static');expect(raw).not.toContain('img_key');expect(raw).toContain('生产');
});
it('normalizes provider dates and merges only trusted known values',()=>{
 const card=fixture();expect(parseQuestionSubmission(card,{period__start:'2026-10-01 +0800',period__end:'2026-10-09 +0800',worker_note:'  只读  '})).toEqual({answers:{env:'prod',period:{start:'2026-10-01',end:'2026-10-09'}},note:'只读'});
 expect(()=>parseQuestionSubmission(card,{env:'test',period__start:'2026-10-01',period__end:'2026-10-09'})).toThrow('覆盖');
 expect(()=>parseQuestionSubmission(card,{period__start:'2026-10-09',period__end:'2026-10-01'})).toThrow('请检查日期');
});
it('persists one answer and rejects a second submission across store reads',()=>{
 const card=fixture();saveQuestionCard(stateDir,card);const values=parseQuestionSubmission(card,{period__start:'2026-10-01',period__end:'2026-10-09'}).answers;
 claimQuestionAnswer(stateDir,card,values);expect(readQuestionCard(stateDir,'q')?.answers).toEqual(values);expect(()=>claimQuestionAnswer(stateDir,card,values)).toThrow('已提交');
});
it('submits once to Main, preserves the question and disables completed controls',async()=>{
 const card=fixture();saveQuestionCard(stateDir,card);const e=event(card,{period__start:'2026-10-01',period__end:'2026-10-09'});
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});
 await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));expect(workerQuestionBridge.submit).toHaveBeenCalledOnce();
 await vi.waitFor(()=>expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).not.toContain('form_action_type'));
 workerQuestionBridge.read=()=>({status:'running',question:{...card.question,answer:'accepted'}});
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});expect(workerQuestionBridge.submit).toHaveBeenCalledOnce();
});
it('keeps invalid input pending without editing away client form values',async()=>{
 const card=fixture();saveQuestionCard(stateDir,card);await handleWorkerQuestionAction({cfg:{},accountId:'a',event:event(card,{period__start:'2026-10-09',period__end:'2026-10-01'}),stateDir});
 expect(workerQuestionBridge.submit).not.toHaveBeenCalled();expect(mocks.edit).not.toHaveBeenCalled();expect(readQuestionCard(stateDir,'q')?.status).toBe('waiting');
});
it.each(['user','chat','message','account','source'])('rejects a mismatched %s binding',async kind=>{
 const card=fixture();saveQuestionCard(stateDir,card);const e=event(card,{});let accountId='a';
 if(kind==='user')e.operator.open_id='other';if(kind==='chat')e.context.chat_id='other';if(kind==='message')e.context.open_message_id='other';if(kind==='account')accountId='other';if(kind==='source')workerQuestionBridge.authorize=()=>false;
 await expect(handleWorkerQuestionAction({cfg:{},accountId,event:e,stateDir})).rejects.toThrow();expect(workerQuestionBridge.submit).not.toHaveBeenCalled();
});
it('keeps saved answers after Main failure and permits an explicit retry without re-entry',async()=>{
 const card=fixture();saveQuestionCard(stateDir,card);workerQuestionBridge.submit=vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async card=>saveQuestionCard(stateDir,{...card,status:'accepted'}));
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:event(card,{period__start:'2026-10-01',period__end:'2026-10-09'}),stateDir});
 expect(readQuestionCard(stateDir,'q')?.status).toBe('submitted');await vi.waitFor(()=>expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).toContain('重试交回 Main'));
 const retry=event(card,{});retry.action.value.m={questionId:'q',retry:true};await handleWorkerQuestionAction({cfg:{},accountId:'a',event:retry,stateDir});
 await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));expect(workerQuestionBridge.submit).toHaveBeenCalledTimes(2);
});

it('supports quick-choice buttons using server-stored option values',async()=>{
 const card=fixture();card.question.knownValues=undefined;card.question.fields=[card.question.fields![0]];saveQuestionCard(stateDir,card);workerQuestionBridge.read=()=>({status:'awaiting_user',question:card.question});
 const e=event(card,{});e.action.value.m={questionId:'q',option:'prod'};
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));expect(readQuestionCard(stateDir,'q')?.answers).toEqual({env:'prod'});
});
it('cancels only after the worker owner confirms cancellation',async()=>{
 const card=fixture();saveQuestionCard(stateDir,card);workerQuestionBridge.cancel=vi.fn(()=>({status:'cancelled'}));
 const e=event(card,{});e.action.value.a='worker.question.cancel';
 try{await handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});expect(workerQuestionBridge.submit).not.toHaveBeenCalled();expect(readQuestionCard(stateDir,'q')?.status).toBe('cancelled');}finally{workerQuestionBridge.cancel=undefined;}
});

it('prevents concurrent callback tokens from dispatching two Main answer turns',async()=>{
 const card=fixture();saveQuestionCard(stateDir,card);let release!:()=>void;
 workerQuestionBridge.submit=vi.fn(async submitted=>{await new Promise<void>(r=>release=r);saveQuestionCard(stateDir,{...submitted,status:'accepted'});});
 const e=event(card,{period__start:'2026-10-01',period__end:'2026-10-09'});
 const first=handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});
 await vi.waitFor(()=>expect(workerQuestionBridge.submit).toHaveBeenCalledOnce());
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:{...e,token:'another'},stateDir});release();await first;await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));
 expect(workerQuestionBridge.submit).toHaveBeenCalledOnce();
});

it('preserves explicit provider datetime offsets rather than reinterpreting a device local time',()=>{
 const card=fixture();card.question.knownValues=undefined;card.question.fields=[{id:'at',label:'时间',type:'datetime',timezone:'Asia/Shanghai',required:true}];
 expect(parseQuestionSubmission(card,{at:'2026-10-10 12:30 +0900'}).answers).toEqual({at:'2026-10-10 12:30+0900'});
});
it('escapes native mention tags from Worker questions and user notes',()=>{
 const card=fixture();card.question.question='<at id="all"></at> 范围？';expect(JSON.stringify(renderQuestionCard(card))).not.toContain('<at');
});

it('uses v2 component properties for select/date controls and callback behaviors for every button',()=>{
 const saved=fixture();saved.question.knownValues={};saved.question.fields!.push({id:'scope',label:'内容范围',type:'multi_select',options:[{label:'过程',value:'process'}]},{id:'at',label:'时间',type:'datetime',timezone:'Asia/Shanghai'});
 const card=renderQuestionCard(saved);const nodes:Record<string,unknown>[]=[];
 const walk=(node:unknown)=>{if(Array.isArray(node))node.forEach(walk);else if(node&&typeof node==='object'){const value=node as Record<string,unknown>;if(value.tag)nodes.push(value);Object.values(value).forEach(walk);}};walk(card);
 for(const control of nodes.filter(node=>['select_static','multi_select_static','date_picker','picker_datetime'].includes(String(node.tag)))){expect(control).not.toHaveProperty('label');expect(control).not.toHaveProperty('label_position');expect(control).toHaveProperty('name');}
 for(const btn of nodes.filter(node=>node.tag==='button')){expect(btn).not.toHaveProperty('value');expect(btn.behaviors).toEqual([expect.objectContaining({type:'callback',value:expect.objectContaining({oc:'ocf1'})})]);}
 expect(JSON.stringify(card)).toContain('内容范围');expect(JSON.stringify(card)).toContain('开始日期');
});


it('keeps every form input within the Card JSON 2.0 length limit',()=>{
 const card=fixture();card.question.fields!.push({id:'detail',label:'描述',type:'text'},{id:'count',label:'数量',type:'number'});
 const rendered=renderQuestionCard(card),inputs:Record<string,unknown>[]=[];
 const walk=(node:unknown)=>{if(Array.isArray(node))node.forEach(walk);else if(node&&typeof node==='object'){const value=node as Record<string,unknown>;if(value.tag==='input')inputs.push(value);Object.values(value).forEach(walk);}};walk(rendered);
 expect(inputs.map(node=>[node.name,node.max_length])).toEqual([['detail',1000],['count',40],['worker_note',1000]]);
 for(const input of inputs){expect(input.max_length).toBeGreaterThanOrEqual(1);expect(input.max_length).toBeLessThanOrEqual(1000);}
});

const textReply=(overrides:Partial<Parameters<typeof handleWorkerQuestionTextReply>[0]>={})=>handleWorkerQuestionTextReply({cfg:{},stateDir,accountId:'a',chatId:'chat',senderId:'alice',messageId:'answer-message',parentId:'card',text:'北京时间10月19日到20日',...overrides});
it('accepts a native text answer without inventing values for required form fields and updates the same question card',async()=>{
 const card=fixture();saveQuestionCard(stateDir,card);
 expect(await textReply()).toBe(true);
 await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));
 expect(readQuestionCard(stateDir,'q')).toMatchObject({answerSource:'user_text',answerMessageId:'answer-message',answers:{env:'prod'},note:'北京时间10月19日到20日',messageId:'card'});
 expect(workerQuestionBridge.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({jobId:'job',answerMessageId:'answer-message'}));
 expect(mocks.edit.mock.calls.every(([p])=>p.messageId==='card')).toBe(true);
 expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).toContain('文字补充：北京时间10月19日到20日');
 expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).not.toContain('form_action_type');
 expect(mocks.send).not.toHaveBeenCalled();
});
it.each(['accountId','chatId','senderId','parentId'] as const)('does not capture a text answer with a different %s',async key=>{
 saveQuestionCard(stateDir,fixture());expect(await textReply({[key]:'other'})).toBe(false);
 expect(workerQuestionBridge.submit).not.toHaveBeenCalled();expect(mocks.edit).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
});
it.each(['expired','cancelled','source','worker-running','wrong-question'] as const)('keeps an invalid %s text answer from resuming or becoming a new task',async kind=>{
 const card=fixture();if(kind==='expired')card.question.expiresAt=0;if(kind==='cancelled')card.status='cancelled';saveQuestionCard(stateDir,card);
 if(kind==='source')workerQuestionBridge.authorize=()=>false;
 if(kind==='worker-running')workerQuestionBridge.read=()=>({status:'running',question:card.question});
 if(kind==='wrong-question')workerQuestionBridge.read=()=>({status:'awaiting_user',question:{...card.question,questionId:'other'}});
 expect(await textReply()).toBe(true);expect(workerQuestionBridge.submit).not.toHaveBeenCalled();expect(mocks.edit).not.toHaveBeenCalled();expect(mocks.send).toHaveBeenCalledOnce();
 expect(readQuestionCard(stateDir,'q')?.answerMessageId).toBeUndefined();
});
it('deduplicates the same native reply and rejects replacement by a different reply',async()=>{
 saveQuestionCard(stateDir,fixture());await textReply();await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));
 await textReply();expect(mocks.send).not.toHaveBeenCalled();
 await textReply({messageId:'second-message',text:'另一条补充'});
 expect(workerQuestionBridge.submit).toHaveBeenCalledOnce();expect(readQuestionCard(stateDir,'q')?.note).toBe('北京时间10月19日到20日');expect(mocks.send).toHaveBeenCalledOnce();
});
it('preserves a long text answer in full while bounding only the question card preview',async()=>{
 const card=fixture();card.question.allowFreeText=false;saveQuestionCard(stateDir,card);const raw='完整原始文字'.repeat(1800);
 await textReply({text:raw});await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));
 expect(readQuestionCard(stateDir,'q')?.note).toBe(raw);expect(workerQuestionBridge.submit).toHaveBeenCalledWith(expect.objectContaining({note:raw}));
 expect(Buffer.byteLength(JSON.stringify(mocks.edit.mock.calls.at(-1)![0].card),'utf8')).toBeLessThan(28000);
 expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).toContain('完整文字已保存');
});
it('keeps oversize text pending and does not silently truncate it before continuation',async()=>{
 saveQuestionCard(stateDir,fixture());expect(await textReply({text:'长'.repeat(16000)})).toBe(true);
 expect(workerQuestionBridge.submit).not.toHaveBeenCalled();expect(readQuestionCard(stateDir,'q')?.status).toBe('waiting');expect(mocks.send).toHaveBeenCalledOnce();
});
it('reserves the answer once when a form callback races with a native text reply',async()=>{
 const card=fixture();saveQuestionCard(stateDir,card);let release!:()=>void;
 workerQuestionBridge.submit=vi.fn(async submitted=>{await new Promise<void>(resolve=>release=resolve);saveQuestionCard(stateDir,{...submitted,status:'accepted'});});
 await textReply();await vi.waitFor(()=>expect(workerQuestionBridge.submit).toHaveBeenCalledOnce());
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:event(card,{period__start:'2026-10-19',period__end:'2026-10-20'}),stateDir});
 release();await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));expect(workerQuestionBridge.submit).toHaveBeenCalledOnce();
});
it('retains a failed text answer for the same explicit retry control as a form answer',async()=>{
 saveQuestionCard(stateDir,fixture());workerQuestionBridge.submit=vi.fn().mockRejectedValueOnce(Error('offline')).mockImplementation(async card=>saveQuestionCard(stateDir,{...card,status:'accepted'}));
 await textReply();await vi.waitFor(()=>expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).toContain('重试交回 Main'));
 const retry=event(fixture(),{});retry.action.value.m={questionId:'q',retry:true};
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:retry,stateDir});await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));
 expect(workerQuestionBridge.submit).toHaveBeenLastCalledWith(expect.objectContaining({answerSource:'user_text',answerMessageId:'answer-message',note:'北京时间10月19日到20日'}));
});
it('does not guess between two pending questions sharing the same reply target',async()=>{
 const card=fixture();saveQuestionCard(stateDir,card);saveQuestionCard(stateDir,{...card,jobId:'other',question:{...card.question,questionId:'other'}});
 expect(await textReply()).toBe(true);expect(workerQuestionBridge.submit).not.toHaveBeenCalled();expect(mocks.send).toHaveBeenCalledOnce();
});
it('clears the earlier text source and clarification when a pending question is answered through its form',()=>{
 const card={...fixture(),answerSource:'user_text' as const,answerMessageId:'unaccepted-text',note:'未明确',validationNote:'请提供日期'};saveQuestionCard(stateDir,card);
 const values=parseQuestionSubmission(card,{period__start:'2026-10-19',period__end:'2026-10-20'});
 const submitted=claimQuestionAnswer(stateDir,card,values.answers,values.note);
 expect(submitted.answerSource).toBe('user_card');expect(submitted.answerMessageId).toBeUndefined();expect(submitted.validationNote).toBeUndefined();
});

it('rejects waiting cards with no remaining response controls',()=>{
 const card=fixture();
 expect(()=>renderQuestionCard({...card,question:{...card.question,fields:undefined,allowFreeText:false}})).toThrow('no answer controls');
 expect(()=>renderQuestionCard({...card,question:{...card.question,fields:card.question.fields!.slice(0,1),allowFreeText:false}})).toThrow('no answer controls');
 expect(JSON.stringify(renderQuestionCard({...card,question:{...card.question,fields:undefined,allowFreeText:true}}))).toContain('worker_note');
});

function reopenFixture(){
 const card:QuestionCard={...fixture(),status:'accepted',reopenAllowed:true};card.question={...card.question,answer:'未知跳过',resumeReason:'user_wait_timeout'};
 saveQuestionCard(stateDir,card);const question={...fixture().question,questionId:'supplement'};
 workerQuestionBridge.read=()=>({status:'running',question:card.question});
 workerQuestionBridge.reopen=vi.fn(async()=>({question,supplementId:'supplement'}));
 const e=event(card,{});e.action.value.a=WORKER_QUESTION_REOPEN;return {card,e};
}
it('reopens one supplemental card and removes the original button, including repeated callbacks',async()=>{
 const {e}=reopenFixture();
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});
 expect(mocks.card).toHaveBeenCalledOnce();expect(readQuestionCard(stateDir,'q')?.reopenedQuestionId).toBe('supplement');
 const next=readQuestionCard(stateDir,'supplement')!;expect(next.supplementOf).toBe('q');expect(next.messageId).toBe('supplement-card');
 expect(JSON.stringify(renderQuestionCard(next))).not.toContain('取消任务');
 expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).not.toContain('重新补充');
});
it('does not create another supplemental card after an uncertain send',async()=>{
 const {e}=reopenFixture();mocks.card.mockRejectedValue(Error('transport lost'));
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});
 expect(readQuestionCard(stateDir,'supplement')?.creationState).toBe('uncertain');
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});
 expect(mocks.card).toHaveBeenCalledOnce();expect(JSON.stringify(mocks.send.mock.calls.at(-1))).toContain('待核实');
});
it('repairs the old button without resending a card after an edit failure',async()=>{
 const {e}=reopenFixture();mocks.edit.mockRejectedValueOnce(Error('edit failed'));
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir});expect(mocks.card).toHaveBeenCalledOnce();expect(mocks.edit).toHaveBeenCalledTimes(2);
});
it('never reopens a card when the original source has been revoked',async()=>{
 const {e}=reopenFixture();workerQuestionBridge.authorize=()=>false;
 await expect(handleWorkerQuestionAction({cfg:{},accountId:'a',event:e,stateDir})).rejects.toThrow();expect(mocks.card).not.toHaveBeenCalled();
});
it('supplement retries describe Worker continuation rather than Main submission',()=>{
 const card:QuestionCard={...fixture(),status:'submitted',supplementOf:'old',answers:{}};
 const raw=JSON.stringify(renderQuestionCard(card,'暂未确认'));expect(raw).toContain('重试补充');expect(raw).not.toContain('重试交回 Main');
});

it('timeout status never claims the requester answered and preserves reopen in oversized fallback cards',()=>{
 const card:QuestionCard={...fixture(),status:'accepted',answerSource:'user_wait_timeout',note:'跳过未知',reopenAllowed:true,submittedAt:123};
 card.question={...card.question,resumeReason:'user_wait_timeout'};
 let raw=JSON.stringify(renderQuestionCard(card));expect(raw).toContain('已超时继续');expect(raw).toContain('宿主超时续接');expect(raw).not.toContain('回答者为原提问者');
 card.question.question='大'.repeat(12000);raw=JSON.stringify(renderQuestionCard(card));expect(raw).toContain('重新补充');expect(Buffer.byteLength(raw)).toBeLessThan(28000);
});


it.each(['form','text','rendered_form','rendered_text'] as const)('persists real late %s input after timeout instead of silently accepting the timeout answer',async mode=>{
 const card=fixture();if(mode.startsWith('rendered')){card.status='accepted';card.answerSource='user_wait_timeout';card.question={...card.question,answer:'未知跳过',resumeReason:'user_wait_timeout'};}saveQuestionCard(stateDir,card);
 workerQuestionBridge.read=()=>({status:'running',question:{...card.question,answer:'未知跳过',resumeReason:'user_wait_timeout'}});
 if(mode.endsWith('form'))await handleWorkerQuestionAction({cfg:{},accountId:'a',event:event(card,{period__start:'2026-10-01',period__end:'2026-10-09'}),stateDir});
 else await handleWorkerQuestionTextReply({cfg:{},accountId:'a',chatId:'chat',senderId:'alice',messageId:'late-message',parentId:'card',text:'日期为10月1日至9日',stateDir});
 await vi.waitFor(()=>expect(workerQuestionBridge.submit).toHaveBeenCalledOnce());
 const submitted=vi.mocked(workerQuestionBridge.submit!).mock.calls[0][0];
 expect(submitted.submittedAt).toBeGreaterThan(0);expect(submitted.answerSource).toBe(mode.endsWith('form')?'user_card':'user_text');
 if(mode.endsWith('form'))expect(submitted.answers?.period).toEqual({start:'2026-10-01',end:'2026-10-09'});else expect(submitted.note).toBe('日期为10月1日至9日');
 await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));
});
it('retries only pre-expiry server-saved input after expiry and ignores callback replacement values',async()=>{
 const card=fixture();saveQuestionCard(stateDir,card);
 const saved=claimQuestionAnswer(stateDir,card,{env:'prod',period:{start:'2026-10-01',end:'2026-10-09'}});
 const expired={...saved,submittedAt:Date.now()-2000,question:{...saved.question,expiresAt:Date.now()-1000}};saveQuestionCard(stateDir,expired);
 workerQuestionBridge.read=()=>({status:'awaiting_user',question:expired.question});
 const retry=event(card,{period__start:'2099-01-01',period__end:'2099-12-31'});retry.action.value.m={questionId:'q',retry:true};
 await handleWorkerQuestionAction({cfg:{},accountId:'a',event:retry,stateDir});
 await vi.waitFor(()=>expect(workerQuestionBridge.submit).toHaveBeenCalledOnce());
 expect(vi.mocked(workerQuestionBridge.submit!).mock.calls[0][0].answers?.period).toEqual({start:'2026-10-01',end:'2026-10-09'});
 await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));
});
it.each(['waiting','late_claim'] as const)('does not revive an expired new answer through retry metadata: %s',async mode=>{
 const card=fixture();card.question.expiresAt=Date.now()-1000;
 saveQuestionCard(stateDir,mode==='waiting'?card:{...card,status:'submitted',answers:{env:'prod'},answerSource:'user_card',submittedAt:Date.now()});
 const retry=event(card,{});retry.action.value.m={questionId:'q',retry:true};
 await expect(handleWorkerQuestionAction({cfg:{},accountId:'a',event:retry,stateDir})).rejects.toThrow('expired');expect(workerQuestionBridge.submit).not.toHaveBeenCalled();
});

it('outer callback retries an expired saved envelope and does not poison a failed adapter token',async()=>{
 const {handleFeishuCardAction}=await import('./card-action.js');
 const {processedCardActions}=await import('./card-action-state.js');processedCardActions.clear();
 const card=fixture();const now=Date.now();card.question.expiresAt=now-1000;
 saveQuestionCard(stateDir,{...card,status:'submitted',answers:{env:'prod'},answerSource:'user_card',submittedAt:now-2000});
 const e=event(card,{});e.action.value.m={questionId:'q',retry:true};
 workerQuestionBridge.action=undefined;
 await expect(handleFeishuCardAction({cfg:{},event:e,accountId:'a'})).rejects.toThrow('adapter');
 workerQuestionBridge.action=async args=>handleWorkerQuestionAction({...args,stateDir});
 workerQuestionBridge.read=()=>({status:'awaiting_user',question:card.question});
 try{
  await handleFeishuCardAction({cfg:{},event:e,accountId:'a'});
  await vi.waitFor(()=>expect(workerQuestionBridge.submit).toHaveBeenCalledOnce());
  await vi.waitFor(()=>expect(readQuestionCard(stateDir,'q')?.status).toBe('accepted'));
 }finally{workerQuestionBridge.action=undefined;processedCardActions.clear();}
});
