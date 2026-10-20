import {registerDiagnosticSource} from './diagnostics.mjs';
const source=registerDiagnosticSource({apiVersion:1,id:'example.events',pluginId:'example',label:'Example'},Symbol());
source.log({agentId:'main'},()=>({message:'Done',traceId:'trace',data:{durationMs:12}}));
// @ts-expect-error Agent routing is required in trusted context.
source.log({}, {message:'Invalid'});
// @ts-expect-error Business event cannot override registered source.
source.log({agentId:'main'},{message:'Invalid',sourceId:'forged'});
// @ts-expect-error Diagnostic API versions are explicit.
registerDiagnosticSource({apiVersion:2,id:'x',pluginId:'x',label:'Invalid'},Symbol());
source.dispose();

registerDiagnosticSource({apiVersion:1,id:'example.history',pluginId:'example',label:'History',history:async({agentId,signal})=>{signal.throwIfAborted();return [{message:agentId}];},clearHistory:async({signal})=>{signal.throwIfAborted();return {cleared:1};}},Symbol()).dispose();
// @ts-expect-error History providers must return diagnostic events.
registerDiagnosticSource({apiVersion:1,id:'bad.history',pluginId:'example',label:'Bad',history:async()=>({records:[]})},Symbol());
