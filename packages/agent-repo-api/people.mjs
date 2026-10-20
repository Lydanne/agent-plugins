// Channel-owned observations and administrator UI share this versioned local API.
// The model cannot register providers or supply an Agent identity to the tool.
const registry=globalThis[Symbol.for('openclaw-plugins.people.v1')]??=new Map();
export function getPeopleService(agentId){return registry.get(agentId)?.service;}
export function registerPeopleService(agentId,service,owner){
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agentId)||!owner||typeof service?.observe!=='function')throw Error('Invalid people service');
 const old=registry.get(agentId);if(old&&old.owner!==owner)throw Error('People service already registered');
 const entry={service,owner};registry.set(agentId,entry);return ()=>{if(registry.get(agentId)===entry)registry.delete(agentId);};
}
// Feishu owns credentials and network access; Agent Repo owns persistence.
const providers=globalThis[Symbol.for('openclaw-plugins.people-resolvers.v1')]??=new Map();
export function getPeopleResolver(){return providers.get('feishu')?.resolve;}
export function registerPeopleResolver(resolve,owner){
 if(typeof resolve!=='function'||!owner)throw Error('Invalid people resolver');
 const old=providers.get('feishu');if(old&&old.owner!==owner)throw Error('People resolver already registered');
 const entry={resolve,owner};providers.set('feishu',entry);return ()=>{if(providers.get('feishu')===entry)providers.delete('feishu');};
}
const groupSync=globalThis[Symbol.for('openclaw-plugins.people-group-sync.v1')]??=new Map();
export function getPeopleGroupSync(){return groupSync.get('feishu')?.service;}
export function registerPeopleGroupSync(service,owner){
 if(!owner||!['info','start','status','join','stop'].every(key=>typeof service?.[key]==='function'))throw Error('Invalid people group sync service');
 const old=groupSync.get('feishu');if(old&&old.owner!==owner)throw Error('People group sync already registered');
 const entry={service,owner};groupSync.set('feishu',entry);return ()=>{if(groupSync.get('feishu')===entry)groupSync.delete('feishu');};
}
