import { createHash } from "node:crypto";
import { basename, dirname, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { TextDecoder } from "node:util";
import { buildOutboundMediaLoadOptions, getAgentScopedMediaLocalRoots, type OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { createDoc, writeDoc } from "./docx.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { getFeishuRuntime } from "./runtime.js";
import { normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";
import { runBeforeFeishuMessageDispatch, captureFeishuSendAuthority } from "./send-context.js";
import type {FeishuChatType} from "./types.js";

function replaceLocalReferences(text:string,refs:Reference[]):string {
 return transformLocalReferences(text,refs,(ref,label,kind)=>{
  if(kind==="inlineCode")return "`"+basename(ref.path)+"`";
  if(kind==="bare")return basename(ref.path);
  return `${label || basename(ref.path)} (${basename(ref.path)})`;
 });
}
type Reference = { raw: string; path: string; markup?:string; label?:string };
export function resolveLocalFilePath(raw: string, workspaceDir?: string): string | undefined {
  let value = raw.trim().replace(/^<|>$/g, "").replace(/:\d+(?::\d+)?$/, "").replace(/#L\d+(?:-L\d+)?$/, "");
  if (value.startsWith("file://")) {
    try { value = fileURLToPath(value); } catch { return undefined; }
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
    try{value=decodeURIComponent(value);}catch{}
  }
  if (value.startsWith("~/")) value = resolve(homedir(), value.slice(2));
  if (value.startsWith("./") || value.startsWith("../")) {
    if (!workspaceDir) return undefined;
    value = resolve(workspaceDir, value);
  }
  return value.startsWith("/") && !value.endsWith("/") ? value : undefined;
}
/** Existence never grants read permission; the media loader still enforces access. */
export async function isExistingLocalFile(path:string):Promise<boolean> {
 return Boolean(await localFileInfo(path));
}
async function localFileInfo(path:string) {
 try{const info=await stat(path);return info.isFile()?info:undefined;}catch(error){
  if(["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))return undefined;
  throw error;
 }
}
const attachmentSkipBytes=1024*1024*1024;
function skippedAttachmentNotice(files:{path:string;size:number}[]):string {
 if(!files.length)return "";
 return "\n\n附件未上传说明：\n"+files.map(file=>{
  const name=basename(file.path).replace(/([\\`*_\[\]<>#])/g,"\\$1");
  return `- ${name}：${(file.size/1024/1024).toFixed(2)} MB（${file.size} 字节），超过 1GB（1024MB），已跳过上传。`;
 }).join("\n");
}
/** Scan explicit file references, excluding fenced code and remote URLs. Never crawl directories. */
export function findLocalFileReferences(text: string, workspaceDir?: string): Reference[] {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, "");
  const references: Reference[] = [];
  type Node = {type:string;url?:string;value?:string;children?:Node[];position?:{start:{offset?:number};end:{offset?:number}}};
  const labelOf=(node:Node):string=>node.value ?? node.children?.map(labelOf).join("") ?? "";
  const visit=(node:Node)=>{
    if(["link","image"].includes(node.type) && node.url){
      const path=resolveLocalFilePath(node.url,workspaceDir),start=node.position?.start.offset,end=node.position?.end.offset;
      if(path)references.push({raw:node.url,path,markup:start!==undefined&&end!==undefined?prose.slice(start,end):undefined,label:labelOf(node)});
    }
    if(node.type!=="code")node.children?.forEach(visit);
  };
  visit(fromMarkdown(prose) as Node);
  return references.filter((ref,index)=>references.findIndex(other=>other.raw===ref.raw)===index);
}

/** Message images stay on the native media path; report-internal images remain attachments. */
export function splitMessageImages(text: string, mediaUrls: string[] = [], workspaceDir?: string) {
 const isImage=(url:string)=>/\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg|avif|heic)$/i.test(resolveLocalFilePath(url,workspaceDir) ?? url.split(/[?#]/)[0]);
 const refs=findLocalFileReferences(text,workspaceDir).filter(ref=>isImage(ref.path));
 const images=[...new Set([...mediaUrls.filter(isImage),...refs.map(ref=>ref.path)])];
 return {text:transformLocalReferences(text,refs,()=>"",workspaceDir).trim(),images,mediaUrls:mediaUrls.filter(url=>!isImage(url))};
}

/** Change only recognized local references; keep summaries, remote URLs and code examples intact. */
function transformLocalReferences(text:string,refs:Reference[],render:(ref:Reference,label:string|undefined,kind:string)=>string,workspaceDir?:string):string {
 type Node={type:string;url?:string;value?:string;children?:Node[];position?:{start:{offset?:number};end:{offset?:number}}};
 const byPath=new Map(refs.map(ref=>[ref.path,ref]));
 const edits:{start:number;end:number;value:string}[]=[];
 const refFor=(raw:string)=>{
  const exact=refs.find(ref=>ref.raw===raw);if(exact)return exact;
  const path=resolveLocalFilePath(raw,workspaceDir);return path?byPath.get(path):undefined;
 };
 const add=(start:number,end:number,ref:Reference,label?:string,kind="link")=>{
  if(edits.some(edit=>start<edit.end && end>edit.start))return;
  edits.push({start,end,value:render(ref,label,kind)});
 };
 const labelOf=(node:Node):string=>node.value ?? node.children?.map(labelOf).join("") ?? "";
 const visit=(node:Node)=>{
  const start=node.position?.start.offset,end=node.position?.end.offset;
  if(node.type==="code")return;
  if(node.type==="link" || node.type==="image") {
   const ref=node.url?refFor(node.url):undefined;
   if(ref && start!==undefined && end!==undefined)add(start,end,ref,labelOf(node));
   return;
  }
  node.children?.forEach(visit);
 };
 visit(fromMarkdown(text) as Node);
 let reply=text;
 for(const edit of edits.sort((a,b)=>b.start-a.start))reply=reply.slice(0,edit.start)+edit.value+reply.slice(edit.end);
 return reply;
}

/** Several local reports share one cloud document; collapse identical standalone entries only. */
function uniqueDocumentEntries(text:string,url:string):{text:string;linked:boolean} {
 type Node={type:string;url?:string;value?:string;children?:Node[];position?:{start:{offset?:number};end:{offset?:number}}};
 const tree=fromMarkdown(text) as Node,seen=new Set<string>(),edits:{start:number;end:number}[]=[];
 const labelOf=(node:Node):string=>node.value ?? node.children?.map(labelOf).join("") ?? "";
 let linked=false;
 const visit=(node:Node)=>{
  if(node.type==="code")return;
  if(node.type==="link" && node.url===url)linked=true;
  node.children?.forEach(visit);
 };
 visit(tree);
 for(const node of tree.children ?? []) {
  const link=node.type==="paragraph" && node.children?.length===1?node.children[0]:undefined;
  if(link?.type!=="link" || link.url!==url)continue;
  const label=labelOf(link),end=node.position?.end.offset;
  let start=node.position?.start.offset;
  if(seen.has(label) && start!==undefined && end!==undefined) {
   while(start>0 && /[\r\n]/.test(text[start-1]))start--;
   edits.push({start,end});
  }
  seen.add(label);
 }
 for(const edit of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,edit.start)+text.slice(edit.end);
 return {text,linked};
}

function documentReplyText(text:string,refs:Reference[],uploadedPaths:Set<string>,url:string,fallbackLink:string,workspaceDir?:string):string {
 let linked=false;
 const reply=transformLocalReferences(text,refs,(ref,label,kind)=>{
  const name=label || basename(ref.path);
  if(uploadedPaths.has(ref.path)) {
   linked=true;return `[${name.replace(/([\\\[\]])/g,"\\$1")}](${url})`;
  }
  if(kind==="inlineCode")return "`"+basename(ref.path)+"`";
  return kind==="bare"?basename(ref.path):`${name} (${basename(ref.path)})`;
 },workspaceDir);
 const unique=uniqueDocumentEntries(reply,url);
 return linked || unique.linked?unique.text:[unique.text.trim(),fallbackLink].filter(Boolean).join("\n\n");
}

/** Keep report labels while pointing local references at the shared cloud status page. */
export function pendingDocumentText(text:string,url:string,workspaceDir?:string):string {
 const refs=findLocalFileReferences(text,workspaceDir);
 return documentReplyText(text,refs,new Set(refs.map(ref=>ref.path)),url,`[完整报告](${url})`,workspaceDir);
}

export function unavailableDocumentText(text:string,workspaceDir?:string):string {
 return replaceLocalReferences(text,findLocalFileReferences(text,workspaceDir))+"\n\n完整报告上传未完成，总结已保留。";
}

export function failedDocumentText(text:string,url:string,workspaceDir?:string):string {
 return pendingDocumentText(text,url,workspaceDir)+"\n\n完整报告上传未完成，总结已保留。";
}

export type DocumentDeliveryFailure = { stage: string; code?: string | number };
/** Keep diagnostics bounded: SDK errors can contain credentials and file contents. */
export function documentDeliveryFailure(error:unknown,stage="read_files"):DocumentDeliveryFailure {
 let code:string|number|undefined;
 const seen=new Set<unknown>();
 while(error && typeof error==="object" && !seen.has(error)) {
  seen.add(error);
  const detail=error as {deliveryStage?:string;code?:unknown;response?:{data?:{code?:unknown}};cause?:unknown};
  if(detail.deliveryStage)stage=detail.deliveryStage;
  const candidate=detail.response?.data?.code ?? detail.code;
  if(typeof candidate==="number" || (typeof candidate==="string" && /^[A-Za-z_0-9-]{1,64}$/.test(candidate)))code=candidate;
  error=detail.cause;
 }
 return {stage,...(code!==undefined?{code}:{})};
}
async function deliveryStep<T>(stage:string,action:()=>Promise<T>):Promise<T> {
 try{return await action();}catch(cause){throw Object.assign(new Error("Document delivery step failed",{cause}),{deliveryStage:stage});}
}
export type ConfirmedDocumentGrant={documentId:string;memberType:string;memberId:string;permission:string};
type DocumentRecipientContext={chatId:string;senderId:string;chatType?:FeishuChatType};
/** A private conversation is not a group collaborator. Use its trusted requester. */
export function resolveDocumentPermissionRecipient(to:string,context?:DocumentRecipientContext):{memberType:"openchat"|"openid"|"userid";memberId:string} {
 const target=normalizeFeishuTarget(to),kind=resolveReceiveIdType(to.replace(/^(feishu|lark):/i,""));
 if(!target)throw Error("Cannot grant document access to this recipient");
 if(kind==="chat_id" && target===context?.chatId && (context.chatType==="p2p" || context.chatType==="private")) {
  if(!/^ou_[A-Za-z0-9_-]+$/.test(context.senderId))throw Object.assign(new Error("Private document delivery requires the trusted requester OpenID"),{code:"DOCUMENT_REQUESTER_MISSING"});
  return {memberType:"openid",memberId:context.senderId};
 }
 return {memberType:kind==="chat_id"?"openchat":kind==="open_id"?"openid":"userid",memberId:target};
}
export type WorkerReportTitle = {sessionName?: string; finishedAt?: number};

/** Use bound Worker metadata, never infer a session name from report contents. */
export function reportDocumentTitle(filename: string, template?: string, workerReport?: WorkerReportTitle): string {
  if (!workerReport) return (template ?? "{filename}").replaceAll("{filename}", filename).slice(0,200);
  const sessionName = workerReport.sessionName?.replace(/\s+/g," ").trim() || "Worker报告";
  const timestamp = workerReport.finishedAt;
  const date = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"})
    .format(typeof timestamp === "number" && Number.isFinite(timestamp) && Math.abs(timestamp)<=8.64e15 ? timestamp : Date.now());
  // Reserve room for the date even when the session name reaches the title limit.
  if (!template || template === "{filename}") return sessionName.slice(0,189)+" "+date;
  const values:Record<string,string> = {filename,sessionName,date};
  return template.replace(/\{(filename|sessionName|date)\}/g,(_,key:string)=>values[key]).slice(0,200);
}

export type DeliveryParams = {
  cfg: ClawdbotConfig; accountId?: string; to: string; text?: string; mediaUrls?: string[];
  workspaceDir?: string; mediaLocalRoots?: readonly string[]; mediaAccess?: OutboundMediaAccess;
  mediaReadFile?: OutboundMediaAccess["readFile"]; signal?: AbortSignal;
  existingDocumentId?: string;
  workerReport?: WorkerReportTitle;
  confirmedGrant?: ConfirmedDocumentGrant;
  recipientContext?: DocumentRecipientContext;
  onFailure?: (failure:DocumentDeliveryFailure)=>void;
  agentId?: string; mediaRuntime?: Pick<PluginRuntime["media"], "loadWebMedia">;
};
type DocumentResult = { text: string; documentId?: string; url?: string; mediaUrls: string[]; skippedAttachmentNotice?:string };
const prepared = new Map<string, Promise<DocumentResult>>();

function isMissingFile(error: unknown): boolean {
 const seen=new Set<unknown>();
 while(error && typeof error==="object" && !seen.has(error)) {
  seen.add(error);
  const detail=error as {code?:string;cause?:unknown};
  if(["ENOENT","ENOTDIR","not-found"].includes(detail.code ?? ""))return true;
  error=detail.cause;
 }
 return false;
}

function assertDeliveryCurrent(params: DeliveryParams, error?: unknown): void {
 params.signal?.throwIfAborted();captureFeishuSendAuthority()?.();
 const seen=new Set<unknown>();
 while(error && typeof error==="object" && !seen.has(error)) {
  seen.add(error);
  const detail=error as {name?:string;cause?:unknown};
  if(detail.name==="AbortError")throw error;
  error=detail.cause;
 }
}

/** Attachments are best effort; only a real message receipt completes delivery. */
export async function prepareFeishuDocumentDelivery(params: DeliveryParams): Promise<DocumentResult | undefined> {
 const account=resolveFeishuRuntimeAccount(params);
 const workspaceDir=params.workspaceDir ?? account.config?.documentDelivery?.workspaceDir ?? account.config?.workspaceSync?.root ?? params.cfg.agents?.defaults?.workspace;
 const split=splitMessageImages(params.text ?? "",params.mediaUrls,workspaceDir);
 const documentParams={...params,text:split.text,mediaUrls:split.mediaUrls};
 let fallbackText=replaceLocalReferences(split.text,findLocalFileReferences(split.text,workspaceDir ?? "/"));
 let skippedNotice="";
 try {
  const result=await prepareDocument(documentParams,(text,notice)=>{fallbackText=text;if(notice)skippedNotice=notice;});
  if(result)return {...result,mediaUrls:[...result.mediaUrls,...split.images]};
  if(split.text!==(params.text ?? "").trim())return {text:split.text,mediaUrls:[...split.mediaUrls,...split.images]};
  return undefined;
 } catch(error) {
  // File preparation cannot restore a withdrawn task's right to send a reply.
  assertDeliveryCurrent(params,error);
  params.onFailure?.(documentDeliveryFailure(error));
  return {text:[fallbackText,"附件未成功交付，已改为文字结果。"].filter(Boolean).join("\n\n")+skippedNotice,mediaUrls:split.images,...(skippedNotice?{skippedAttachmentNotice:skippedNotice}:{})};
 }
}

/** Resolve existing files before creating a document; missing local references are skipped. */
async function prepareDocument(params: DeliveryParams,captureText:(text:string,skippedNotice?:string)=>void): Promise<DocumentResult | undefined> {
  if(!findLocalFileReferences(params.text ?? "","/").length && !(params.mediaUrls ?? []).some(url=>resolveLocalFilePath(url,"/")))return undefined;
  params.signal?.throwIfAborted();captureFeishuSendAuthority()?.();
  const account = resolveFeishuRuntimeAccount(params);
  const config = account.config?.documentDelivery;
  if (config?.enabled === false) return undefined;
  const workspaceDir=params.workspaceDir ?? config?.workspaceDir ?? account.config?.workspaceSync?.root ?? params.cfg.agents?.defaults?.workspace;
  if(!workspaceDir && (findLocalFileReferences(params.text ?? "","/").some(ref=>/^\.\.?\//.test(ref.raw)) || (params.mediaUrls ?? []).some(url=>/^\.\.?\//.test(url))))throw Error("Relative file delivery requires a configured workspaceDir");
  const refs = findLocalFileReferences(params.text ?? "", workspaceDir);
  captureText(replaceLocalReferences(params.text ?? "",refs));
  const media = params.mediaUrls ?? [];
  if (!refs.length && !media.some(url=>resolveLocalFilePath(url,workspaceDir))) return undefined;
  const inputs = [...new Set([...refs.map(ref=>ref.path),...media.flatMap(url=>{const path=resolveLocalFilePath(url,workspaceDir);return path?[path]:[];})])];
  const maxFiles = config?.maxFiles ?? 20;
  // A large SQL-only batch is one readable document and one source bundle.
  // Bound source fan-in separately; every input still passes the normal media authority.
  const bundleSql = inputs.length > maxFiles && inputs.every(input=>extname(input).toLowerCase()===".sql");
  if(bundleSql && inputs.length>200)throw Object.assign(Error("Too many SQL sources"),{code:"DOCX_SQL_SOURCE_LIMIT"});
  const maxBytes = Math.min((config?.maxFileMb ?? 20)*1024*1024,20*1024*1024);
  // Use the trusted turn owner, never the referenced file's parent, to grant a workspace.
  const mediaLocalRoots = params.mediaLocalRoots ?? config?.localRoots ??
    (params.agentId ? getAgentScopedMediaLocalRoots(params.cfg, params.agentId) : undefined);
  let total = 0;
  const files = [];
  const skipped:{path:string;size:number}[]=[];
  const textual = new Set(config?.textExtensions ?? [".md",".markdown",".txt",".sql"]);
  for (const input of inputs) {
    params.signal?.throwIfAborted();
    const info=await localFileInfo(input);
    if(!info)continue;
    // Inspect metadata before loading: never buffer or upload oversized files.
    if(info.size>attachmentSkipBytes) {
      skipped.push({path:input,size:info.size});
      const notice=skippedAttachmentNotice(skipped);
      captureText(replaceLocalReferences(params.text ?? "",refs),notice);
      continue;
    }
    if(!bundleSql && files.length>=maxFiles)throw Object.assign(Error("Too many document attachments"),{code:"DOCX_FILE_COUNT_LIMIT"});
    let loaded;
    try {
      loaded = await runBeforeFeishuMessageDispatch(()=>(params.mediaRuntime ?? getFeishuRuntime().media).loadWebMedia(input,buildOutboundMediaLoadOptions({
        maxBytes, optimizeImages:false, mediaAccess:params.mediaAccess, mediaReadFile:params.mediaReadFile,
        mediaLocalRoots,
      })));
    } catch(error) {
      assertDeliveryCurrent(params,error);
      if(resolveLocalFilePath(input,workspaceDir) && isMissingFile(error))continue;
      throw error;
    }
    if(loaded.buffer.length>maxBytes)throw Error("Document attachment exceeds per-file size limit");
    total += loaded.buffer.length;
    if (total > (config?.maxTotalMb ?? 50)*1024*1024) throw Error("Document attachments exceed total size limit");
    if (!loaded.buffer.length) throw Error("Document attachment is empty");
    const name=loaded.fileName ?? basename(input);
    let content:string|undefined;
    if(textual.has(extname(name).toLowerCase()) || bundleSql)try{content=new TextDecoder("utf-8",{fatal:true}).decode(loaded.buffer);}catch{}
    if(bundleSql && content===undefined)throw Object.assign(Error("SQL source is not UTF-8"),{code:"DOCX_SQL_ENCODING"});
    if(content && /\.m(?:d|arkdown)$/i.test(name) && resolveLocalFilePath(input,workspaceDir)) {
      const nested=findLocalFileReferences(content,dirname(input));
      for(const ref of nested)if(!inputs.includes(ref.path))inputs.push(ref.path);
      content=replaceLocalReferences(content,nested);
    }
    files.push({path:input,buffer:loaded.buffer,name,content});
  }
  let markdown = replaceLocalReferences(params.text ?? "",refs);
  if(!files.length && !skipped.length)return {text:markdown || "引用的本地文件不存在，已跳过上传。",mediaUrls:[]};
  const title = reportDocumentTitle(files[0]?.name ?? basename(skipped[0].path),config?.titleTemplate,params.workerReport);
  let sqlBundle = "";
  for (const file of files) {
    if(file.content===undefined)continue;
    const heading=file.name.replace(/([\\`*_\[\]<>#])/g,"\\$1");
    if (/\.sql$/i.test(file.name)) {
      let fenceLength=3;
      for(const match of file.content.matchAll(/`+/g))fenceLength=Math.max(fenceLength,match[0].length+1);
      const fence="`".repeat(fenceLength);
      const section=`\n\n## ${heading}\n\n${fence}sql\n${file.content}\n${fence}`;
      if(textual.has(".sql"))markdown+=section;sqlBundle+=section;
    }
    else if (/\.m(?:d|arkdown)$/i.test(file.name)) markdown += `\n\n## ${heading}\n\n${file.content}`;
    else markdown += `\n\n## ${heading}\n\n`+file.content.split(/\r?\n/).map(line=>line.replace(/([\\`*_\[\]<>#])/g,"\\$1")).join("\n");
  }
  const attachments=bundleSql && files.length ? [{name:"sql-sources.md",buffer:Buffer.from(`# SQL 原文汇总（${files.length} 份）\n${sqlBundle}`,"utf8")}] : files;
  if(bundleSql && attachments.some(file=>file.buffer.length>maxBytes))throw Object.assign(Error("SQL bundle exceeds attachment budget"),{code:"DOCX_SQL_BUNDLE_SIZE"});
  const skippedNotice=skippedAttachmentNotice(skipped);
  markdown+=skippedNotice;
  // This expanded body belongs only in the document. Upload failure must never
  // turn a quoted report, source file or role manual into additional chat prose.
  const exceedsTextLimit=markdown.length > (config?.maxTextChars ?? 200000);
  const key=createHash("sha256").update(JSON.stringify([account.accountId,account.appId,params.to,[params.recipientContext?.chatId,params.recipientContext?.chatType,params.recipientContext?.senderId],config,title,params.existingDocumentId,params.confirmedGrant,params.text,markdown,files.map(file=>[file.name,createHash("sha256").update(file.buffer).digest("hex")])])).digest("hex");
  const existing=prepared.get(key);
  if(existing){const result=await existing;params.signal?.throwIfAborted();captureFeishuSendAuthority()?.();return result;}
  const operation = (async()=>{
    const client=createFeishuClient(account);
    const check=()=>{params.signal?.throwIfAborted();captureFeishuSendAuthority()?.();};
    check();
    const doc=params.existingDocumentId ? {document_id:params.existingDocumentId} : await deliveryStep("create_document",()=>runBeforeFeishuMessageDispatch(()=>createDoc(client,title,config?.folderToken,{grantToRequester:false})));
    const documentId=doc.document_id;
    let bodyFallback=false;

    try {
      try {
        check();
        await deliveryStep("write_content",async()=>{
          if(exceedsTextLimit)throw Object.assign(new Error("Document text exceeds configured limit"),{code:"DOCX_TEXT_LIMIT"});
          return runBeforeFeishuMessageDispatch(()=>writeDoc(client,documentId,markdown||title,maxBytes,30000));
        });
      } catch(error) {
        // Retirement/cancellation cannot grant permission for fallback mutations.
        assertDeliveryCurrent(params,error);
        if(!bundleSql && !files.some(file=>/\.m(?:d|arkdown)$/i.test(file.name)))throw error;
        params.onFailure?.(documentDeliveryFailure(error));
        bodyFallback=true;
        // Do not retry the failed converter or clear partially inserted content.
        // This small plain-text block is independent of Markdown conversion.
        check();await deliveryStep("fallback_notice",()=>runBeforeFeishuMessageDispatch(async()=>{
          const notice=await client.docx.documentBlockChildren.create({
            path:{document_id:documentId,block_id:documentId},params:{document_revision_id:-1},
            data:{index:-1,children:[{block_type:2,text:{elements:[{text_run:{content:"正文转换未完成，完整内容请查看下方原始 Markdown 附件。"+skippedNotice}}]}}]},
          });
          assertFeishuApiSuccess(notice,"Document fallback notice failed");
        }));
      }
      for(const file of attachments){check();await deliveryStep("attach_file",()=>runBeforeFeishuMessageDispatch(()=>attachDocumentFile(client,documentId,file,check)));}
      if(config?.grantToTarget !== false){
        const {memberType,memberId:target}=resolveDocumentPermissionRecipient(params.to,params.recipientContext),perm=config?.permission ?? "view";
        const grant=params.confirmedGrant;
        if(grant?.documentId!==documentId || grant.memberType!==memberType || grant.memberId!==target || grant.permission!==perm) {
         check();await deliveryStep("grant_access",async()=>{const permission=await runBeforeFeishuMessageDispatch(()=>client.drive.permissionMember.create({path:{token:documentId},params:{type:"docx",need_notification:false},data:{member_type:memberType,member_id:target,perm}}));
         assertFeishuApiSuccess(permission,"Document recipient permission failed");});
        }
      }
    } catch(cause){throw new Error(`Document preparation failed (${documentId}); no chat message was sent`,{cause});}
    check();
    const base=config?.urlBase ?? (account.domain==="lark"?"https://www.larksuite.com":"https://feishu.cn");
    const url=base.replace(/\/$/,"")+"/docx/"+documentId;
    const fallbackLink=(config?.linkTemplate ?? "已整理为飞书文档：[{title}]({url})").replaceAll("{title}",title.replace(/[\[\]\\]/g," ")).replaceAll("{url}",url);
    return {text:documentReplyText(params.text ?? "",refs,new Set(files.map(file=>file.path)),url,fallbackLink,workspaceDir)+(bodyFallback?"\n\n正文转换未完成，原始 Markdown 已附在文档内，请下载查看。":"")+skippedNotice,documentId,url,mediaUrls:[]};
  })();
  prepared.set(key,operation);
  operation.catch(()=>prepared.delete(key));
  if(prepared.size>200)prepared.delete(prepared.keys().next().value!);
  const result=await operation;params.signal?.throwIfAborted();captureFeishuSendAuthority()?.();return result;
}

/** Create an actual file block, upload to its node and bind its token. */
export async function attachDocumentFile(client: ReturnType<typeof createFeishuClient>,documentId:string,file:{buffer:Buffer;name:string},check:()=>void=()=>{}) {
  let stage="create_attachment";
  try {
    check();
    const inserted=await client.docx.documentBlockChildren.create({path:{document_id:documentId,block_id:documentId},params:{document_revision_id:-1},data:{children:[{block_type:23,file:{}}],index:-1}});
    assertFeishuApiSuccess(inserted,"Document attachment block creation failed");
    let blockId=inserted.data?.children?.find(block=>block.block_type===23)?.block_id;
    // File blocks may be wrapped in a View block. Resolve the file child explicitly.
    if(!blockId){
      const view=inserted.data?.children?.find(block=>block.block_type===33);
      if(view?.block_id){stage="resolve_attachment";check();const children=await client.docx.documentBlockChildren.get({path:{document_id:documentId,block_id:view.block_id}});assertFeishuApiSuccess(children,"Document attachment child lookup failed");blockId=children.data?.items?.find(block=>block.block_type===23)?.block_id;}
    }
    if(!blockId)throw Error("Document file block missing from create response");
    check();
    stage="upload_attachment";
    const upload=await client.drive.media.uploadAll({data:{file_name:file.name,parent_type:"docx_file",parent_node:blockId,size:file.buffer.length,file:file.buffer}});
    if(!upload?.file_token)throw Error("Document attachment upload returned no file token");
    check();
    stage="bind_attachment";
    const patched=await client.docx.documentBlock.patch({path:{document_id:documentId,block_id:blockId},params:{document_revision_id:-1},data:{replace_file:{token:upload.file_token}}});
    assertFeishuApiSuccess(patched,"Document attachment binding failed");
  } catch(cause) {throw Object.assign(new Error("Document attachment step failed",{cause}),{deliveryStage:stage});}
}

/** Keep visible card prose, rather than serializing implementation fields into a document. */
export function documentCardText(card: Record<string,unknown>): string {
 const contents:string[]=[];
 const visit=(value:unknown)=>{
  if(Array.isArray(value)){value.forEach(visit);return;}
  if(value && typeof value==="object")for(const [key,child] of Object.entries(value)){
   if(["content","text","url"].includes(key)&&typeof child==="string")contents.push(child);
   else visit(child);
  }
 };
 visit(card);return [...new Set(contents)].join("\n\n");
}
export function documentLinkCard(text:string): Record<string,unknown> {
 return {schema:"2.0",config:{update_multi:true},body:{elements:[{tag:"markdown",content:text}]}};
}
