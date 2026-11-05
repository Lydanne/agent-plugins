import {checkProjectChildren} from './dist/project-read-lease.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
// Directory placement is host-owned. Task text never grants filesystem rights.
export function applyDirectoryPolicy(runtime){
 if(!runtime.projectContext)return runtime; // Fixed-cwd legacy installations keep their contract.
 const workspace=!!(runtime.workspacePool||runtime.workspace),mode=workspace?'workspace':'project-read-only';
 const approvalMode=workspace?runtime.approvalMode:'read-only';
 const instructions=workspace?'目录策略：仅在宿主分配的 workspace 内按本任务授权写入或切换分支；不得修改 projects 源目录或其他工作区。':'目录策略：projects 是默认分支的只读资料副本。禁止文件写入、安装依赖和切换分支（含报告及临时文件）；结果内联返回，由宿主保存报告。需要落盘产物、修改代码或切换分支时，在原任务中说明需要独立 workspace，不在源目录尝试。';
 const base=runtime.directoryPolicy?runtime.executorInstructions.split('\n目录策略：')[0]:runtime.executorInstructions;
 return {...runtime,approvalMode,directoryPolicy:{version:2,mode,originalApprovalMode:runtime.directoryPolicy?.originalApprovalMode??runtime.approvalMode},projectContext:{...runtime.projectContext,directoryMode:mode},executorInstructions:base+'\n'+instructions};
}

export function assertDirectoryReady(runtime){
 if(runtime.directoryPolicy?.mode==='workspace'&&!runtime.workspace)throw Error('Workspace must be allocated before executing a write or branch-switching task');
}
export async function checkReadOnlyProject(runtime){
 if(runtime.directoryPolicy?.mode!=='project-read-only')return;
 const git=async args=>(await exec('git',['--no-optional-locks','-c','core.fsmonitor=false',...args],{cwd:runtime.cwd,timeout:10000,maxBuffer:2*1024*1024})).stdout.trim();
 const registration=runtime.scopedSkillSnapshot?.projectRegistration;
 if(registration)await checkProjectChildren(runtime.cwd,registration.branch);
 if(registration&&((await git(['branch','--show-current']))!==registration.branch||(await git(['remote','get-url','origin']))!==registration.url))throw Error('Read-only project branch or origin changed; source preserved');
 if(await git(['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=all']))throw Error('Read-only project has local changes; use an independent workspace and preserve source changes');
}
