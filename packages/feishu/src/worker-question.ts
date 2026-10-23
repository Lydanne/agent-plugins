import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {validateContextAnswers,type ContextRequest,type ContextField} from '../../agent-worker/context-request.mjs';
import {createFeishuCardInteractionEnvelope} from './card-interaction.js';
import type {TaskLease} from './source-task.js';
export const WORKER_QUESTION_SUBMIT='worker.question.submit';
export const WORKER_QUESTION_CANCEL='worker.question.cancel';
export const WORKER_QUESTION_REOPEN='worker.question.reopen';
export type Question = ContextRequest & {questionId:string;expiresAt:number;knownValues?:Record<string,unknown>;answer?:string;answerSource?:string;answeredAt?:number;resumeReason?:string;timeoutRequestedAt?:number};
export type QuestionProvenance = Omit<TaskLease,'signal'> & {sessionId?:string;requestMessageIds:string[]};
export type QuestionTextReply = {cfg:import('../runtime-api.js').ClawdbotConfig;accountId:string;chatId:string;senderId:string;messageId:string;parentId:string;text:string};
export type QuestionCard = {jobId:string;provenance:QuestionProvenance;question:Question;messageId:string;status:'waiting'|'submitted'|'accepted'|'cancelled';answers?:Record<string,unknown>;note?:string;answerSource?:'user_card'|'user_text'|'main_context'|'user_wait_timeout';answerMessageId?:string;validationNote?:string;submittedAt?:number;workingMessageId?:string;workingAttempted?:boolean;rendered?:boolean;creationState?:'retryable'|'uncertain';supplementOf?:string;reopenAllowed?:boolean;reopenedQuestionId?:string;dispatchAttempts?:number;urgentAttemptedAt?:number;urgentOutcome?:'uncertain'|'sent'|'failed'};
type QuestionBridge={reopen?:(params:{jobId:string;questionId:string;provenance:QuestionProvenance})=>Promise<{question:Question;supplementId:string}>;supplement?:(params:{jobId:string;questionId:string;provenance:QuestionProvenance;answer:string;answerSource:string;answerValues?:Record<string,unknown>;answerMessageId?:string})=>Promise<unknown>;submission?:(params:{jobId:string;questionId:string;provenance:QuestionProvenance})=>{answerText?:string;answerValues?:Record<string,unknown>;answerSource:'user_card'|'user_text';answerMessageId?:string;userSubmittedAt?:number}|undefined;cancel?:(params:{jobId:string;questionId:string;provenance:QuestionProvenance})=>{status:string};read?:(params:{jobId:string;questionId:string;provenance:QuestionProvenance})=>{status:string;question:Question;latestQuestionId?:string};submit?:(card:QuestionCard)=>Promise<void>;textReply?:(params:QuestionTextReply)=>Promise<boolean>;action?:(params:{cfg:import('../runtime-api.js').ClawdbotConfig;accountId:string;event:import('./card-action.js').FeishuCardActionEvent})=>Promise<void>;authorize?:(p:QuestionProvenance)=>boolean};
const symbol=Symbol.for('ada.worker-question.v1');
const globalState=globalThis as typeof globalThis & {[symbol]?:QuestionBridge};
export const workerQuestionBridge=globalState[symbol]??={};
function database(stateDir:string){
 const dir=join(stateDir,'feishu-worker-questions');mkdirSync(dir,{recursive:true,mode:0o700});
 const path=join(dir,'questions.sqlite');const db=new DatabaseSync(path);chmodSync(path,0o600);
 db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)');return db;
}
export function readQuestionCard(stateDir:string,questionId:string):QuestionCard|undefined{
 const db=database(stateDir);try{const row=db.prepare('SELECT metadata FROM questions WHERE id=?').get(questionId) as {metadata:string}|undefined;return row?JSON.parse(row.metadata):undefined;}finally{db.close();}
}
export function saveQuestionCard(stateDir:string,card:QuestionCard){const db=database(stateDir);try{db.prepare('INSERT OR REPLACE INTO questions VALUES (?,?)').run(card.question.questionId,JSON.stringify(card));}finally{db.close();}}
export function findQuestionCardsForReply(stateDir:string,p:Pick<QuestionTextReply,'accountId'|'chatId'|'senderId'|'parentId'>):QuestionCard[]{
 const db=database(stateDir);try{return (db.prepare("SELECT metadata FROM questions WHERE json_extract(metadata,'$.messageId')=? AND json_extract(metadata,'$.provenance.accountId')=? AND json_extract(metadata,'$.provenance.chatId')=? AND json_extract(metadata,'$.provenance.senderId')=?").all(p.parentId,p.accountId,p.chatId,p.senderId) as {metadata:string}[]).map(row=>JSON.parse(row.metadata));}finally{db.close();}
}
export function questionAnswerSourceIds(p:Pick<QuestionProvenance,'taskId'|'revision'|'accountId'|'chatId'|'sessionKey'|'senderId'>,stateDir:string):string[]{
 const db=database(stateDir);try{return (db.prepare("SELECT json_extract(metadata,'$.answerMessageId') AS message FROM questions WHERE json_extract(metadata,'$.provenance.taskId')=? AND json_extract(metadata,'$.provenance.revision')=? AND json_extract(metadata,'$.provenance.accountId')=? AND json_extract(metadata,'$.provenance.chatId')=? AND json_extract(metadata,'$.provenance.sessionKey')=? AND json_extract(metadata,'$.provenance.senderId')=? AND json_extract(metadata,'$.answerSource')='user_text' AND json_extract(metadata,'$.answerMessageId') IS NOT NULL").all(p.taskId,p.revision,p.accountId,p.chatId,p.sessionKey,p.senderId) as {message:string}[]).map(row=>row.message);}finally{db.close();}
}

