import {isAbsolute} from 'node:path';
export function fileOperation(event){
 if(event.toolName!=='agent_file')return undefined;
 const p=event.params;if(!p||Object.keys(p).some(key=>!['action','path','maxBytes','content'].includes(key))||!['read','create','write'].includes(p.action)||typeof p.path!=='string'||!p.path||isAbsolute(p.path)||p.path.includes('\\')||p.path.includes('\0'))return undefined;
 const parts=p.path.split('/');if(parts.some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))return undefined;
 if(p.maxBytes!==undefined&&(!Number.isSafeInteger(p.maxBytes)||p.maxBytes<1||p.maxBytes>1048576))return undefined;
 if(p.action==='read'&&p.content!==undefined||p.action!=='read'&&(typeof p.content!=='string'||Buffer.byteLength(p.content)>1048576||p.maxBytes!==undefined))return undefined;
 const actions=p.action==='read'?['read']:p.action==='create'?['create']:['create','update'];
 return {requirements:[{resourceId:'tool://agent-repo/agent_file',action:'execute'},...actions.map(action=>({resourceId:'file://agent-repo/workspace/'+p.action,action}))]};
}
export function fileResources(agentId){
 const base={agentId,provider:'agent-repo',status:'active',verification:'verified',enforcement:'enforced',labels:['files'],behavior:{access:'read',atomicity:'not-applicable',recovery:'not-applicable',idempotency:'guaranteed',externalEffect:'none',sensitivity:'sensitive'},definition:{adapter:'agent-file-v2',symlinks:false,hardlinks:false,hiddenPaths:false}};
 return [{...base,behavior:{...base.behavior,access:'mixed',atomicity:'unknown',recovery:'unknown'},definition:{...base.definition,toolName:'agent_file'},id:'tool://agent-repo/agent_file',kind:'tool',name:'受控文件操作',actions:['discover','read','execute']},...['read','create','write'].map(action=>({...base,id:'file://agent-repo/workspace/'+action,kind:'file',name:'Agent 工作区文件 '+action,actions:action==='read'?['read']:action==='create'?['create']:['create','update'],behavior:action==='read'?base.behavior:{...base.behavior,access:'write',atomicity:'unknown',recovery:'irreversible',idempotency:action==='create'?'not-guaranteed':'guaranteed'}}))];
}
export function createFileTool(directory){
 return {name:'agent_file',label:'Permission controlled file access',description:'Read, create or write a relative workspace file. Create refuses existing files; write requires both create and update permissions. Hidden paths and links are refused.',parameters:{type:'object',additionalProperties:false,required:['action','path'],properties:{action:{type:'string',enum:['read','create','write']},path:{type:'string'},content:{type:'string',maxLength:1048576},maxBytes:{type:'integer',minimum:1,maximum:1048576}}},async execute(_id,params,signal){
  if(!fileOperation({toolName:'agent_file',params}))throw Error('Invalid controlled file request');signal?.throwIfAborted();
  const {root}=await import('openclaw/plugin-sdk/file-access-runtime');const boundary=await root(directory,{hardlinks:'reject',symlinks:'reject',mutationSymlinks:'reject',mkdir:false,assertBeforeMutation:()=>signal?.throwIfAborted()});
  if(params.action!=='read'){await boundary[params.action](params.path,params.content,{mkdir:false,mutationSymlinks:'reject',mode:0o600});return {content:[{type:'text',text:JSON.stringify({path:params.path,action:params.action,bytes:Buffer.byteLength(params.content)})}]};}
  const result=await boundary.read(params.path,{hardlinks:'reject',symlinks:'reject',maxBytes:params.maxBytes??262144});signal?.throwIfAborted();
  return {content:[{type:'text',text:result.buffer.toString('utf8')}]};
 }};
}
