import {readdirSync, existsSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {readFile,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readJson, writeJson, requestKeyFor} from './jobs.mjs';

const symbol = Symbol.for('ada.codex-completion.v1');
export const completionBridge = globalThis[symbol] ??= {deliver: undefined};
export async function captureReports(response, maxBytes = 120000) {
 let result; try {result = JSON.parse(response?.content?.find(c => c.type === 'text')?.text);} catch {return [];}
 const reports = [];
 if (!Array.isArray(result.reportPaths) || !result.cwd) return reports;
 let remaining = maxBytes;
 const root = await realpath(join(result.cwd, result.reportDirectory ?? '.tmp')).catch(() => undefined);
 const primary=result.taskReport?.storage?.state==='written'?result.taskReport.storage.path:undefined;
 const paths=[...new Set([...(result.reportPaths.includes(primary)?[primary]:[]),...result.reportPaths])];
 for (const path of paths.slice(0,10)) {
  try {
   if (typeof path !== 'string' || !root) throw Error('unavailable');
   const resolved = await realpath(path), rel = relative(root,resolved);
   if (rel.startsWith('..') || isAbsolute(rel) || !/\.(md|markdown|txt|json)$/i.test(resolved)) throw Error('outside_report_scope');
   const info = await stat(resolved);
   if (!info.isFile() || info.size > remaining) throw Error('report_budget_exceeded');
   const content = await readFile(resolved,'utf8'); remaining -= Buffer.byteLength(content);
   reports.push({path,content});
  } catch (error) {reports.push({path,omittedReason:['outside_report_scope','report_budget_exceeded'].includes(error.message)?error.message:'report_unavailable'});}
 }
 for(const path of paths.slice(10))reports.push({path,omittedReason:'report_count_limit'});
 return reports;
}
const terminal = new Set(['awaiting_main', 'completed', 'failed', 'timed_out', 'cancelled']);

/** Recover the submitted task, not unrelated conversation state or executor credentials. */
export function readCompletionRequest(root, job) {
 const unavailable = reason => ({availability:'unavailable', reason,
  ...(typeof job.taskSummary === 'string' ? {taskSummary:job.taskSummary} : {})});
 let request;
 try {request = readJson(join(root,job.jobId + '.request.json'));}
 catch (error) {return unavailable(error.code === 'ENOENT' ? 'request_missing' : 'request_unreadable');}
 const params = request?.params, scope = request?.scope;
 if (typeof scope !== 'string' || !params ||
  !['task','context','constraints'].every(key => typeof params[key] === 'string')) return unavailable('request_invalid');
 if (createHash('sha256').update(scope).digest('hex') !== job.scope || params.topic !== job.topic ||
  !job.requestKey || requestKeyFor(params,scope,job.provenance) !== job.requestKey) return unavailable('request_binding_mismatch');
 return {availability:'available', task:params.task, context:params.context, constraints:params.constraints};
}

export function completionEvent(job, request = {availability:'unavailable',reason:'request_not_loaded'}) {
 let result;
 try {result = JSON.parse(job.result?.content?.find(c => c.type === 'text')?.text);} catch {}
 return {type: job.status==='awaiting_main'?'agent_worker.context_request':'agent_worker.completed', eventId: job.status==='awaiting_main'?'agent_worker:question:'+job.contextRequest.questionId:'codex_query:' + job.jobId,
  ...(job.status==='awaiting_main'?{contextRequest:job.contextRequest}:{}),
  jobId: job.jobId, topic: job.topic,...(job.project?{project:job.project,projectId:job.projectId,repository:job.repository,cwd:job.cwd}:{}), status: job.status, provenance: job.provenance, request,
  reportContent: result?.result ?? (job.status === 'cancelled' ? '任务已取消；已发生的外部操作不代表已回滚。' : job.error ?? '未取得执行结果'),
  reportPaths: result?.reportPaths ?? [], reports:job.reports ?? [], taskReport:job.taskReport, experienceReview: result?.experienceReview,
  createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt};
}

/** Only opted-in new jobs have delivery records; never replay historical business results. */
export function createCompletionService({root, bridge = completionBridge, logger = console, pollMs = 1000}) {
 const inflight = new Map();
 let controller = new AbortController();
 let timer, stopped = true;
 const fileOf = id => join(root, id + '.json');
 function patch(id, change, eventKey) {
  const file = fileOf(id), job = readJson(file);
  if(job.notification?.eventKey!==eventKey)return;
  writeJson(file, {...job, notification: {...job.notification, ...change}});
 }
 async function deliver(job) {
  const patchEvent=change=>patch(job.jobId,change,job.notification.eventKey);
  try {
   patchEvent({state: 'processing', attempts: (job.notification.attempts ?? 0) + 1});
   const outcome = await bridge.deliver(completionEvent(job,readCompletionRequest(root,job)), {
    signal:controller.signal,
    beforeSend: () => {controller.signal.throwIfAborted();if(readJson(fileOf(job.jobId)).notification?.eventKey!==job.notification.eventKey)throw Object.assign(Error('Delivery superseded'),{name:'AbortError'}); patchEvent({state: 'sending', sendingAt: Date.now()});},
    onReceipt: receipt => patchEvent({state: 'delivered', receipt, deliveredAt: Date.now()}),
   });
   if (readJson(fileOf(job.jobId)).notification.state !== 'delivered') {
    patchEvent({state: outcome?.suppressed ? 'suppressed' : 'pending',
     reason: outcome?.reason, retryAt: Date.now() + 10000});
   }
  } catch (error) {
   // Persist only bounded diagnostics; provider errors can contain credentials or report text.
   const errorCode = error?.message === 'Feishu runtime not initialized' ? 'feishu_runtime_unavailable'
    : error?.message === 'Completion session has no agent owner' ? 'completion_owner_missing'
    : error?.name === 'AbortError' ? 'delivery_aborted' : 'delivery_failed';
   const current = readJson(fileOf(job.jobId));
   // Network send may have succeeded before receipt persistence failed. Never blindly resend.
   if (current.notification.state !== 'delivered') patchEvent({
    state: current.notification.state === 'sending' ? 'uncertain' : 'pending', lastErrorCode: errorCode, retryAt: Date.now() + 10000});
   logger.warn?.('Codex completion delivery deferred: ' + job.jobId + ' (' + errorCode + ')');
  } finally {inflight.delete(job.jobId);}
 }
 function tick() {
  if (stopped || !bridge.deliver || !existsSync(root)) return;
  const jobs = readdirSync(root).filter(n => /^[0-9a-f-]{36}\.json$/i.test(n)).flatMap(n => {
   try {return [readJson(join(root,n))];} catch {logger.warn?.('Unreadable completion job: ' + n); return [];}
  })
   .filter(j => j.notification && terminal.has(j.status)).sort((a,b) => a.finishedAt - b.finishedAt);
  for (const job of jobs) {
   if (inflight.has(job.jobId)) continue;
   if (job.notification.state === 'sending') {patch(job.jobId,{state:'uncertain'},job.notification.eventKey); continue;}
   if (!['pending', 'processing'].includes(job.notification.state) || job.notification.retryAt > Date.now()) continue;
   const task = deliver(job).catch(() => logger.warn?.('Completion persistence deferred: ' + job.jobId)); inflight.set(job.jobId,task);
  }
 }
 return {
  tick,
  start() {controller = new AbortController(); stopped = false; timer = setInterval(() => {try {tick();} catch {logger.warn?.('Codex completion scan deferred');}}, pollMs); timer.unref?.(); tick();},
  async stop() {stopped = true; clearInterval(timer); controller.abort(); await Promise.allSettled([...inflight.values()]);},
 };
}
