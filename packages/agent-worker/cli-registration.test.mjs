import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from './index.mjs';
import {workerInspectionActions} from './cli-capabilities.mjs';
import {registerInspector} from './session-inspector.mjs';
test('Worker CLI metadata registration never opens runtime, jobs or automation state',()=>{
 let metadata;
 plugin.register({registrationMode:'cli-metadata',registerCli(_callback,value){metadata=value;},get runtime(){throw Error('runtime unavailable');},registerService(){throw Error('must not start services');}});
 assert.deepEqual(metadata.commands,['agent-worker']);
});
test('Worker CLI management catalog matches host action registration',()=>{
 const registered=[];registerInspector({registerSessionAction:entry=>registered.push(entry.id)},{});
 assert.deepEqual(registered,workerInspectionActions.map(a=>'inspect-'+a));
});
