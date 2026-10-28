import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {ClawdbotConfig} from '../runtime-api.js';
import type {FeishuCardActionEvent} from './card-action.js';
import {createFeishuCardInteractionEnvelope} from './card-interaction.js';
import {sendCardFeishu,editMessageFeishu} from './send.js';
import {isFeishuCardValidationRejection} from './api-response.js';
import {workerQuestionBridge,type QuestionProvenance} from './worker-question.js';
export const WORKER_CONTRIBUTOR_APPROVE='worker.contributor.approve';
export type ContributorMode='once'|'always'|'worker';
export type ContributorRequest={requestId:string;questionId:string;kind?:string;source:{senderId:string;sourceMessageIds:string[]};answer:string;status:string;expiresAt:number};
export type ContributorEvent={jobId:string;provenance:QuestionProvenance;request:ContributorRequest};
type Card=ContributorEvent&{messageId?:string;creationState?:'retryable'|'uncertain';mode?:ContributorMode;resumed?:boolean;queued?:boolean;state?:string;reason?:string};
const modes:Record<ContributorMode,string>={once:'允许一次',always:'一直允许',worker:'允许这轮（Worker）'};
const text=(content:string)=>({tag:'plain_text',content});
const md=(content:string)=>({tag:'markdown',content});
const serials=new Map<string,Promise<unknown>>();
async function serial<T>(key:string,fn:()=>Promise<T>):Promise<T>{
 const prior=serials.get(key)??Promise.resolve();const next=prior.catch(()=>{}).then(fn);serials.set(key,next);
 try{return await next;}finally{if(serials.get(key)===next)serials.delete(key);}
}
function database(stateDir:string){
 const dir=join(stateDir,'feishu-worker-contributors');mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,'cards.sqlite'),db=new DatabaseSync(path);chmodSync(path,0o600);
 db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)');return db;
}
export function readContributorCard(stateDir:string,id:string):Card|undefined{
 const db=database(stateDir);try{const row=db.prepare('SELECT metadata FROM cards WHERE id=?').get(id) as {metadata:string}|undefined;return row?JSON.parse(row.metadata):undefined;}finally{db.close();}
}
function save(stateDir:string,card:Card){const db=database(stateDir);try{db.prepare('INSERT OR REPLACE INTO cards VALUES (?,?)').run(card.request.requestId,JSON.stringify(card));}finally{db.close();}}
export function renderContributorCard(card:Card):Record<string,unknown>{
 const p=card.provenance,r=card.request;
 const excerpt=Array.from(r.answer),shortened=excerpt.length>1800;
 const elements:Record<string,unknown>[]=[md(`<at id="${p.senderId}"></at>老师，<at id="${r.source.senderId}"></at>老师希望补充您的任务。`),md(('任务：'+card.jobId+'\n补充内容'+(shortened?'（摘录）':'')+'：'+excerpt.slice(0,1800).join('')+(shortened?'\n（完整补充已保存；本卡只展示摘录，可查看本卡所回复的原补充消息。）':'')).replace(/</g,'&lt;').replace(/>/g,'&gt;'))];
 const unavailable=card.state==='blocked'||card.state==='suppressed';
 const reasons:Record<string,string>={original_session_missing:'原 Worker 会话不可用',original_request_missing:'原任务请求记录缺失',original_request_invalid:'原任务请求记录损坏',original_request_mismatch:'原任务请求绑定不匹配',worker_failed:'原 Worker 执行失败',worker_timed_out:'原 Worker 已超时',task_cancelled:'原任务已取消',source_invalid:'任务来源已失效'};
 if(card.mode){
  elements.push(md('您已选择：'+modes[card.mode]+'。'+(unavailable?(card.state==='suppressed'?'本条引导已停止，不再执行。':'本条引导未能接续，未执行。')+(card.reason?'原因：'+(reasons[card.reason]??'接续条件不可用')+'。':''):card.resumed?'当前补充已交回原 Worker。':card.queued?'补充已保存，将在原 Worker 当前轮次结束后接续。':'授权已保存；当前补充尚未恢复执行，请查看原任务状态。')));
 }else{
  elements.push(md('允许一次：仅当前补充。\n一直允许：同账号、同群中，今后允许该同事补充您发起的 Worker 任务。\n允许这轮（Worker）：仅当前 Worker 任务的后续补充。'));
  elements.push(...(['once','always','worker'] as const).map(mode=>({tag:'button',text:text(modes[mode]),type:mode==='worker'?'primary':'default',behaviors:[{type:'callback',value:createFeishuCardInteractionEnvelope({k:'button',a:WORKER_CONTRIBUTOR_APPROVE,m:{requestId:r.requestId,mode},c:{u:p.senderId,h:p.chatId,s:p.sessionKey,e:r.expiresAt,t:'group'}})}]})));
  elements.push(md('仅原提问者可确认；确认前不会据此恢复 Worker。不操作即不授权。'));
 }
 elements.push(md('仅允许提供待核验线索；不改变原任务目标、约束、决策、业务写入或取消权限。'));
 return {schema:'2.0',config:{update_multi:true,summary:{content:unavailable?'本条引导未执行':card.mode?'任务补充权限已确认':'请确认同事补充任务的权限'}},header:{title:text(unavailable?'权限已确认 · 引导未执行':card.mode?'补充权限已确认':'允许同事补充任务？'),template:unavailable?'orange':card.mode?'green':'orange'},body:{elements}};
}
export async function presentContributorApproval(params:{cfg:ClawdbotConfig;stateDir:string;event:ContributorEvent;authorize:(p:QuestionProvenance)=>boolean}):Promise<{interactive:boolean}>{
 const {cfg,stateDir,event,authorize}=params;
 return serial(stateDir+':'+event.request.requestId,async()=>{
  const current=workerQuestionBridge.contributorRead?.({jobId:event.jobId,requestId:event.request.requestId,provenance:event.provenance});
  if(!current||!authorize(current.job.provenance))throw Error('Contributor approval source unavailable');
  let card=readContributorCard(stateDir,event.request.requestId)??{jobId:event.jobId,provenance:current.job.provenance,request:current.request};
  if(card.jobId!==event.jobId)throw Error('Contributor card binding mismatch');
  if(card.messageId)return {interactive:true};
  if(card.creationState==='uncertain')throw Error('Contributor card delivery is uncertain; inspect before retrying');
  card={...card,creationState:'uncertain'};save(stateDir,card);
  try{
   const result=await sendCardFeishu({cfg,accountId:card.provenance.accountId,to:'chat:'+card.provenance.chatId,replyToMessageId:card.request.source.sourceMessageIds[0],replyInThread:card.provenance.replyInThread??false,card:renderContributorCard(card),preserveInteractiveControls:true});
   if(!result.messageId)throw Error('Missing contributor card receipt');
   save(stateDir,{...card,messageId:result.messageId,creationState:undefined});return {interactive:true};
  }catch(error){if(isFeishuCardValidationRejection(error))save(stateDir,{...card,creationState:'retryable'});throw error;}
 });
}
export async function handleContributorAction(params:{cfg:ClawdbotConfig;stateDir:string;accountId:string;event:FeishuCardActionEvent}):Promise<void>{
 const {cfg,stateDir,accountId,event}=params,meta=event.action.value.m as Record<string,unknown>|undefined;
 const id=typeof meta?.requestId==='string'?meta.requestId:'';
 if(!['once','always','worker'].includes(String(meta?.mode)))throw Error('Invalid contributor permission mode');
 const mode=meta!.mode as ContributorMode;
 await serial(stateDir+':'+id,async()=>{
  const card=readContributorCard(stateDir,id);
  if(!card||card.provenance.accountId!==accountId||card.provenance.chatId!==event.context.chat_id||card.provenance.senderId!==event.operator.open_id||card.messageId!==(event.context.open_message_id??event.open_message_id))throw Error('Contributor approval card binding mismatch');
  if(card.mode&&card.mode!==mode)throw Error('Contributor approval already decided differently');
  if(!card.mode){
   if(card.request.expiresAt<=Date.now()||!workerQuestionBridge.contributorDecide)throw Error('Contributor approval expired or service unavailable');
   const outcome=await workerQuestionBridge.contributorDecide({jobId:card.jobId,requestId:id,provenance:card.provenance,actor:{senderId:event.operator.open_id,accountId},mode});
   card.mode=mode;card.resumed=outcome.resumed;card.queued=outcome.queued;card.state=outcome.state;card.reason=outcome.reason;save(stateDir,card);
  }
  await editMessageFeishu({cfg,accountId,messageId:card.messageId!,card:renderContributorCard(card),preserveInteractiveControls:true});
 });
}

