import {randomUUID} from "node:crypto";
import {mkdirSync,chmodSync} from "node:fs";
import {join,basename} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {OpenClawPluginApi} from "openclaw/plugin-sdk/channel-entry-contract";
import type {ClawdbotConfig} from "../runtime-api.js";
import {resolveFeishuRuntimeAccount} from "./accounts.js";
import {createFeishuClient} from "./client.js";
import {createDoc,writeDoc} from "./docx.js";
import {assertFeishuApiSuccess} from "./api-response.js";
import {splitMessageImages,resolveLocalFilePath,isExistingLocalFile,findLocalFileReferences,pendingDocumentText,failedDocumentText,prepareFeishuDocumentDelivery,resolveDocumentPermissionRecipient,documentDeliveryFailure,type DeliveryParams,type DocumentDeliveryFailure,type ConfirmedDocumentGrant} from "./document-delivery.js";
import {isCompletionSourceCurrent,type TaskLease} from "./source-task.js";
import {withFeishuRequestContext} from "./send-context.js";
import {editMessageFeishu} from "./send.js";
import {workingResultCard} from "./working-card.js";
import {readAsyncTaskCard,prepareAsyncCardResult,acceptAsyncCardResult} from "./async-task-card.js";
import {runFeishuWorkingTurn} from "./working-turn-queue.js";
import {withinCardTableLimit} from "./presentation-card.js";

type Source=Pick<TaskLease,"taskId"|"revision"|"accountId"|"chatId"|"chatType"|"sessionKey"|"senderId"|"sourceMessageIds">;
type Job={confirmedGrant?:ConfirmedDocumentGrant;uploadFailure?:DocumentDeliveryFailure;id:string;source:Source;sessionId?:string;agentId:string;text:string;mediaUrls?:string[];documentId:string;url:string;workspaceDir?:string;messageId?:string;completionJobId?:string;publishedText?:string;displayPrefix?:string;finalText?:string;editAttempts?:number;retryAt?:number;status:"draft"|"staging_failed"|"queued"|"working"|"done"|"interrupted"|"cancelled"|"update_failed"};
export type StagedDocument={id:string;text:string};
function database(stateDir:string) {
  const dir=join(stateDir,"feishu-document-uploads");mkdirSync(dir,{recursive:true,mode:0o700});
  const file=join(dir,"uploads.sqlite"),db=new DatabaseSync(file);chmodSync(file,0o600);
  db.exec("PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, message TEXT, retry_at INTEGER); CREATE INDEX IF NOT EXISTS uploads_status ON uploads(status,retry_at); CREATE INDEX IF NOT EXISTS uploads_message ON uploads(message)");return db;
}
function save(stateDir:string,job:Job) {const db=database(stateDir);try{db.prepare("INSERT INTO uploads VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,status=excluded.status,message=excluded.message,retry_at=excluded.retry_at").run(job.id,JSON.stringify(job),job.status,job.messageId ?? null,job.retryAt ?? null);}finally{db.close();}}
function jobs(stateDir:string,filter?:{statuses?:string[];id?:string;message?:string}):Job[] {
  const db=database(stateDir);
  try {
    const where=filter?.statuses?`status IN (${filter.statuses.map(()=>"?").join(",")})`:filter?.id?"id=?":filter?.message?"message=?":"1=1";
    const args=filter?.statuses ?? (filter?.id?[filter.id]:filter?.message?[filter.message]:[]);
    return (db.prepare(`SELECT payload FROM uploads WHERE ${where} ORDER BY rowid`).all(...args) as {payload:string}[]).map(row=>JSON.parse(row.payload) as Job);
  }finally{db.close();}
}

