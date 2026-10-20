import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const runCli=promisify(execFile);
const restricted=/Gateway requests are only available to bundled or trusted official plugins/;

// The in-process gateway facade is restricted on third-party installations.
// Query the same public read-only methods through the operator's official CLI;
// credentials stay in the host process/config and never enter the skill body.
export function createMainPluginCatalogReader({gatewayRequest,run=runCli,cliCommand=['openclaw']}={}) {
 return async(method,params)=>{
  if(method!=='plugins.list'&&method!=='tools.catalog')throw Error('Unsupported Main catalog method');
  if(!params||Object.keys(params).some(key=>!['agentId','includePlugins'].includes(key))||
   method==='plugins.list'&&Object.keys(params).length||
   method==='tools.catalog'&&(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(params.agentId)||params.includePlugins!==true))throw Error('Invalid Main catalog parameters');
  if(gatewayRequest) {
   try {return await gatewayRequest(method,params);}
   catch(error) {if(!restricted.test(error?.message??''))throw Error('Unable to read Main plugin catalog through host API');}
  }
  try {
   const {stdout}=await run(cliCommand[0],[...cliCommand.slice(1),'gateway','call',method,'--params',JSON.stringify(params),'--json','--timeout','45000'],
    {timeout:60000,maxBuffer:4*1024*1024,encoding:'utf8',windowsHide:true});
   return JSON.parse(stdout);
  } catch {throw Error('Unable to read Main plugin catalog through OpenClaw CLI');}
 };
}
