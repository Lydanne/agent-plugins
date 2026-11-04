/** Controlled network reader: no ambient credentials, redirects or arbitrary request headers. */
export function networkOperation(event){
 if(event.toolName!=='agent_network')return undefined;
 const p=event.params;if(!p||Object.keys(p).some(key=>!['url','maxBytes'].includes(key))||typeof p.url!=='string')return undefined;
 let url;try{url=new URL(p.url);}catch{return undefined;}
 if(url.protocol!=='https:'||url.username||url.password||url.hash)return undefined;
 if(p.maxBytes!==undefined&&(!Number.isSafeInteger(p.maxBytes)||p.maxBytes<1||p.maxBytes>1048576))return undefined;
 return {requirements:[{resourceId:'tool://agent-repo/agent_network',action:'execute'},{resourceId:'network://agent-repo/https',action:'read'},{resourceId:'network://agent-repo/https',action:'transfer'}],context:{destinationHost:url.hostname,destinationOrigin:url.origin,protocol:'https'}};
}
export function networkResources(agentId){
 const common={agentId,provider:'agent-repo',status:'active',verification:'verified',enforcement:'enforced',labels:['network'],behavior:{access:'read',atomicity:'not-applicable',recovery:'irreversible',idempotency:'unknown',externalEffect:'present',sensitivity:'unknown'},definition:{adapter:'agent-network-v1',redirects:false}};
 return [{...common,definition:{...common.definition,toolName:'agent_network'},id:'tool://agent-repo/agent_network',kind:'tool',name:'受控 HTTPS 读取',actions:['discover','read','execute']},{...common,id:'network://agent-repo/https',kind:'network',name:'HTTPS 请求目标',actions:['read','transfer']}];
}
export function createNetworkTool({fetchGuard}={}){
 return {name:'agent_network',label:'Permission controlled HTTPS reader',description:'Read a public HTTPS URL with entity-bound permissions. Redirects and custom credentials are not accepted.',parameters:{type:'object',additionalProperties:false,required:['url'],properties:{url:{type:'string'},maxBytes:{type:'integer',minimum:1,maximum:1048576}}},async execute(_id,params,signal){
  if(!networkOperation({toolName:'agent_network',params}))throw Error('Invalid controlled network request');
  fetchGuard??=(await import('openclaw/plugin-sdk/ssrf-runtime')).fetchWithSsrFGuard;
  const {response,release}=await fetchGuard({url:params.url,init:{method:'GET',credentials:'omit'},maxRedirects:0,requireHttps:true,timeoutMs:20000,signal,mode:'strict',pinDns:true,capture:false});
  try{
   if(response.status>=300&&response.status<400)throw Error('Redirect requires a separately authorized URL');
   if(!response.ok)throw Error('Network response status '+response.status);
   const reader=response.body?.getReader(),chunks=[];let size=0;
   if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>(params.maxBytes??262144))throw Error('Network response exceeds authorized output limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
   const bytes=Buffer.concat(chunks);return {content:[{type:'text',text:bytes.toString('utf8')}]};
  }finally{await release();}
 }};
}
