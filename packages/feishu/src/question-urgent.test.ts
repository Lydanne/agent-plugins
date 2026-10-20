import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveQuestionCard,readQuestionCard,type QuestionCard} from './worker-question.js';
const mocks=vi.hoisted(()=>({urgent:vi.fn(),enabled:true}));
vi.mock('./accounts.js',()=>({resolveFeishuRuntimeAccount:()=>({config:{workingCard:{questionUrgentApp:mocks.enabled}}})}));
vi.mock('./client.js',()=>({createFeishuClient:()=>({im:{message:{urgentApp:mocks.urgent}}})}));
import {urgentQuestion} from './question-urgent.js';
let stateDir:string,card:QuestionCard;
beforeEach(()=>{
 stateDir=mkdtempSync(join(tmpdir(),'question-urgent-'));mocks.enabled=true;mocks.urgent.mockReset().mockResolvedValue({code:0,data:{invalid_user_id_list:[]}});
 card={jobId:'job',messageId:'question-card',rendered:true,status:'waiting',question:{questionId:'q',question:'选择环境',reason:'环境未知',progress:'已准备',expiresAt:Date.now()+60000},provenance:{taskId:'task',revision:0,accountId:'a',chatId:'chat',sessionKey:'agent:main:feishu:chat',senderId:'requester',sourceMessageIds:['request'],requestMessageIds:['request']}};
 saveQuestionCard(stateDir,card);
});
afterEach(()=>rmSync(stateDir,{recursive:true,force:true}));
const notify=(authorize=()=>true)=>urgentQuestion({cfg:{},stateDir,card,authorize,log:vi.fn()});
it('buzzes only the requester on the delivered question once, including concurrent calls and store reload',async()=>{
 await Promise.all([notify(),notify()]);await notify();
 expect(mocks.urgent).toHaveBeenCalledExactlyOnceWith({path:{message_id:'question-card'},params:{user_id_type:'open_id'},data:{user_id_list:['requester']}});
 expect(readQuestionCard(stateDir,'q')).toMatchObject({urgentOutcome:'sent',urgentAttemptedAt:expect.any(Number)});
});
it.each(['unrendered','answered','expired','disabled','unauthorized'])('does not buzz %s questions',async kind=>{
 if(kind==='unrendered')card.rendered=false;
 if(kind==='answered')card.status='accepted';
 if(kind==='expired')card.question.expiresAt=Date.now()-1;
 if(kind==='disabled')mocks.enabled=false;
 saveQuestionCard(stateDir,card);await notify(()=>kind!=='unauthorized');expect(mocks.urgent).not.toHaveBeenCalled();
});
it.each(['permission','transport','invalid_recipient'])('retains the question and never replays a %s buzz failure',async kind=>{
 if(kind==='permission')mocks.urgent.mockResolvedValue({code:99991672});
 if(kind==='transport')mocks.urgent.mockRejectedValue(Error('timeout'));
 if(kind==='invalid_recipient')mocks.urgent.mockResolvedValue({code:0,data:{invalid_user_id_list:['requester']}});
 await expect(notify()).resolves.toBeUndefined();await notify();expect(mocks.urgent).toHaveBeenCalledOnce();
 expect(readQuestionCard(stateDir,'q')).toMatchObject({status:'waiting',messageId:'question-card',urgentOutcome:'failed'});
});
it('buzzes each new question exactly once',async()=>{
 await notify();card={...card,messageId:'next-card',question:{...card.question,questionId:'q2'}};saveQuestionCard(stateDir,card);await notify();expect(mocks.urgent).toHaveBeenCalledTimes(2);
 expect(mocks.urgent.mock.calls[1][0].path.message_id).toBe('next-card');
});
it('does not buzz after a render receipt if authority expires before API dispatch',async()=>{
 let count=0;await notify(()=>++count===1);expect(mocks.urgent).not.toHaveBeenCalled();expect(readQuestionCard(stateDir,'q')?.status).toBe('waiting');
});

it('cannot redirect a stored question buzz to another recipient',async()=>{
 card={...card,provenance:{...card.provenance,senderId:'other'}};await notify();expect(mocks.urgent).not.toHaveBeenCalled();
});
