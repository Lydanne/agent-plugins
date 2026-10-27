import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateModelConfiguration} from './migrate-model-config.mjs';
import {defaultHermesTemplates,hermesCommand} from './hermes-templates.mjs';
import {resolveConfiguration,resolveQueueExecution,executionFingerprint} from './configuration.mjs';
import {defaultTaskQueues} from './task-queues.mjs';

test('migration preserves effective parameters, queue capacities and immutable input',()=>{
 const input={modelProfiles:{default:{enabled:true,harness:'codex',model:'base',reasoningEffort:'medium',speed:'fast',thinkingProfiles:{6:{model:'ignored'}}}},defaultModelId:'default',thinkingLevel:6,
 hermesTemplates:{codex:{...defaultHermesTemplates.codex,variables:{model:'template'}}},taskQueues:{short:{...defaultTaskQueues.short,hermesVariables:{}},long:{...defaultTaskQueues.long,hermesVariables:{model:'queue',reasoningEffort:'max'}}}};
 const copy=structuredClone(input),out=migrateModelConfiguration(input);
 assert.deepEqual(input,copy);assert.equal(out.modelProfiles,undefined);assert.equal(out.thinkingLevel,undefined);
 assert.deepEqual(out.hermesTemplates.codex.variables,{});
 assert.equal(resolveQueueExecution(out).model,'template');assert.equal(resolveQueueExecution(out).speed,'fast');
 assert.equal(resolveQueueExecution(out,{queueId:'long'}).model,'queue');assert.equal(resolveQueueExecution(out,{queueId:'long'}).reasoningEffort,'max');
 assert.equal(out.taskQueues.short.maxConcurrentJobs,3);assert.deepEqual(migrateModelConfiguration(out),out);
});
test('migration refuses ambiguous or disabled profiles and template overrides are rejected',()=>{
 for(const profiles of [{},{a:{enabled:false}},{a:{enabled:true},b:{enabled:true}}])assert.throws(()=>migrateModelConfiguration({modelProfiles:profiles}),/exactly one/);
 for(const key of ['model','reasoningEffort','speed'])assert.throws(()=>resolveConfiguration({hermesTemplates:{codex:{...defaultHermesTemplates.codex,variables:{[key]:'old'}}}}),/only in taskQueues/);
});
test('frozen historical template/profile snapshot keeps command and identity after resolution',()=>{
 const frozen=structuredClone(resolveQueueExecution({})),before=hermesCommand(frozen),fingerprint=executionFingerprint(frozen);
 frozen.modelProfiles={old:{enabled:true,model:'unrelated'}};frozen.defaultModelId='old';frozen.thinkingProfiles={6:{model:'wrong'}};frozen.thinkingLevel=6;
 frozen.hermesTemplates.codex.variables.model='historical';
 assert.deepEqual(hermesCommand(resolveConfiguration(frozen)),before);
 assert.equal(executionFingerprint(resolveConfiguration(frozen)),fingerprint);
});
