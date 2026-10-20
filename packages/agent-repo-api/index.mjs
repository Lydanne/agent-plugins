const registry=globalThis[Symbol.for('openclaw-plugins.agent-repo-api.v1')]??=new Map();
export const AgentRepoError = globalThis[Symbol.for('openclaw-plugins.agent-repo-api.error.v1')]??=class AgentRepoError extends Error {
 constructor(code,message){super(message);this.name='AgentRepoError';this.code=code;}
};
export function trustedAgentId(context) {
 const id=context?.agentId;
 if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))throw new AgentRepoError('AGENT_REPO_UNAVAILABLE','A trusted Agent context is required');
 if(context.sessionKey!==undefined&&/^agent:([^:]+):/.exec(context.sessionKey)?.[1]!==id)throw new AgentRepoError('AGENT_CONTEXT_MISMATCH','Agent context does not own this conversation');
 return id;
}
export function registerAgentRepoService(service,{owner}={}) {
 if(service?.apiVersion!==1||!owner||!['listProjects','inspectProject','prepareExecutionScope'].every(key=>typeof service[key]==='function'))throw new AgentRepoError('API_VERSION_UNSUPPORTED','Unsupported Agent Repo API');
 const id=trustedAgentId(service),previous=registry.get(id);
 if(previous&&previous.owner!==owner)throw new AgentRepoError('AGENT_REPO_DUPLICATE','Agent Repo service is already registered for this Agent');
 const record={service,owner};registry.set(id,record);
 return ()=>{if(registry.get(id)===record)registry.delete(id);};
}
export function getAgentRepoService(context,{required=true}={}) {
 const id=trustedAgentId(context),service=registry.get(id)?.service;
 if(!service&&required)throw new AgentRepoError('AGENT_REPO_UNAVAILABLE','Agent Repo service is unavailable');
 return service;
}
