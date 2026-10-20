// Each chunk stays below the host's string and UTF-8 result budgets.
export const inspectionChunkSize=32000;
export const inspectionMaxChunks=512;
export async function readInspectionResponse(request,action,payload){
 const read=async(name,data)=>{const response=await request(name,data);if(response?.ok!==true)throw Error(response?.error??'读取失败');return response.result;};
 const first=await read(action,payload);
 if(first?.encoding!=='json-chunks')return first;
 if(typeof first.transferId!=='string'||!Number.isInteger(first.totalChunks)||first.totalChunks<1||first.totalChunks>inspectionMaxChunks)throw Error('会话记录传输无效');
 const chunks=[];
 for(let index=0;index<first.totalChunks;index++){
  const part=index===0?first:await read('chunk',{transferId:first.transferId,index});
  if(part?.encoding!=='json-chunks'||part.transferId!==first.transferId||part.totalChunks!==first.totalChunks||part.index!==index||typeof part.chunk!=='string'||part.chunk.length>inspectionChunkSize)throw Error('会话记录分块不完整');
  chunks.push(part.chunk);
 }
 return JSON.parse(chunks.join(''));
}
