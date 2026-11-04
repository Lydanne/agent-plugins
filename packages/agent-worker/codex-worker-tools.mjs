import {connectWorkerCli,workerCliEnvironment} from './dist/worker-cli.mjs';

/** Transport only. The task-bound broker owns discovery and execution permissions. */
export function createCodexWorkerBridge(lease,{connect=connectWorkerCli,timeout=30000}={}){
 if(!lease)return undefined;
 const env=workerCliEnvironment(lease);
 return {definitions:[{type:'function',name:'worker_plugin',description:'Discover, describe or invoke an OpenClaw plugin under the original Worker task identity. Discover and inspect the schema before calling. This does not grant permission or change the task account, project or requester.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['catalog','describe','call']},tool:{type:'string',minLength:1,maxLength:160},args:{type:'object',additionalProperties:true}},required:['action'],additionalProperties:false}}],
  async invoke({name,arguments:input,signal}){
   signal?.throwIfAborted();
   if(name!=='worker_plugin'||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['action','tool','args'].includes(key))||!['catalog','describe','call'].includes(input.action))throw Error('Invalid Worker plugin call');
   if(input.action==='catalog'&&(input.tool!==undefined||input.args!==undefined)||input.action!=='catalog'&&(typeof input.tool!=='string'||!input.tool||input.tool.length>160)||input.action==='describe'&&input.args!==undefined||input.args!==undefined&&(!input.args||typeof input.args!=='object'||Array.isArray(input.args)))throw Error('Invalid Worker plugin arguments');
   const client=await connect({timeout,signal},env);if(!client)throw Error('Task-bound plugin connection unavailable');
   try{
    signal?.throwIfAborted();
    if(input.action==='catalog')return await client.request('worker.catalog',{});
    return await client.request('tools.invoke',{name:input.tool,...(input.action==='call'?{args:input.args??{}}:{})},input.action==='describe'?{describe:true}:{});
   }finally{client.close();}
  }};
}
