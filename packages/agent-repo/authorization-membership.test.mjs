import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePermissionGroups} from './authorization-membership.mjs';
const now=Date.parse('2026-11-04T01:00:00Z');
const nodes=[['p','person'],['d','department'],['parent','department'],['org','organization']].map(([id,type])=>({id,type,status:'active',sourceId:'tenant'}));
const edges=[['member_of','p','d'],['parent_department','d','parent'],['belongs_to','parent','org']].map(([type,fromId,toId])=>({type,fromId,toId,sourceId:'tenant',status:'active'}));
const binding=(id,entityId,entityType,membership)=>({id,entityId,entityType,membership,agentId:'ada',groupId:id,status:'active'});
const bindings=[binding('personal','p','person','self'),binding('direct','d','department','members'),binding('parentDirect','parent','department','members'),binding('tree','parent','department','descendants'),binding('organization','org','organization','members')];
const input={agentId:'ada',subject:{id:'p',agentId:'ada',sourceId:'tenant',verified:true},snapshot:{agentId:'ada',subjectId:'p',sourceId:'tenant',observedAt:new Date(now).toISOString(),complete:true,nodes,edges},bindings,groups:bindings.map(b=>({id:b.id,status:'active'})),now};
test('explicit department inheritance and organization membership',()=>assert.deepEqual(resolvePermissionGroups(input).groupIds,['personal','direct','tree','organization']));
test('fresh complete same-source evidence is mandatory',()=>{
 for(const patch of [{complete:false},{sourceId:'other'},{observedAt:'2026-11-03T00:00:00Z'},{observedAt:'2026-11-05T00:00:00Z'}])assert.equal(resolvePermissionGroups({...input,snapshot:{...input.snapshot,...patch}}).verified,false);
});
test('ended membership removes inherited rights; direct personal binding remains',()=>{
 const snapshot={...input.snapshot,edges:edges.map(e=>({...e,status:'ended'}))};assert.deepEqual(resolvePermissionGroups({...input,snapshot}).groupIds,['personal']);
});
test('disabled and expired bindings never grant',()=>{
 assert.deepEqual(resolvePermissionGroups({...input,bindings:bindings.map(b=>({...b,validUntil:new Date(now).toISOString()}))}).groupIds,[]);
 assert.deepEqual(resolvePermissionGroups({...input,groups:input.groups.map(g=>({...g,status:'disabled'}))}).groupIds,[]);
});
test('department cycles and incorrectly typed hierarchy edges cannot confer inherited permissions',()=>{
 for(const edge of [{type:'parent_department',fromId:'parent',toId:'d'},{type:'parent_department',fromId:'d',toId:'d'},{type:'parent_department',fromId:'parent',toId:'org'}]){
  const snapshot={...input.snapshot,edges:[...edges,{...edge,sourceId:'tenant',status:'active'}]};
  const result=resolvePermissionGroups({...input,snapshot});
  assert.equal(result.verified,false);assert.deepEqual(result.groupIds,[]);
 }
});
test('shared ancestors in an acyclic department graph remain valid',()=>{
 const snapshot={...input.snapshot,nodes:[...nodes,{id:'second',type:'department',status:'active',sourceId:'tenant'}],edges:[...edges,{type:'member_of',fromId:'p',toId:'second',sourceId:'tenant',status:'active'},{type:'parent_department',fromId:'second',toId:'parent',sourceId:'tenant',status:'active'}]};
 assert.deepEqual(resolvePermissionGroups({...input,snapshot}).groupIds,['personal','direct','tree','organization']);
});
