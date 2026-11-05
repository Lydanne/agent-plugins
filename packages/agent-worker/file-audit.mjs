import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {readFile,writeFile,rename,mkdtemp,rm,lstat,realpath} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
const exec=promisify(execFile);
const MAX_FILES=100,MAX_FILE=256*1024,MAX_TOTAL=2*1024*1024;
async function git(cwd,args){return (await exec('git',['--no-optional-locks','-c','core.quotePath=false','-c','core.fsmonitor=false',...args],{cwd,encoding:'buffer',timeout:10000,maxBuffer:4*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_LITERAL_PATHSPECS:'1'}})).stdout;}
const text=buffer=>buffer.toString('utf8');
async function optional(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function save(file,value){const temp=file+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,file);}
async function paths(cwd,base){const changed=text(await git(cwd,['diff','--no-renames','--name-only','-z','--no-ext-diff','--no-textconv',base,'--'])).split('\0');const untracked=text(await git(cwd,['ls-files','--others','--exclude-standard','-z'])).split('\0');return [...new Set([...changed,...untracked].filter(Boolean))];}
async function working(cwd,path){
 const target=resolve(cwd,path);if(!target.startsWith(cwd+sep))return {omitted:'路径超出仓库'};
 try{const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink())return {omitted:'符号链接、子模块或特殊文件不读取内容'};
 if(!(await realpath(target)).startsWith(cwd+sep))return {omitted:'路径超出仓库'};
 if(info.size>MAX_FILE)return {omitted:'文件超过 256 KiB'};
 const data=await readFile(target);if(data.length>MAX_FILE)return {omitted:'文件超过 256 KiB'};
 return {data:data.toString('base64'),mode:info.mode&0o111?'100755':'100644'};
 }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function committed(cwd,base,path){
 const entry=text(await git(cwd,['ls-tree','-z',base,'--',path]));if(!entry)return null;
 const mode=entry.slice(0,6);if(!['100644','100755'].includes(mode))return {omitted:'符号链接或子模块不读取内容'};
 const object=entry.split('\t')[0].split(' ')[2];
 if(Number(text(await git(cwd,['cat-file','-s',object])))>MAX_FILE)return {omitted:'文件超过 256 KiB'};
 return {data:(await git(cwd,['cat-file','blob',object])).toString('base64'),mode};
}
async function patch(before,after){
 const dir=await mkdtemp(join(tmpdir(),'worker-audit-'));
 try{await writeFile(join(dir,'before'),before,{mode:0o600});await writeFile(join(dir,'after'),after,{mode:0o600});
 try{return text(await git(dir,['diff','--no-index','--no-ext-diff','--no-textconv','--no-color','--','before','after']));}catch(e){if(e.code===1&&e.stdout)return text(e.stdout);throw e;}
 }finally{await rm(dir,{recursive:true,force:true});}
}
async function change(path,before,after){
 if(JSON.stringify(before)===JSON.stringify(after)&&!before?.omitted)return null;
 const status=!before?'A':!after?'D':'M';
 if(before?.omitted||after?.omitted)return {path,status,notice:before?.omitted??after?.omitted};
 const a=Buffer.from(before?.data??'','base64'),b=Buffer.from(after?.data??'','base64');
 const binary=a.includes(0)||b.includes(0);
 const result={path,status,beforeHash:before?createHash('sha256').update(a).digest('hex'):undefined,afterHash:after?createHash('sha256').update(b).digest('hex'):undefined,modeChanged:!!before&&!!after&&before.mode!==after.mode,binary};
 if(binary){
 const mime=/\.png$/i.test(path)?'image/png':/\.jpe?g$/i.test(path)?'image/jpeg':/\.webp$/i.test(path)?'image/webp':null;
 if(mime){if(before)result.beforeImage=`data:${mime};base64,${before.data}`;if(after)result.afterImage=`data:${mime};base64,${after.data}`;}
 return result;
 }
 result.patch=await patch(a,b);
 const lines=result.patch.split('\n'),start=lines.findIndex(line=>line.startsWith('@@'));const body=start<0?[]:lines.slice(start+1);result.additions=body.filter(line=>line.startsWith('+')).length;result.deletions=body.filter(line=>line.startsWith('-')).length;
 return result;
}
export async function beginFileAudit({root,id,cwd,isolated=false,resumed=false}){
 const file=join(root,id+'.audit-base.json'),existing=await optional(file);if(existing)return existing.unavailable||existing.cwd===await realpath(cwd);
 if(resumed){await save(file,{version:1,unavailable:true,legacy:true,startedAt:Date.now()});return true;}
 try{
 if(!cwd)throw Error('missing cwd');
 const directory=await realpath(cwd),top=await realpath(text(await git(directory,['rev-parse','--show-toplevel'])).trim());
 if(top!==directory)throw Error('not repository root');
 const head=text(await git(top,['rev-parse','--verify','HEAD'])).trim(),dirty=await paths(top,head),initial=Object.create(null);let bytes=0;
 for(const path of dirty.slice(0,MAX_FILES)){const value=await working(top,path);bytes+=value?.data?.length??0;initial[path]=bytes<=MAX_TOTAL?value:{omitted:'基线内容超过预算'};}
 await save(file,{version:1,cwd:top,head,isolated,startedAt:Date.now(),initial,truncated:dirty.length>MAX_FILES||bytes>MAX_TOTAL});
 }catch{await save(file,{version:1,unavailable:true,startedAt:Date.now()});}
 return true;
}
function renames(files){
 const consumed=new Set();
 for(const added of files.filter(file=>file.status==='A'&&file.afterHash)){const removed=files.find(file=>file.status==='D'&&file.beforeHash===added.afterHash&&!consumed.has(file));if(removed){added.status='R';added.previousPath=removed.path;added.patch='';added.additions=0;added.deletions=0;if(removed.beforeImage)added.beforeImage=removed.beforeImage;consumed.add(removed);}}
 return files.filter(file=>!consumed.has(file)).map(({beforeHash,afterHash,...file})=>file);
}
export async function captureFileAudit({root,id,final=false}){
 const base=await optional(join(root,id+'.audit-base.json'));if(!base)return;
 const file=join(root,id+'.audit.json');
 if(base.unavailable){await save(file,{version:1,available:false,final,capturedAt:Date.now(),notice:base.legacy?'此任务开始时未记录审计基线，恢复执行时不倒推历史改动。':'执行目录不是有提交的 Git 仓库，无法建立审计基线。'});return;}
 try{
 const deadline=Date.now()+10000;
 const head=text(await git(base.cwd,['rev-parse','--verify','HEAD'])).trim();
 const cumulative=await paths(base.cwd,base.head),pending=await paths(base.cwd,head);
 const candidates=[...new Set([...cumulative,...pending,...Object.keys(base.initial)])];
 const files=[],uncommitted=[];let bytes=0,truncated=base.truncated||candidates.length>MAX_FILES;
 for(const path of candidates.slice(0,MAX_FILES)){
 if(Date.now()>deadline){truncated=true;break;}
 const after=await working(base.cwd,path),before=Object.hasOwn(base.initial,path)?base.initial[path]:await committed(base.cwd,base.head,path);
 const total=await change(path,before,after),current=pending.includes(path)?await change(path,await committed(base.cwd,head,path),after):null;
 bytes+=JSON.stringify([total,current]).length;if(bytes>MAX_TOTAL){truncated=true;break;}
 if(total)files.push(total);if(current)uncommitted.push(current);
 }
 const commits=text(await git(base.cwd,['log','--max-count=50','--format=%h %s',base.head+'..'+head,'--'])).trim().split('\n').filter(Boolean);
 await save(file,{version:1,available:true,startedAt:base.startedAt,capturedAt:Date.now(),final,base:base.head,head,isolated:base.isolated,truncated,files:renames(files),uncommitted:renames(uncommitted),commits});
 }catch{
 const previous=await optional(file);await save(file,{...(previous??{version:1,available:false}),final,stale:true,notice:'本次采集失败；保留上次快照，不能据此确认最终变更。'});
 }
}
export async function readFileAudit(root,id){return await optional(join(root,id+'.audit.json'))??{available:false,notice:'此任务尚未记录文件审计；旧任务不会从当前工作区补算。'};}
