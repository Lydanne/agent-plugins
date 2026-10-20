import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,realpathSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export const validUsername=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const text=(value,max=200)=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u001f]/.test(value))throw Error('人员字段格式无效');return value.trim();};
function identity(input){return Object.fromEntries(['accountId','appId','openId'].map(key=>{const value=text(input[key]);if(!value)throw Error('人员身份缺失');return [key,value];}));}
const personId=input=>createHash('sha256').update(JSON.stringify(identity(input))).digest('hex');
function database(root){
 let directory=realpathSync(root);
 for(const part of ['.runtime','people']){directory=join(directory,part);mkdirSync(directory,{recursive:true,mode:0o700});if(lstatSync(directory).isSymbolicLink()||!lstatSync(directory).isDirectory())throw Error('人员存储目录无效');chmodSync(directory,0o700);}
 const file=join(directory,'people.sqlite');try{if(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())throw Error('人员存储文件无效');}catch(error){if(error.code!=='ENOENT')throw error;}
 const db=new DatabaseSync(file);chmodSync(file,0o600);db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, value TEXT NOT NULL)');return db;
}
function view(record){
 const {directory,overrides,...data}=record,merged={...directory,...overrides};
 const prefix=merged.email?.split('@')[0],explicit=overrides.giteaUsername;
 return {...data,...merged,giteaUsername:explicit??(validUsername(prefix)?prefix:null),giteaSource:explicit?'admin':validUsername(prefix)?'email_prefix':'unknown'};
}
export function createPeopleStore(root){
 const read=(db,id)=>{const row=db.prepare('SELECT value FROM people WHERE id=?').get(id);return row?JSON.parse(row.value):null;};
 const write=(db,record)=>{db.prepare('INSERT OR REPLACE INTO people VALUES (?,?)').run(record.id,JSON.stringify(record));return view(record);};
 function transaction(callback){const db=database(root);try{db.exec('BEGIN IMMEDIATE');const value=callback(db);db.exec('COMMIT');return value;}finally{db.close();}}
 return {
  observe(input){const ids=identity(input),id=personId(ids);return transaction(db=>{
   const prior=read(db,id),now=new Date().toISOString(),directory={...prior?.directory};
   // Missing fields are unavailable, not confirmed deletions. Keep last-known values.
   if(input.name!==undefined)directory.name=text(input.name)||null;
   if(input.email!==undefined)directory.email=text(input.email,320)||null;
   if(input.departments!==undefined){if(!Array.isArray(input.departments)||input.departments.length>100)throw Error('部门格式无效');directory.departments=input.departments.map(d=>({id:text(d.id),...(d.name?{name:text(d.name)}:{})}));}
   return write(db,{...ids,id,directory:{name:null,email:null,departments:[],...directory},overrides:prior?.overrides??{},observedAt:now,updatedAt:prior?.updatedAt??now,revision:prior&&JSON.stringify(directory)===JSON.stringify(prior.directory)?prior.revision:randomUUID()});
  });},
  lookup(input){const db=database(root);try{const record=read(db,personId(input));return record?view(record):null;}finally{db.close();}},
  all(){const db=database(root);try{return db.prepare('SELECT value FROM people ORDER BY id').all().map(row=>view(JSON.parse(row.value)));}finally{db.close();}},
  list({query='',offset=0}={}){query=text(query).toLocaleLowerCase();if(!Number.isInteger(offset)||offset<0)throw Error('分页参数无效');const db=database(root);try{const all=db.prepare('SELECT value FROM people ORDER BY id').all().map(row=>view(JSON.parse(row.value))).filter(p=>[p.name,p.email,p.openId,p.giteaUsername,...p.departments.map(d=>d.name)].join(' ').toLocaleLowerCase().includes(query));return {people:all.slice(offset,offset+50),total:all.length,offset,nextOffset:offset+50<all.length?offset+50:null};}finally{db.close();}},
  update({id,revision,patch}){if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['name','email','departments','giteaUsername'].includes(key)))throw Error('人员修改参数无效');return transaction(db=>{
   const record=read(db,id);if(!record||record.revision!==revision)throw Error('人员资料已变化，请刷新后重试');const next={...record.overrides};
   for(const [key,value] of Object.entries(patch)){
    if(value===null){delete next[key];continue;}
    if(key==='departments'){if(!Array.isArray(value)||value.length>100)throw Error('部门格式无效');next[key]=value.map(d=>({id:text(d.id),...(d.name?{name:text(d.name)}:{})}));continue;}
    const normalized=text(value,key==='email'?320:200);if(key==='giteaUsername'&&!validUsername(normalized)||key==='email'&&normalized&&!/^[^\s@]+@[^\s@]+$/.test(normalized))throw Error('邮箱或 Gitea 账号格式无效');next[key]=normalized||null;
   }
   return write(db,{...record,overrides:next,updatedAt:new Date().toISOString(),revision:randomUUID()});
  });},
  remove({id,revision}){return transaction(db=>{const record=read(db,id);if(!record||record.revision!==revision)throw Error('人员资料已变化，请刷新后重试');db.prepare('DELETE FROM people WHERE id=?').run(id);return {deleted:true};});},
 };
}
