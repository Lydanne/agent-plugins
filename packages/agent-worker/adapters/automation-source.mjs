/** Keep legacy Feishu provenance unchanged; an explicit automation source never falls back. */
export function validateAutomationSource(provenance,scope){
 const source=provenance?.automation;
 if(!source&&!scope?.includes(':automation:'))return;
 if(!source||source.version!==1||typeof source.taskId!=='string'||!/^[0-9a-f-]{36}$/i.test(source.taskId)||Object.keys(source).some(k=>!['version','taskId'].includes(k))||typeof provenance.sessionId!=='string'||!provenance.sessionId||scope!==`agent:${provenance.agentId}:automation:${source.taskId}`)throw Error('Invalid automation provenance');
}