/** Publish a small, readable cloud placeholder before any full report/file preparation. */
export async function stageBackgroundDocument(params:DeliveryParams & {stateDir:string;source:Source;sessionId?:string;agentId:string;completionJobId?:string}):Promise<StagedDocument|undefined> {
  const account=resolveFeishuRuntimeAccount(params),config=account.config.documentDelivery;
  const workspaceDir=params.workspaceDir ?? config?.workspaceDir ?? account.config.workspaceSync?.root ?? params.cfg.agents?.defaults?.workspace;
  // A mixed reply uses ordinary delivery so its images are not lost in the upload queue.
  if(splitMessageImages(params.text ?? "",params.mediaUrls,workspaceDir).images.length)return;
  const refs=findLocalFileReferences(params.text ?? "",workspaceDir);
  if(config?.enabled===false || (!refs.length && !(params.mediaUrls ?? []).some(url=>resolveLocalFilePath(url,workspaceDir))))return;
  // Large reports retain the existing chunking fallback; never truncate the summary.
  if(Buffer.byteLength(params.text ?? "","utf8")>20000 || !withinCardTableLimit(params.text ?? ""))return;
  const candidates=[...new Set([...refs.map(ref=>ref.path),...(params.mediaUrls ?? []).flatMap(url=>{const path=resolveLocalFilePath(url,workspaceDir);return path?[path]:[];})])];
  const localPaths:string[]=[];
  for(const path of candidates)if(await isExistingLocalFile(path))localPaths.push(path);
  if(!localPaths.length)return;
  const check=()=>{params.signal?.throwIfAborted();if(!isCompletionSourceCurrent(params.source,params.stateDir))throw new DOMException("Task source invalid","AbortError");};
  const started=Date.now();
  const client=createFeishuClient(account);
  const recipient=config?.grantToTarget!==false?resolveDocumentPermissionRecipient(params.to,params.source):undefined;
  return withFeishuRequestContext(check,async()=>{
    const title=(config?.titleTemplate ?? "{filename}").replaceAll("{filename}",basename(localPaths[0])).slice(0,200);
    check();const doc=await createDoc(client,title,config?.folderToken,{grantToRequester:false});
    const url=(config?.urlBase ?? (account.domain==="lark"?"https://www.larksuite.com":"https://feishu.cn")).replace(/\/$/,"")+"/docx/"+doc.document_id;
    const job:Job={id:randomUUID(),source:params.source,agentId:params.agentId,sessionId:params.sessionId,text:params.text ?? "",mediaUrls:params.mediaUrls,documentId:doc.document_id,url,workspaceDir,completionJobId:params.completionJobId,status:"draft"};
    save(params.stateDir,job);
    let phase="write_placeholder";
    try {
      check();await writeDoc(client,doc.document_id,"上传中\n\n总结已生成，完整报告正在上传，请稍后刷新。",20*1024*1024,30000);
      if(recipient) {
        phase="grant_access";
        check();const permission=await client.drive.permissionMember.create({path:{token:doc.document_id},params:{type:"docx",need_notification:false},data:{member_type:recipient.memberType,member_id:recipient.memberId,perm:config?.permission ?? "view"}});
        assertFeishuApiSuccess(permission,"Placeholder permission failed");
        job.confirmedGrant={documentId:doc.document_id,...recipient,permission:config?.permission ?? "view"};save(params.stateDir,job);
      }
      check();
    } catch(error) {
      job.status=error instanceof DOMException && error.name==="AbortError"?"cancelled":"staging_failed";
      job.uploadFailure=documentDeliveryFailure(error,phase);save(params.stateDir,job);
      params.onFailure?.(job.uploadFailure);
      console.warn(`Feishu document placeholder failed: stage=${job.uploadFailure.stage} code=${job.uploadFailure.code ?? "unknown"}`);
      throw error;
    }
    check();console.info(`Feishu document placeholder ready (${Date.now()-started}ms)`);return {id:job.id,text:pendingDocumentText(job.text,url,workspaceDir)};
  });
}

/** Activate only after the first card's platform receipt, never after an uncertain send. */
export function activateBackgroundDocument(stateDir:string,stage:StagedDocument,messageId:string,unbound=false,displayPrefix=""):void {
  const job=jobs(stateDir,{id:stage.id})[0];if(!job || job.status!=="draft")return;
  if(unbound)job.completionJobId=undefined;
  job.messageId=messageId;job.displayPrefix=displayPrefix;job.publishedText=displayPrefix+stage.text;job.status="queued";save(stateDir,job);
  // The service timer starts uploads in its own scope, independent of the human turn.
}