/** Reserve before the provider call; never replay an uncertain buzz after restart. */
export function claimQuestionUrgent(stateDir:string,card:QuestionCard):boolean{
 const db=database(stateDir);try{
  db.exec('BEGIN IMMEDIATE');
  const row=db.prepare('SELECT metadata FROM questions WHERE id=?').get(card.question.questionId) as {metadata:string}|undefined;
  const current:QuestionCard|undefined=row?JSON.parse(row.metadata):undefined;
  if(!current||current.jobId!==card.jobId||current.messageId!==card.messageId||['accountId','chatId','senderId'].some(key=>current.provenance[key as 'accountId'|'chatId'|'senderId']!==card.provenance[key as 'accountId'|'chatId'|'senderId'])||current.status!=='waiting'||!current.rendered||current.question.expiresAt<=Date.now()||current.urgentAttemptedAt!==undefined){db.exec('COMMIT');return false;}
  db.prepare('UPDATE questions SET metadata=? WHERE id=?').run(JSON.stringify({...current,urgentAttemptedAt:Date.now(),urgentOutcome:'uncertain'}),card.question.questionId);
  db.exec('COMMIT');return true;
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}
export function recordQuestionUrgentOutcome(stateDir:string,questionId:string,outcome:'sent'|'failed'){
 const db=database(stateDir);try{
  db.prepare("UPDATE questions SET metadata=json_set(metadata,'$.urgentOutcome',?) WHERE id=?").run(outcome,questionId);
 }finally{db.close();}
}
export function claimQuestionAnswer(stateDir:string,card:QuestionCard,answers:Record<string,unknown>,note?:string,answerMessageId?:string):QuestionCard{
 const db=database(stateDir);try{
  db.exec('BEGIN IMMEDIATE');const row=db.prepare('SELECT metadata FROM questions WHERE id=?').get(card.question.questionId) as {metadata:string}|undefined;
  if(!row)throw Error('提问不存在');const current:QuestionCard=JSON.parse(row.metadata);
  if(current.jobId!==card.jobId||current.messageId!==card.messageId||['accountId','chatId','senderId'].some(key=>current.provenance[key as 'accountId'|'chatId'|'senderId']!==card.provenance[key as 'accountId'|'chatId'|'senderId']))throw Error('Question card binding mismatch');
  if(current.status!=='waiting')throw Error('本轮答案已提交，请等待任务继续');
  const {answerSource:_source,answerMessageId:_message,validationNote:_validation,...fresh}=current;
  const next:QuestionCard={...fresh,status:'submitted',answers,note,submittedAt:Date.now(),answerSource:answerMessageId?'user_text':'user_card',...(answerMessageId?{answerMessageId,rendered:true}:{})};
  db.prepare('UPDATE questions SET metadata=? WHERE id=?').run(JSON.stringify(next),card.question.questionId);db.exec('COMMIT');return next;
 }finally{db.close();}
}
const text=(content:string)=>({tag:'plain_text',content});
const markdown=(content:string)=>({tag:'markdown',content:content.replace(/</g,'&lt;').replace(/>/g,'&gt;')});
function controls(f:ContextField):Record<string,unknown>[] {
 const base={name:f.id,required:f.required??false};
 const placeholder=text(f.placeholder??'请选择或填写');
 const caption=(label:string)=>markdown(label+(f.required?'（必填）':''));
 if(f.type==='single_select'||f.type==='multi_select')return [caption(f.label),{...base,tag:f.type==='single_select'?'select_static':'multi_select_static',placeholder,options:f.options!.map(o=>({text:text(o.label),value:o.value}))}];
 if(f.type==='date_range')return ['start','end'].flatMap((part,i)=>[caption(f.label+(i?' · 结束日期':' · 开始日期')),{...base,name:f.id+'__'+part,tag:'date_picker',placeholder:text(i?'结束日期（包含当天）':'开始日期')}]);
 if(f.type==='date'||f.type==='datetime')return [caption(f.label),{...base,tag:f.type==='date'?'date_picker':'picker_datetime',placeholder}];
 return [{...base,label:text(f.label),label_position:'top',tag:'input',placeholder:text(f.placeholder??(f.type==='number'?'请输入数字':'请输入内容')),max_length:f.type==='number'?40:1000}];
}
export function questionAction(card:QuestionCard){return createFeishuCardInteractionEnvelope({k:'button',a:WORKER_QUESTION_SUBMIT,m:{questionId:card.question.questionId},c:{u:card.provenance.senderId,h:card.provenance.chatId,s:card.provenance.sessionKey,e:card.question.expiresAt,t:'group'}});}
export function renderQuestionCard(card:QuestionCard,error?:string):Record<string,unknown>{
 const q=card.question,waiting=card.status==='waiting',timedOut=q.resumeReason==='user_wait_timeout';
 const reopen=card.reopenAllowed&&!card.reopenedQuestionId&&q.expiresAt>Date.now()?{tag:'button',text:text('重新补充'),type:'primary',behaviors:[{type:'callback',value:{...questionAction(card),a:WORKER_QUESTION_REOPEN}}]}:undefined;
 const elements:Record<string,unknown>[]=[markdown(q.question)];
 if(error??card.validationNote)elements.push(markdown('填写提示：'+(error??card.validationNote)));
 if(q.knownValues&&Object.keys(q.knownValues).length)elements.push(markdown('已确定信息\n'+answerSummary(q,q.knownValues)));
 if(waiting){
  const fields=(q.fields??[]).filter(f=>!Object.hasOwn(q.knownValues??{},f.id));
  if(!fields.length&&q.allowFreeText===false)throw Error('Question has no answer controls; Main must reply with known context or request missing fields');
  const form:Record<string,unknown>[] = fields.flatMap(f=>[...controls(f),...(['date','date_range','datetime'].includes(f.type)?[markdown('时区：'+f.timezone)]:[])]);
  if(q.allowFreeText!==false)form.push({tag:'input',name:'worker_note',label:text(fields.length?'补充说明（选填）':'补充信息'),label_position:'top',required:!fields.length,max_length:1000,placeholder:text('最多 1000 字；更长内容请直接回复这张卡片')});

  form.push({tag:'button',name:'worker_submit',text:text('确认并继续'),type:'primary',form_action_type:'submit',behaviors:[{type:'callback',value:questionAction(card)}]});
  const quick=fields.length===1&&fields[0].type==='single_select'&&fields[0].options!.length<=3;
  if(quick){for(const option of fields[0].options!)elements.push({tag:'button',text:text(option.label),type:'default',behaviors:[{type:'callback',value:{...questionAction(card),m:{questionId:q.questionId,option:option.value}}}]});}
  if(!quick)elements.push({tag:'form',name:'worker_question',elements:form});
  elements.push(markdown('也可以直接回复这张卡片，用文字补充。'));
  if(!card.supplementOf)elements.push({tag:'button',name:'worker_cancel',text:text('取消任务'),type:'default',confirm:{title:text('取消原任务？'),text:text('取消后不再继续执行；已发生的外部操作不会回滚。')},behaviors:[{type:'callback',value:{...questionAction(card),a:WORKER_QUESTION_CANCEL}}]});
  elements.push({tag:'collapsible_panel',expanded:false,header:{title:text('提问原因与已完成工作')},elements:[markdown(q.reason),markdown(q.progress),...(q.recommendation?[markdown('建议（尚未确认）：'+q.recommendation)]:[])]});
 }else if(card.status==='cancelled'){elements.push(markdown('任务已取消，不再接受本轮补充。'));
 }else{
  const note=['user_text','main_context','user_wait_timeout'].includes(card.answerSource??'')&&card.note&&card.note.length>2000?Array.from(card.note).slice(0,2000).join('')+'\n（卡片展示摘录，完整文字已保存。）':card.note;
  elements.push(markdown((timedOut?'续接说明\n':'已补充\n')+answerSummary(q,card.answers??{})+(note?'\n'+(card.answerSource==='user_text'?'文字补充：':'补充说明：')+note:'')));
  elements.push(markdown(q.resumeReason==='user_wait_timeout'?'等待已超时，已使用确定信息继续；未知信息对应的步骤跳过。':card.supplementOf?'补充已保存，将在原 Worker 当前轮次结束后接续。':card.status==='accepted'?'答案已受理，原任务继续处理。':'答案已保存，正在交回 Main。'));
  if(reopen)elements.push(reopen);
  if(error&&card.status==='submitted')elements.push({tag:'button',text:text(card.supplementOf?'重试补充':'重试交回 Main'),type:'primary',behaviors:[{type:'callback',value:{...questionAction(card),m:{questionId:q.questionId,retry:true}}}]});
  elements.push(markdown((timedOut?'处理时间：':'提交时间：')+new Date(card.submittedAt??Date.now()).toISOString()+(card.answerSource==='user_wait_timeout'?' · 宿主超时续接':card.answerSource==='main_context'?' · Main 自动补充':' · 回答者为原提问者')));
 }
 const rendered={schema:'2.0',config:{update_multi:true,summary:{content:(waiting?'等待您补充：':timedOut?'已超时继续：':'已补充：')+q.question.replace(/<[^>]*>/g,'')}},header:{title:text(waiting?'需要您补充':card.status==='cancelled'?'已取消':timedOut?'已超时继续':'已补充'),template:waiting?'orange':card.status==='cancelled'?'grey':'green'},body:{elements}};
 if(Buffer.byteLength(JSON.stringify(rendered),'utf8')>28000 && ['main_context','user_wait_timeout'].includes(card.answerSource??'')){
  return {schema:'2.0',config:{update_multi:true},header:{title:text(timedOut?'已超时继续':'已补充'),template:'green'},body:{elements:[markdown(Array.from(q.question).slice(0,500).join('')),markdown((card.answerSource==='user_wait_timeout'?'宿主超时续接\n':'Main 自动补充\n')+Array.from(card.note??'').slice(0,2000).join('')+'\n（卡片展示摘录，完整内容已保存。）'),...(reopen?[reopen]:[])]}};
 }
 if(Buffer.byteLength(JSON.stringify(rendered),'utf8')>28000)throw Error('Question card exceeds size limit; use a plain-text question');
 return rendered;
}
export function answerSummary(q:Question,values:Record<string,unknown>){return Object.entries(values).map(([id,value])=>{
 const f=q.fields?.find(f=>f.id===id);
 const label=f?.label??id;
 const readable=(v:unknown):string=>typeof v==='string'?f?.options?.find(o=>o.value===v)?.label??v:JSON.stringify(v);
 return label+'：'+(Array.isArray(value)?value.map(readable).join('、'):readable(value));
}).join('\n');}
export function parseQuestionSubmission(card:QuestionCard,form:unknown){
 if(!form||typeof form!=='object'||Array.isArray(form))throw Error('未收到表单内容');
 const data=form as Record<string,unknown>,raw:Record<string,unknown>={...card.question.knownValues};
 const normalizeDate=(value:unknown)=>typeof value==='string'?value.replace(/\s+[+-]\d{4}$/,''):value;
 const known=card.question.knownValues??{};
 const allowed=new Set(['worker_note','worker_submit','worker_cancel']);
 for(const f of card.question.fields??[]){
  const keys=f.type==='date_range'?[f.id+'__start',f.id+'__end']:[f.id];keys.forEach(k=>allowed.add(k));
  if(Object.hasOwn(known,f.id)){if(keys.some(k=>Object.hasOwn(data,k)))throw Error('已确定字段不能被覆盖');continue;}
  if(f.type==='date_range'){
   if(data[keys[0]]||data[keys[1]])raw[f.id]={start:normalizeDate(data[keys[0]]),end:normalizeDate(data[keys[1]])};
  }else if(Object.hasOwn(data,f.id))raw[f.id]=f.type==='date'?normalizeDate(data[f.id]):f.type==='datetime'&&typeof data[f.id]==='string'?(data[f.id] as string).replace(/\s+([+-]\d{4})$/,'$1'):data[f.id];
 }
 if(Object.keys(data).some(k=>!allowed.has(k)))throw Error('包含未知字段');
 const note=data.worker_note;if(note!==undefined&&(typeof note!=='string'||note.length>4000))throw Error('请检查补充说明');
 if(card.question.allowFreeText===false&&typeof note==='string'&&note.trim())throw Error('本轮不接受补充说明');
 const answers=validateContextAnswers(card.question,raw);
 if(!Object.keys(answers).length&&!(typeof note==='string'&&note.trim()))throw Error('请填写补充信息');
 return {answers,note:typeof note==='string'?note.trim():undefined};
}

export function listQuestionCards(stateDir:string):QuestionCard[]{const db=database(stateDir);try{return (db.prepare('SELECT metadata FROM questions').all() as {metadata:string}[]).map(row=>JSON.parse(row.metadata) as QuestionCard);}finally{db.close();}}
