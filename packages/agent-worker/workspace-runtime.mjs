import {allocateWorkspace,prepareWorkspace,validateWorkspace,markWorkspace,parkWorkspace,restoreParkedWorkspace,parkedWorkspaceReceipt} from './dist/workspace-pool.mjs';
import {createHash} from 'node:crypto';
export function workspaceRuntime(runtime,lease){
 const plan=runtime.workspacePool,source=runtime.projectContext.cwd;
 const materialized='workspace/'+lease.id,logical=plan.projectRepository;
 const map=p=>p===source?lease.path:p.startsWith(source+'/')?lease.path+p.slice(source.length):p;
 const relative=p=>p===logical?materialized:p.startsWith(logical+'/')?materialized+p.slice(logical.length):p;
 const snapshot=runtime.scopedSkillSnapshot;
 const mapped={...snapshot,protocol:4,projectRepository:materialized,repository:relative(snapshot.repository),catalog:snapshot.catalog.map(relative),
  repositorySources:snapshot.repositorySources.map(r=>({...r,root:map(r.root)})),
  instructionSources:snapshot.instructionSources.map(r=>({...r,root:map(r.root),paths:r.paths.map(relative)}))};
 const workspace={id:lease.id,assignmentId:lease.assignmentId,owner:lease.owner,path:lease.path,branch:lease.branch};
 return {...runtime,cwd:lease.path,workspace,scopedSkillSnapshot:mapped,
  executionScope:createHash('sha256').update(JSON.stringify([runtime.executionScope,lease.owner])).digest('hex'),
  projectContext:{...runtime.projectContext,cwd:lease.path,scopeDirectory:map(runtime.projectContext.scopeDirectory),workspace},
  executorInstructions:runtime.executorInstructions.replaceAll(source,lease.path),delegationInstructions:runtime.delegationInstructions.replaceAll(source,lease.path)};
}
export async function prepareJobWorkspace(runtime,owner){
 const plan=runtime.workspacePool;
 if(!plan){if(runtime.workspace||runtime.workspaceCheckpoint)throw Error('Workspace runtime is missing its pool binding');return runtime;}
 if(runtime.workspaceCheckpoint) {
  if(!runtime.workspace||runtime.workspaceCheckpoint.jobId!==owner||runtime.workspaceCheckpoint.assignmentId!==runtime.workspace.assignmentId)throw Error('Workspace checkpoint runtime binding changed');
  const restored=await restoreParkedWorkspace(plan,runtime.workspace,{agentId:runtime.projectContext.agentId,checkpointId:runtime.workspaceCheckpoint.checkpointId});
  if(!restored)return null;
  await validateWorkspace(plan,restored);
  const resumed={...runtime};delete resumed.workspaceCheckpoint;return resumed;
 }
 const slot=await allocateWorkspace(plan,owner,runtime.workspace);
 if(!slot)return null;
 if(slot.blocked)throw Error(slot.error);
 let lease=slot;
 if(slot.status==='preparing'){if(!slot.needsPreparation)return null;lease=await prepareWorkspace(plan,slot);}
 await validateWorkspace(plan,lease);
 return runtime.workspace?runtime:workspaceRuntime(runtime,lease);
}
export async function settleJobWorkspace(runtime){
 if(!runtime.workspace)return;
 const prior=await parkedWorkspaceReceipt(runtime.workspacePool,runtime.workspace,{agentId:runtime.projectContext.agentId});
 if(prior)return prior;
 const lease=await validateWorkspace(runtime.workspacePool,runtime.workspace,{settling:true});
 const parked=await parkWorkspace(runtime.workspacePool,lease,{agentId:runtime.projectContext.agentId});
 return {...parked,checkpoint:parked.preservedCheckpoint};
}
export async function checkJobWorkspace(runtime){if(runtime.workspace){await validateWorkspace(runtime.workspacePool,runtime.workspace);await markWorkspace(runtime.workspacePool,runtime.workspace,'running');}}
export async function holdJobWorkspace(runtime){if(runtime.workspace)await markWorkspace(runtime.workspacePool,runtime.workspace,'held');}