/** Durable upload work runs outside Ada's turn; only the final edit enters its FIFO. */
export function registerDocumentBackground(api:OpenClawPluginApi) {
  const core=api.runtime,stateDir=core.state.resolveStateDir();
  let timer:ReturnType<typeof setInterval>|undefined,controller:AbortController|undefined;
  const active=new Set<string>();
  const run=async(job:Job,signal:AbortSignal)=>{
    const cfg=structuredClone(core.config.current()) as ClawdbotConfig;
    const check=()=>{
      signal.throwIfAborted();
      const storePath=core.agent.session.resolveStorePath(cfg.session?.store,{agentId:job.agentId});
      const current=core.agent.session.getSessionEntry({storePath,agentId:job.agentId,sessionKey:job.source.sessionKey,readConsistency:"latest"});
      if(!isCompletionSourceCurrent(job.source,stateDir) || (job.sessionId && current?.sessionId!==job.sessionId))throw new DOMException("Task source/session invalid","AbortError");
    };
    try {
      check();const interrupted=job.status==="interrupted";
      job.status="working";save(stateDir,job);
      const started=Date.now();
      await withFeishuRequestContext(check,async()=>{
        let text=job.finalText ?? (job.displayPrefix ?? "")+failedDocumentText(job.text,job.url,job.workspaceDir),success=false,skippedNotice="";
        if(!job.finalText && !interrupted) {
          const document=await prepareFeishuDocumentDelivery({cfg,accountId:job.source.accountId,agentId:job.agentId,mediaRuntime:core.media,to:"chat:"+job.source.chatId,recipientContext:job.source,text:job.text,mediaUrls:job.mediaUrls,workspaceDir:job.workspaceDir,existingDocumentId:job.documentId,confirmedGrant:job.confirmedGrant,signal,onFailure:failure=>{job.uploadFailure=failure;save(stateDir,job);console.warn(`Feishu background document upload failed: stage=${failure.stage} code=${failure.code ?? "unknown"}`);}});
          success=Boolean(document?.documentId);
          if(success)text=(job.displayPrefix ?? "")+document!.text;
          else {skippedNotice=document?.skippedAttachmentNotice ?? "";text+=skippedNotice;}
        }
        check();
        if(!job.finalText && !success) {
          const client=createFeishuClient(resolveFeishuRuntimeAccount({cfg,accountId:job.source.accountId}));
          try {await writeDoc(client,job.documentId,"上传未完成\n\n"+(interrupted?"服务重启中断了上传。":"完整报告上传失败或文件不存在。")+"总结已经交付，请联系管理员核对报告。"+skippedNotice,20*1024*1024,30000);} catch {check();console.warn("Feishu upload status document update failed");}
        }
        job.finalText=text;save(stateDir,job);
        console.info(`Feishu background document processed: upload=${success?"succeeded":job.uploadFailure?"failed":"not_attempted"} (${Date.now()-started}ms)`);
        // The published text has a platform receipt. An unchanged result does
        // not need a FIFO turn or PATCH, including shared cards with newer siblings.
        if(text===job.publishedText) {
         const binding=job.completionJobId?readAsyncTaskCard(stateDir,job.completionJobId,job.source):undefined;
         if(job.completionJobId && (!binding || binding.messageId!==job.messageId)){job.status="cancelled";return;}
         if(!job.completionJobId || binding?.result===text){check();job.status="done";return;}
        }
        await runFeishuWorkingTurn({key:JSON.stringify([job.source.accountId,job.source.sessionKey]),senderId:job.source.senderId,signal,prepare:async()=>{},cancel:async()=>{job.status="cancelled";},run:async()=>{
          check();const account=resolveFeishuRuntimeAccount({cfg,accountId:job.source.accountId});
          const binding=job.completionJobId?readAsyncTaskCard(stateDir,job.completionJobId,job.source):undefined;
          if(job.completionJobId && (!binding || binding.messageId!==job.messageId)) {job.status="cancelled";return;}
          const result=binding?prepareAsyncCardResult(stateDir,binding,text,account.config):undefined;
          job.editAttempts=(job.editAttempts ?? 0)+1;save(stateDir,job);
          if(result && !result.fits)throw Error("Uploaded report card exceeds limit");
          const combined=binding ? text : jobs(stateDir,{message:job.messageId}).filter(other=>other.messageId===job.messageId && !other.completionJobId && other.source.taskId===job.source.taskId && other.source.revision===job.source.revision && other.source.accountId===job.source.accountId && other.source.chatId===job.source.chatId && other.publishedText).map(other=>other.finalText ?? other.publishedText!).join("\n\n---\n\n");
          const editStarted=Date.now();
          await editMessageFeishu({cfg,accountId:job.source.accountId,messageId:job.messageId!,card:result?.card ?? workingResultCard(combined || text,account.config)});
          console.info(`Feishu background report card updated (${Date.now()-editStarted}ms)`);
          if(binding)acceptAsyncCardResult(stateDir,binding,text);
          job.status="done";
        }});
      });
    } catch {
      if(signal.aborted)return; // Keep working state for recovery after service restart.
      try{check();job.status=job.finalText && (job.editAttempts ?? 0)<3?"queued":"update_failed";job.retryAt=Date.now()+1000;console.warn("Feishu background document/card update failed; summary is retained");}catch{job.status="cancelled";}
    } finally {save(stateDir,job);}
  };
  api.registerService({id:"feishu-document-uploads",start:()=>{
    controller=new AbortController();
    for(const job of jobs(stateDir,{statuses:["working"]}))if(job.status==="working"){job.status="interrupted";save(stateDir,job);}
    const tick=()=>{
      if(!controller || controller.signal.aborted)return;
      for(const job of jobs(stateDir,{statuses:["queued","interrupted"]}).filter(job=>["queued","interrupted"].includes(job.status) && (!job.retryAt || job.retryAt<=Date.now()))) {
        if(active.size>=2)break;
        if(active.has(job.id))continue;
        active.add(job.id);void run(job,controller.signal).catch(()=>console.warn("Feishu background upload state persistence failed")).finally(()=>active.delete(job.id));
      }
    };
    timer=setInterval(tick,250);timer.unref();tick();
  },stop:()=>{if(timer)clearInterval(timer);controller?.abort();}});
}
