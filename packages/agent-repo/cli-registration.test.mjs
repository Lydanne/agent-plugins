import test from 'node:test';
import assert from 'node:assert/strict';
import plugin,{projectTool} from './index.mjs';
import {repoToolActions,projectActions,diagnosticActions} from './cli-capabilities.mjs';
import {registeredCliCapabilities} from './dist/plugin-cli.mjs';
import {createDiagnosticHub} from './dist/diagnostics-api.mjs';
import {registerProjectInspector} from './project-inspector.mjs';
test('CLI metadata registration does not access runtime or create services',()=>{
 let metadata;
 plugin.register({registrationMode:'cli-metadata',registerCli(_callback,value){metadata=value;},get runtime(){throw Error('runtime unavailable');},registerService(){throw Error('must not start services');}});
 assert.deepEqual(metadata.commands,['agent-repo']);
 const catalog=registeredCliCapabilities().find(entry=>entry.pluginId==='agent-repo');
 assert.deepEqual(catalog.tools.find(tool=>tool.name==='agent_file'),{name:'agent_file',command:'file',actions:['read','create','write']});
 assert.deepEqual(catalog.tools.find(tool=>tool.name==='agent_network'),{name:'agent_network',command:'network'});
});
test('CLI action catalog covers tool schema and registered management actions',()=>{
 const tool=projectTool({agents:{main:{repo:'/fixture'}}},{agentId:'main'});
 assert.deepEqual(tool.parameters.properties.action.enum,repoToolActions);
 const hub=createDiagnosticHub();assert.deepEqual(Object.keys(hub.actions).sort(),[...diagnosticActions].sort());hub.dispose();
 const registered=[];registerProjectInspector({registerSessionAction:entry=>registered.push(entry.id)},{...Object.fromEntries(diagnosticActions.map(key=>[key,()=>({})]))});
 assert.deepEqual(registered.sort(),[...projectActions,...diagnosticActions].map(a=>'projects-'+a).sort());
});
