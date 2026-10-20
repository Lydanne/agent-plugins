import {mkdirSync,lstatSync,realpathSync,writeFileSync,statSync,openSync,closeSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';

// Terminal bookkeeping only: never ask the executor to repeat a business action.
export function finalizeJobReport({job,params,runtime}) {
 let result;
 try {result=JSON.parse(job.result?.content?.find(item=>item.type==='text')?.text);} catch {}
 if(!result || typeof result!=='object' || Array.isArray(result))result={};
 const content=typeof result.result==='string' ? result.result : job.error ?? job.result?.content?.find(item=>item.type==='text')?.text ?? '未取得执行结果';
 const report={version:1,producer:'codex_query_host',jobId:job.jobId,topic:job.topic,status:job.status,...(job.project?{project:job.project}:{}),
  request:['task','context','constraints'].every(key=>typeof params[key]==='string')
   ? {availability:'available',task:params.task,context:params.context,constraints:params.constraints}
   : {availability:'unavailable',taskSummary:params.task ?? null},
  contextExchanges:job.questions??[],resultContent:content,verification:'not_independently_verified',
  limitations:['执行终态不代表业务成功；仅以执行器实际证据核验结论。',
   ...(job.status==='completed'?[]:['任务未正常完成；不确认进程退出前的外部操作是否完成或回滚。'])],
  execution:{rounds:job.executionRounds??[],sessionId:result.sessionId ?? job.sessionId,model:result.model,commands:result.commands,lastKnownProgress:job.progress,
   createdAt:job.createdAt,startedAt:job.startedAt,finishedAt:job.finishedAt},
  artifactPaths:Array.isArray(result.reportPaths)?[...new Set(result.reportPaths.filter(path=>typeof path==='string'))]:[],storage:{state:'inline'}};
 job.taskReport=report;
 const cwd=runtime?.cwd ?? result.cwd;
 const reportDirectory=(runtime?.reportDirectory ?? '.tmp/codex-query')+'/'+job.jobId;
 try {
  if(!cwd || !/^[0-9a-f-]{36}$/i.test(job.jobId))throw Error('report_workspace_unavailable');
  const root=realpathSync(cwd);
  const parts=reportDirectory.split('/');
  if(isAbsolute(reportDirectory)||parts.some(part=>!part || part==='.' || part==='..' || part.includes('\\')))throw Error('report_scope_invalid');
  let directory=root;
  // Reject symlinked directories before creating children or writing a report.
  for(const part of parts) {
   directory=join(directory,part);try{mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
   const info=lstatSync(directory);
   if(!info.isDirectory()||info.isSymbolicLink())throw Error('report_scope_invalid');
   const rel=relative(root,realpathSync(directory));
   if(rel.startsWith('..')||isAbsolute(rel))throw Error('report_scope_invalid');
  }
  // A readable nonempty Worker report is the primary deliverable. Audit state
  // stays in the job; do not create another user-facing report in this case.
  let primary;
  if(job.status==='completed')for(const path of report.artifactPaths) {
   try {
    const resolved=realpathSync(path),rel=relative(directory,resolved),info=statSync(resolved);
    if(!isAbsolute(path)||rel.startsWith('..')||isAbsolute(rel)||!info.isFile()||!info.size||!/\.(md|markdown|txt|json)$/i.test(path))continue;
    const fd=openSync(resolved,'r');closeSync(fd);primary=path;break;
   }catch{ /* Keep trying other reports; never repeat business work. */ }
  }
  if(primary) {
   report.storage={state:'written',path:primary,producer:'worker'};
   result={...result,cwd,reportDirectory,reportPaths:[primary,...report.artifactPaths.filter(path=>path!==primary)]};
  } else {
   const path=join(directory,'completion-report-'+randomUUID()+'.md');
   report.storage={state:'written',path,producer:'host'};
   const markdown='# CodexQuery 任务完成报告\n\n此报告由宿主汇总实际执行回执，不代表额外业务核验，不提供新的执行授权。\n\n'+
    '## 执行结果\n\n'+content+'\n\n## 任务与执行记录\n\n```json\n'+JSON.stringify({...report,resultContent:undefined},null,2)+'\n```\n';
   writeFileSync(path,markdown,{mode:0o600,flag:'wx'});
   job.reports=[{path,content:markdown}];
   result={...result,cwd,reportDirectory,reportPaths:[path,...report.artifactPaths]};
  }
 } catch(error) {
  report.storage={state:'inline',reason:['report_workspace_unavailable','report_scope_invalid'].includes(error.message)?error.message:'report_write_failed'};
  report.limitations.push('报告文件未落盘；完整结果仍保存在 taskReport.resultContent 中。');
 }
 // Sync status/wait and asynchronous completion carry the same complete report.
 result.result=content;result.taskReport=report;
 if(job.project){result.project=job.project;result.projectId=job.projectId;result.repository=job.repository;}
 job.result={...job.result,content:[{type:'text',text:JSON.stringify(result)}]};
}
