import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {git} from './repository-skills.mjs';
import {readSubagentSource,resolveSubagentCatalog} from './subagents.mjs';
async function fixture(t){const base=fileURLToPath(new URL('../../.tmp/subagent-tests/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'repo-'));t.after(()=>rm(root,{recursive:true,force:true}));await git(root,['init','-b','main']);return root;}
async function file(root,path,body){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),body);}
async function commit(root){await git(root,['add','.']);await git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','fixture']);}
test('discovers committed scoped Markdown, native Codex TOML, role registration and OpenCode metadata only',async t=>{
 const root=await fixture(t);
 await file(root,'.agents/agents/reviewer.md','---\nname: review\ndescription: Shared reviewer\nmodel: fixture\n---\nInstructions');
 await file(root,'.agents/agents/README.md','# Not an agent');
 await file(root,'.agents/skills/demo/agents/openai.yaml','name: not-a-subagent');
 await file(root,'.codex/agents/explorer.toml','name = "explore"\ndescription = "Native TOML"\nmodel = "fixture-model"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = """\nprivate instructions\n"""');
 await file(root,'.codex/config.toml','[agents]\nmax_threads = 4\n[agents.legacy]\ndescription = "Legacy role"\nconfig_file = "agents/legacy.toml"\n[mcp_servers.secret]\nurl = "credential-never-return"');
 await file(root,'.codex/agents/legacy.toml','model = "legacy-model"\ndeveloper_instructions = "private instructions"');
 await file(root,'.opencode/agents/audit.md','---\ndescription: Audit code\nmode: subagent\nhidden: true\nmodel: provider/model\n---\nPrivate instructions');
 await file(root,'.opencode/agents/build.md','---\nmode: primary\n---\nBuild');
 await file(root,'.opencode/agent/old.md','---\nmode: all\n---\nOld format');
 await file(root,'.opencode/opencode.jsonc','{ // comment\n"agent": {"disabled": {"description":"Disabled role","disable":true,},},"provider":{"secret":"credential-never-return"},}');
 await commit(root);const before=await git(root,['status','--porcelain']),source=await readSubagentSource(root,root,'project');resolveSubagentCatalog([source]);
 assert.deepEqual(source.subagents.map(a=>a.name).sort(),['audit','disabled','explore','legacy','old','review']);assert.equal(source.warnings.length,0);
 assert.equal(source.subagents.find(a=>a.name==='legacy').model,'legacy-model');assert.equal(source.subagents.find(a=>a.name==='legacy').definitionPath,'.codex/agents/legacy.toml');
 assert.equal(source.subagents.find(a=>a.name==='audit').hidden,true);assert.equal(source.subagents.find(a=>a.name==='disabled').status,'disabled');
 assert.ok(source.subagents.every(a=>a.updatedAt&&a.updatedCommit));assert.ok(!JSON.stringify(source).includes('credential-never-return'));assert.ok(!JSON.stringify(source).includes('private instructions'));
 await file(root,'.codex/agents/legacy.toml','model = "new-model"');await commit(root);const changed=await readSubagentSource(root,root,'project');assert.equal(changed.subagents.find(a=>a.name==='legacy').updatedCommit,(await git(root,['rev-parse','HEAD'])).trim());
 assert.equal(await git(root,['status','--porcelain']),before);
});
test('malformed, linked, escaped and duplicate definitions fail locally without leaking config or hiding valid siblings',async t=>{
 const root=await fixture(t);
 await file(root,'.agents/agents/valid.md','---\nname: valid\ndescription: Committed\n---\nInstructions');
 await file(root,'.agents/agents/bad.md','---\nname: [\n---\nBAD_SECRET');
 await file(root,'.codex/agents/bad.toml','name = "bad"\nmodel = [ BROKEN_SECRET');
 await file(root,'.codex/agents/one.toml','name = "duplicate"');await file(root,'.codex/agents/two.toml','name = "duplicate"');
 await file(root,'.codex/config.toml','[agents.escape]\nconfig_file = "../../outside.toml"\n[agents.absolute]\nconfig_file = "/tmp/outside.toml"\n[agents.missing]\nconfig_file = "roles/missing.toml"');
 await symlink('/tmp/outside-agent.md',join(root,'.agents/agents/link.md'));await commit(root);
 await file(root,'.agents/agents/valid.md','---\nname: valid\ndescription: Dirty\n---\nInstructions');await file(root,'.agents/agents/untracked.md','New');
 const source=await readSubagentSource(root,root,'project');resolveSubagentCatalog([source]);
 assert.equal(source.state,'dirty');assert.equal(source.subagents.find(a=>a.name==='valid').description,'Committed');assert.equal(source.subagents.find(a=>a.name==='valid').status,'pending_commit');
 assert.ok(!source.subagents.some(a=>['escape','absolute','missing','untracked','link'].includes(a.name)));assert.equal(source.warnings.length,6);assert.ok(!JSON.stringify(source).includes('BROKEN_SECRET'));assert.ok(!JSON.stringify(source).includes('BAD_SECRET'));
 assert.ok(source.subagents.filter(a=>a.name==='duplicate').every(a=>a.status==='disabled'));
});
test('directory overlay uses provider and name, preserving independent harness definitions and disabled fallbacks',()=>{
 const value=(provider,name,path,disabledReason=null)=>({provider,name,path,disabledReason});
 const project={source:'project',state:'available',subagents:[value('codex','review','root.toml'),value('agents','review','root.md')]},child={source:'repository',state:'available',subagents:[value('codex','review','child.toml'),value('agents','review','child.md','disabled')]},agent={source:'agent',state:'available',subagents:[value('opencode','review','shared.md')]};
 assert.equal(resolveSubagentCatalog([project,child,agent]),3);assert.equal(project.subagents[0].status,'shadowed');assert.equal(project.subagents[0].overriddenBy,'child.toml');assert.equal(project.subagents[1].status,'candidate');assert.equal(child.subagents[1].status,'disabled');assert.equal(agent.subagents[0].status,'candidate');
});

test('linked definition directories are reported without following a sibling repository',async t=>{
 const root=await fixture(t),sibling=await fixture(t);await file(sibling,'.agents/agents/foreign.md','Foreign prompt');await commit(sibling);
 await mkdir(join(root,'.agents'),{recursive:true});await symlink(join(sibling,'.agents/agents'),join(root,'.agents/agents'));await file(root,'.codex/agents/good.toml','name = "good"');await commit(root);
 const source=await readSubagentSource(root,root,'project');assert.deepEqual(source.subagents.map(a=>a.name),['good']);assert.equal(source.warnings.length,1);assert.ok(!JSON.stringify(source).includes('Foreign prompt'));
});
