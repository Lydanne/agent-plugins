import type {ClawdbotConfig} from '../runtime-api.js';
import {resolveFeishuRuntimeAccount} from './accounts.js';
import {createFeishuClient} from './client.js';
import {assertFeishuApiSuccess} from './api-response.js';
import {withFeishuRequestContext} from './send-context.js';
import {claimQuestionUrgent,recordQuestionUrgentOutcome,type QuestionCard} from './worker-question.js';

/** A buzz is best effort and belongs to the delivered question, not a new message. */
export async function urgentQuestion(params:{cfg:ClawdbotConfig;stateDir:string;card:QuestionCard;authorize:()=>boolean;log:(message:string)=>void}):Promise<void>{
 const {cfg,stateDir,card,authorize,log}=params;
 const account=resolveFeishuRuntimeAccount({cfg,accountId:card.provenance.accountId});
 if(account.config?.workingCard?.questionUrgentApp===false||!authorize()||!card.messageId||!card.provenance.senderId)return;
 try{
  if(!claimQuestionUrgent(stateDir,card))return;
  const check=()=>{if(!authorize())throw new DOMException('Task authorization expired','AbortError');};
  const response=await withFeishuRequestContext(check,()=>{
   check();return createFeishuClient(account).im.message.urgentApp({path:{message_id:card.messageId},params:{user_id_type:'open_id'},data:{user_id_list:[card.provenance.senderId]}});
  });
  assertFeishuApiSuccess(response,'Question in-app buzz failed');
  if(response.data?.invalid_user_id_list?.length)throw Error('Question in-app buzz recipient rejected');
  recordQuestionUrgentOutcome(stateDir,card.question.questionId,'sent');
 }catch{
  // Preserve the attempt marker even when the provider outcome is uncertain.
  try{recordQuestionUrgentOutcome(stateDir,card.question.questionId,'failed');}catch{}
  log('Question in-app buzz failed or unconfirmed; question remains available; check im:message.urgent permission and chat policy');
 }
}
