import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,link,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createFileTool,fileOperation} from './authorization-files.mjs';
test('controlled file reads enforce the public SDK boundary against links and traversal',async t=>{
 const dir=await mkdtemp(tmpdir()+'/auth-files-');t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(dir+'/sample','data');
 const tool=createFileTool(dir);assert.equal((await tool.execute('id',{action:'read',path:'sample'})).content[0].text,'data');
 await symlink(dir+'/sample',dir+'/linked');await assert.rejects(tool.execute('id',{action:'read',path:'linked'}));
 await link(dir+'/sample',dir+'/hard');await assert.rejects(tool.execute('id',{action:'read',path:'hard'}));
 for(const path of ['../sample','/etc/passwd','.runtime/authorization.sqlite','a/../sample','a//sample'])assert.equal(fileOperation({toolName:'agent_file',params:{action:'read',path}}),undefined);
});
test('create cannot overwrite and write requires both create and update',async t=>{
 const dir=await mkdtemp(tmpdir()+'/auth-file-write-');t.after(()=>rm(dir,{recursive:true,force:true}));const tool=createFileTool(dir);
 await tool.execute('id',{action:'create',path:'new',content:'first'});await assert.rejects(tool.execute('id',{action:'create',path:'new',content:'overwrite'}));
 assert.equal((await tool.execute('id',{action:'read',path:'new'})).content[0].text,'first');
 assert.deepEqual(fileOperation({toolName:'agent_file',params:{action:'write',path:'new',content:'second'}}).requirements.map(r=>r.action),['execute','create','update']);
 await tool.execute('id',{action:'write',path:'new',content:'second'});assert.equal((await tool.execute('id',{action:'read',path:'new'})).content[0].text,'second');
 await symlink(dir+'/new',dir+'/alias');await assert.rejects(tool.execute('id',{action:'write',path:'alias',content:'bad'}));
});
