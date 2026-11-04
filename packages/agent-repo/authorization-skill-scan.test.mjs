import test from 'node:test';
import assert from 'node:assert/strict';
import {scanAuthorizationSkills} from './authorization-skill-scan.mjs';
test('root and child skills retain independent identity and partial failures are explicit',async()=>{
 const calls=[],catalog={skills:[{name:'same',path:'skill'}],snapshot:{repositorySources:[{head:'one'}]}};
 const result=await scanAuthorizationSkills({repo:'/fixture'},{agentId:'ada'},{agentSkills:async()=>catalog,readProjects:async()=>({p:{projectId:'p',repository:'projects/p'}}),containedPath:async()=>'/fixture/children',readdir:async()=>[{name:'child',isDirectory:()=>true,isSymbolicLink:()=>false},{name:'linked',isDirectory:()=>true,isSymbolicLink:()=>true}],repositorySkills:async(_binding,scope)=>{calls.push(scope.repository);if(scope.repository.endsWith('child'))throw Error('uncommitted');return catalog;}});
 assert.deepEqual(calls,['projects/p','projects/p/repositories/child']);assert.equal(result.skills.length,2);assert.equal(result.complete,false);assert.equal(result.failures[0].scope,'projects/p/repositories/child');
});
