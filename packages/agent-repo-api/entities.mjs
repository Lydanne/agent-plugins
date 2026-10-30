import {trustedAgentId} from './index.mjs';
// Trusted in-process producers resolve the Agent from their routed event context.
// Payload fields cannot select another Agent or a filesystem path.
const registry=globalThis[Symbol.for('openclaw-plugins.entities.v1')]??=new Map();
export function getEntityService(context){return registry.get(trustedAgentId(context))?.service;}
export function registerEntityService(agentId,service,owner){
 if(typeof agentId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agentId)||!owner||!['types','list','get','registerType','upsert'].every(method=>typeof service?.[method]==='function'))throw Error('Invalid entity service');
 const previous=registry.get(agentId);if(previous&&previous.owner!==owner)throw Error('Entity service already registered');
 const entry={service,owner};registry.set(agentId,entry);return ()=>{if(registry.get(agentId)===entry)registry.delete(agentId);};
}

/** Version 2: only trusted in-process connectors may mint source capabilities. */
export function getGraphService(context){const service=getEntityService(context);return service?.version===2?service:undefined;}

const syncRegistry=globalThis[Symbol.for('openclaw-plugins.entities.sync.v1')]??=new Map();
export function getEntitySyncProvider(id){return syncRegistry.get(id)?.service;}
export function registerEntitySyncProvider(id,service,owner){
 if(!/^[a-z][a-z0-9_-]{0,63}$/.test(id)||!owner||!['info','start','stop'].every(key=>typeof service?.[key]==='function'))throw Error('Invalid entity sync provider');
 const old=syncRegistry.get(id);if(old&&old.owner!==owner)throw Error('Entity sync provider already registered');const entry={service,owner};syncRegistry.set(id,entry);return ()=>{if(syncRegistry.get(id)===entry)syncRegistry.delete(id);};
}
