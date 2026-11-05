import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDirectoryPolicy} from './directory-policy.mjs';
import {hermesCommand,defaultHermesTemplates} from './hermes-templates.mjs';
import {executionFingerprint} from './configuration.mjs';
const base={cwd:'/source',cli:'codex',model:'fixture',reasoningEffort:'low',executorInstructions:'task limits',approvalMode:'dangerously-bypass-approvals-and-sandbox',projectContext:{root:'/agent',cwd:'/source'}};
test('shared project always clamps sandbox and repeated application is stable',()=>{const policy=applyDirectoryPolicy(base);assert.equal(policy.approvalMode,'read-only');assert.equal(policy.projectContext.directoryMode,'project-read-only');assert.deepEqual(applyDirectoryPolicy(policy),policy);const command=hermesCommand(policy);assert(command.args.includes('read-only'));assert(!command.args.includes('--dangerously-bypass-approvals-and-sandbox'));});
test('workspace does not increase an administrator read-only ceiling; legacy mode is unchanged',()=>{assert.equal(applyDirectoryPolicy({...base,workspacePool:{}}).approvalMode,base.approvalMode);assert.equal(applyDirectoryPolicy({...base,workspacePool:{},approvalMode:'read-only'}).approvalMode,'read-only');const legacy={...base,projectContext:undefined};assert.equal(applyDirectoryPolicy(legacy),legacy);});
test('custom template flags cannot bypass directory sandbox policy',()=>{for(const extra of [['--full-auto'],['-c','sandbox_mode="danger-full-access"'],['--sandbox=workspace-write'],['--add-dir','/source']]){const config=applyDirectoryPolicy({...base,hermesExecution:{variables:{cli:'codex',model:'fixture',reasoningEffort:'low',speed:''},template:{...defaultHermesTemplates.codex,args:[...defaultHermesTemplates.codex.args,...extra]}}});assert.throws(()=>hermesCommand(config),/directory policy conflict/);}});
test('a pending workspace cannot execute against the shared source directory',async()=>{const {assertDirectoryReady}=await import('./directory-policy.mjs');assert.throws(()=>assertDirectoryReady(applyDirectoryPolicy({...base,workspacePool:{}})),/allocated/);assert.doesNotThrow(()=>assertDirectoryReady(applyDirectoryPolicy({...base,workspacePool:{},workspace:{id:'demo-0'}})));});

test('directory policy fingerprints retain the original administrator ceiling after readonly clamping',()=>{const full=applyDirectoryPolicy(base),read=applyDirectoryPolicy({...base,approvalMode:'read-only'});assert.equal(full.approvalMode,read.approvalMode);assert.notEqual(executionFingerprint(full),executionFingerprint(read));});

test('directory policy parses quoted TOML keys and every CLI config argument form',()=>{
 const overrides=[' "sandbox_mode" = "danger-full-access"',"'sandbox_mode'=danger-full-access",'"permissions" . "unsafe" = {filesystem={":root"="write"} }',' "projects"."/source".trust_level="trusted"','"mcp_servers".external.command="sh"','"hooks"={}','"notify"=["sh","-c","touch /source/escape"]','"features".hooks=true','default_permissions="unsafe"','profile="unsafe"','sandbox_permissions=["disk-full-write-access"]','shell_environment_policy.inherit="all"','model="safe"\n"approval_policy"="never"'];
 for(const override of overrides)for(const extra of [['-c',override],['--config',override],['--config='+override],['-c'+override],['-c='+override]]){
  const config=applyDirectoryPolicy({...base,hermesExecution:{variables:{cli:'codex',model:'fixture',reasoningEffort:'low',speed:''},template:{...defaultHermesTemplates.codex,args:[...defaultHermesTemplates.codex.args,...extra]}}});
  assert.throws(()=>hermesCommand(config),/directory policy conflict/,JSON.stringify(extra));
 }
});
test('directory policy rejects alternate profile, hook trust and feature flags including resume fragments',()=>{
 for(const extra of [['--ask-for-approval=on-request'],['-aon-request'],['--dangerously-bypass-hook-trust'],['--enable','hooks'],['--enable=hooks'],['--disable','shell_tool'],['--ignore-rules'],['--worktree'],['-punsafe'],['--profile=unsafe'],['-sworkspace-write']]){
  const template={...defaultHermesTemplates.codex,resumeArgs:['resume','{{sessionId}}',...extra]};
  const config=applyDirectoryPolicy({...base,hermesExecution:{variables:{cli:'codex',model:'fixture',reasoningEffort:'low',speed:''},template}});
  assert.throws(()=>hermesCommand(config,{threadId:'fixture-session'}),/directory policy conflict/);
 }
});
test('directory policy preserves ordinary model instructions and service tier overrides',()=>{
 const extra=['-c','developer_instructions="sandbox_mode=unsafe is only quoted instructional text"','--config=model=fixture','-cservice_tier=fast','--config','model_reasoning_effort="high"'];
 const config=applyDirectoryPolicy({...base,hermesExecution:{variables:{cli:'codex',model:'fixture',reasoningEffort:'low',speed:''},template:{...defaultHermesTemplates.codex,args:[...defaultHermesTemplates.codex.args,...extra]}}});
 assert.deepEqual(hermesCommand(config).args.slice(-extra.length),extra);
});
