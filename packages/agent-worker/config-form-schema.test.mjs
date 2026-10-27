import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaultHermesTemplates,validateHermesTemplates} from './hermes-templates.mjs';
import {defaultTaskQueues,resolveTaskQueues} from './task-queues.mjs';

const manifest=JSON.parse(readFileSync(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
// OpenClaw 2026.10.7 Control UI's schema analyzer accepts these keywords used by
// our dictionaries. It rejects minProperties/maxProperties at the whole node.
// Keep this compatibility contract here rather than importing private host UI bundles.
const formKeywords=new Set(['type','default','description','title','deprecated','properties','propertyNames','additionalProperties','required','items','enum','pattern','minLength','maxLength','minimum','maximum','minItems','maxItems','uniqueItems']);
function checkFormSchema(schema,path){
 assert.ok(schema&&typeof schema==='object'&&!Array.isArray(schema),path);
 for(const key of Object.keys(schema))assert.ok(formKeywords.has(key),`${path}: unsupported Control UI keyword ${key}`);
 for(const [key,child] of Object.entries(schema.properties??{}))checkFormSchema(child,`${path}.${key}`);
 for(const key of ['propertyNames','items','additionalProperties'])if(schema[key]&&typeof schema[key]==='object')checkFormSchema(schema[key],`${path}.${key}`);
}

test('Hermes and queue dictionaries remain editable in the host configuration form',()=>{
 for(const key of ['hermesTemplates','taskQueues']){
  const schema=manifest.configSchema.properties[key];checkFormSchema(schema,key);
  assert.equal(schema.type,'object');assert.equal(schema.propertyNames.type,'string');assert.ok(schema.propertyNames.pattern);
  assert.equal(schema.additionalProperties.type,'object');
 }
});

test('runtime retains dictionary size limits without unsupported form keywords',()=>{
 const templates=n=>Object.fromEntries(Array.from({length:n},(_,i)=>['template'+i,structuredClone(defaultHermesTemplates.codex)]));
 const queues=n=>Object.fromEntries(Array.from({length:n},(_,i)=>['queue'+i,structuredClone(defaultTaskQueues.short)]));
 assert.doesNotThrow(()=>validateHermesTemplates(templates(50)));
 assert.doesNotThrow(()=>resolveTaskQueues({taskQueues:queues(50),defaultQueueId:'queue0'}));
 for(const size of [0,51]){
  assert.throws(()=>validateHermesTemplates(templates(size)),/Invalid hermesTemplates/);
  assert.throws(()=>resolveTaskQueues({taskQueues:queues(size),defaultQueueId:'queue0'}),/Invalid taskQueues/);
 }
});
