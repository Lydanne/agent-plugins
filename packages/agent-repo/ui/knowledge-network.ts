import type {KnowledgeEntry,KnowledgeEdge} from './knowledge-model';
export type SizeMode='total'|'in'|'out';
export const areaColors:Record<string,string>={features:'#4f8a80',concepts:'#648bca',rules:'#ac7db3',processes:'#c88b54',architecture:'#678ab0',decisions:'#b78368',sources:'#8c9560',index:'#84929d'};
export const groupId=(n:KnowledgeEntry)=>n.featureId?'feature:'+n.featureId:'area:'+(n.area??n.path.split('/').slice(0,-1)[0]??'index');
export const nodeWeight=(n:KnowledgeEntry,mode:SizeMode='total')=>mode==='in'?n.inDegree??0:mode==='out'?n.outDegree??0:(n.neighborDegree??((n.inDegree??0)+(n.outDegree??0)));
// Fixed across projects and snapshots: 0 / 16 / 100+ neighbors => 12 / 36 / 72 diameter.
export const radiusForWeight=(weight:number)=>6+Math.min(30,Math.sqrt(Math.max(0,weight))*3);
export const nodeRadius=(n:KnowledgeEntry,mode:SizeMode='total')=>radiusForWeight(nodeWeight(n,mode));
export interface NetworkPoint {id:string;path:string;x:number;y:number;r:number;group:string;entry:KnowledgeEntry}
export interface NetworkGroup {id:string;label:string;x:number;y:number;r:number;count:number;expanded:boolean;area:string;orbits?:number[];systemOrbit?:number;logicalId?:string}
// Prefer the shallowest index document (index.md, then README.md); never invent a center document.
export function groupCenter(items:KnowledgeEntry[],mode:SizeMode='total'){
 const indexes=items.filter(n=>/(^|\/)(index|readme)\.md$/i.test(n.path)||n.type==='index');
 return indexes.sort((a,b)=>a.path.split('/').length-b.path.split('/').length||Number(!/(^|\/)index\.md$/i.test(a.path))-Number(!/(^|\/)index\.md$/i.test(b.path))||a.path.localeCompare(b.path))[0]??[...items].sort((a,b)=>nodeWeight(b,mode)-nodeWeight(a,mode)||a.path.localeCompare(b.path))[0];
}
// Index documents anchor each planetary system; other documents occupy concentric orbits.
export const driftAmplitude=(radius:number)=>Math.max(.6,4-(radius-8)*.2);
export function phaseFor(id:string){let h=2166136261;for(let i=0;i<id.length;i++)h=Math.imul(h^id.charCodeAt(i),16777619);return (h>>>0)/4294967296*Math.PI*2;}
export function driftOffset(id:string,radius:number,time:number){const phase=phaseFor(id),a=driftAmplitude(radius),t=time/(3500+radius*160);return {x:Math.sin(t+phase)*a*.65,y:Math.sin(t*.83+phase*2)*a};}
const goldenAngle=Math.PI*(3-Math.sqrt(5));
export function layoutNetwork(nodes:KnowledgeEntry[],edges:KnowledgeEdge[],expanded:Set<string>,mode:SizeMode='total',previous?:{groups:NetworkGroup[]}){
 const buckets=new Map<string,KnowledgeEntry[]>();for(const n of nodes){const id=groupId(n);if(!buckets.has(id))buckets.set(id,[]);buckets.get(id)!.push(n);}
 const points:NetworkPoint[]=[],groups:NetworkGroup[]=[];
 for(const [id,items] of [...buckets].sort(([a],[b])=>a.localeCompare(b))){
  const center=groupCenter(items,mode);items.sort((a,b)=>Number(b===center)-Number(a===center)||nodeWeight(b,mode)-nodeWeight(a,mode)||a.path.localeCompare(b.path));
  const open=expanded.has(id),orbits:number[]=[];let extent=open?36:36+Math.min(44,Math.sqrt(items.length)*3);
  if(open){const centerRadius=Math.max(24,...items.map(n=>nodeRadius(n,mode))),max=centerRadius,spacing=max*2+28;let index=0,ring=0;
   while(index<items.length){const radius=ring*spacing,capacity=ring===0?1:Math.max(1,Math.floor(Math.PI/Math.asin(spacing/(2*radius)))),count=Math.min(capacity,items.length-index),phase=phaseFor(id)+ring*goldenAngle;
    if(ring)orbits.push(radius);
    for(let j=0;j<count;j++){const n=items[index++]!,r=n===center?centerRadius:nodeRadius(n,mode),angle=j/count*Math.PI*2+phase;points.push({id:'doc:'+n.path,path:n.path,entry:n,group:id,x:Math.cos(angle)*radius,y:Math.sin(angle)*radius,r});extent=Math.max(extent,radius+r+32);}ring++;
   }
  }
  groups.push({id,label:id.slice(id.indexOf(':')+1),x:0,y:0,r:extent,count:items.length,expanded:open,area:items[0]?.area??'index',orbits});
 }
 // Nested solar systems: a central group, then disjoint radial shells.
 // Sort a copy so metadata and edge ordering stay stable across snapshots.
 const weights=new Map([...buckets].map(([id,items])=>[id,items.reduce((sum,n)=>sum+nodeWeight(n,mode),0)]));
 const ranked=[...groups].sort((a,b)=>b.r-a.r||(weights.get(b.id)??0)-(weights.get(a.id)??0)||b.count-a.count||a.id.localeCompare(b.id));
 const old=new Map(previous?.groups.map(g=>[g.id,g])??[]),core=previous?.groups.find(g=>g.systemOrbit===0),currentCore=core?groups.find(g=>g.id===core.id):undefined;
 const canKeep=!!currentCore&&currentCore.expanded===core!.expanded&&currentCore.r<=core!.r,kept=new Set<string>();
 if(canKeep)for(const g of groups){const p=old.get(g.id);if(p&&p.expanded===g.expanded&&p.r>=g.r){g.x=p.x;g.y=p.y;g.r=p.r;g.systemOrbit=p.systemOrbit;kept.add(g.id);}}
 let remaining=ranked.filter(g=>!kept.has(g.id)),outer=groups.filter(g=>kept.has(g.id)).reduce((r,g)=>Math.max(r,Math.hypot(g.x,g.y)+g.r),0),ring=0;
 if(!kept.size&&remaining.length){const center=remaining[0]!;center.x=0;center.y=0;center.systemOrbit=0;outer=center.r;remaining=remaining.slice(1);}
 let index=0;while(index<remaining.length){
  const max=remaining[index]!.r,radius=outer+max+64,spacing=max*2+64,capacity=Math.max(1,Math.floor(Math.PI/Math.asin(Math.min(1,spacing/(2*radius))))),count=Math.min(capacity,remaining.length-index),phase=phaseFor('knowledge-universe')+(ring++)*goldenAngle;
  for(let j=0;j<count;j++){const g=remaining[index++]!,angle=phase+j/count*Math.PI*2;g.x=Math.cos(angle)*radius;g.y=Math.sin(angle)*radius;g.systemOrbit=radius;}
  outer=radius+max;
 }

 const byGroup=new Map(groups.map(g=>[g.id,g]));for(const n of points){const g=byGroup.get(n.group)!;n.x+=g.x;n.y+=g.y;}
 const owners=new Map(nodes.map(n=>[n.path,groupId(n)])),links=new Map<string,{source:string;target:string;count:number}>();
 for(const e of edges){const a=owners.get(e.source),b=owners.get(e.target);if(!a||!b)continue;const source=expanded.has(a)?'doc:'+e.source:'group:'+a,target=expanded.has(b)?'doc:'+e.target:'group:'+b;if(source===target)continue;const key=JSON.stringify([source,target]);const old=links.get(key);if(old)old.count++;else links.set(key,{source,target,count:1});}
 return {points,groups,edges:[...links.values()]};
}
// Validate the rendered radii, not labels or nominal layout dimensions.
export function validateNetwork(network:ReturnType<typeof layoutNetwork>){
 const groups=new Map(network.groups.map(g=>[g.id,g]));
 const ordered=[...network.groups].sort((a,b)=>a.x-a.r-(b.x-b.r));
 for(let i=0;i<ordered.length;i++){const a=ordered[i]!;for(let j=i+1;j<ordered.length;j++){const b=ordered[j]!;if(b.x-b.r>a.x+a.r)break;if(Math.hypot(a.x-b.x,a.y-b.y)<=a.r+b.r)return false;}}
 const cell=network.points.reduce((size,p)=>Math.max(size,p.r*2),50),buckets=new Map<string,NetworkPoint[]>();
 for(const p of network.points){const g=groups.get(p.group);if(!g||Math.hypot(p.x-g.x,p.y-g.y)+p.r>=g.r)return false;const x=Math.floor(p.x/cell),y=Math.floor(p.y/cell);for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of buckets.get(`${x+dx}:${y+dy}`)??[])if(Math.hypot(p.x-q.x,p.y-q.y)<=p.r+q.r)return false;const key=`${x}:${y}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key)!.push(p);}
 return true;
}
// Metadata-only history frames can retain the complete drawn geometry.
export function sameNetworkGeometry(a:ReturnType<typeof layoutNetwork>|undefined,b:ReturnType<typeof layoutNetwork>){
 if(!a||a.points.length!==b.points.length||a.groups.length!==b.groups.length||a.edges.length!==b.edges.length)return false;
 for(let i=0;i<a.points.length;i++){const p=a.points[i]!,q=b.points[i]!;if(p.id!==q.id||p.group!==q.group||p.x!==q.x||p.y!==q.y||p.r!==q.r||p.entry.area!==q.entry.area)return false;}
 for(let i=0;i<a.groups.length;i++){const p=a.groups[i]!,q=b.groups[i]!;if(p.id!==q.id||p.label!==q.label||p.x!==q.x||p.y!==q.y||p.r!==q.r||p.expanded!==q.expanded||p.count!==q.count||p.area!==q.area||p.systemOrbit!==q.systemOrbit)return false;}
 for(let i=0;i<a.edges.length;i++){const p=a.edges[i]!,q=b.edges[i]!;if(p.source!==q.source||p.target!==q.target||p.count!==q.count)return false;}
 return true;
}
