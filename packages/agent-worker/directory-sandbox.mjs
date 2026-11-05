import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,realpath,rm,readFile,writeFile,unlink,lstat} from 'node:fs/promises';
import {isAbsolute,join,relative,dirname,basename,resolve,delimiter} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse,stringify} from 'smol-toml';
import {sharedHardlinkReadRules} from './hardlink-read-rules.mjs';
const exec=promisify(execFile);
const within=(parent,path)=>{const rel=relative(parent,path);return !rel||!rel.startsWith('..')&&!isAbsolute(rel);};
const validModes=new Set(['read-only','workspace-write','dangerously-bypass-approvals-and-sandbox']);
const expired=()=>Object.assign(Error('Worker task execution budget exhausted during sandbox preparation'),{code:'EXECUTION_TIMEOUT'});
function budget(signal,deadline=Infinity,max=5000){signal?.throwIfAborted();const remaining=deadline-Date.now();if(remaining<=0)throw expired();return Math.max(1,Math.min(max,remaining));}
async function canonicalExecutable(command,env){
 const candidates=isAbsolute(command)?[command]:command.includes('/')?[resolve(command)]:(env.PATH??'').split(delimiter).map(dir=>join(dir,command));
 for(const candidate of candidates){try{const path=await realpath(candidate);if((await lstat(path)).isFile())return path;}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}}
 throw Error('Directory sandbox CLI is unavailable');
}
async function runtimeHome(path,disjoint){
 if(!isAbsolute(path))throw Error('Worker CODEX_HOME must be absolute');
 let ancestor=resolve(path),parts=[];
 for(;;){try{ancestor=await realpath(ancestor);break;}catch(error){if(error.code!=='ENOENT')throw error;parts.unshift(basename(ancestor));ancestor=dirname(ancestor);}}
 const candidate=join(ancestor,...parts);if(!disjoint(candidate))throw Error('Worker runtime storage must be outside shared projects');
 await mkdir(candidate,{recursive:true,mode:0o700});return realpath(candidate);
}
// Read the public effective-config API without starting a model/thread. This also
// verifies the selected CLI understands named permissions before business starts.
export async function inspectDirectoryProfile({cli,profileName,cwd,env,signal,deadline}){
 const timeout=budget(signal,deadline,10000);
 return new Promise((resolveResult,reject)=>{
  const child=spawn(cli,['app-server','--stdio'],{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});let buffer='',bytes=0,settled=false,configuration;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);try{process.kill(-child.pid,'SIGKILL');}catch{};error?reject(error):resolveResult(value);};
  const abort=()=>finish(signal.reason??Error('Worker sandbox preparation cancelled'));
  const timer=setTimeout(()=>finish(deadline<=Date.now()?expired():Error('Codex directory profile inspection timed out')),timeout);
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  child.stdin.on('error',()=>finish(Error('Codex directory profile inspection failed')));child.on('error',()=>finish(Error('Codex directory profile inspection failed')));child.on('close',()=>finish(Error('Codex CLI cannot load required directory permission profiles')));child.stderr.resume();
  child.stdout.on('data',part=>{bytes+=part.length;if(bytes>2*1024*1024)return finish(Error('Codex directory profile response exceeds limit'));buffer+=part;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line);if(value.error)return finish(Error('Codex CLI rejected required directory permission profiles'));if(value.id===1){send({method:'initialized'});send({id:2,method:'config/read',params:{cwd,includeLayers:true}});}if(value.id===2){configuration=value.result;send({id:3,method:'hooks/list',params:{cwds:[cwd]}});}if(value.id===3)finish(undefined,{...configuration,hookInventory:value.result});}catch{finish(Error('Codex directory profile response is invalid'));}}});
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
  send({id:1,method:'initialize',params:{clientInfo:{name:'agent-worker-directory-check',version:'1'},capabilities:{experimentalApi:true}}});
 });
}

