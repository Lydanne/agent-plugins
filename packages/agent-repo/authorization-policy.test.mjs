import test from 'node:test';
import assert from 'node:assert/strict';
import {permissionActions,defaultPermissionGroups,evaluatePermissions,validatePermissionRule} from './authorization-policy.mjs';
const resource={id:'order',agentId:'ada',kind:'data',provider:'xgj',actions:['read','update'],revision:'1',status:'active',verification:'verified',enforcement:'enforced',behavior:{atomicity:'guaranteed'}};
const allow={id:'read',groupId:'internal',effect:'allow',actions:['read'],selector:{}};
const input={agentId:'ada',subject:{id:'person',agentId:'ada',verified:true},groups:['internal'],rules:[allow],requirements:[{resource,action:'read'}]};
test('nine actions and three named default groups',()=>{assert.equal(permissionActions.length,9);assert.deepEqual(defaultPermissionGroups.map(g=>g.name),['管理员组','内部组','外部组']);});
test('default deny and explicit deny across groups',()=>{
 assert.equal(evaluatePermissions(input).allowed,true);
 assert.equal(evaluatePermissions({...input,rules:[]}).allowed,false);
 assert.equal(evaluatePermissions({...input,groups:['internal','external'],rules:[allow,{...allow,id:'deny',groupId:'external',effect:'deny'}]}).checks[0].reason,'EXPLICIT_DENY');
});
test('all required operations need independent authorization',()=>{
 assert.equal(evaluatePermissions({...input,requirements:[...input.requirements,{resource,action:'update'}]}).allowed,false);
});
test('scope identity and enforcement are hard boundaries',()=>{
 for(const patch of [{agentId:'other'},{status:'removed'},{verification:'pending'},{enforcement:'missing'}])assert.equal(evaluatePermissions({...input,requirements:[{resource:{...resource,...patch},action:'read'}]}).allowed,false);
 assert.equal(evaluatePermissions({...input,subject:{...input.subject,verified:false}}).allowed,false);
 assert.equal(evaluatePermissions({...input,requirements:[]}).allowed,false);
});
test('conditions cannot be composed from unrelated grants or unknown attributes',()=>{
 const rules=[{...allow,conditions:{environment:['test'],atomicity:['guaranteed']}},{...allow,id:'other',conditions:{environment:['prod'],atomicity:['unknown']}}];
 assert.equal(evaluatePermissions({...input,rules,context:{environment:'prod'}}).allowed,false);
 assert.equal(evaluatePermissions({...input,rules,context:{environment:'test'}}).allowed,true);
 assert.throws(()=>validatePermissionRule({...allow,conditions:{script:['true']}}));
});
test('task ceiling never expands and binds resource revision',()=>{
 assert.equal(evaluatePermissions({...input,ceiling:[]}).allowed,false);
 assert.equal(evaluatePermissions({...input,ceiling:[{resourceId:'order',action:'read',revision:'0'}]}).allowed,false);
 assert.equal(evaluatePermissions({...input,ceiling:[{resourceId:'order',action:'read',revision:'1'}]}).allowed,true);
});
test('parameter rules constrain actual payloads and reject missing, inherited or malformed fields',()=>{
 const rule={...allow,parameters:[{path:'account',op:'equals',value:'allowed'},{path:'limit',op:'max',value:10},{path:'fields',op:'subset',value:['id','status']}]};
 assert.equal(evaluatePermissions({...input,rules:[rule],parameters:{account:'allowed',limit:5,fields:['id']}}).allowed,true);
 for(const params of [{account:'other',limit:5,fields:['id']},{account:'allowed',limit:11,fields:['id']},{account:'allowed',limit:5,fields:['password']},{limit:5,fields:['id']},Object.assign(Object.create({account:'allowed'}),{limit:5,fields:['id']})])assert.equal(evaluatePermissions({...input,rules:[rule],parameters:params}).allowed,false);
 assert.throws(()=>validatePermissionRule({...allow,parameters:[{path:'__proto__.x',op:'present',value:true}]}));
 assert.throws(()=>validatePermissionRule({...allow,parameters:[{path:'limit',op:'max',value:'10'}]}));
});
test('all-operation effects honor scope and deny wins across groups in either order',()=>{
 const grant={...allow,effect:'allow_all',actions:[]};
 const block={...grant,id:'blocked',groupId:'external',effect:'deny_all',selector:{resourceIds:[resource.id]}};
 const evaluate=(rules,groups)=>evaluatePermissions({...input,rules,groups,requirements:resource.actions.map(action=>({resource,action}))});
 assert.equal(evaluate([grant,block],['internal']).allowed,true);
 for(const rules of [[grant,block],[block,grant]])assert.ok(evaluate(rules,['internal','external']).checks.every(check=>check.reason==='EXPLICIT_DENY'));
 assert.equal(evaluate([grant,{...block,selector:{resourceIds:['other']}}],['internal','external']).allowed,true);
});
