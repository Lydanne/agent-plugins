import {createHash} from 'node:crypto';
import {AgentRepoError} from './dist/agent-repo-api.mjs';
/** History filters use stored bindings, without preparing or synchronizing a project. */
export function validateHistoryFilter({projectId,repository}={}) {
 if(projectId!==undefined&&(typeof projectId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(projectId))||repository!==undefined&&(typeof repository!=='string'||!/^(?:project|projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/repositories\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/.test(repository)))throw new AgentRepoError('PROJECT_SELECTOR_INVALID','Invalid history project filter');
 if(projectId!==undefined&&repository?.startsWith('projects/')&&repository.split('/')[1]!==projectId)throw new AgentRepoError('PROJECT_SELECTOR_CONFLICT','projectId and repository select different projects');
}
export function matchesHistoryFilter(entry,{projectId,repository}={}) {
 return (projectId===undefined||(entry.projectId??entry.project?.projectId)===projectId)&&(repository===undefined||(entry.repository??entry.project?.repository)===repository);
}
export function bindingKey(topic,runtime) {
 return runtime.executionScope?'project:'+createHash('sha256').update(JSON.stringify([runtime.executionScope,topic])).digest('hex'):topic;
}
export function compatibleLegacyBinding(entry,runtime) {
 const snapshot=entry?.skillsSnapshot,current=runtime.scopedSkillSnapshot;
 return !!runtime.executionScope&&entry?.cwd===runtime.cwd&&snapshot?.root===current?.root&&snapshot?.repository===current?.repository&&snapshot?.projectId===current?.projectId;
}
export function projectFields(runtime) {
 return runtime?.projectContext?{projectId:runtime.projectContext.projectId,repository:runtime.projectContext.repository,cwd:runtime.cwd,project:runtime.projectContext,executionScope:runtime.executionScope}:{};
}
