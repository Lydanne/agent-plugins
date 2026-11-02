import {test,expect} from 'vitest';
import {layoutNetwork,validateNetwork,sameNetworkGeometry,groupId,nodeRadius} from './knowledge-network';
import type {KnowledgeEntry} from './knowledge-model';
for(const count of [1,200,2000,10000])test(`deterministic grouping keeps ${count} documents disjoint`,()=>{
 const nodes:KnowledgeEntry[]=Array.from({length:count},(_,i)=>({path:i+'.md',title:String(i),featureId:'f'+Math.floor(i/80),inDegree:i%40,outDegree:i%20}));
 const expanded=new Set(nodes.map(groupId)),layout=layoutNetwork(nodes,[],expanded);expect(layout.points).toHaveLength(count);expect(validateNetwork(layout)).toBe(true);
 for(let i=0;i<layout.groups.length;i++){const a=layout.groups[i]!;for(const b of layout.groups.slice(i+1))expect(Math.hypot(a.x-b.x,a.y-b.y)).toBeGreaterThan(a.r+b.r);const points=layout.points.filter(n=>n.group===a.id);for(let j=0;j<points.length;j++){const p=points[j]!;expect(Math.hypot(p.x-a.x,p.y-a.y)+p.r).toBeLessThan(a.r);for(const q of points.slice(j+1))expect(Math.hypot(p.x-q.x,p.y-q.y)).toBeGreaterThan(p.r+q.r);}}
 expect(layoutNetwork(nodes,[],expanded).points).toEqual(layout.points);expect(layoutNetwork(nodes,[],new Set()).groups.reduce((s,g)=>s+g.count,0)).toBe(count);
});
test('aggregation preserves direction and count, size distinguishes incoming and outgoing links',()=>{const nodes=[{path:'a',title:'A',featureId:'one',inDegree:100,outDegree:0},{path:'b',title:'B',featureId:'two'},{path:'c',title:'C',featureId:'two'}];const edges=[{source:'a',target:'b',kind:'link' as const},{source:'a',target:'c',kind:'link' as const},{source:'b',target:'a',kind:'link' as const}];expect(layoutNetwork(nodes,edges,new Set()).edges).toEqual([{source:'group:feature:one',target:'group:feature:two',count:2},{source:'group:feature:two',target:'group:feature:one',count:1}]);expect(nodeRadius(nodes[0]!,'in')).toBeGreaterThan(nodeRadius(nodes[0]!,'out'));});
test('unchanged groups retain their positions as history adds another feature',()=>{const nodes=[{path:'a',title:'A',featureId:'a'},{path:'b',title:'B',featureId:'b'}];const first=layoutNetwork(nodes,[],new Set()),next=layoutNetwork([...nodes,{path:'c',title:'C',featureId:'c'}],[],new Set(),'total',first);expect(next.groups.slice(0,2)).toEqual(first.groups);for(const a of next.groups)for(const b of next.groups)if(a.id!==b.id)expect(Math.hypot(a.x-b.x,a.y-b.y)).toBeGreaterThan(a.r+b.r);});

test('geometry validation rejects actual intersections',()=>{const data=layoutNetwork([{path:'a',title:'A'},{path:'b',title:'B'}],[],new Set(['area:index']));data.points[1]!.x=data.points[0]!.x;data.points[1]!.y=data.points[0]!.y;expect(validateNetwork(data)).toBe(false);});
test('one huge feature and many singleton features both satisfy geometric validation',()=>{for(const single of [true,false]){const nodes=Array.from({length:10000},(_,i)=>({path:i+'.md',title:String(i),featureId:single?'huge':'f'+i,inDegree:100,outDegree:100}));const layout=layoutNetwork(nodes,[],new Set(nodes.map(groupId)));expect(layout.points).toHaveLength(10000);expect(validateNetwork(layout)).toBe(true);}});

test('history reuses geometry only when all positions, groups and directed relationships agree',()=>{const nodes=[{path:'a',title:'A'},{path:'b',title:'B'}],edges=[{source:'a',target:'b',kind:'link' as const}],a=layoutNetwork(nodes,edges,new Set(nodes.map(groupId))),b=layoutNetwork(nodes.map(n=>({...n,title:'changed'})),edges,new Set(nodes.map(groupId)));expect(sameNetworkGeometry(a,b)).toBe(true);expect(sameNetworkGeometry(a,{...b,edges:[{...b.edges[0]!,count:2}]})).toBe(false);expect(sameNetworkGeometry(a,{...b,points:b.points.map(p=>({...p,x:p.x+1}))})).toBe(false);});

test('organic placement reserves the complete drift envelope, with lighter small nodes',async()=>{
 const {driftOffset,driftAmplitude}=await import('./knowledge-network');
 expect(driftAmplitude(8)).toBeGreaterThan(driftAmplitude(24));
 const nodes=Array.from({length:2000},(_,i)=>({path:i+'.md',title:String(i),featureId:'f'+Math.floor(i/100),inDegree:i%100}));
 const network=layoutNetwork(nodes,[],new Set(nodes.map(groupId)));
 for(let t=0;t<60000;t+=1000){const moved={...network,points:network.points.map(p=>{const d=driftOffset(p.id,p.r,t);return {...p,x:p.x+d.x,y:p.y+d.y};})};expect(validateNetwork(moved)).toBe(true);}
 expect(new Set(network.groups.map(g=>g.y)).size).toBe(network.groups.length);
});

test('node sizes have strong stable contrast with a bounded maximum',()=>{const radius=(weight:number)=>nodeRadius({path:'a',title:'A',neighborDegree:weight});expect([0,1,4,16,64,100,10000].map(radius)).toEqual([6,9,12,18,30,36,36]);expect(radius(100)/radius(0)).toBe(6);});
test('collision validation catches enlarged nodes across two old grid cells',()=>{const n=layoutNetwork([{path:'a',title:'A',neighborDegree:100},{path:'b',title:'B',neighborDegree:100}],[],new Set(['area:index']));n.groups[0]!.x=75;n.groups[0]!.y=0;n.groups[0]!.r=200;n.points[0]!.x=49;n.points[0]!.y=0;n.points[1]!.x=101;n.points[1]!.y=0;expect(validateNetwork(n)).toBe(false);});
