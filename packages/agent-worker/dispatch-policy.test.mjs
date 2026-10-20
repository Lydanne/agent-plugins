import test from 'node:test';
import assert from 'node:assert/strict';
import {asyncRunRequested,waitForQueryJob,discoverTopics} from './dispatch-policy.mjs';
import {explainQueryError} from './diagnostics.mjs';

test('async configuration cannot be overridden by a synchronous run argument',()=>{
 assert.equal(asyncRunRequested({}, {asyncCompletionEnabled:true}),true);
 assert.equal(asyncRunRequested({deliveryMode:'async'},{}),true);
 assert.equal(asyncRunRequested({deliveryMode:'wait'},{}),false);
 assert.throws(()=>asyncRunRequested({deliveryMode:'wait'},{asyncCompletionEnabled:true}),error=>explainQueryError(error).code==='ASYNC_REQUIRED');
});

test('async waits return immediate state including persisted jobs after config is disabled',async()=>{
 for(const [context,notification] of [[{asyncCompletionEnabled:true},undefined],[{}, {state:'pending'}]]) {
  let waited=false;
  const job={status:'running',notification};
  const result=await waitForQueryJob({jobId:'fixture',waitSeconds:30},{sessionKey:'group',...context},{status:()=>job,wait:()=>{waited=true;throw Error('must not block');}});
  assert.equal(waited,false);assert.equal(result.status,'running');assert.equal(result.waitSkipped,true);
 }
});

test('legacy synchronous jobs retain explicit waiting when async is disabled',async()=>{
 let args;
 const result=await waitForQueryJob({jobId:'fixture',waitSeconds:7},{sessionKey:'group'},{status:()=>({status:'running'}),wait:(...value)=>{args=value;return {status:'completed'};}});
 assert.deepEqual(args,['fixture','group',7]);assert.equal(result.status,'completed');
});

test('topic discovery bounds recent topics and finds older exact issues before applying the setting',()=>{
 const topics=Array.from({length:15},(_,i)=>({topic:`issue-${i}`,sessionId:`session-${i}`,updatedAt:new Date(1000*i).toISOString()}));
 const selected=discoverTopics(topics,{limit:3});
 assert.deepEqual(selected.tasks.map(t=>t.topic),['issue-14','issue-13','issue-12']);
 assert.deepEqual(selected.topicPage,{total:15,limit:3,hasMore:true});
 assert.equal(discoverTopics(topics,{query:'ISSUE-0',limit:3}).tasks[0].sessionId,'session-0');
 assert.deepEqual(discoverTopics(topics,{query:'openid-label',limit:3,jobTopics:['issue-1']}).tasks.map(t=>t.topic),['issue-1']);
 assert.equal(discoverTopics(topics,{query:'missing'}).tasks.length,0);
 assert.equal(discoverTopics(topics).tasks.length,10);
});

test('matching project jobs do not expose same-name topics from another project or repository',()=>{
 const topics=[{topic:'same',projectId:'a',repository:'projects/a'},{topic:'same',projectId:'b',repository:'projects/b'},{topic:'same',projectId:'b',repository:'projects/b/repositories/frontend'}];
 assert.deepEqual(discoverTopics(topics,{query:'business-record',jobTopics:[topics[1]]}).tasks,[topics[1]]);
 assert.deepEqual(discoverTopics(topics,{query:'projects/a'}).tasks,[topics[0]]);
});
