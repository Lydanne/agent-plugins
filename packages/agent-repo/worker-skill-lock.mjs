import {mkdirSync,writeFileSync,readFileSync,renameSync,rmSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

function owner(path) {
 const directory=lstatSync(path),file=join(path,'owner.json');
 if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('Unresolved Worker skill lock ownership');
 // Release can remove owner.json just before removing the directory; retry ENOENT.
 if(!lstatSync(file).isFile())throw Error('Unresolved Worker skill lock ownership');
 const value=JSON.parse(readFileSync(file,'utf8'));
 if(!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.token!=='string')throw Error('Unresolved Worker skill lock ownership');
 return value;
}
function dead(value) {
 try {process.kill(value.pid,0);return false;}catch(error){return error.code==='ESRCH';}
}
function tryAcquire(path,depth=0) {
 if(depth>4)return undefined;
 // Recovery itself has a process owner, so a crash during reclamation is also recoverable.
 try {lstatSync(path+'.recovery');const release=tryAcquire(path+'.recovery',depth+1);if(!release)return undefined;release();}catch(error){if(error.code!=='ENOENT')throw error;}
 let occupied=false;
 try {lstatSync(path);occupied=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(occupied){
  if(!dead(owner(path)))return undefined;
  const release=tryAcquire(path+'.recovery',depth+1);if(!release)return undefined;
  try {if(dead(owner(path)))rmSync(path,{recursive:true});}finally{release();}
  return undefined;
 }
 const temporary=path+'.'+randomUUID()+'.tmp',value={pid:process.pid,token:randomUUID()};
 mkdirSync(temporary,{mode:0o700});
 try {
  writeFileSync(join(temporary,'owner.json'),JSON.stringify(value),{mode:0o600});
  // Publish a nonempty directory atomically: even SIGKILL cannot leave an ownerless lock.
  try {renameSync(temporary,path);}catch(error){if(['EEXIST','ENOTEMPTY'].includes(error.code))return undefined;throw error;}
 }finally{rmSync(temporary,{recursive:true,force:true});}
 return ()=>{
  if(owner(path).token!==value.token)throw Error('Worker skill lock ownership changed');
  rmSync(path,{recursive:true});
 };
}
export async function acquireWorkerSkillLock(path,{timeoutMs=5000}={}) {
 const deadline=Date.now()+timeoutMs;
 for(;;){
  try {const release=tryAcquire(path);if(release)return release;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(Date.now()>=deadline)throw Error('Worker skill publication is busy; inspect unresolved lock');
  await new Promise(resolve=>setTimeout(resolve,25));
 }
}
