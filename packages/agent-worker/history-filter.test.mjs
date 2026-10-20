import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import plugin,{query} from './index.mjs';
import {createJobs} from './jobs.mjs';
import {validateHistoryFilter} from './project-binding.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');

test('history selector syntax and explicit project conflicts are rejected',()=>{
 for(const filter of [{projectId:''},{projectId:null},{projectId:'../a'},{repository:42},{repository:'projects/a/'},{repository:'/projects/a'},{repository:'projects/a/repositories/../b'}])assert.throws(()=>validateHistoryFilter(filter),{code:'PROJECT_SELECTOR_INVALID'});
 assert.throws(()=>validateHistoryFilter({projectId:'a',repository:'projects/b/repositories/frontend'}),{code:'PROJECT_SELECTOR_CONFLICT'});
 for(const filter of [{},{projectId:'a'},{repository:'project'},{repository:'project/repositories/frontend'},{projectId:'a',repository:'projects/a/repositories/frontend'}])validateHistoryFilter(filter);
});

test('list filters stored jobs and bindings before limits without requiring a project provider',async t=>{
 const base=new URL('../../.tmp/history-filter-tests/',import.meta.url);await mkdir(base,{recursive:true});
 const state=await mkdtemp(new URL('case-',base).pathname),scope='history-fixture',root=join(state,'jobs');await mkdir(root);
 t.after(()=>rm(state,{recursive:true,force:true}));
 const rows=[
  {projectId:'a',repository:'projects/a',createdAt:10},
  {projectId:'a',repository:'projects/a/repositories/frontend',createdAt:20,tags:['needle']},
  {projectId:'b',repository:'projects/b',createdAt:30,tags:['needle']},
  {createdAt:40},
  {projectId:'a',repository:'projects/a/repositories/frontend',createdAt:50,other:true},
  {projectId:'retired',repository:'projects/retired',createdAt:60},
 ].map(row=>({jobId:randomUUID(),scope:hash(row.other?'another-chat':scope),topic:'same',status:'completed',taskSummary:'fixture',tags:[],...row}));
 for(const row of rows)await writeFile(join(root,row.jobId+'.json'),JSON.stringify(row));
 const bindings=Object.fromEntries(rows.filter(row=>!row.other).map(row=>[row.jobId,{topic:row.topic,sessionId:randomUUID(),cwd:state,updatedAt:new Date(row.createdAt).toISOString(),...(row.projectId?{project:{projectId:row.projectId,repository:row.repository,root:state}}:{})}]));
 const bindingFile=join(state,hash(scope)+'.json');await writeFile(bindingFile,JSON.stringify(bindings));
 const before=await readFile(bindingFile,'utf8'),factories=[];
 plugin.register({pluginConfig:{state,cwd:state,skillsEnabled:false},registerService:()=>{},registerTool:f=>factories.push(f)});
 const tool=factories[0]({sessionKey:scope});
 const list=async filter=>JSON.parse((await tool.execute('',{action:'list',...filter})).content[0].text);
 const a=await list({projectId:'a'});
 assert.deepEqual(a.jobs.map(row=>row.repository),['projects/a/repositories/frontend','projects/a']);
 assert.deepEqual(a.tasks.map(row=>row.repository),a.jobs.map(row=>row.repository));
 assert.equal(a.jobPage.total,2);assert.equal(a.topicPage.total,2);
 const rootOnly=await list({repository:'projects/a'});assert.equal(rootOnly.jobs.length,1);assert.equal(rootOnly.tasks.length,1);
 const child=await list({projectId:'a',repository:'projects/a/repositories/frontend',query:'needle'});
 assert.equal(child.jobs.length,1);assert.equal(child.tasks.length,1);assert.equal(child.jobs[0].jobId,rows[1].jobId);
 const missing=await list({projectId:'missing'});assert.equal(missing.jobs.length,0);assert.equal(missing.tasks.length,0);
 const retired=await list({projectId:'retired'});assert.equal(retired.jobs[0].jobId,rows[5].jobId);
 const unfiltered=await list({});assert.equal(unfiltered.jobs.length,5);assert.equal(unfiltered.tasks.length,5);assert.ok(unfiltered.jobs.some(row=>row.projectId===undefined));
 const bounded=JSON.parse((await query({action:'list',projectId:'a'},{sessionKey:scope,jobListLimit:1})).content[0].text);
 assert.equal(bounded.jobs[0].jobId,rows[1].jobId);assert.equal(bounded.tasks[0].repository,rows[1].repository);
 assert.deepEqual(bounded.jobPage,{total:2,limit:1,hasMore:true});assert.deepEqual(bounded.topicPage,bounded.jobPage);
 const jobs=createJobs({root,node:process.execPath,worker:'/unused',getRuntime:()=>{throw Error('Must not prepare a project');}});
 assert.equal(jobs.search('another-chat',{projectId:'a'}).jobs[0].jobId,rows[4].jobId);
 assert.equal(jobs.search('absent-chat',{projectId:'a'}).jobs.length,0);
 assert.throws(()=>jobs.search(scope,{projectId:'a',repository:'projects/b'}),{code:'PROJECT_SELECTOR_CONFLICT'});
 for(const filter of [{projectId:'../a'},{repository:'../a'},{projectId:'a',repository:'projects/b'},{expectedRegistryRevision:'unused'}])await assert.rejects(list(filter),/PROJECT_SELECTOR_(?:INVALID|CONFLICT)/);
 for(const action of ['status','wait','cancel','projects','tag','reply','await_user'])await assert.rejects(query({action,projectId:'a'},{sessionKey:scope}),/PROJECT_SELECTOR_INVALID/);
 assert.equal(await readFile(bindingFile,'utf8'),before);
});
