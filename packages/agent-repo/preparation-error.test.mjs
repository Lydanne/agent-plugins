import test from 'node:test';
import assert from 'node:assert/strict';
import {preparationDiagnostic,diagnosticError} from './preparation-error.mjs';
test('known preparation failures are actionable and preserve the primary cause',()=>{
 const d=preparationDiagnostic(new Error('Repository version changed after prompt preparation'));
 assert.equal(d.code,'AGENT_REPO_REPOSITORY_CHANGED');assert.deepEqual(preparationDiagnostic(diagnosticError(d)),d);
 assert.equal(preparationDiagnostic(new Error('prompt hook invocation is no longer active')).code,'AGENT_REPO_PROMPT_EXPIRED');
 assert.equal(preparationDiagnostic(Object.assign(new Error('private path'),{code:'ENOENT'})).code,'AGENT_REPO_PATH_MISSING');
});
test('unknown exception payloads cannot leak credentials or conversation text',()=>{
 const d=preparationDiagnostic(new Error('Bearer secret https://user:password@example.invalid private message'));
 assert.equal(d.code,'AGENT_REPO_PREPARATION_UNKNOWN');assert.ok(!JSON.stringify(d).includes('password'));assert.ok(!JSON.stringify(d).includes('private message'));
});

test('Git sync failures keep actionable classifications without stderr or credentials',async()=>{
 const {gitSyncDiagnostic}=await import('./preparation-error.mjs');
 for(const [stderr,code] of [
  ['Permission denied (publickey).','AUTH_FAILED'],['Host key verification failed.','HOST_KEY_FAILED'],
  ['Could not resolve hostname git.example.invalid','DNS_FAILED'],['Connection timed out','CONNECT_TIMEOUT'],
  ['Connection reset by peer','NETWORK_FAILED'],["cannot lock ref 'refs/remotes/origin/main': is at abc but expected def",'LOCK_CONFLICT'],
  ["couldn't find remote ref refs/heads/missing",'REMOTE_REF_MISSING'],['repository not found','REMOTE_UNAVAILABLE'],
  ['No space left on device','DISK_FULL'],['private credentials URL https://user:secret@example.invalid','COMMAND_FAILED']]){
  const result=gitSyncDiagnostic({stderr,code:128});assert.equal(result.code,'AGENT_REPO_GIT_'+code);
  assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('example.invalid'));
 }
});
