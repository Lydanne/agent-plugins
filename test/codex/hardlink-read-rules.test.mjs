import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,link,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sharedHardlinkReadRules} from '../../packages/agent-worker/hardlink-read-rules.mjs';
const exec=promisify(execFile),cli=process.env.WORKER_CODEX_CLI;
test('real Codex exact read rules block existing hardlinks, parent renames and new links without blocking private workspace edits',{skip:!cli,timeout:30000},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'codex-hardlink-rules-'))),source=join(root,'source'),cwd=join(root,'workspace'),home=join(root,'home');
 try{
  for(const dir of [source,cwd,home])await mkdir(dir);await writeFile(join(source,'fixture'),'original');await link(join(source,'fixture'),join(cwd,'existing-link'));await mkdir(join(cwd,'nested'));await link(join(source,'fixture'),join(cwd,'nested/linked'));await writeFile(join(cwd,'own'),'before');
  const rules=await sharedHardlinkReadRules(cwd,{deadline:Date.now()+10000}),filesystem={':root':'read',[cwd]:'write',...rules};
  const toml='{filesystem={'+Object.entries(filesystem).map(([path,mode])=>JSON.stringify(path)+'='+JSON.stringify(mode)).join(',')+'},network={enabled=false}}';
  // No model, user account, network service, or production files participate.
  const result=await exec(cli,['sandbox','--include-managed-config','-c','permissions.fixture='+toml,'-P','fixture','-C',cwd,'--','/bin/sh','-c','cat existing-link; printf blocked > existing-link; ln "$SOURCE" new-link; mv nested moved; printf blocked > moved/linked; printf private > own'],{cwd,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,SOURCE:join(source,'fixture')},timeout:15000});
  assert.match(result.stdout,/original/);assert.match(result.stderr,/Operation not permitted|Permission denied/);assert.equal(await readFile(join(source,'fixture'),'utf8'),'original');assert.equal(await readFile(join(cwd,'own'),'utf8'),'private');
 }finally{await rm(root,{recursive:true,force:true});}
});
