import {layoutNetwork,groupId,type NetworkGroup,type NetworkPoint,type SizeMode} from './knowledge-network';
import type {KnowledgeEntry,KnowledgeEdge} from './knowledge-model';
type Network=ReturnType<typeof layoutNetwork>;
type Slot={group:string;point?:NetworkPoint;order:number};
// A session-local atlas, with immutable geometry and current-frame metadata only.
// Historical-only documents get disjoint outer extensions; absent documents leave holes.
export class KnowledgeHistoryLayout {
 private groups=new Map<string,NetworkGroup>();private paths=new Map<string,Slot>();private uids=new Map<string,Slot|null>();private sequence=0;private nextOrder=0;private groupOrder=new Map<string,number>();
 constructor(network:Network,nodes:KnowledgeEntry[],private mode:SizeMode){this.register(network,nodes);}
 private key(n:KnowledgeEntry){return groupId(n)+'\0'+n.path;}
 private uid(n:KnowledgeEntry){return n.uid?groupId(n)+'\0'+n.uid:undefined;}
 private register(network:Network,nodes:KnowledgeEntry[]){for(const g of network.groups){this.groupOrder.set(g.id,this.groupOrder.size);this.groups.set(g.id,{...g,orbits:[...(g.orbits??[])]});}const points=new Map(network.points.map(p=>[p.path,p])),orders=new Map(network.points.map((p,i)=>[p.path,i]));this.nextOrder=network.points.length;for(const n of nodes){const p=points.get(n.path),slot={group:p?.group??groupId(n),point:p?{...p}:undefined,order:orders.get(n.path)??this.nextOrder++};this.paths.set(this.key(n),slot);const uid=this.uid(n);if(uid)this.uids.set(uid,this.uids.has(uid)?null:slot);}}
 project(nodes:KnowledgeEntry[],edges:KnowledgeEdge[],expanded:Set<string>):Network{
  const uidCounts=new Map<string,number>();for(const n of nodes){const key=this.uid(n);if(key)uidCounts.set(key,(uidCounts.get(key)??0)+1);}
  const find=(n:KnowledgeEntry)=>this.paths.get(this.key(n))??(this.uid(n)&&uidCounts.get(this.uid(n)!)===1?this.uids.get(this.uid(n)!):undefined);
  const missing=nodes.filter(n=>!find(n));if(missing.length){const extra=layoutNetwork(missing,[],expanded,this.mode),right=[...this.groups.values()].reduce((x,g)=>Math.max(x,g.x+g.r),0),left=extra.groups.reduce((x,g)=>Math.min(x,g.x-g.r),Infinity),dx=right-left+96,ids=new Map<string,string>();for(const g of extra.groups){const id='history:'+this.sequence+':'+g.id;ids.set(g.id,id);g.label+=this.groups.has(g.id)?' · 历史补充':'';g.logicalId=g.id;g.id=id;g.x+=dx;g.systemOrbit=undefined;}for(const p of extra.points){p.x+=dx;p.group=ids.get(p.group)!;}
   // Register under logical document identities, while physical groups remain separate.
   for(const g of extra.groups){this.groupOrder.set(g.id,this.groupOrder.size);this.groups.set(g.id,{...g});}const points=new Map(extra.points.map(p=>[p.path,p]));for(const n of missing){const p=points.get(n.path),slot={group:ids.get(groupId(n))!,point:p?{...p}:undefined,order:this.nextOrder++};this.paths.set(this.key(n),slot);const uid=this.uid(n);if(uid)this.uids.set(uid,this.uids.has(uid)?null:slot);}this.sequence++;
  }
  const groups=new Map<string,NetworkGroup>(),points:NetworkPoint[]=[],orders=new Map<string,number>(),owners=new Map<string,string>();for(const n of nodes){const slot=find(n)!;if(!groups.has(slot.group))groups.set(slot.group,{...this.groups.get(slot.group)!,count:0});const g=groups.get(slot.group)!;g.count++;owners.set(n.path,g.expanded?'doc:'+n.path:'group:'+g.id);if(slot.point){points.push({...slot.point,id:'doc:'+n.path,path:n.path,entry:n});orders.set(n.path,slot.order);}}
  const links=new Map<string,{source:string;target:string;count:number}>();for(const e of edges){const source=owners.get(e.source),target=owners.get(e.target);if(!source||!target||source===target)continue;const key=JSON.stringify([source,target]),link=links.get(key);if(link)link.count++;else links.set(key,{source,target,count:1});}
  points.sort((a,b)=>orders.get(a.path)!-orders.get(b.path)!);return {points,groups:[...groups.values()].sort((a,b)=>this.groupOrder.get(a.id)!-this.groupOrder.get(b.id)!),edges:[...links.values()]};
 }
}
