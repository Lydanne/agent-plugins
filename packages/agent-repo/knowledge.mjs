import {lstat,realpath,opendir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,relative,isAbsolute,sep,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {parseDocument} from 'yaml';
import MarkdownIt from 'markdown-it';
export const knowledgeActions=['knowledge_list','knowledge_search','knowledge_read','knowledge_validate','knowledge_graph'];
export const knowledgeParameters={path:{type:'string',maxLength:512,description:'知识目录内的相对 Markdown 路径，不能是绝对路径'},uid:{type:'string',maxLength:320,description:'所配置元数据命名空间内的稳定 UID'},startLine:{type:'integer',minimum:1},maxLines:{type:'integer',minimum:1,maximum:200}};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const inside=(r,p)=>{const x=relative(r,p);return x===''||(!isAbsolute(x)&&x!=='..'&&!x.startsWith('..'+sep));};
const hash=s=>createHash('sha256').update(s).digest('hex');
function fail(code){throw Object.assign(Error(code),{code});}
const baseExcluded=['.git','.agents','.opencode','.codex','.tmp','node_modules','__pycache__'];
const namespace=v=>typeof v==='string'&&/^x_[a-z][a-z0-9_]{0,61}$/.test(v);
export async function safeRead(root,path,max=262144) {
 const target=resolve(root,path);if(!inside(root,target))fail('KNOWLEDGE_PATH_DENIED');
 for(let cur=target;cur!==root;cur=dirname(cur)){const s=await lstat(cur);if(s.isSymbolicLink()||(cur===target&&!s.isFile()))fail('KNOWLEDGE_PATH_DENIED');}
 const f=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const s=await f.stat();if(!s.isFile()||s.nlink!==1)fail('KNOWLEDGE_PATH_DENIED');if(s.size>max)fail('KNOWLEDGE_FILE_LIMIT');
  const b=Buffer.alloc(max+1);let n=0;
  while(n<b.length){const r=await f.read(b,n,b.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}
  if(n>max)fail('KNOWLEDGE_FILE_LIMIT');
  const after=await f.stat();if(s.size!==after.size||s.mtimeMs!==after.mtimeMs||await realpath(target)!==target)fail('KNOWLEDGE_CHANGED');
  return new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,n));
 }finally{await f.close();}
}
async function optionalJson(root,path) {
 try{const v=JSON.parse(await safeRead(root,path,65536));if(!object(v))fail('KNOWLEDGE_CONFIG_INVALID');return v;}
 catch(e){if(e.code==='ENOENT')return undefined;fail('KNOWLEDGE_CONFIG_INVALID');}
}
/** Namespace is explicit project configuration, then Bundle declaration, then default. Never infer from document fields. */
export async function resolveKnowledgeConfig(projectRoot,knowledgeRoot,defaults) {
 const project=await realpath(projectRoot),root=knowledgeRoot?await realpath(knowledgeRoot).catch(e=>{if(e.code==='ENOENT')return resolve(project,relative(resolve(projectRoot),resolve(knowledgeRoot)));throw e;}):resolve(project,'wiki');
 if(!inside(project,root))fail('KNOWLEDGE_PATH_DENIED');
 const p=await optionalJson(project,'project.json'),b=await optionalJson(root,'bundle.json');
 const configured=p?.knowledge?.metadata_namespace,declared=b?.metadata_namespace,global=defaults?.metadataNamespace;
 if(configured!==undefined&&!namespace(configured)||declared!==undefined&&!namespace(declared)||global!==undefined&&!namespace(global))fail('KNOWLEDGE_NAMESPACE_INVALID');
 const excluded=new Set(baseExcluded);
 if(b?.exclude_directories!==undefined){if(!Array.isArray(b.exclude_directories)||b.exclude_directories.length>50||b.exclude_directories.some(v=>typeof v!=='string'||!v||v==='.'||v==='..'||/[\\/\u0000]/.test(v)))fail('KNOWLEDGE_CONFIG_INVALID');for(const v of b.exclude_directories)excluded.add(v);}
 return {root,defaultMetadataNamespace:global??'x_agent',metadataNamespace:configured??declared??global??'x_agent',namespaceSource:configured!==undefined?'project.json':declared!==undefined?'bundle.json':global!==undefined?'global':'default',normalized:b!==undefined,bundle:b,excluded:[...excluded]};
}
function visible(text){let fence=null;return text.split(/\r?\n/).map(line=>{const m=/^\s{0,3}(`{3,}|~{3,})/.exec(line);if(m){if(!fence)fence=m[1];else if(m[1][0]===fence[0]&&m[1].length>=fence.length)fence=null;return '';}return fence?'':line.replace(/`[^`]*`/g,'');}).join('\n');}
export function document(path,text,ns) {
 let meta={},body=text,parseError=false;
 if(/^---\r?\n/.test(text)){
  const m=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if(!m)parseError=true;
  else try{const parsed=parseDocument(m[1],{uniqueKeys:true});if(parsed.errors.length||parsed.warnings.length)throw Error();meta=parsed.toJS({maxAliasCount:20});if(!object(meta))throw Error();body=text.slice(m[0].length);}catch{parseError=true;}
 }
 const x=object(meta?.[ns])?meta[ns]:{},title=typeof meta.title==='string'?meta.title.slice(0,320):(/^#\s+(.+)$/m.exec(body)?.[1]??basename(path,'.md')).slice(0,320);
 return {path,text,body,meta,x,title,uid:typeof x.uid==='string'&&x.uid.length>0&&x.uid.length<=320?x.uid:undefined,parseError,sha256:hash(text)};
}
function integer(v,defaultValue,min,max){if(v===undefined)return defaultValue;if(!Number.isSafeInteger(v)||v<min||v>max)fail('KNOWLEDGE_ARGUMENT_INVALID');return v;}
async function scan(config) {
 const {root}=config,docs=[],issues=[];let count=0,dirs=0,bytes=0,visited=0,complete=true;
 try{if(!(await lstat(root)).isDirectory())fail('KNOWLEDGE_UNAVAILABLE');}catch(e){if(e.code==='ENOENT')return {available:false,docs,issues,complete:false};throw e;}
 async function walk(dir){
  if(++dirs>4000){complete=false;return;}
  const entries=[];for await(const e of await opendir(dir)){entries.push(e);if(entries.length>10000){complete=false;break;}}
  entries.sort((a,b)=>a.name.localeCompare(b.name,'en'));
  for(const e of entries){if(++visited>10000){complete=false;return;}if(config.excluded.includes(e.name))continue;
   const path=resolve(dir,e.name),rel=relative(root,path).split(sep).join('/');
   if(rel.length>512){issues.push({path:rel.slice(0,512),code:'path_limit'});complete=false;continue;}
   if(e.isSymbolicLink()){issues.push({path:rel,code:'symlink_skipped'});complete=false;continue;}
   if(e.isDirectory()){await walk(path);if(visited>10000||dirs>4000||count>2000||bytes>16777216)return;continue;}
   if(!e.name.endsWith('.md'))continue;
   if(!e.isFile()){issues.push({path:rel,code:'not_regular'});complete=false;continue;}
   if(++count>2000){complete=false;return;}
   try{const text=await safeRead(root,rel);bytes+=Buffer.byteLength(text);if(bytes>16777216){complete=false;return;}docs.push(document(rel,text,config.metadataNamespace));}
   catch(error){issues.push({path:rel,code:['KNOWLEDGE_PATH_DENIED','KNOWLEDGE_FILE_LIMIT','KNOWLEDGE_CHANGED'].includes(error.code)?error.code:'unreadable'});complete=false;}
  }
 }
 await walk(root);
 if(visited>10000||dirs>4000||count>2000||bytes>16777216)issues.push({code:'scan_limit'});
 return {available:true,docs,issues:issues.slice(0,100),complete,revision:hash(JSON.stringify([config.metadataNamespace,config.excluded,docs.map(d=>[d.path,d.sha256])]))};
}
export const summary=d=>({path:d.path,title:d.title,...(d.uid?{uid:d.uid}:{}),...(typeof d.meta.type==='string'?{type:d.meta.type.slice(0,80)}:{}),...(typeof d.meta.status==='string'?{status:d.meta.status.slice(0,40)}:{}),...(typeof d.x.feature_id==='string'?{featureId:d.x.feature_id.slice(0,160)}:{})});
const graphMarkdown=new MarkdownIt({html:false,linkify:false,maxNesting:32});
const relationTypes=new Set(['references','part_of','depends_on','constrained_by','implements','supersedes']);
function graphPath(config,source,href){
 if(typeof href!=='string'||!href||href.startsWith('#')||href.startsWith('/')||/^[a-z][a-z\d+.-]*:/i.test(href))return null;
 let decoded;try{decoded=decodeURIComponent(href.split('#')[0]);}catch{return null;}
 if(!decoded||decoded.length>512||/[\u0000-\u001f\u007f\\?#]/.test(decoded)||isAbsolute(decoded)||/^[a-z][a-z\d+.-]*:/i.test(decoded)||!decoded.endsWith('.md'))return null;
 const path=resolve(config.root,dirname(source),decoded),rel=relative(config.root,path).split(sep).join('/');
 return inside(config.root,path)&&!rel.split('/').some(p=>config.excluded.includes(p))?rel:null;
}
export function knowledgeGraph(config,result,limit,budget={edges:1000,references:10000}){
 const docs=result.docs.slice(0,limit),nodes=docs.map(summary),paths=new Set(nodes.map(n=>n.path)),allPaths=new Set(result.docs.map(d=>d.path)),uids=new Map(),edges=[],seen=new Set();
 let references=0,unresolvedReferences=0,ignoredReferences=0,omittedEdges=0,invalidDocuments=0,referenceLimit=false;
 for(const d of result.docs)if(d.uid)uids.set(d.uid,[...(uids.get(d.uid)??[]),d.path]);
 const consume=()=>{if(++references>budget.references){referenceLimit=true;return false;}return true;};
 const add=(source,target,kind,relation)=>{
  if(source===target)return;
  const key=JSON.stringify([source,target,kind,relation]);if(seen.has(key))return;seen.add(key);
  if(!paths.has(target)||edges.length>=budget.edges){omittedEdges++;return;}
  edges.push({source,target,kind,...(relation?{relation}:{})});
 };
 function links(tokens,source){
  for(const token of tokens){
   if(referenceLimit)return;
   if(token.type==='link_open'){
    if(!consume())return;
    const target=graphPath(config,source,token.attrGet('href'));
    if(target===null)ignoredReferences++;else if(!allPaths.has(target))unresolvedReferences++;else add(source,target,'link');
   }
   if(token.children)links(token.children,source);
  }
 }
 for(const d of docs){
  if(referenceLimit)break;
  if(d.parseError){invalidDocuments++;continue;}
  links(graphMarkdown.parse(d.body,{}),d.path);
  for(const r of Array.isArray(d.x.relations)?d.x.relations:[]){
   if(!consume())break;
   if(!object(r)||!relationTypes.has(r.type)||typeof r.target_uid!=='string'||r.target_uid.length>320||r.target_bundle){ignoredReferences++;continue;}
   const targets=uids.get(r.target_uid);
   // A partial scan cannot establish UID uniqueness, even if one candidate was found.
   if(!result.complete||targets?.length!==1){unresolvedReferences++;continue;}
   add(d.path,targets[0],'relation',r.type);
  }
 }
 const truncated=result.docs.length>limit||omittedEdges>0||referenceLimit;
 return {nodes,edges,totalNodes:result.docs.length,nodeLimit:limit,edgeLimit:budget.edges,scanComplete:result.complete,complete:result.complete&&!truncated&&!invalidDocuments,truncated,unresolvedReferences,ignoredReferences,omittedEdges,invalidDocuments,referenceLimit,scope:'local_document_references'};
}
async function validate(config,result) {
 const errors=[],warnings=[],uids=new Map();let truncated=false,refs=0;
 const error=(path,code)=>{if(errors.length<200)errors.push({path,code});else truncated=true;};
 const warn=(path,code)=>{if(warnings.length<100)warnings.push({path,code});else truncated=true;};
 const consume=path=>{if(++refs>10000){error(path,'validation_limit');truncated=true;return false;}return !truncated;};
 const date=v=>{if(typeof v!=='string')return false;const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(v);if(!m)return false;const [,y,mo,d,h,mi,s]=m.map(Number),days=[31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];return y>0&&mo>=1&&mo<=12&&d>=1&&d<=days[mo-1]&&h<24&&mi<60&&s<60&&Number.isFinite(Date.parse(v));};
 if(config.normalized&&(config.bundle.schema_version!==1||typeof config.bundle.bundle_id!=='string'||! /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.bundle.bundle_id)))error('bundle.json','bundle_schema');
 for(const d of result.docs){
  if(truncated)break;
  if(d.parseError){error(d.path,'frontmatter_invalid');continue;}
  const {meta:m,x}=d;
  if(x.uid!==undefined&&!d.uid)error(d.path,'uid_invalid');
  if(d.uid){if(uids.has(d.uid))error(d.path,'duplicate_uid');else uids.set(d.uid,d);}
  if(config.normalized){
   if(!object(m[config.metadataNamespace]))error(d.path,'metadata_namespace_missing');
   if(!date(x.created_at)||!date(x.updated_at)||Date.parse(x.updated_at)<Date.parse(x.created_at))error(d.path,'timestamps_invalid');
   const navigation=(basename(d.path)==='index.md'||d.path==='log.md')&&m.type===undefined;
   if(!navigation){for(const k of ['type','title','description','status'])if(typeof m[k]!=='string'||!m[k])error(d.path,'missing_'+k);if(!d.uid)error(d.path,'missing_uid');}
   if(m.status&&!['draft','stable','deprecated'].includes(m.status))error(d.path,'status_invalid');
   if(m.status==='stable'&&(!Array.isArray(m.verified)||!m.verified.length||m.verified.some(v=>!v?.by||!date(v?.at))))error(d.path,'review_missing');
   if(m.generated!==undefined&&(!object(m.generated)||!m.generated.by||!date(m.generated.at)))error(d.path,'generated_invalid');
   const parts=d.path.split('/');if(parts[0]==='features'&&parts.length>2&&!navigation&&x.feature_id!==parts[1])error(d.path,'feature_id_mismatch');
  }
  if(m.stale_after!==undefined){if(!date(m.stale_after))error(d.path,'stale_after_invalid');else if(Date.parse(m.stale_after)<Date.now())warn(d.path,'review_overdue');}
  if(x.relations!==undefined&&!Array.isArray(x.relations))error(d.path,'relations_invalid');
  if(m.sources!==undefined&&!Array.isArray(m.sources))error(d.path,'sources_invalid');
  // Local file targets only: no network requests, no code-fence examples or anchor certification.
  for(const [,link]of visible(d.body).matchAll(/\]\(([^)]+)\)/g)){
   if(!consume(d.path))break;
   const target=link.trim().replace(/^<(.+)>$/,'$1');if(/^file:/i.test(target)){error(d.path,'link_outside_scope');continue;}if(target.startsWith('#')||/^[a-z][a-z0-9+.-]*:/i.test(target))continue;
   if(target.length>512||target.includes('\\')){error(d.path,'link_invalid');continue;}
   const path=resolve(config.root,dirname(d.path),target.split('#')[0]);
   if(!inside(config.root,path)){warn(d.path,'link_outside_scope_unverified');continue;}
   if(relative(config.root,path).split(sep).some(p=>config.excluded.includes(p)))continue;
   try{if(await realpath(path)!==path)throw Error();await lstat(path);}catch{error(d.path,'link_missing_or_unsafe');}
  }
 }
 for(const d of result.docs){
  if(truncated)break;
  for(const r of Array.isArray(d.x.relations)?d.x.relations:[]){
   if(!consume(d.path))break;
   if(!object(r)||!['references','part_of','depends_on','constrained_by','implements','supersedes'].includes(r.type)||typeof r.target_uid!=='string')error(d.path,'relation_invalid');
   else if(!r.target_bundle&&!uids.has(r.target_uid))error(d.path,'relation_target_missing');
   else if(r.target_bundle)warn(d.path,'cross_bundle_relation_unverified');
  }
  const ids=new Set();for(const s of Array.isArray(d.meta.sources)?d.meta.sources:[]){
   if(!consume(d.path))break;
   if(!object(s)||typeof s.id!=='string'||!s.id||typeof s.title!=='string'||typeof s.resource!=='string'){error(d.path,'source_invalid');continue;}
   if(ids.has(s.id))error(d.path,'source_id_duplicate');ids.add(s.id);
   const path=resolve(config.root,dirname(d.path),s.resource.split('#')[0]);
   if(!inside(resolve(config.root,'sources'),path)||relative(config.root,path).split(sep).some(p=>config.excluded.includes(p))){error(d.path,'source_outside_scope');continue;}
   try{await safeRead(config.root,relative(config.root,path));}catch{error(d.path,'source_missing_or_unsafe');}
  }
 }
 return {valid:result.complete&&!truncated?errors.length===0:null,complete:result.complete&&!truncated,errors,warnings,scope:'local_structure',limitations:['remote_urls_not_checked','anchors_not_checked','business_truth_not_checked','cross_bundle_targets_not_resolved','outside_scope_file_targets_not_checked']};
}
export async function queryKnowledge(project,params,defaults) {
 const allowed={knowledge_list:['limit','offset'],knowledge_search:['query','limit','offset'],knowledge_read:['path','uid','startLine','maxLines'],knowledge_validate:[],knowledge_graph:['limit']};
 const keys=allowed[params.action];if(!keys||Object.keys(params).some(k=>!['action','projectId',...keys].includes(k)))fail('KNOWLEDGE_ARGUMENT_INVALID');
 const graphLimit=params.action==='knowledge_graph'?integer(params.limit,100,1,100):undefined;
 const config=await resolveKnowledgeConfig(project.paths.repository,project.paths.knowledge,defaults),result=await scan(config);
 const base={projectId:project.projectId,knowledgePath:config.root,metadataNamespace:config.metadataNamespace,namespaceSource:config.namespaceSource,normalized:config.normalized,available:result.available,complete:result.complete,revision:result.revision,issues:result.issues,authority:'reference_only'};
 if(!result.available)return {...base,...(params.action==='knowledge_validate'?{valid:null}:{}),reason:'knowledge_directory_missing'};
 if(params.action==='knowledge_graph')return {...base,...knowledgeGraph(config,result,graphLimit)};
 if(params.action==='knowledge_validate')return {...base,...await validate(config,result),scanned:result.docs.length};
 if(params.action==='knowledge_search'||params.action==='knowledge_list'){
  if(params.action==='knowledge_search'&&(typeof params.query!=='string'||!params.query.trim()||params.query.length>320))fail('KNOWLEDGE_ARGUMENT_INVALID');
  const terms=params.action==='knowledge_list'?[]:params.query.trim().toLowerCase().split(/\s+/);if(terms.length>16)fail('KNOWLEDGE_ARGUMENT_INVALID');
  const offset=integer(params.offset,0,0,100000),limit=integer(params.limit,20,1,100);
  const matches=result.docs.flatMap(d=>{const hay=[d.title,d.uid,d.x.feature_id,d.text].join('\n').toLowerCase();if(!terms.every(t=>hay.includes(t)))return [];
   const lines=d.text.split(/\r?\n/),i=lines.findIndex(l=>terms.some(t=>l.toLowerCase().includes(t)));return [{...summary(d),line:i>=0?i+1:1,excerpt:(lines[i]??d.title).slice(0,240)}];});
  return {...base,entries:matches.slice(offset,offset+limit),total:matches.length,offset,limit,nextOffset:offset+limit<matches.length?offset+limit:null};
 }
 if((typeof params.path==='string')===(typeof params.uid==='string'))fail('KNOWLEDGE_ARGUMENT_INVALID');
 if(params.path!==undefined&&(typeof params.path!=='string'||/[\u0000\r\n]/.test(params.path)||params.path.length>512||isAbsolute(params.path)||params.path.includes('\\')||params.path.split('/').some(p=>!p||p==='.'||p==='..'||config.excluded.includes(p))||!params.path.endsWith('.md')))fail('KNOWLEDGE_PATH_DENIED');
 if(params.uid!==undefined&&(typeof params.uid!=='string'||!params.uid||params.uid.length>320))fail('KNOWLEDGE_ARGUMENT_INVALID');
 if(params.uid!==undefined&&!result.complete)fail('KNOWLEDGE_SCAN_INCOMPLETE');
 const found=result.docs.filter(d=>params.path?d.path===params.path:d.uid===params.uid);
 if(found.length>1)fail('KNOWLEDGE_UID_AMBIGUOUS');
 if(!found.length)return {...base,found:false};
 const d=found[0],lines=d.text.split(/\r?\n/),start=integer(params.startLine,1,1,100000),max=integer(params.maxLines,100,1,200);let content='',end=start-1,lineTruncated=false;
 for(let i=start-1;i<Math.min(lines.length,start-1+max);i++){const next=(content?'\n':'')+lines[i];if(Buffer.byteLength(content+next)>32768){if(!content){content=lines[i].slice(0,8192).replace(/[\uD800-\uDBFF]$/,'');end=i+1;lineTruncated=true;}break;}content+=next;end=i+1;}
 return {...base,found:true,entry:summary(d),content,startLine:start,endLine:end,totalLines:lines.length,nextLine:end<lines.length?end+1:null,truncated:end<lines.length||lineTruncated,lineTruncated,sha256:d.sha256};
}
