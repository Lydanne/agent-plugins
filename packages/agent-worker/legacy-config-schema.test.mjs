import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolveConfiguration,resolveQueueExecution} from './configuration.mjs';
// Exercise the host's public schema validator, not just the plugin normalizer.
const require=createRequire(new URL('../feishu/package.json',import.meta.url));
const {validateJsonSchemaValue}=require('openclaw/plugin-sdk/json-schema-runtime');
const manifest=JSON.parse(readFileSync(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
const schema=manifest.configSchema;
test('host accepts retired level settings before plugin initialization, without reviving level behavior',()=>{
 const old={thinkingLevel:6,thinkingProfiles:{'6':{model:'old-override'}},modelProfiles:{default:{enabled:true,harness:'codex',model:'fixture',reasoningEffort:'low',thinkingProfiles:{'6':{reasoningEffort:'max',speed:'fast'}}}}};
 const original=structuredClone(old);
 for(const applyDefaults of [false,true]){
  const result=validateJsonSchemaValue({schema,value:structuredClone(old),applyDefaults});assert.equal(result.ok,true,JSON.stringify(result));
  const config=resolveConfiguration(result.value);
  assert.equal(config.thinkingLevel,undefined);assert.equal(config.thinkingProfiles,undefined);assert.equal(config.modelProfiles.default.thinkingProfiles,undefined);
  const execution=resolveQueueExecution(config);assert.equal(execution.model,'fixture');assert.equal(execution.reasoningEffort,'low');assert.equal(execution.speed,undefined);
 }
 assert.deepEqual(old,original);
 for(const key of ['thinkingLevel','thinkingProfiles']){
  assert.equal(schema.properties[key].deprecated,true);assert.equal(Object.hasOwn(schema.properties[key],'default'),false);
 }
 for(const bad of [{thinkingLevel:7},{thinkingLevel:'6'},{thinkingProfiles:[]},{unrelatedField:true}])assert.equal(validateJsonSchemaValue({schema,value:bad,applyDefaults:false}).ok,false);
});

test('host defaults preserve legacy queue timeouts and explicit queues take precedence',()=>{
 const legacy={timeoutMs:90000,longTimeoutMs:7200000};
 for(const input of [{},legacy,{...legacy,taskQueues:{build:{name:'Build',timeoutMs:45000,maxConcurrentJobs:2,maxQueuedJobs:7}},defaultQueueId:'build'}]){
  const expected=resolveConfiguration(input);
  for(const applyDefaults of [false,true]){
   const result=validateJsonSchemaValue({schema,value:structuredClone(input),applyDefaults});assert.equal(result.ok,true,JSON.stringify(result));
   if(!Object.hasOwn(input,'taskQueues'))assert.equal(Object.hasOwn(result.value,'taskQueues'),false);
   const actual=resolveConfiguration(result.value);assert.deepEqual(actual.taskQueues,expected.taskQueues);assert.equal(actual.defaultQueueId,expected.defaultQueueId);
  }
 }
 assert.equal(Object.hasOwn(schema.properties.taskQueues,'default'),false);
});
