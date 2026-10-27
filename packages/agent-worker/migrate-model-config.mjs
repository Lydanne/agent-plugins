import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {defaultHermesTemplates} from './hermes-templates.mjs';
import {resolveTaskQueues} from './task-queues.mjs';
import {resolveQueueExecution} from './configuration.mjs';

// Pure migration: never launches work or edits a live configuration in place.
export function migrateModelConfiguration(input){
 const output=structuredClone(input),profiles=input.modelProfiles;
 const enabled=profiles===undefined?[['default',{model:'gpt-6.1-sol',reasoningEffort:'low'}]]:Object.entries(profiles).filter(([,p])=>p.enabled);
 if(profiles!==undefined&&enabled.length!==1)throw Error('Migration requires exactly one enabled legacy profile; map additional profiles to explicit queues before removing them');
 const profile=enabled[0]?.[1]??{},templates=structuredClone(input.hermesTemplates??defaultHermesTemplates);
 const queues=resolveTaskQueues(input).taskQueues;
 for(const [id,queue] of Object.entries(queues)){
  const template=templates[queue.hermesTemplateId??'codex'];
  if(!template)throw Error('Unknown Hermes template for queue '+id);
  const oldVars=input.taskQueues?.[id]?.hermesVariables??{};
  const vars={model:profile.model,reasoningEffort:profile.reasoningEffort??'low',speed:profile.speed??'',...(profile.cli?{cli:profile.cli}:{}),...template.variables,...oldVars};
  queue.hermesVariables={...oldVars,...Object.fromEntries(['model','reasoningEffort','speed','cli','codexHome'].filter(k=>vars[k]!==undefined).map(k=>[k,vars[k]]))};
 }
 for(const template of Object.values(templates))for(const key of ['model','reasoningEffort','speed'])delete template.variables[key];
 output.taskQueues=queues;output.hermesTemplates=templates;
 for(const key of ['modelProfiles','defaultModelId','thinkingLevel','thinkingProfiles','models','model','reasoningEffort'])delete output[key];
 for(const queueId of Object.keys(queues))resolveQueueExecution(output,{queueId});
 return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [source,target]=process.argv.slice(2);
 if(!source||!target||source===target)throw Error('Usage: node migrate-model-config.mjs INPUT_JSON NEW_OUTPUT_JSON (backs up input separately; never overwrite live config)');
 const config=JSON.parse(await readFile(source,'utf8'));
 if(config.plugins?.entries?.['agent-worker'])config.plugins.entries['agent-worker'].config=migrateModelConfiguration(config.plugins.entries['agent-worker'].config??{});

 // For plugin-only input remove retired keys as well.
 const result=config.plugins?.entries?.['agent-worker']?config:migrateModelConfiguration(JSON.parse(await readFile(source,'utf8')));
 await writeFile(target,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log('Migration written; validate and apply through the host configuration API. No tasks were executed.');
}
