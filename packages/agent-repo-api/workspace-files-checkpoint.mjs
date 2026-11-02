import {mkdir,lstat,realpath,readFile,readlink,copyFile,symlink,chmod,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {poolGit} from './workspace-pool.mjs';

async function safeFile(root,name) {
 if(!name || name.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git')) throw Error('Unsafe checkpoint file path');
 const path=resolve(root,name);
 if(!path.startsWith(root+'/')) throw Error('Checkpoint path escapes repository');
 let parent=root;
 for(const part of name.split('/').slice(0,-1)) {
  parent=join(parent,part);
  if((await lstat(parent)).isSymbolicLink()) throw Error('Checkpoint parent must not be linked');
 }
 return path;
}
async function fingerprint(path) {
 const stat=await lstat(path);
 if(stat.isSymbolicLink()) return {type:'symlink',target:await readlink(path)};
 if(!stat.isFile()) throw Error('Unsupported checkpoint file type');
 return {type:'file',mode:stat.mode&0o777,sha256:createHash('sha256').update(await readFile(path)).digest('hex')};
}
export async function listExtraFiles(root) {
 const regular=await poolGit(root,['ls-files','--others','--exclude-standard','-z'],{raw:true});
 const ignored=await poolGit(root,['ls-files','--others','--ignored','--exclude-standard','-z'],{raw:true});
 return [...new Set((regular+ignored).split('\0').filter(Boolean))].sort();
}
// A fresh destination is mandatory: incomplete prior snapshots are never reused
// or overwritten. No source file is removed, even after successful verification.
export async function captureExtraFiles(root,destination,{exclude=[]}={}) {
 root=await realpath(root);
 const parent=await realpath(dirname(destination));destination=join(parent,destination.split('/').at(-1));
 if(destination===root||destination.startsWith(root+'/')) throw Error('File checkpoint must be outside the repository');
 await mkdir(destination,{mode:0o700});
 const inventory=async()=> (await listExtraFiles(root)).filter(name=>!exclude.some(prefix=>name===prefix||name.startsWith(prefix+'/')));
 const names=await inventory(),receipts=[];
 for(const name of names) {
  const source=await safeFile(root,name),before=await fingerprint(source),target=join(destination,name);
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  if(before.type==='symlink') await symlink(before.target,target);
  else {await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,before.mode);}
  if(JSON.stringify(before)!==JSON.stringify(await fingerprint(source)) || JSON.stringify(before)!==JSON.stringify(await fingerprint(target))) throw Error('Checkpoint file changed during capture');
  receipts.push({path:name,...before});
 }
 if(JSON.stringify(names)!==JSON.stringify(await inventory())) throw Error('Checkpoint file inventory changed');
 return receipts;
}

async function restoreTarget(root,name) {
 // Validate all components before creating any directories. Parent symlinks
 // cannot redirect restoration outside the bound repository.
 if(typeof name!=='string'||!name||name.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git')) throw Error('Unsafe checkpoint file path');
 let parent=root;
 for(const part of name.split('/').slice(0,-1)) {
  parent=join(parent,part);
  try {const stat=await lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid restore parent');}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 return join(root,name);
}
function expectedFingerprint(receipt) {
 if(receipt.type==='symlink'&&typeof receipt.target==='string')return {type:'symlink',target:receipt.target};
 if(receipt.type==='file'&&Number.isInteger(receipt.mode)&&receipt.mode>=0&&receipt.mode<=0o777&&/^[a-f0-9]{64}$/.test(receipt.sha256))return {type:'file',mode:receipt.mode,sha256:receipt.sha256};
 throw Error('Invalid file checkpoint receipt');
}
export async function restoreExtraFiles(root,destination,receipts,{expectedRoot}={}) {
 root=await realpath(root);destination=await realpath(destination);
 if(root!==expectedRoot)throw Error('Original repository binding changed');
 if(!Array.isArray(receipts))throw Error('Invalid file checkpoint receipts');
 const prepared=[],names=new Set();
 // Preflight every saved object and existing destination before modifying any.
 for(const receipt of receipts) {
  if(names.has(receipt.path))throw Error('Duplicate checkpoint file');names.add(receipt.path);
  const expected=expectedFingerprint(receipt),source=await safeFile(destination,receipt.path),target=await restoreTarget(root,receipt.path);
  if(JSON.stringify(await fingerprint(source))!==JSON.stringify(expected))throw Error('Saved checkpoint file verification failed');
  let present=false;
  try {if(JSON.stringify(await fingerprint(target))!==JSON.stringify(expected))throw Error('Restore conflicts with existing file');present=true;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  prepared.push({source,target,expected,present,name:receipt.path});
 }
 for(const {source,target,expected,present,name} of prepared) {
  if(present)continue;
  await restoreTarget(root,name);
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  if(expected.type==='symlink')await symlink(expected.target,target);
  else {await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,expected.mode);}
  if(JSON.stringify(await fingerprint(target))!==JSON.stringify(expected))throw Error('Restored checkpoint file verification failed');
 }
 // Retain the saved objects: recovery/cleanup is a separate fenced operation.
 return {restored:prepared.length};
}


export async function verifyExtraCheckpointSource(root,destination,receipts,{exclude=[]}={}) {
 root=await realpath(root);destination=await realpath(destination);
 const names=(await listExtraFiles(root)).filter(name=>!exclude.some(prefix=>name===prefix||name.startsWith(prefix+'/')));
 if(JSON.stringify(names)!==JSON.stringify(receipts.map(r=>r.path).sort()))throw Error('Extra files changed after capture');
 for(const receipt of receipts) {
  const expected=expectedFingerprint(receipt);
  const source=await safeFile(root,receipt.path),backup=await safeFile(destination,receipt.path);
  if(JSON.stringify(await fingerprint(source))!==JSON.stringify(expected)||JSON.stringify(await fingerprint(backup))!==JSON.stringify(expected))throw Error('Extra file verification failed before release');
 }
}
export async function clearExtraCheckpointSource(root,destination,receipts,options) {
 await verifyExtraCheckpointSource(root,destination,receipts,options);
 root=await realpath(root);
 for(const receipt of receipts) {
  const source=await safeFile(root,receipt.path);
  if(JSON.stringify(await fingerprint(source))!==JSON.stringify(expectedFingerprint(receipt)))throw Error('Extra file changed during release');
  await unlink(source);
 }
}
