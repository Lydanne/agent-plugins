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
