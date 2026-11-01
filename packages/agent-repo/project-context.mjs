import {resolveKnowledgeConfig} from './knowledge.mjs';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.length<=160&&!/[\u0000\r\n]/.test(v)?v:undefined;
const inside=(root,path)=>{const p=relative(root,path);return p===''||(!isAbsolute(p)&&p!=='..'&&!p.startsWith('..'+sep));};
/** Optional, bounded metadata discovery. No commands, tool config, identities or credentials are returned. */
export async function readProjectContext(projectRoot,knowledgePath,knowledgeDefaults) {
 const root=await realpath(projectRoot);
 async function load(path) {
  const target=resolve(root,path);
  try {
   if(!inside(root,target))return {status:'invalid'};
   const stat=await lstat(target);
   if(!stat.isFile()||stat.size>65536||await realpath(target)!==target)return {status:'invalid'};
   const data=JSON.parse(await readFile(target,'utf8'));
   return object(data)?{status:'available',data}:{status:'invalid'};
  } catch(error){return {status:error.code==='ENOENT'?'missing':'invalid'};}
 }
 const project=await load('project.json'),fallback=await load('git-policy.json'),pkg=await load('package.json');
 const p=project.data;
 const projectInfo={status:project.status,path:'project.json'};
 if(p){if(p.schema_version!==1)projectInfo.status='invalid';else Object.assign(projectInfo,{schemaVersion:1,...(text(p.project_id)?{projectId:p.project_id}:{}),...(text(p.name)?{name:p.name}:{})});}
 // Explicit project policy errors must not silently fall back to another policy.
 const hasProjectGit=p&&Object.hasOwn(p,'git');
 const source=hasProjectGit?'project.json':projectInfo.status==='invalid'?'project.json':'git-policy.json';
 const status=source==='project.json'?projectInfo.status:fallback.status;
 const policy=hasProjectGit?p.git:source==='git-policy.json'?fallback.data:undefined;
 const git={status,source};
 if(status==='available') {
  if(!object(policy)||!['read-only','local','direct','review'].includes(policy.delivery)||policy.auto_merge!==false||(source==='git-policy.json'&&policy.schema_version!==1))git.status='invalid';
  else Object.assign(git,{delivery:policy.delivery,autoMerge:false,...(text(policy.branch_prefix)?{branchPrefix:policy.branch_prefix}:{}),...(policy.sync==='ff-only'?{sync:'ff-only'}:{})});
 }
 const validation={status:pkg.status,path:'package.json'};
 if(pkg.data)Object.assign(validation,{...(text(pkg.data.engines?.node)?{node:pkg.data.engines.node}:{}),scripts:['check','test','build','typecheck','git:check'].filter(k=>typeof pkg.data.scripts?.[k]==='string')});
 const knowledgeRoot=knowledgePath?await realpath(knowledgePath).catch(()=>resolve(root,relative(resolve(projectRoot),resolve(knowledgePath)))):resolve(root,'wiki');
 const bundlePath=relative(root,resolve(knowledgeRoot,'bundle.json'));
 let bundle=await load(bundlePath);
 if(bundle.status==='missing'&&knowledgeRoot===resolve(root,'wiki'))bundle=await load('bundle.json');
 const bundleInfo={status:bundle.status};
 if(bundle.data) {
  const b=bundle.data;
  if(b.schema_version!==1||!text(b.bundle_id))bundleInfo.status='invalid';
  else Object.assign(bundleInfo,{schemaVersion:1,bundleId:b.bundle_id,...(text(b.title)?{title:b.title}:{}),...(typeof b.metadata_namespace==='string'&&/^x_[a-z][a-z0-9_]{0,61}$/.test(b.metadata_namespace)?{metadataNamespace:b.metadata_namespace}:{})});
 }
 let knowledge;
 try{const c=await resolveKnowledgeConfig(root,knowledgeRoot,knowledgeDefaults);knowledge={status:'available',metadataNamespace:c.metadataNamespace,namespaceSource:c.namespaceSource,normalized:c.normalized};}catch{knowledge={status:'invalid'};}
 return {schemaVersion:1,authority:'reference_only',project:projectInfo,git,validation,bundle:bundleInfo,knowledge};
}
