import {lstat,readdir,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
const within=(parent,path)=>{const rel=relative(parent,path);return !rel||!rel.startsWith('..')&&!isAbsolute(rel);};

// A path sandbox cannot distinguish an existing writable hardlink from its
// protected source inode. Restrict every multiply-linked regular file before
// granting the containing tree write access. Never break links or change files.
export async function sharedHardlinkReadRules(writeRoots,{signal,deadline=Infinity}={}){
 const check=()=>{signal?.throwIfAborted();if(Date.now()>=deadline)throw Object.assign(Error('Directory boundary verification exceeded the execution deadline'),{code:'EXECUTION_TIMEOUT'});};
 const roots=Array.isArray(writeRoots)?writeRoots:[writeRoots],canonical=[];
 for(const root of roots){
  check();if(typeof root!=='string'||!isAbsolute(root))throw Error('Directory write roots must be absolute');
  const path=await realpath(root);check();if(path!==resolve(root))throw Error('Directory write roots must not contain symlinks');canonical.push(path);
 }
 const unique=[...new Set(canonical)].filter(path=>!canonical.some(other=>other!==path&&within(other,path)));
 const rules={},pending=[...unique];
 while(pending.length){
  check();const path=pending.pop(),metadata=await lstat(path);check();
  if(metadata.isSymbolicLink())continue;
  if(metadata.isFile()){if(metadata.nlink>1)rules[path]='read';continue;}
  if(!metadata.isDirectory())continue;
  const entries=await readdir(path,{withFileTypes:true});check();
  // Keep traversal bounded by the executor's deadline without following links
  // into another workspace, source directory, or a cyclic package-manager tree.
  for(const entry of entries){if(!entry.isSymbolicLink())pending.push(join(path,entry.name));}
 }
 return rules;
}
