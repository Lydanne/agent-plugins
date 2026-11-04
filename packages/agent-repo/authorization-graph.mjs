/** Read-only adapter over the public entity graph. */
export function createAuthorizationGraphReader(graph,agentId){
 function all(method,input,key){const items=[];let offset=0;for(let page=0;page<1000;page++){const result=graph[method]({...input,offset,limit:100});items.push(...result[key]);if(result.nextOffset==null)return items;if(result.nextOffset<=offset)throw Error('Invalid pagination');offset=result.nextOffset;}throw Error('Membership exceeds budget');}
 return {
  resolveIdentity(host){
   const r=host.requester;if(host.agentId!==agentId||r?.channel!=='feishu'||!r.accountId||!r.senderId)return null;
   const found=all('list',{typeId:'person'},'entities').filter(node=>{if(node.source?.kind!=='channel'||node.source.namespace!=='feishu')return false;try{const [account,,sender]=JSON.parse(node.source.externalId);return account===r.accountId&&sender===r.senderId;}catch{return false;}});
   return found.length===1?{id:found[0].id,sourceId:found[0].sourceId,agentId,verified:true}:null;
  },
  readMembership(subject){
   const person=graph.get(subject.id).entity;if(!person)return null;
   const nodes=new Map([[person.id,person]]),edges=[],pending=[person.id],visited=new Set();
   while(pending.length){const id=pending.shift();if(visited.has(id))continue;visited.add(id);if(visited.size>1000)throw Error('Membership exceeds budget');
    for(const edge of all('relations',{fromId:id,sourceId:subject.sourceId,status:'active'},'relations')){if(!['member_of','belongs_to','parent_department'].includes(edge.typeId))continue;const target=graph.get(edge.toId).entity;if(!target||target.sourceId!==subject.sourceId)throw Error('Incomplete membership');edges.push({...edge,type:edge.typeId});nodes.set(target.id,target);pending.push(target.id);}}
   const dates=[...nodes.values(),...edges].map(value=>Date.parse(value.observedAt));if(dates.some(date=>!Number.isFinite(date)))return null;
   return {agentId,subjectId:subject.id,sourceId:subject.sourceId,complete:true,observedAt:new Date(Math.min(...dates)).toISOString(),nodes:[...nodes.values()].map(node=>({...node,type:node.typeId})),edges};
  },
 };
}
