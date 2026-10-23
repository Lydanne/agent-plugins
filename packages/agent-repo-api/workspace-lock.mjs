import {mkdirSync,existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// Short metadata locks recover only after their owning process is confirmed dead.
// Missing/unreadable ownership fails closed rather than guessing from elapsed time.
export function tryLock(path) {
 const recovery=path+'.recovery';
 if(existsSync(recovery))return undefined;
 const owner=join(path,'owner.json'),token=randomUUID();
 try{mkdirSync(path,{mode:0o700});}catch(error){
  if(error.code!=='EEXIST')throw error;
  try{mkdirSync(recovery,{mode:0o700});}catch(error){if(error.code==='EEXIST')return undefined;throw error;}
  try{
   let prior;try{prior=JSON.parse(readFileSync(owner,'utf8'));}catch{return undefined;}
   if(!Number.isInteger(prior.pid)||prior.pid<1)return undefined;
   try{process.kill(prior.pid,0);return undefined;}catch(error){if(error.code!=='ESRCH')return undefined;}
   rmSync(path,{recursive:true});
  }finally{rmSync(recovery,{recursive:true,force:true});}
  return tryLock(path);
 }
 try{writeFileSync(owner,JSON.stringify({pid:process.pid,token}),{mode:0o600});}
 catch(error){rmSync(path,{recursive:true,force:true});throw error;}
 return ()=>{
  if(JSON.parse(readFileSync(owner,'utf8')).token!==token)throw Error('Metadata lock ownership changed');
  rmSync(path,{recursive:true});
 };
}
export async function acquireLock(path,signal) {
 const deadline=Date.now()+5000;
 for(;;){signal?.throwIfAborted();const release=tryLock(path);if(release)return release;
  if(Date.now()>deadline)throw Error('Metadata lock is busy or unresolved; existing jobs have been preserved');
  await new Promise(resolve=>setTimeout(resolve,25));
 }
}
