import {recyclePut} from './recycle-store.mjs';
import {graphDatabase,savePerson,personView as view,nodeById,putNode,audit,now} from './graph-storage.mjs';
import {createHash,randomUUID} from 'node:crypto';
export const validUsername=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const text=(value,max=200)=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u001f]/.test(value))throw Error('人员字段格式无效');return value.trim();};
function identity(input){return Object.fromEntries(['accountId','appId','openId'].map(key=>{const value=text(input[key]);if(!value)throw Error('人员身份缺失');return [key,value];}));}
const personId=input=>createHash('sha256').update(JSON.stringify(identity(input))).digest('hex');
export function createPeopleStore(root){
 const read=(db,id)=>{const row=db.prepare('SELECT value FROM graph_people WHERE id=?').get(id);return row?JSON.parse(row.value):null;};
 const write=(db,record)=>savePerson(db,record);
 function transaction(callback){const db=graphDatabase(root);try{db.exec('BEGIN IMMEDIATE');const value=callback(db);db.exec('COMMIT');return value;}finally{db.close();}}
 return {
  observe(input){const ids=identity(input),id=personId(ids);return transaction(db=>{
   const tombstone=nodeById(db,'person:'+id);if(tombstone?.purged)return view({...ids,id,directory:{name:null,email:null,departments:[]},overrides:{},revision:tombstone.revision,deletedAt:tombstone.updatedAt});const prior=read(db,id);if(prior?.deletedAt)return view(prior);const now=new Date().toISOString(),directory={...prior?.directory};
   // Missing fields are unavailable, not confirmed deletions. Keep last-known values.
   if(input.name!==undefined)directory.name=text(input.name)||null;
   if(input.email!==undefined)directory.email=text(input.email,320)||null;
   if(input.departments!==undefined){if(!Array.isArray(input.departments)||input.departments.length>100)throw Error('部门格式无效');directory.departments=input.departments.map(d=>({id:text(d.id),...(d.name?{name:text(d.name)}:{})}));}
   return write(db,{...ids,id,directory:{name:null,email:null,departments:[],...directory},overrides:prior?.overrides??{},observedAt:now,updatedAt:prior?.updatedAt??now,revision:prior&&JSON.stringify(directory)===JSON.stringify(prior.directory)?prior.revision:randomUUID()});
  });},
  lookup(input){const db=graphDatabase(root);try{const record=read(db,personId(input));return record&&!record.deletedAt?view(record):null;}finally{db.close();}},
  all(){const db=graphDatabase(root);try{return db.prepare("SELECT p.value FROM graph_people p JOIN graph_nodes n ON n.id=p.node_id WHERE n.status='active' ORDER BY p.id").all().map(row=>view(JSON.parse(row.value)));}finally{db.close();}},
  list({query='',offset=0}={}){query=text(query).toLocaleLowerCase();if(!Number.isInteger(offset)||offset<0)throw Error('分页参数无效');const db=graphDatabase(root);try{const all=db.prepare("SELECT p.value FROM graph_people p JOIN graph_nodes n ON n.id=p.node_id WHERE n.status='active' ORDER BY p.id").all().map(row=>view(JSON.parse(row.value))).filter(p=>[p.name,p.email,p.openId,p.giteaUsername,...p.departments.map(d=>d.name)].join(' ').toLocaleLowerCase().includes(query));return {people:all.slice(offset,offset+50),total:all.length,offset,nextOffset:offset+50<all.length?offset+50:null};}finally{db.close();}},
  update({id,revision,patch}){if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['name','email','departments','giteaUsername'].includes(key)))throw Error('人员修改参数无效');return transaction(db=>{
   const record=read(db,id);if(!record||record.deletedAt||record.revision!==revision)throw Error('人员资料已变化，请刷新后重试');const next={...record.overrides};
   for(const [key,value] of Object.entries(patch)){
    if(value===null){delete next[key];continue;}
    if(key==='departments'){if(!Array.isArray(value)||value.length>100)throw Error('部门格式无效');next[key]=value.map(d=>({id:text(d.id),...(d.name?{name:text(d.name)}:{})}));continue;}
    const normalized=text(value,key==='email'?320:200);if(key==='giteaUsername'&&!validUsername(normalized)||key==='email'&&normalized&&!/^[^\s@]+@[^\s@]+$/.test(normalized))throw Error('邮箱或 Gitea 账号格式无效');next[key]=normalized||null;
   }
   return write(db,{...record,overrides:next,updatedAt:new Date().toISOString(),revision:randomUUID()});
  });},
  remove({id,revision}){return transaction(db=>{const record=read(db,id);if(!record||record.deletedAt||record.revision!==revision)throw Error('人员资料已变化，请刷新后重试');const before=nodeById(db,'person:'+id);if(db.prepare("SELECT 1 FROM graph_edges WHERE (from_id=? OR to_id=?) AND status='active'").get(before.id,before.id))throw Error('人员仍有关联，请先按关系规则断联');const after={...before,status:'deleted',updatedAt:now(),revision:randomUUID()};putNode(db,after);audit(db,'people-admin','delete',before.id,before,after,{kind:'manual',reason:'人员管理删除'});const deletedAt=Date.now();db.prepare('UPDATE graph_people SET value=? WHERE id=?').run(JSON.stringify({...record,deletedAt,revision:after.revision}),id);recyclePut(db,{id:before.id,kind:'person',name:before.name,deletedAt,revision:after.revision});return {deleted:true,recycled:true};});},
 };
}