/** Update an already-granted steering card when its asynchronous continuation settles. */
export async function updateContributorReceipt(params:{cfg:ClawdbotConfig;stateDir:string;jobId:string;provenance:QuestionProvenance;supplementId:string;kind:string;status?:string;reason?:string}):Promise<void>{
 if(!['supplement_unavailable','supplement_dispatched'].includes(params.kind))return;
 const db=database(params.stateDir);let matches:Card[];
 try{matches=(db.prepare("SELECT metadata FROM cards WHERE json_extract(metadata,'$.jobId')=? AND json_extract(metadata,'$.request.questionId')=?").all(params.jobId,params.supplementId) as {metadata:string}[]).map(row=>JSON.parse(row.metadata));}finally{db.close();}
 for(const found of matches)await serial(params.stateDir+':'+found.request.requestId,async()=>{
  const card=readContributorCard(params.stateDir,found.request.requestId);
  if(!card?.mode||card.request.kind!=='steering'||!card.messageId||['taskId','revision','accountId','chatId','sessionKey','senderId'].some(key=>card.provenance[key as keyof QuestionProvenance]!==params.provenance[key as keyof QuestionProvenance]))return;
  const state=params.kind==='supplement_dispatched'?'dispatched':params.status;
  if(!['blocked','suppressed','dispatched'].includes(state??''))return;
  const updated={...card,state,reason:params.reason,queued:false,resumed:state==='dispatched'};save(params.stateDir,updated);
  await editMessageFeishu({cfg:params.cfg,accountId:card.provenance.accountId,messageId:card.messageId,card:renderContributorCard(updated),preserveInteractiveControls:true});
 });
}
