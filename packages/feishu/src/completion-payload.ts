import type {CompletionEvent} from "./codex-completion.js";

/** Compact only model input; persisted reports and adapter events stay lossless. */
export function completionPayloadForMain(event:CompletionEvent,recipientContext?:string) {
 const taskReport=event.taskReport && typeof event.taskReport==="object" && !Array.isArray(event.taskReport)
  ? {...event.taskReport} as Record<string,unknown> : undefined;
 const storage=taskReport?.storage as {state?:string;path?:string;producer?:string}|undefined;
 const hostPath=taskReport?.producer==="codex_query_host" && storage?.state==="written" && storage.producer!=="worker" ? storage.path : undefined;
 if(taskReport) {
  if(taskReport.resultContent===event.reportContent){delete taskReport.resultContent;taskReport.resultContentRef="reportContent";}
  if(event.request && JSON.stringify(taskReport.request)===JSON.stringify(event.request)){delete taskReport.request;taskReport.requestRef="request";}
 }
 const seen=new Map<string,string>();
 seen.set(event.reportContent,"reportContent");
 const reports=event.reports?.map((report,index)=>{
  if(typeof report.content!=="string")return {...report};
  const ref=seen.get(report.content);
  if(ref || report.path===hostPath) {
   const {content,...metadata}=report;
   return {...metadata,contentRef:ref ?? "reportContent+request+taskReport"};
  }
  seen.set(report.content,`reports[${index}].content`);
  return {...report};
 });
 return {...event,...(taskReport?{taskReport}:{}),...(reports?{reports}:{}),
  request:event.request ?? {availability:"unavailable",reason:"legacy_event"},
  ...(recipientContext?{deliveryContext:{recipientContext}}:{})};
}
