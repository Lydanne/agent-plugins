import {test} from 'node:test';
import assert from 'node:assert/strict';
import {explainQueryError,describeQueryJob,rememberDiagnostic,queryDiagnostics,diagnosticKey} from './diagnostics.mjs';
test('classifies safe reasons without exposing raw diagnostic secrets',()=>{
 for(const [text,code] of [['Codex query exceeded 10 minutes','TIMEOUT'],['OpenClaw dynamic tool call aborted.','INTERRUPTED'],['No active source-bound task; execution is not authorized','SOURCE_INVALID'],['HTTP 429 secret=private','RATE_LIMIT'],['ECONNRESET token=private','NETWORK'],['Invalid jobId','INVALID_REQUEST'],['unrecognized private output','UNKNOWN']]) {
  const value=explainQueryError(Error(text));assert.equal(value.code,code);assert.ok(!value.message.includes('private'));
  if(code!=='UNKNOWN')assert.equal(explainQueryError(value.message).code,code);
 }
});
test('distinguishes job completion, ongoing work and failure',()=>{
 assert.match(describeQueryJob({status:'completed'}),/已完成/);
 assert.match(describeQueryJob({status:'running'}),/仍在执行/);
 assert.match(describeQueryJob({status:'unknown'}),/无法确认/);
 assert.match(describeQueryJob({status:'timed_out',error:'Codex query exceeded 10 minutes'}),/10 分钟/);
});
test('records diagnostic reader before it is resolved and scopes by trusted identity',()=>{
 const context={agentAccountId:'a',sessionKey:'s',requesterSenderId:'u'};let status='running';
 rememberDiagnostic(context,()=>describeQueryJob({status}));
 assert.match(queryDiagnostics.get(diagnosticKey(context)).read(),/仍在执行/);
 status='completed';assert.match(queryDiagnostics.get(diagnosticKey(context)).read(),/已完成/);
 assert.equal(diagnosticKey({...context,requesterSenderId:undefined}),undefined);
 queryDiagnostics.clear();
});

test('preserves model rejection through repeated safe classification',()=>{
 const raw="The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.";
 const first=explainQueryError(raw);assert.equal(first.code,'MODEL_UNAVAILABLE');assert.deepEqual(explainQueryError(first.message),first);
});
