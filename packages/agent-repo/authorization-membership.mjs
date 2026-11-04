/** Resolve only a complete, fresh, source-bound identity graph supplied by a trusted reader. */
export function resolvePermissionGroups({agentId,subject,snapshot,bindings,groups,now=Date.now(),maxAgeMs=3600000}){
 const denied=reason=>({verified:false,reason,groupIds:[],bindingIds:[]});
 if(subject?.agentId!==agentId||subject?.verified!==true||!subject.id)return denied('UNVERIFIED_SUBJECT');
 if(snapshot?.agentId!==agentId||snapshot.subjectId!==subject.id||snapshot.complete!==true||!snapshot.sourceId||snapshot.sourceId!==subject.sourceId)return denied('UNVERIFIED_MEMBERSHIP');
 const observed=Date.parse(snapshot.observedAt);
 if(!Number.isFinite(observed)||observed>now||now-observed>maxAgeMs)return denied('STALE_MEMBERSHIP');
 const nodes=new Map((snapshot.nodes??[]).map(node=>[node.id,node]));
 const person=nodes.get(subject.id);
 if(!person||person.type!=='person'||person.status!=='active'||person.sourceId!==subject.sourceId)return denied('INACTIVE_SUBJECT');
 const edges=snapshot.edges??[];
 if(edges.some(edge=>edge.sourceId!==subject.sourceId||!nodes.has(edge.fromId)||!nodes.has(edge.toId)))return denied('INVALID_MEMBERSHIP_GRAPH');
 const active=edges.filter(edge=>edge.status==='active'&&nodes.get(edge.fromId).status==='active'&&nodes.get(edge.toId).status==='active');
 // A malformed hierarchy must not turn an unrelated department into an ancestor.
 const parents=new Map(),indegree=new Map();
 for(const edge of active){
  if(edge.type!=='parent_department')continue;
  if(nodes.get(edge.fromId).type!=='department'||nodes.get(edge.toId).type!=='department')return denied('INVALID_MEMBERSHIP_GRAPH');
  if(!parents.has(edge.fromId))parents.set(edge.fromId,new Set());
  if(parents.get(edge.fromId).has(edge.toId))continue;
  parents.get(edge.fromId).add(edge.toId);
  if(!indegree.has(edge.fromId))indegree.set(edge.fromId,0);
  indegree.set(edge.toId,(indegree.get(edge.toId)??0)+1);
 }
 const roots=[...indegree].filter(([,degree])=>degree===0).map(([id])=>id);let visited=0;
 while(roots.length){const id=roots.pop();visited++;for(const parent of parents.get(id)??[]){const degree=indegree.get(parent)-1;indegree.set(parent,degree);if(degree===0)roots.push(parent);}}
 if(visited!==indegree.size)return denied('CYCLIC_MEMBERSHIP_GRAPH');
 const directDepartments=new Set(active.filter(edge=>edge.type==='member_of'&&edge.fromId===subject.id&&nodes.get(edge.toId).type==='department').map(edge=>edge.toId));
 const ancestors=new Set(directDepartments),pending=[...directDepartments];
 while(pending.length){const child=pending.pop();for(const edge of active){if(edge.type!=='parent_department'||edge.fromId!==child||nodes.get(edge.toId).type!=='department')continue;if(!ancestors.has(edge.toId)){ancestors.add(edge.toId);pending.push(edge.toId);}}}
 const organizations=new Set(active.filter(edge=>edge.type==='belongs_to'&&(edge.fromId===subject.id||ancestors.has(edge.fromId))&&nodes.get(edge.toId).type==='organization').map(edge=>edge.toId));
 const enabled=new Set(groups.filter(group=>group.status==='active').map(group=>group.id));
 const selected=bindings.filter(binding=>{
  if(binding.agentId!==agentId||binding.status!=='active'||!enabled.has(binding.groupId))return false;
  if(binding.validFrom&&Date.parse(binding.validFrom)>now||binding.validUntil&&Date.parse(binding.validUntil)<=now)return false;
  const node=nodes.get(binding.entityId);if(!node||node.sourceId!==subject.sourceId||node.status!=='active'||node.type!==binding.entityType)return false;
  if(binding.entityType==='person')return binding.membership==='self'&&binding.entityId===subject.id;
  if(binding.entityType==='organization')return binding.membership==='members'&&organizations.has(binding.entityId);
  if(binding.entityType==='department')return binding.membership==='members'?directDepartments.has(binding.entityId):binding.membership==='descendants'&&ancestors.has(binding.entityId);
  return false;
 });
 return {verified:true,reason:'RESOLVED',groupIds:[...new Set(selected.map(binding=>binding.groupId))],bindingIds:selected.map(binding=>binding.id)};
}
