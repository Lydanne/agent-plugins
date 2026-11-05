import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,realpath,rm,chmod,access,readFile,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {applyDirectoryPolicy} from './directory-policy.mjs';
import {prepareDirectoryInvocation} from './directory-sandbox.mjs';
import {parse} from 'smol-toml';
import {hermesCommand} from './hermes-templates.mjs';
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'worker-directory-test-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'projects/demo'),cwd=join(root,'workspace/demo-0'),state=join(root,'state'),home=join(root,'codex');for(const path of [source,cwd,state,home])await mkdir(path,{recursive:true});
 execFileSync('git',['init','-b','main',cwd],{stdio:'ignore'});
 const cli=join(root,'cli');await writeFile(cli,'#!/bin/sh\necho "CONFIG_PROFILE_V2 --strict-config"\n');await chmod(cli,0o700);
 return {root,source,state,home,cwd,cli,config:{cli,cwd,state,codexHome:home,model:'fixture',reasoningEffort:'low',executorInstructions:'fixture',projectContext:{root,cwd},workspace:{id:'demo-0'},approvalMode:'dangerously-bypass-approvals-and-sandbox'}};
}
const inspectConfig=async()=>({layers:[],hookInventory:{data:[{hooks:[],errors:[]}]}});
const prepare=(config,options={})=>prepareDirectoryInvocation(config,hermesCommand(config),{inspectConfig,...options});
test('native profile preserves administrator ceilings and is private and temporary',async t=>{
 const f=await fixture(t);for(const approvalMode of ['read-only','workspace-write','dangerously-bypass-approvals-and-sandbox']){
  const config=applyDirectoryPolicy({...f.config,approvalMode}),wrapped=await prepare(config),path=join(f.home,wrapped.config.directoryPermissionProfile+'.config.toml');
  try{const policy=parse(await readFile(path,'utf8')),profile=policy.permissions[policy.default_permissions];assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(profile.filesystem[f.cwd],approvalMode==='read-only'?undefined:'write');assert.equal(profile.network.enabled,approvalMode==='dangerously-bypass-approvals-and-sandbox');assert.equal(profile.filesystem[f.home],undefined);assert.equal(wrapped.env.CODEX_HOME,f.home);assert.deepEqual(wrapped.invocation.args.slice(0,2),['-p',policy.default_permissions]);assert(wrapped.invocation.args.includes('--strict-config'));}finally{await wrapped.cleanup();}await assert.rejects(access(path));await assert.rejects(access(wrapped.env.TMPDIR));
 }
});
test('readonly source keeps authorized network without writable source or runtime home',async t=>{
 const f=await fixture(t),config=applyDirectoryPolicy({...f.config,cwd:f.source,workspace:undefined}),wrapped=await prepare(config);
 try{const profile=wrapped.config.directoryPermissionConfig.permissions[wrapped.config.directoryPermissionProfile];assert.equal(profile.network.enabled,true);assert.equal(profile.filesystem[f.source],undefined);assert.equal(profile.filesystem[f.home],undefined);assert.equal(config.approvalMode,'read-only');}finally{await wrapped.cleanup();}
});
test('runtime overlap, writable bootstrap PATH, custom wrappers and old CLI fail closed',async t=>{
 const f=await fixture(t),config=applyDirectoryPolicy(f.config);
 for(const patch of [{state:f.source},{codexHome:f.root},{codexHome:join(f.cwd,'home')},{state:f.cwd}])await assert.rejects(prepare({...config,...patch}),/outside shared projects/);
 await assert.rejects(prepare(config,{env:{PATH:f.cwd+':'+process.env.PATH}}),/PATH overlaps/);
 await assert.rejects(prepareDirectoryInvocation(config,{...hermesCommand(config),command:'/bin/sh'},{inspectConfig}),/custom wrapper/);
 await writeFile(f.cli,'#!/bin/sh\necho old\n');await assert.rejects(prepare(config),/does not support/);
});
test('refresh has no write roots or command network',async t=>{
 const f=await fixture(t),wrapped=await prepare(applyDirectoryPolicy(f.config),{refresh:true});try{const profile=wrapped.config.directoryPermissionConfig.permissions[wrapped.config.directoryPermissionProfile];assert.equal(profile.network.enabled,false);assert(!Object.values(profile.filesystem).includes('write'));}finally{await wrapped.cleanup();}
});
test('scratch symlink and enabled hooks fail closed; expired and aborted preparation never starts',async t=>{
 const f=await fixture(t),config=applyDirectoryPolicy(f.config);
 await symlink(f.source,join(f.state,'sandbox'));await assert.rejects(prepare(config),/state path/);await rm(join(f.state,'sandbox'));
 await assert.rejects(prepare(config,{inspectConfig:async()=>({layers:[],hookInventory:{data:[{hooks:[{enabled:true}]}]}})}),/hooks/);
 await assert.rejects(prepare(config,{deadline:Date.now()-1}),{code:'EXECUTION_TIMEOUT'});
 const controller=new AbortController();controller.abort();await assert.rejects(prepare(config,{signal:controller.signal}),{name:'AbortError'});
});
