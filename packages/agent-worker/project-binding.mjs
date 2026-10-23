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
 if(runtime.modelSessionScope)return 'model:'+createHash('sha256').update(JSON.stringify([runtime.executionScope??null,runtime.modelSessionScope,topic])).digest('hex');
 return runtime.executionScope?'project:'+createHash('sha256').update(JSON.stringify([runtime.executionScope,topic])).digest('hex'):topic;
}
export function compatibleLegacyBinding(entry,runtime) {
 if(!entry||entry.modelSessionScope&&entry.modelSessionScope!==runtime.modelSessionScope)return false;
 if(!runtime.executionScope)return !!runtime.modelSessionScope&&!entry.executionScope&&entry.cwd===runtime.cwd;
 const snapshot=entry?.skillsSnapshot,current=runtime.scopedSkillSnapshot;
 return !!runtime.executionScope&&entry?.cwd===runtime.cwd&&snapshot?.root===current?.root&&snapshot?.repository===current?.repository&&snapshot?.projectId===current?.projectId;
}
export function modelFields(runtime) {
 return runtime?.modelSessionScope?{modelId:runtime.modelId,modelName:runtime.modelName,harness:runtime.harness,model:runtime.model,modelSessionScope:runtime.modelSessionScope,thinkingLevel:runtime.thinkingLevel}:{};
}
export function projectFields(runtime) {
 return runtime?.projectContext?{projectId:runtime.projectContext.projectId,repository:runtime.projectContext.repository,cwd:runtime.cwd,...(runtime.workspace?{workspace:runtime.workspace}:{}),...(runtime.workspacePool?{useWorkspace:true}:{}),project:runtime.projectContext,executionScope:runtime.executionScope}:{};
}
