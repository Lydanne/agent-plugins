import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createJobs,writeJson,readJson,requestKeyFor} from '../../agent-worker/jobs.mjs';
import {registerQuestionBridge} from '../../agent-worker/question-bridge.mjs';
const mocks=vi.hoisted(()=>({valid:true,send:vi.fn(),edit:vi.fn(),observe:vi.fn(),run:vi.fn()}));
vi.mock('./send.js',()=>({sendMessageFeishu:mocks.send,sendCardFeishu:mocks.send,editMessageFeishu:mocks.edit}));
vi.mock('./source-task.js',()=>({isCompletionSourceCurrent:()=>mocks.valid,isTaskSourceRecalled:()=>false,sourceTaskBridge:{recalls:new Set(),leases:new Map()}}));
vi.mock('./runtime.js',()=>({getFeishuRuntime:()=>{throw Error('Ambient runtime forbidden');}}));
vi.mock('./question-urgent.js',()=>({urgentQuestion:vi.fn()}));
import {registerCodexCompletion} from './codex-completion.js';
import {saveQuestionCard,readQuestionCard,claimQuestionAnswer,workerQuestionBridge,WORKER_QUESTION_SUBMIT} from './worker-question.js';
import {handleWorkerQuestionAction} from './worker-question-action.js';
let root:string,workerRoot:string,jobs:any,job:any,q:any,card:any,workerService:any,feishuService:any,completion:any;
const p={taskId:'task',revision:0,accountId:'a',chatId:'chat',sessionKey:'agent:main:feishu:chat',sessionId:'current',senderId:'alice',agentId:'main',sourceMessageIds:['request'],requestMessageIds:['request']};
beforeEach(async()=>{
 root=mkdtempSync('/tmp/worker-supplement-integration-');workerRoot=join(root,'jobs');mkdirSync(workerRoot);mkdirSync(join(workerRoot,'active'));
 mocks.valid=true;mocks.send.mockReset().mockResolvedValue({messageId:'sent'});mocks.edit.mockReset().mockResolvedValue({messageId:'card'});mocks.observe.mockReset();mocks.run.mockReset();
 const params={topic:'topic',task:'read',context:'known',constraints:'read only'};
 q={questionId:randomUUID(),question:'日期？',fields:[{id:'date',label:'日期',type:'text',required:true}],createdAt:Date.now()-10000,expiresAt:Date.now()+60000,answer:'unknown, continue',resumeReason:'user_wait_timeout'};
 job={jobId:randomUUID(),scope:createHash('sha256').update(p.sessionKey).digest('hex'),requestKey:requestKeyFor(params,p.sessionKey,p),provenance:p,topic:'topic',status:'completed',questions:[q],tags:[],resourceKeys:['resource'],schedulerVersion:1,queueSequence:1,createdAt:Date.now(),heartbeatAt:Date.now(),resumeSessionId:randomUUID()};
 writeJson(join(workerRoot,job.jobId+'.json'),job);writeJson(join(workerRoot,job.jobId+'.request.json'),{params,scope:p.sessionKey,runtime:{state:workerRoot,cwd:workerRoot}});
 jobs=createJobs({root:workerRoot,node:process.execPath,worker:'must-not-start'});
 const runtime={system:{enqueueSystemEvent:mocks.observe},state:{resolveStateDir:()=>root},config:{current:()=>({})},agent:{session:{resolveStorePath:()=>'/isolated/sessions.json',getSessionEntry:()=>({sessionId:'current'})}},channel:{inbound:{run:mocks.run}}};
 registerCodexCompletion({runtime,logger:{warn:vi.fn()},registerService:(s:any)=>feishuService=s} as any);await feishuService.start({});
 completion=(globalThis as any)[Symbol.for('ada.codex-completion.v1')];
 registerQuestionBridge({registerService:(s:any)=>workerService=s},jobs,completion);await workerService.start();
 const question={...q};delete question.answer;delete question.resumeReason;
 card={jobId:job.jobId,provenance:p,question,messageId:'card',status:'waiting'};saveQuestionCard(root,card);
});
afterEach(async()=>{await workerService?.stop();await feishuService?.stop({});rmSync(root,{recursive:true,force:true});});
const records=()=>existsSync(join(workerRoot,'supplements'))?readdirSync(join(workerRoot,'supplements')).filter(f=>f.endsWith('.json')).map(f=>readJson(join(workerRoot,'supplements',f))):[];
const dispatch=()=>jobs.processSupplements(job.jobId,p.sessionKey,completion.authorizeReply,(e:any)=>completion.observe({...e,jobId:job.jobId,provenance:p}));
it('actual callback persists a form after timeout and routes it through both adapters into exact-session continuation',async()=>{
 await handleWorkerQuestionAction({cfg:{},accountId:'a',stateDir:root,event:{operator:{open_id:'alice'},context:{chat_id:'chat',open_message_id:'card'},action:{value:{a:WORKER_QUESTION_SUBMIT,m:{questionId:q.questionId}},form_value:{date:'2026-10-23'}}} as any});
 await vi.waitFor(()=>expect(readQuestionCard(root,q.questionId)?.status).toBe('accepted'));
 expect(records()).toHaveLength(1);const supplement=records()[0];expect(supplement.answer).toContain('2026-10-23');
 await dispatch();await dispatch();
 const child=readJson(join(workerRoot,supplement.supplementId+'.json'));expect(child.resumeSessionId).toBe(job.resumeSessionId);expect(child.resourceKeys).toEqual(['resource']);
 expect(readJson(join(workerRoot,child.jobId+'.request.json')).resumeParams.constraints).toBe('read only');
 expect(records()).toHaveLength(1);expect(mocks.run).not.toHaveBeenCalled();expect(mocks.observe).toHaveBeenCalled();
});
it('SQLite receipt survives missing Worker adapter, service restart, and expiry without replaying Main',async()=>{
 const saved=claimQuestionAnswer(root,card,{date:'2026-10-22'});
 await workerService.stop();await expect(workerQuestionBridge.submit!(saved)).rejects.toThrow();expect(readQuestionCard(root,q.questionId)?.status).toBe('submitted');
 // Preserve the exact admission instant and move only the hard deadline past it.
 const expired={...q,expiresAt:saved.submittedAt!};writeJson(join(workerRoot,job.jobId+'.json'),{...job,questions:[expired]});saveQuestionCard(root,{...saved,question:{...saved.question,expiresAt:saved.submittedAt!}});
 await new Promise(resolve=>setTimeout(resolve,2));await feishuService.stop({});await feishuService.start({});await workerService.start();
 await workerQuestionBridge.submit!(readQuestionCard(root,q.questionId)!);await workerQuestionBridge.submit!(readQuestionCard(root,q.questionId)!);
 expect(readQuestionCard(root,q.questionId)?.status).toBe('accepted');expect(records()).toHaveLength(1);await dispatch();expect(records()[0].status).toBe('dispatched');expect(mocks.run).not.toHaveBeenCalled();
});
it('a persisted human answer already consumed by timeout is not applied a second time',async()=>{
 const saved=claimQuestionAnswer(root,card,{date:'2026-10-21'});
 writeJson(join(workerRoot,job.jobId+'.json'),{...job,questions:[{...q,answer:'日期：2026-10-21',answerSource:'user_card',userSubmittedAt:saved.submittedAt}]});
 await workerQuestionBridge.submit!(saved);expect(readQuestionCard(root,q.questionId)?.status).toBe('accepted');expect(records()).toHaveLength(0);expect(mocks.run).not.toHaveBeenCalled();
});
it.each(['cancelled','withdrawn'])('saved receipt cannot restart %s work',async mode=>{
 const saved=claimQuestionAnswer(root,card,{date:'2026-10-20'});
 if(mode==='withdrawn'){mocks.valid=false;await expect(workerQuestionBridge.submit!(saved)).rejects.toThrow();expect(records()).toHaveLength(0);}
 else{writeJson(join(workerRoot,job.jobId+'.json'),{...job,status:'cancelled'});await workerQuestionBridge.submit!(saved);await dispatch();expect(records()[0].status).toBe('suppressed');expect(existsSync(join(workerRoot,records()[0].supplementId+'.json'))).toBe(false);}
 expect(mocks.run).not.toHaveBeenCalled();
});
it.each(['request_only','child_saved','dispatch_saved'])('replays crash boundary %s with one child and immutable execution binding',async boundary=>{
 const saved=claimQuestionAnswer(root,card,{date:'2026-10-19'});await workerQuestionBridge.submit!(saved);await dispatch();
 const supplement=records()[0],childPath=join(workerRoot,supplement.supplementId+'.json'),requestPath=join(workerRoot,supplement.supplementId+'.request.json');
 const originalChild=readJson(childPath),originalRequest=readJson(requestPath);
 if(boundary!=='dispatch_saved')writeJson(join(workerRoot,'supplements',supplement.supplementId+'.json'),{...supplement,status:'accepted',childJobId:undefined});
 if(boundary==='request_only')rmSync(childPath);
 await dispatch();await dispatch();
 expect(records()).toHaveLength(1);expect(records()[0].status).toBe('dispatched');
 const child=readJson(childPath);expect(child.jobId).toBe(originalChild.jobId);expect(child.resumeSessionId).toBe(originalChild.resumeSessionId);expect(child.requestKey).toBe(originalChild.requestKey);expect(child.resourceKeys).toEqual(originalChild.resourceKeys);
 expect(readJson(requestPath)).toEqual(originalRequest);expect(readdirSync(workerRoot).filter(name=>name.endsWith('.json')&&!name.endsWith('.request.json'))).toHaveLength(2);
});
