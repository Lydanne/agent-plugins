import {realpath} from 'node:fs/promises';
import {relative,posix} from 'node:path';
import {parse as yaml} from 'yaml';
import {parse as toml} from 'smol-toml';
import {parse as jsonc} from 'jsonc-parser';
import {git} from './repository-skills.mjs';
import {containedPath} from './repositories.mjs';
const directories=['.agents/agents','.codex/agents','.opencode/agents','.opencode/agent'];
const configs=['.codex/config.toml','.opencode/opencode.json','.opencode/opencode.jsonc'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=600)=>typeof value==='string'?value.slice(0,max):'';
const conditions={agent:'此 Agent 的所有项目可查看；实际调用由执行器配置决定。',project:'选择当前项目时可查看；当前子仓库继承此定义。',repository:'仅选择此子仓库时可查看；不包含兄弟仓库或其他项目。'};
function markdown(body){
 const match=body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
 const metadata=match?yaml(match[1],{maxAliasCount:20})??{}:{};
 if(!object(metadata))throw Error('Invalid metadata');
 const content=match?body.slice(match[0].length):body;
 return {...metadata,description:metadata.description??content.replace(/^#.*\n/gm,'').trim().split(/\r?\n\s*\r?\n/)[0]};
}
function entry(metadata,provider,name,path,kind){
 if(!object(metadata)||typeof name!=='string'||!name.trim()||name.length>160||/[\u0000\r\n]/.test(name))throw Error('Invalid definition');
 const mode=provider==='opencode'?(metadata.mode??'all'):'subagent';
 if(provider==='opencode'&&!['primary','subagent','all'].includes(mode))throw Error('Invalid mode');
 if(mode==='primary')return null;
 return {name,provider,path,source:kind,description:text(metadata.description),model:text(metadata.model,160),reasoningEffort:text(metadata.model_reasoning_effort,80),mode,definitionPath:text(metadata.definitionPath,1024),hidden:metadata.hidden===true,disabledReason:metadata.disable===true?'定义已禁用':null,appliesWhen:conditions[kind]};
}
export async function readSubagentSource(root,agentRoot,kind){
 const canonical=await realpath(root);
 if(await realpath((await git(root,['rev-parse','--show-toplevel'])).trim())!==canonical)throw Error('Not a Git root');
 const head=(await git(root,['rev-parse','HEAD'])).trim(),warnings=[],entries=[];
 const tree=(await git(root,['ls-tree','-r','-z',head,'--',...directories,...configs])).split('\0').filter(Boolean);
 if(tree.length>2000)throw Error('Subagent catalog too large');
 const rows=tree.map(row=>{const [metadata,path]=row.split('\t');const [mode,type,oid]=metadata.split(' ');return {mode,type,oid,path};}),byPath=new Map(rows.map(row=>[row.path,row]));
 const warn=path=>warnings.push(path+' · 无法读取此定义；检查格式、已提交版本及普通文件路径。');
 const blocked=new Set();
 for(const directory of directories){try{if(await containedPath(canonical,directory)!==canonical+'/'+directory)throw Error('Linked directory');}catch{blocked.add(directory);warn(directory);}}
 async function read(path){
  const row=byPath.get(path);
  if(!row||row.type!=='blob'||!['100644','100755'].includes(row.mode)||await containedPath(canonical,path)!==canonical+'/'+path)throw Error('Invalid file');
  const body=await git(root,['show',head+':'+path]);if(Buffer.byteLength(body)>256*1024)throw Error('Definition too large');return body;
 }
 async function add(metadata,provider,name,path,versionPaths=[path]){
  const value=entry(metadata,provider,name,relative(agentRoot,canonical+'/'+path),kind);if(!value)return;
  const [updatedAt,updatedCommit]=(await git(root,['log',head,'-1','--format=%cI%x00%H','--',...versionPaths.map(path=>':(literal)'+path)])).trim().split('\0');
  entries.push({...value,updatedAt:updatedAt||null,updatedCommit:updatedCommit||null});
 }
 const parsedConfigs=new Map(),referenced=new Set();
 for(const path of configs){
  if(!byPath.has(path))continue;
  try{
   const body=await read(path),errors=[],config=path.endsWith('.toml')?toml(body):jsonc(body,errors,{allowTrailingComma:true});
   if(errors.length||!object(config))throw Error('Invalid config');parsedConfigs.set(path,config);
   if(path==='.codex/config.toml'&&object(config.agents))for(const definition of Object.values(config.agents)){
    if(!object(definition)||typeof definition.config_file!=='string'||definition.config_file.startsWith('/')||/[\\\u0000\r\n]/.test(definition.config_file))continue;
    const target=posix.normalize(posix.join('.codex',definition.config_file));if(target.startsWith('.codex/')&&target.endsWith('.toml'))referenced.add(target);
   }
  }catch{warn(path);}
 }
 for(const row of rows){
  const dir=directories.find(dir=>row.path.startsWith(dir+'/'));
  if(!dir||blocked.has(dir)||row.path.slice(dir.length+1).split('/').length>6||/(?:^|\/)README\.md$/i.test(row.path))continue;
  const provider=dir.startsWith('.codex')?'codex':dir.startsWith('.opencode')?'opencode':'agents',extension=provider==='codex'?'.toml':'.md';
  if(!row.path.endsWith(extension))continue;
  if(provider==='codex'&&referenced.has(row.path))continue;
  try{const body=await read(row.path),metadata=provider==='codex'?toml(body):markdown(body);if(provider==='codex'&&!metadata.name)throw Error('Missing native agent name');await add(metadata,provider,provider==='opencode'?posix.basename(row.path,extension):metadata.name??posix.basename(row.path,extension),row.path);}catch{warn(row.path);}
 }
 for(const path of configs){
  if(!parsedConfigs.has(path))continue;
  try{
   const config=parsedConfigs.get(path);
   const provider=path.startsWith('.codex')?'codex':'opencode',definitions=provider==='codex'?config.agents:config.agent;
   if(definitions===undefined)continue;if(!object(definitions)||Object.keys(definitions).length>500)throw Error('Invalid definitions');
   for(const [name,definition] of Object.entries(definitions)){
    // Codex [agents] also contains scalar concurrency settings, not roles.
    if(!object(definition)){if(provider==='opencode')warn(path);continue;}
    try{
     let metadata=definition,versionPaths=[path];
     if(provider==='codex'&&definition.config_file!==undefined){
      const file=definition.config_file;
      if(typeof file!=='string'||!file||file.startsWith('/')||/[\\\u0000\r\n]/.test(file))throw Error('Invalid config reference');
      const target=posix.normalize(posix.join(posix.dirname(path),file));
      if(!target.startsWith('.codex/')||!target.endsWith('.toml'))throw Error('Config reference outside .codex');
      // Only the same repository's committed ordinary files may be referenced.
      if(!byPath.has(target)){
       const raw=(await git(root,['ls-tree',head,'--',':(literal)'+target])).trim();
       if(!/^100(?:644|755) blob [a-f0-9]+\t/.test(raw))throw Error('Missing config reference');
       const [meta,p]=raw.split('\t'),[mode,type,oid]=meta.split(' ');byPath.set(p,{mode,type,oid,path:p});
      }
      metadata={...toml(await read(target)),...definition};metadata.definitionPath=relative(agentRoot,canonical+'/'+target);versionPaths.push(target);
     }
     await add(metadata,provider,name,path,versionPaths);
    }catch{warn(path+' ['+name+']');}
   }
  }catch{warn(path);}
 }
 const counts=new Map();for(const value of entries){const key=value.provider+'\0'+value.name;counts.set(key,(counts.get(key)??0)+1);}
 for(const value of entries)if(counts.get(value.provider+'\0'+value.name)>1)value.disabledReason='同一来源有重复定义；需核对执行器配置';
 const dirty=!!(await git(root,['status','--porcelain=v1','--untracked-files=all','--',...directories,...configs,...[...byPath.keys()]] )).trim();
 if((await git(root,['rev-parse','HEAD'])).trim()!==head)throw Error('Repository changed during scan');
 return {source:kind,repository:relative(agentRoot,canonical)||null,head,state:dirty?'dirty':'available',subagents:entries,warnings};
}
export async function subagentInventory(root,agentRoot,kind){
 try{return await readSubagentSource(root,agentRoot,kind);}catch{return {source:kind,repository:relative(agentRoot,root)||null,state:'unavailable',subagents:[],warnings:['无法读取此范围的已提交子代理定义。']};}
}
export function resolveSubagentCatalog(sources){
 const effective=new Map(),key=value=>value.provider+'\0'+value.name;
 for(const source of sources)for(const value of source.subagents)if(!value.disabledReason)effective.set(key(value),value);
 for(const source of sources)for(const value of source.subagents){value.status=value.disabledReason?'disabled':effective.get(key(value))!==value?'shadowed':source.state==='dirty'?'pending_commit':'candidate';if(value.status==='shadowed')value.overriddenBy=effective.get(key(value)).path;}
 return effective.size;
}