// A fresh named configuration layer is private, exclusive and removed after the
// turn. It preserves auth/session CODEX_HOME and ordinary provider configuration,
// without overwriting config.toml or placing provider secrets into process argv.
export async function prepareDirectoryInvocation(config,invocation,{refresh=false,env=process.env,signal,deadline=Infinity,inspectConfig=inspectDirectoryProfile}={}){
 if(!config.directoryPolicy)return {invocation,config,env,cleanup:async()=>{}};
 budget(signal,deadline);
 const mode=config.directoryPolicy.originalApprovalMode??config.approvalMode;
 if(!validModes.has(mode)||!config.projectContext?.root||!config.codexHome||!config.state)throw Error('Directory sandbox requires a complete host-owned execution binding');
 const agentRoot=await realpath(config.projectContext.root),sourceRoot=await realpath(join(agentRoot,'projects')),cwd=await realpath(config.cwd),state=await realpath(config.state);
 let workspaceRoot=join(agentRoot,'workspace');try{if(await realpath(workspaceRoot)!==workspaceRoot)throw Error('Worker workspace root must not be a symlink');}catch(error){if(error.code!=='ENOENT')throw error;}
 const disjoint=path=>![sourceRoot,workspaceRoot].some(root=>within(root,path)||within(path,root));
 if(!disjoint(state))throw Error('Worker runtime storage must be outside shared projects');
 const home=await runtimeHome(config.codexHome,disjoint);
 // Loader variables execute before native sandbox startup, so they cannot be
 // inherited into the trusted bootstrap (including local MCP wrappers).
 const loaderKey=key=>/^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LD_.*|DYLD_.*|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB)$/.test(key);
 env=Object.fromEntries(Object.entries(env).filter(([key])=>!loaderKey(key)));
 const cli=await canonicalExecutable(config.cli,env);
 const workspace=config.directoryPolicy.mode==='workspace';
 if(await canonicalExecutable(invocation.command,env)!==cli)throw Error('Directory policy requires the verified Codex executable, not a custom wrapper');
 for(const directory of (env.PATH??'').split(delimiter)){if(!isAbsolute(directory))throw Error('Directory sandbox requires an absolute trusted executable PATH');let actual=resolve(directory),suffix=[];for(;;){try{actual=join(await realpath(actual),...suffix);break;}catch(error){if(error.code!=='ENOENT')throw error;suffix.unshift(basename(actual));actual=dirname(actual);}}if(within(workspaceRoot,actual)||within(home,actual))throw Error('Directory sandbox executable PATH overlaps a writable task or runtime directory');}
 if(workspace&&(!config.workspace||!within(join(agentRoot,'workspace'),cwd)||cwd===join(agentRoot,'workspace')||within(sourceRoot,cwd)||within(cwd,sourceRoot)))throw Error('Directory sandbox requires an allocated independent workspace');
 if(!workspace&&!within(sourceRoot,cwd))throw Error('Read-only execution must stay inside shared projects');
 if(within(workspaceRoot,cli)||within(home,cli))throw Error('Directory sandbox CLI cannot be stored in a writable task or runtime directory');
 let help;try{help=(await exec(cli,['exec','--help'],{timeout:budget(signal,deadline),signal,maxBuffer:128*1024,env})).stdout;}catch(error){budget(signal,deadline);throw Error('Codex CLI cannot establish the required directory sandbox');}
 if(!help.includes('CONFIG_PROFILE_V2')||!help.includes('--strict-config'))throw Error('Codex CLI does not support required directory permission profiles');
 let userConfig={};try{const file=await readFile(join(home,'config.toml'),'utf8');if(Buffer.byteLength(file)>1024*1024)throw Error();userConfig=parse(file);}catch(error){if(error.code!=='ENOENT')throw Error('Codex user configuration cannot be safely prepared');}
 if(userConfig.notify?.length)throw Error('Codex notification commands require sandbox support before Worker execution');
 if(userConfig.profile!==undefined)throw Error('Select a directly configured Codex provider before enabling Worker directory profiles');
 const networkAllowed=mode==='dangerously-bypass-approvals-and-sandbox'||mode==='workspace-write'&&userConfig.sandbox_workspace_write?.network_access===true;
 // No sandbox/profile selector from the copied user layer may override host policy.
 for(const key of ['sandbox_mode','sandbox_workspace_write','sandbox_read_only','default_permissions','profile'])delete userConfig[key];
 const name='worker_'+randomUUID().replaceAll('-',''),profilePath=join(home,name+'.config.toml');
 let scratch,profileIdentity;
 const cleanup=async()=>{if(profileIdentity){try{const current=await lstat(profilePath);if(current.dev===profileIdentity.dev&&current.ino===profileIdentity.ino)await unlink(profilePath);}catch(error){if(error.code!=='ENOENT')throw error;}}if(scratch)await rm(scratch,{recursive:true,force:true});};
 try{
  const sandboxRoot=join(state,'sandbox');await mkdir(sandboxRoot,{recursive:true,mode:0o700});if(await realpath(sandboxRoot)!==sandboxRoot||!disjoint(sandboxRoot))throw Error('Worker sandbox state path changed or overlaps shared projects');
  scratch=await mkdtemp(join(sandboxRoot,'turn-'));if(await realpath(scratch)!==scratch||!disjoint(scratch))throw Error('Worker sandbox scratch path changed');
  const filesystem={':root':'read',[sourceRoot]:'read'};
  if(!refresh&&mode!=='read-only')filesystem[scratch]='write';
  if(workspace&&!refresh&&mode!=='read-only'){
   filesystem[cwd]='write';
   for(const repo of config.workspacePool?.repositories??[{path:'.'}]){
    budget(signal,deadline);const root=repo.path==='.'?cwd:join(cwd,repo.path);if(!within(cwd,root))throw Error('Workspace repository escaped allocated directory');
    const {stdout}=await exec('git',['rev-parse','--absolute-git-dir'],{cwd:root,timeout:budget(signal,deadline),signal,env});const gitDir=await realpath(stdout.trim());if(!within(cwd,gitDir))throw Error('Workspace Git metadata escaped allocated directory');filesystem[gitDir]=mode==='dangerously-bypass-approvals-and-sandbox'?'write':'read';
   }
  }
  Object.assign(filesystem,await sharedHardlinkReadRules(Object.entries(filesystem).filter(([,access])=>access==='write').map(([path])=>path),{signal,deadline}));
  const profile={filesystem,network:{enabled:!refresh&&networkAllowed}};
  userConfig.default_permissions=name;userConfig.permissions={...(userConfig.permissions??{}),[name]:profile};userConfig.approval_policy='never';
  // A repository's local config is reference material, not execution authority.
  userConfig.projects={...(userConfig.projects??{}),[cwd]:{trust_level:'untrusted'}};
  // Local MCP commands do not inherit native tool sandboxes. Apply the same public
  // profile to those separate process trees; remote MCP stays host-authorized.
  if(userConfig.mcp_servers)for(const server of Object.values(userConfig.mcp_servers))if(typeof server.command==='string'){
   const command=server.command,args=server.args??[];if(!Array.isArray(args)||!args.every(arg=>typeof arg==='string'))throw Error('Invalid local MCP configuration');
   for(const key of Object.keys(server.env??{}))if(loaderKey(key)||['PATH','CODEX_HOME'].includes(key))throw Error('Local MCP bootstrap environment conflicts with Worker directory isolation');
   if((server.env_vars??[]).some(key=>loaderKey(key)||['PATH','CODEX_HOME'].includes(key)))throw Error('Local MCP inherited environment conflicts with Worker directory isolation');
   server.env={...(server.env??{}),PATH:env.PATH,CODEX_HOME:home};
   server.command=cli;server.args=['sandbox','--include-managed-config','-p',name,'-P',name,'-C',cwd,'--',command,...args];
  }
  await writeFile(profilePath,stringify(userConfig),{flag:'wx',mode:0o600});profileIdentity=await lstat(profilePath);
  const nextEnv={...env,CODEX_HOME:home,TMPDIR:scratch,TMP:scratch,TEMP:scratch};
  const effective=await inspectConfig({cli,profileName:name,cwd,env:nextEnv,signal,deadline});
  if(!Array.isArray(effective?.layers))throw Error('Codex CLI cannot verify the required directory permission profile');
  for(const layer of effective.layers)if(!layer.disabledReason&&!['user','project'].includes(layer.name?.type)&&layer.config?.sandbox_mode!==undefined)throw Error('System sandbox configuration conflicts with the Worker directory profile');
  for(const layer of effective.layers)if(!layer.disabledReason&&!['user','project'].includes(layer.name?.type)&&Object.values(layer.config?.mcp_servers??{}).some(server=>server?.command))throw Error('System local MCP commands require explicit Worker sandbox integration');
  if(effective.layers.some(layer=>!layer.disabledReason&&layer.config?.notify?.length))throw Error('Codex notification commands require sandbox support before Worker execution');
  const hookData=effective.hookInventory?.data;if(!Array.isArray(hookData)||hookData.some(item=>item.errors?.length||item.hooks?.some(hook=>hook.enabled)))throw Error('Enabled or unverified Codex hooks require sandbox support before Worker execution');
  // Any writable-root/profile injection in templates was rejected by hermesCommand.
  const args=[...invocation.args];
  if(invocation.adapter==='codex-jsonl'){
   const at=args.indexOf('--sandbox');if(at>=0)args.splice(at,2);const bypass=args.indexOf('--dangerously-bypass-approvals-and-sandbox');if(bypass>=0)args.splice(bypass,1);
   const execAt=args.indexOf('exec');if(execAt<0)throw Error('Directory policy requires a standard Codex exec template');args.splice(execAt+1,0,'--strict-config');
  }
  budget(signal,deadline);
  return {invocation:{...invocation,command:cli,args:invocation.adapter==='codex-jsonl'?['-p',name,...args]:args},config:{...config,directoryPermissionProfile:name,directoryPermissionConfig:userConfig},env:nextEnv,cleanup};
 }catch(error){await cleanup();throw error;}
}
