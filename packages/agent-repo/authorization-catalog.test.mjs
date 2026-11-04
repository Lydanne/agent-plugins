import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAuthorizationStore} from './authorization-store.mjs';
import {scanPermissionResources} from './authorization-catalog.mjs';
test('discovery includes core tools and active plugin tools; changed capabilities lose verification',()=>{
 const rows=new Map(),store={transaction:callback=>callback(),agentId:'ada',get:(_,id)=>rows.get(id),saveResource:(value,{expectedRevision})=>{const result={...value,revision:expectedRevision+1};rows.set(value.id,result);return result;}};
 const inventory={plugins:{plugins:[{id:'p',version:'1',runtime:{state:'active'}},{id:'off',runtime:{state:'disabled'}}]},catalog:{agentId:'ada',groups:[{source:'core',tools:[{id:'exec'}]},{source:'plugin',pluginId:'p',tools:[{id:'query',description:'read only'}]},{source:'plugin',pluginId:'off',tools:[{id:'hidden'}]}]}};
 assert.equal(scanPermissionResources(store,inventory,{actor:'scanner'}).discovered,2);
 assert.equal(rows.get('tool://p/query').verification,'pending');
 rows.get('tool://p/query').verification='verified';
 assert.equal(scanPermissionResources(store,inventory,{actor:'scanner'}).changed,0);
 inventory.catalog.groups[1].tools[0].description='now writes';
 assert.equal(scanPermissionResources(store,inventory,{actor:'scanner'}).changed,1);
 assert.equal(rows.get('tool://p/query').verification,'pending');
 assert.equal(rows.get('tool://p/query').enforcement,'missing');
});
test('invalid full inventory is rejected before writes',()=>{
 let writes=0;const store={transaction:callback=>callback(),agentId:'ada',saveResource:()=>writes++};
 assert.throws(()=>scanPermissionResources(store,{plugins:{plugins:[]},catalog:{agentId:'ada',groups:[{source:'core',tools:[{id:'valid'},{}]}]}}));assert.equal(writes,0);
});
test('CLI inventory preserves command transport and never executes commands',()=>{
 const rows=new Map(),store={transaction:callback=>callback(),agentId:'ada',get:(_,id)=>rows.get(id),saveResource:(value)=>{rows.set(value.id,value);return {...value,revision:1};}};
 scanPermissionResources(store,{plugins:{plugins:[{id:'p',runtime:{state:'active'}}]},catalog:{agentId:'ada',groups:[]},commands:[{pluginId:'p',tools:[{name:'orders',command:'order',actions:['get','update']}],management:['save'],automation:[],local:[]}]},{actor:'scanner'});
 assert.equal(rows.size,3);assert.equal(rows.get('cli://p/order%20get').definition.action,'get');
 assert.equal(rows.get('cli://p/order%20update').verification,'pending');assert.equal(rows.get('cli://p/management%20save').definition.transport,'management');
});
test('builtin fingerprints include provider upgrades and core input schema changes',()=>{
 const rows=new Map(),store={transaction:callback=>callback(),agentId:'ada',get:(_,id)=>rows.get(id),applyDefaults:()=>{},saveResource:(value,{expectedRevision})=>{const saved={...value,revision:expectedRevision+1};rows.set(value.id,saved);return saved;}};
 const inventory={plugins:{plugins:[{id:'agent-worker',version:'1',runtime:{state:'active'}}]},catalog:{agentId:'ada',groups:[{source:'core',tools:[{id:'exec',parameters:{type:'object'}}]}]}};
 scanPermissionResources(store,inventory,{actor:'scanner'});
 assert.equal(scanPermissionResources(store,inventory,{actor:'scanner'}).changed,0);
 inventory.plugins.plugins[0].version='2';scanPermissionResources(store,inventory,{actor:'scanner'});
 assert.equal(rows.get('tool://agent-worker/agent_worker/run').revision,2);
 assert.equal(rows.get('tool://openclaw/exec').revision,1);
 inventory.catalog.groups[0].tools[0].parameters={type:'object',properties:{elevated:{type:'boolean'}}};
 scanPermissionResources(store,inventory,{actor:'scanner'});
 assert.equal(rows.get('tool://openclaw/exec').revision,2);
});
test('adapted enforcement and default-authorization changes create new resource revisions',()=>{
 const rows=new Map(),store={transaction:callback=>callback(),agentId:'ada',get:(_,id)=>rows.get(id),applyDefaults:()=>{},saveResource:(value,{expectedRevision})=>{const saved={...value,revision:expectedRevision+1};rows.set(value.id,saved);return saved;}};
 const descriptor={id:'adapter://p/test',agentId:'ada',provider:'p',kind:'tool',actions:['execute'],adapter:{id:'p',revision:'1'},definition:{},status:'active',verification:'verified',enforcement:'enforced'};
 const inventory={plugins:{plugins:[]},catalog:{agentId:'ada',groups:[]},adapted:[descriptor]};
 scanPermissionResources(store,inventory,{actor:'scanner'});
 descriptor.defaultAuthorization='explicit-only';scanPermissionResources(store,inventory,{actor:'scanner'});
 assert.equal(rows.get(descriptor.id).revision,2);
 descriptor.enforcement='missing';scanPermissionResources(store,inventory,{actor:'scanner'});
 assert.equal(rows.get(descriptor.id).revision,3);
});
test('a late invalid descriptor rolls back earlier resources, grants and audits atomically',t=>{
 const root=mkdtempSync(join(tmpdir(),'authorization-scan-')),store=createAuthorizationStore(root,{agentId:'ada'});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const inventory={plugins:{plugins:[{id:'agent-repo',version:'1',runtime:{state:'active'}}]},catalog:{agentId:'ada',groups:[]},adapted:[{id:'adapter://broken/item',agentId:'ada',provider:'broken',kind:'tool',adapter:{id:'broken',revision:'1'},actions:['invalid'],status:'active',verification:'verified',enforcement:'enforced'}]};
 assert.throws(()=>scanPermissionResources(store,inventory,{actor:'scanner'}),/Invalid permission resource/);
 assert.deepEqual(store.list('resources'),[]);assert.deepEqual(store.history(),[]);
 inventory.adapted=[];
 const result=scanPermissionResources(store,inventory,{actor:'scanner'});assert.ok(result.discovered>0);
 assert.equal(store.get('resources','data://agent-repo/entities').revision,1);
 assert.ok(store.effectiveRules('data://agent-repo/entities').length>0);
});
