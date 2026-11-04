import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {privateFile,databaseTransaction} from './database.mjs';
import {defaultPermissionGroups,permissionActions,validatePermissionRule,permissionDefaultMatches} from './authorization-policy.mjs';

/** Internal store only. Transport handlers must authenticate administration separately. */
export function createAuthorizationStore(root,{agentId,now=()=>new Date().toISOString()}={}){
 if(typeof agentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(agentId))throw Error('Invalid authorization Agent');
 const file=privateFile(root,['authorization.sqlite']),db=new DatabaseSync(file);
 chmodSync(file,0o600);db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF');
 const version=db.prepare('PRAGMA user_version').get().user_version;
 if(version>3){db.close();throw Error('Unsupported authorization schema');}
 if(version===0)databaseTransaction(db,()=>{
  db.exec(`
   CREATE TABLE auth_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE auth_groups(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT NOT NULL);
   CREATE TABLE auth_resources(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT NOT NULL);
   CREATE TABLE auth_resource_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(id,revision));
   CREATE TABLE auth_rules(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES auth_groups(id),revision INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('explicit','default')),value TEXT NOT NULL);
   CREATE TABLE auth_bindings(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES auth_groups(id),revision INTEGER NOT NULL,value TEXT NOT NULL);
   CREATE TABLE auth_auto_grants(resource_id TEXT NOT NULL REFERENCES auth_resources(id),resource_revision INTEGER NOT NULL,rule_id TEXT NOT NULL REFERENCES auth_rules(id),rule_revision INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(resource_id,resource_revision,rule_id));
   CREATE TABLE auth_audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,value TEXT NOT NULL);
   PRAGMA user_version=1;
  `);
  db.prepare('INSERT INTO auth_meta VALUES(?,?)').run('agentId',agentId);
  for(const group of defaultPermissionGroups)db.prepare('INSERT INTO auth_groups VALUES(?,1,?)').run(group.id,JSON.stringify({...group,builtin:true,status:'active'}));
  const defaults=[
   {id:'builtin-administrator-default',groupId:'administrator',kind:'default',effect:'allow',actions:[...permissionActions],selector:{}},
   {id:'builtin-internal-default',groupId:'internal',kind:'default',effect:'allow',actions:['discover','read','execute'],selector:{},conditions:{access:['read'],sensitivity:['ordinary'],externalEffect:['none']}},
  ];
  for(const rule of defaults)db.prepare('INSERT INTO auth_rules VALUES(?,?,1,?,?)').run(rule.id,rule.groupId,rule.kind,JSON.stringify(rule));

 });
 if(db.prepare("SELECT value FROM auth_meta WHERE key='agentId'").get()?.value!==agentId){db.close();throw Error('Authorization database belongs to another Agent');}
 if(version<2)databaseTransaction(db,()=>{db.exec('CREATE TABLE IF NOT EXISTS auth_task_scopes(id TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=2;');});
 if(version<3)databaseTransaction(db,()=>{db.exec('CREATE TABLE IF NOT EXISTS auth_policy_versions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL); PRAGMA user_version=3;');});
 const tables={groups:'auth_groups',resources:'auth_resources',rules:'auth_rules',bindings:'auth_bindings'};
 const get=(kind,id)=>{const row=db.prepare(`SELECT * FROM ${tables[kind]} WHERE id=?`).get(id);return row?{...JSON.parse(row.value),revision:row.revision}:null;};
 const list=kind=>{if(!Object.hasOwn(tables,kind))throw Error('Invalid authorization collection');return db.prepare(`SELECT * FROM ${tables[kind]} ORDER BY id`).all().map(row=>({...JSON.parse(row.value),revision:row.revision}));};
 function audit(actor,action,target,value){
  if(typeof actor!=='string'||!actor)throw Error('Missing trusted audit actor');
  db.prepare('INSERT INTO auth_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),now(),actor,action,target,JSON.stringify(value));
 }
 function save(kind,value,{expectedRevision=0,actor}={},extra={}){
  return databaseTransaction(db,()=>{
   if(typeof value.id!=='string'||!value.id||value.id.length>512)throw Error('Invalid authorization identifier');
   const previous=get(kind,value.id);
   if((previous?.revision??0)!==expectedRevision)throw Error('Authorization revision conflict');
   const revision=expectedRevision+1,body={...value};delete body.revision;
   const columns=['id','revision','value',...Object.keys(extra)],values=[value.id,revision,JSON.stringify(body),...Object.values(extra)];
   db.prepare(`INSERT INTO ${tables[kind]} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`).run(...values);
   audit(actor,kind+'.save',value.id,{before:previous,after:{...body,revision}});
   return {...body,revision};
  });
 }
 return {
  transaction(callback){return databaseTransaction(db,callback);},
  taskScope(id,subjectId,groupIds){
   if(typeof id!=='string'||!id||id.length>1024)throw Error('Invalid task scope identity');
   return databaseTransaction(db,()=>{
    const existing=db.prepare('SELECT value FROM auth_task_scopes WHERE id=?').get(id);
    if(existing){const scope=JSON.parse(existing.value);if(scope.subjectId!==subjectId)throw Error('Task requester changed');return scope;}
    const resources=list('resources').map(resource=>({id:resource.id,revision:resource.revision,rules:this.effectiveRules(resource.id).filter(rule=>groupIds.includes(rule.groupId))}));
    const scope={id,subjectId,groupIds:[...groupIds],resources,createdAt:now()};
    db.prepare('INSERT INTO auth_task_scopes VALUES(?,?)').run(id,JSON.stringify(scope));audit(subjectId,'task.scope',id,{resourceCount:resources.length,groupIds});return scope;
   });
  },
  mode(){return db.prepare("SELECT value FROM auth_meta WHERE key='mode'").get()?.value??'audit';},
  setMode(mode,{actor}={}){if(!['audit','enforce'].includes(mode))throw Error('Invalid authorization mode');return databaseTransaction(db,()=>{const previous=db.prepare("SELECT value FROM auth_meta WHERE key='mode'").get()?.value??'audit';db.prepare("INSERT INTO auth_meta VALUES('mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);audit(actor,'mode.set',agentId,{before:previous,after:mode});return {mode};});},
  agentId,list,get:(kind,id)=>{if(!Object.hasOwn(tables,kind))throw Error('Invalid authorization collection');return get(kind,id);},
  saveGroup(value,options){
   if(typeof value.name!=='string'||!value.name||!['active','disabled'].includes(value.status))throw Error('Invalid permission group');
   const old=get('groups',value.id);if(old?.builtin&&value.builtin!==true)throw Error('Cannot replace built-in group identity');
   return save('groups',value,options);
  },
  policyVersions(){return db.prepare('SELECT * FROM auth_policy_versions ORDER BY rowid DESC LIMIT 100').all().map(row=>({...JSON.parse(row.value),revision:row.revision,status:row.status}));},
  draftRule(value,{expectedRevision=0,actor}={}){
   const {kind='explicit',revision:ignored,...rule}=value;validatePermissionRule(rule);
   if(!['explicit','default'].includes(kind))throw Error('Invalid rule kind');
   return databaseTransaction(db,()=>{
    if(!get('groups',rule.groupId))throw Error('Unknown permission group');
    const current=get('rules',rule.id);if((current?.revision??0)!==expectedRevision)throw Error('Authorization revision conflict');
    const draft={id:randomUUID(),rule:{...rule,kind},baseRevision:expectedRevision,before:current,createdAt:now()};
    db.prepare('INSERT INTO auth_policy_versions VALUES(?,1,?,?)').run(draft.id,'draft',JSON.stringify(draft));audit(actor,'policy.draft',draft.id,{ruleId:rule.id,baseRevision:expectedRevision});
    return {...draft,revision:1,status:'draft'};
   });
  },
  publishPolicy(id,{expectedRevision,actor}={}){
   return databaseTransaction(db,()=>{
    const row=db.prepare('SELECT * FROM auth_policy_versions WHERE id=?').get(id);if(!row||row.revision!==expectedRevision||row.status!=='draft')throw Error('Policy draft revision conflict');
    const draft=JSON.parse(row.value),saved=this.saveRule(draft.rule,{expectedRevision:draft.baseRevision,actor});
    const published={...draft,publishedAt:now(),ruleRevision:saved.revision};
    db.prepare('UPDATE auth_policy_versions SET revision=revision+1,status=?,value=? WHERE id=?').run('published',JSON.stringify(published),id);
    audit(actor,'policy.publish',id,{ruleId:saved.id,ruleRevision:saved.revision});return {...published,revision:row.revision+1,status:'published'};
   });
  },
  saveRule(value,options){
   const {kind='explicit',...rule}=value;validatePermissionRule(rule);
   if(!['explicit','default'].includes(kind))throw Error('Invalid rule kind');
   return save('rules',{...rule,kind},options,{group_id:rule.groupId,kind});
  },
  saveBinding(value,options){
   if(value.agentId!==agentId||typeof value.entityId!=='string'||!value.entityId||!['person','department','organization'].includes(value.entityType)||!['self','members','descendants'].includes(value.membership)||!['active','disabled'].includes(value.status))throw Error('Invalid entity binding');
   if(value.entityType==='person'&&value.membership!=='self'||value.entityType==='organization'&&value.membership!=='members'||value.entityType==='department'&&value.membership==='self')throw Error('Invalid membership mode');
   for(const key of ['validFrom','validUntil'])if(value[key]!==undefined&&!Number.isFinite(Date.parse(value[key])))throw Error('Invalid binding validity');
   if(value.validFrom&&value.validUntil&&Date.parse(value.validFrom)>=Date.parse(value.validUntil))throw Error('Invalid binding interval');
   return save('bindings',value,options,{group_id:value.groupId});
  },
  saveResource(value,options){
   if(value.agentId!==agentId||typeof value.kind!=='string'||!value.kind||typeof value.provider!=='string'||!value.provider||!Array.isArray(value.actions)||!value.actions.length||value.actions.some(a=>!permissionActions.includes(a))||!['pending','active','disabled','removed'].includes(value.status)||!['pending','verified'].includes(value.verification)||!['missing','enforced'].includes(value.enforcement))throw Error('Invalid permission resource');
   return databaseTransaction(db,()=>{
    const result=save('resources',value,options);
    db.prepare('INSERT INTO auth_resource_revisions VALUES(?,?,?)').run(result.id,result.revision,JSON.stringify(result));
    return result;
   });
  },
  previewDefaults(resourceId,{context={}}={}){
   return databaseTransaction(db,()=>{
    const resource=get('resources',resourceId);if(!resource)throw Error('Unknown resource');
    const before=db.prepare('SELECT value FROM auth_auto_grants WHERE resource_id=? AND resource_revision=? ORDER BY rule_id').all(resourceId,resource.revision).map(row=>JSON.parse(row.value));
    const rules=list('rules'),groups=list('groups'),active=new Set(groups.filter(group=>group.status==='active').map(group=>group.id));
    const after=[];
    if(resource.defaultAuthorization!=='explicit-only'&&resource.status==='active'&&resource.verification==='verified'&&resource.enforcement==='enforced')for(const stored of rules){
     if(stored.kind!=='default'||!active.has(stored.groupId))continue;
     const {kind,revision,...rule}=stored;if(!permissionDefaultMatches(rule,resource))continue;
     const actions=rule.actions.filter(action=>resource.actions.includes(action));if(!actions.length)continue;
     after.push({...rule,actions,selector:{resourceIds:[resource.id]},origin:{kind:'default',ruleId:rule.id,ruleRevision:revision,resourceRevision:resource.revision}});
    }
    const revision=createHash('sha256').update(JSON.stringify({resource,rules,groups,before,after,context})).digest('hex');
    return {resourceId,resourceRevision:resource.revision,revision,before,after};
   });
  },
  recomputeDefaults(resourceId,{expectedRevision,actor,context={}}={}){
   return databaseTransaction(db,()=>{
    const preview=this.previewDefaults(resourceId,{context});if(preview.revision!==expectedRevision)throw Error('Default authorization preview changed');
    db.prepare('DELETE FROM auth_auto_grants WHERE resource_id=? AND resource_revision=?').run(resourceId,preview.resourceRevision);
    for(const grant of preview.after)db.prepare('INSERT INTO auth_auto_grants VALUES(?,?,?,?,?)').run(resourceId,preview.resourceRevision,grant.origin.ruleId,grant.origin.ruleRevision,JSON.stringify(grant));
    audit(actor,'default.recompute',resourceId,preview);return preview;
   });
  },
  applyDefaults(resourceId,{actor,context={}}={}){
   return databaseTransaction(db,()=>{
    const resource=get('resources',resourceId);
    if(!resource||resource.status!=='active'||resource.verification!=='verified'||resource.enforcement!=='enforced')throw Error('Resource is not verified and enforced');
    if(resource.defaultAuthorization==='explicit-only')return [];
    const activeGroups=new Set(list('groups').filter(group=>group.status==='active').map(group=>group.id));
    const applied=[];
    for(const stored of list('rules')){
     if(stored.kind!=='default'||!activeGroups.has(stored.groupId))continue;
     const {kind,revision,...rule}=stored;
     if(!permissionDefaultMatches(rule,resource))continue;
     const actions=rule.actions.filter(action=>resource.actions.includes(action));if(!actions.length)continue;
     const grant={...rule,actions,selector:{resourceIds:[resource.id]},origin:{kind:'default',ruleId:rule.id,ruleRevision:revision,resourceRevision:resource.revision}};
     const result=db.prepare('INSERT OR IGNORE INTO auth_auto_grants VALUES(?,?,?,?,?)').run(resource.id,resource.revision,rule.id,revision,JSON.stringify(grant));
     if(result.changes){audit(actor,'default.apply',resource.id,{ruleId:rule.id,ruleRevision:revision,resourceRevision:resource.revision});applied.push(grant);}
    }
    return applied;
   });
  },
  effectiveRules(resourceId){
   const resource=get('resources',resourceId);if(!resource)return [];
   const explicit=list('rules').filter(rule=>rule.kind==='explicit').map(({kind,revision,...rule})=>rule);
   const automatic=db.prepare('SELECT value FROM auth_auto_grants WHERE resource_id=? AND resource_revision=?').all(resourceId,resource.revision).map(row=>JSON.parse(row.value));
   return [...explicit,...automatic];
  },
  audit:(actor,action,target,value)=>databaseTransaction(db,()=>audit(actor,action,target,value)),
  history({limit=100}={}){if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('Invalid audit limit');return db.prepare('SELECT * FROM auth_audit ORDER BY rowid DESC LIMIT ?').all(limit).map(row=>({...row,value:JSON.parse(row.value)}));},
  close:()=>db.close(),
 };
}
