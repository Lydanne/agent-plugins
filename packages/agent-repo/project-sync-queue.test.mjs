import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectSyncQueue} from './project-sync-queue.mjs';
test('project requests coalesce, retry busy readers after cooldown, and service stop drains work',async()=>{
 let now=0,calls=0;const queue=createProjectSyncQueue({clock:()=>now,cooldownMs:10});const run=async()=>{calls++;return calls>1;};queue.enqueue('project',run);queue.enqueue('project',run);await queue.tick();assert.equal(calls,1);await queue.tick();assert.equal(calls,1);now=11;await queue.tick();assert.equal(calls,2);await queue.tick();assert.equal(calls,2);
 let release;queue.enqueue('another',()=>new Promise(resolve=>{release=resolve;}));const running=queue.tick();let stopped=false;const stop=queue.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);release(true);await running;await stop;queue.enqueue('last',run);await queue.tick();assert.equal(calls,2);
});
