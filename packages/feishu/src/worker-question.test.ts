import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderQuestionCard,parseQuestionSubmission,saveQuestionCard,readQuestionCard,claimQuestionAnswer,questionAction,workerQuestionBridge,type QuestionCard} from './worker-question.js';
import {handleWorkerQuestionAction} from './worker-question-action.js';
const mocks=vi.hoisted(()=>({edit:vi.fn(),send:vi.fn()}));
vi.mock('./send.js',()=>({editMessageFeishu:mocks.edit,sendMessageFeishu:mocks.send}));
let stateDir:string;
const fixture=():QuestionCard=>({jobId:'job',provenance:{taskId:'task',revision:0,accountId:'a',chatId:'chat',senderId:'alice',sessionKey:'agent:main:feishu:chat',requestMessageIds:['request'],sourceMessageIds:['request']},messageId:'card',status:'waiting',question:{questionId:'q',expiresAt:Date.now()+60000,question:'请确认日期范围',reason:'日期未知',progress:'已确认只读方式',knownValues:{env:'prod'},fields:[{id:'env',label:'环境',type:'single_select',required:true,options:[{label:'生产',value:'prod'},{label:'测试',value:'test'}]},{id:'period',label:'日期',type:'date_range',timezone:'Asia/Shanghai',required:true}],allowFreeText:true}});
const event=(card:QuestionCard,form:Record<string,unknown>)=>({operator:{open_id:'alice'},token:'token',context:{chat_id:'chat',open_message_id:'card'},action:{tag:'button',value:questionAction(card),form_value:form}});
beforeEach(()=>{stateDir=mkdtempSync(join(tmpdir(),'worker-form-'));mocks.edit.mockReset().mockResolvedValue({messageId:'card'});mocks.send.mockReset().mockResolvedValue({messageId:'notice'});workerQuestionBridge.read=()=>({status:'awaiting_user',question:fixture().question});workerQuestionBridge.authorize=()=>true;workerQuestionBridge.submit=vi.fn(async card=>saveQuestionCard(stateDir,{...card,status:'accepted',workingMessageId:'new-working'}));});
afterEach(()=>{rmSync(stateDir,{recursive:true,force:true});workerQuestionBridge.read=undefined;workerQuestionBridge.authorize=undefined;workerQuestionBridge.submit=undefined;});
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

it('rejects waiting cards with no remaining response controls',()=>{
 const card=fixture();
 expect(()=>renderQuestionCard({...card,question:{...card.question,fields:undefined,allowFreeText:false}})).toThrow('no answer controls');
 expect(()=>renderQuestionCard({...card,question:{...card.question,fields:card.question.fields!.slice(0,1),allowFreeText:false}})).toThrow('no answer controls');
 expect(JSON.stringify(renderQuestionCard({...card,question:{...card.question,fields:undefined,allowFreeText:true}}))).toContain('worker_note');
});
