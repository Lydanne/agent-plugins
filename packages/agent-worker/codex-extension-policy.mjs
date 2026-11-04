import {assertCodexOwnedConfig} from './codex-skill-policy.mjs';

// Native extensions and lifecycle hooks do not carry a Worker task lease.
// Disable at process startup as well as thread configuration, before discovery.
export const codexExtensionConfig=Object.freeze({
 'features.hooks':false,
 'features.codex_hooks':false,
 'features.plugin_hooks':false,
 'features.plugins':false,
 'features.remote_plugin':false,
 'features.apps':false,
 'features.connectors':false,
});
export const codexExtensionArgs=Object.freeze(Object.entries(codexExtensionConfig).flatMap(([key,value])=>['-c',key+'='+value]));
export function assertCodexExtensionArgs(args){assertCodexOwnedConfig(args,codexExtensionConfig,'extension',['features']);}
