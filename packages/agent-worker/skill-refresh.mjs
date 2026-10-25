import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
export const revisionOf = snapshot => snapshot ? `${snapshot.skills}:${snapshot.roles}` : undefined;
export async function readSkillVersion(state, root, directories=['skills','.agents/skills']) {
 const snapshot=JSON.parse(await readFile(join(state,'skill-versions',hash(root)+'.json'),'utf8'));
 if(snapshot.protocol!==1 || snapshot.root!==root || !/^[a-f0-9]{64}$/.test(snapshot.skills) || !/^[a-f0-9]{64}$/.test(snapshot.roles) ||
  !Array.isArray(snapshot.catalog) || snapshot.catalog.length>500 || !snapshot.catalog.every(p=>typeof p==='string' && directories.some(dir=>p.startsWith(dir+'/') && p.endsWith('/SKILL.md')) && !p.split('/').includes('..')) ||
  !Array.isArray(snapshot.skillEntries) || snapshot.skillEntries.some(p=>typeof p!=='string') || hash(snapshot.skillEntries.join('\n'))!==snapshot.skills) throw Error('Invalid published workspace skill version');
 return snapshot;
}
export function skillRefreshPlan(previous, current) {
 const old=previous?.catalog ?? [];
 const removed=old.filter(p=>!current.catalog.includes(p));
 return {needsUpdate:revisionOf(previous)!==revisionOf(current),
  migrate:!!previous && (previous.roles!==current.roles || removed.length>0),
  added:current.catalog.filter(p=>!old.includes(p)),removed,
  changed:current.catalog.filter(p=>old.includes(p) && previous.skills!==current.skills)};
}
export function skillTaskContext(snapshot) {
 return {revision:revisionOf(snapshot),root:snapshot.root,catalog:snapshot.catalog,...(snapshot.protocol>=2?{projectId:snapshot.projectId,repository:snapshot.repository,cwd:snapshot.root+'/'+snapshot.projectRepository}:{}),...(snapshot.protocol>=3?{instructions:snapshot.instructionSources.flatMap(item=>item.paths)}:{}),
  instruction:'此列表替代旧版本工作区技能索引，其他来源仍遵守宿主配置。任务开始前必须读取本任务适用的 SKILL.md 最新正文、所需引用及 instructions 列出的仓库规范；索引确认不等于正文已读取。不得因历史任务执行过某操作就重复操作。'};
}
export async function refreshSkillSession({previous,current,runTurn,onApplied,signal}) {
 const plan=skillRefreshPlan(previous,current);
 if(!plan.needsUpdate)return false;
 signal?.throwIfAborted();
 const revision=revisionOf(current);
 const response=await runTurn(JSON.stringify({kind:'skill_catalog_refresh',revision,root:current.root,
  catalog:current.catalog,added:plan.added,changed:plan.changed,removed:plan.removed,
  instruction:'这是技能索引刷新轮次，不是业务任务。只更新本会话技能索引认知，不执行工具、业务操作或旧任务，不修改文件。新列表替代旧工作区索引；旧技能正文不得作为后续任务规则，后续使用时重新读取。不要声称已读取技能正文。仅返回 JSON：{"status":"catalog_applied","revision":"本轮 revision 原值"}。'}),{refresh:true,outputSchema:{type:'object',properties:{status:{type:'string',enum:['catalog_applied']},revision:{type:'string',enum:[revision]}},required:['status','revision'],additionalProperties:false}});
 signal?.throwIfAborted();
 let ack;try{ack=JSON.parse(response);}catch{throw Error('Skill refresh was not acknowledged; user task was not started');}
 if(ack.status!=='catalog_applied'||ack.revision!==revision)throw Error('Skill revision acknowledgement mismatch; user task was not started');
 await onApplied(current);
 return true;
}

/** Local administrator recovery only; never accepted from model tool parameters. */
export function reviewedContinuationMatches(review,expectedSessionId,previous,current) {
 return !!expectedSessionId && review?.sessionId===expectedSessionId && review.previousRevision===revisionOf(previous) && review.currentRevision===revisionOf(current) && typeof review.reason==='string' && !!review.reason.trim() && !skillRefreshPlan(previous,current).removed.length;
}
