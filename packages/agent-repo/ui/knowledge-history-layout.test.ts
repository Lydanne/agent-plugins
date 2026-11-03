import {test,expect} from 'vitest';
import {KnowledgeHistoryLayout} from './knowledge-history-layout';
import {layoutNetwork,groupId,validateNetwork,sameNetworkGeometry} from './knowledge-network';
const nodes=Array.from({length:160},(_,i)=>({path:i+'.md',title:'Node '+i,uid:'uid-'+i,featureId:'f'+Math.floor(i/40),neighborDegree:i%20}));
const expanded=new Set(nodes.map(groupId));
test('historical metadata, removed centers and missing nodes never move or resize baseline positions',()=>{
 const baseline=layoutNetwork(nodes,[],expanded),atlas=new KnowledgeHistoryLayout(baseline,nodes,'total');expect(sameNetworkGeometry(baseline,atlas.project(nodes,[],expanded))).toBe(true);
 const old=nodes.filter((_,i)=>i%3!==0).map(n=>({...n,neighborDegree:100,title:'Historical '+n.title})),frame=atlas.project(old,[],expanded);
 for(const p of frame.points){const b=baseline.points.find(b=>b.path===p.path)!;expect([p.x,p.y,p.r,p.group]).toEqual([b.x,b.y,b.r,b.group]);expect(p.entry.title).toContain('Historical');}expect(validateNetwork(frame)).toBe(true);expect(new Map(atlas.project(nodes,[],expanded).points.map(p=>[p.path,p]))).toEqual(new Map(baseline.points.map(p=>[p.path,p])));
});
test('historical-only knowledge is allocated once outside the existing atlas, with complete directed edges',()=>{
 const baseline=layoutNetwork(nodes,[],expanded),atlas=new KnowledgeHistoryLayout(baseline,nodes,'total'),extra=Array.from({length:500},(_,i)=>({path:'deleted-'+i+'.md',title:'Deleted',uid:'old-'+i,featureId:i<250?'f0':'old',neighborDegree:100})),entries=[...nodes,...extra],open=new Set([...expanded,'feature:old']),edges=extra.map(n=>({source:n.path,target:nodes[0]!.path,kind:'link' as const}));
 const first=atlas.project(entries,edges,open);expect(first.points).toHaveLength(660);expect(first.edges.reduce((s,e)=>s+e.count,0)).toBe(500);expect(validateNetwork(first)).toBe(true);for(const p of baseline.points)expect(first.points.find(n=>n.path===p.path)).toEqual(p);atlas.project(nodes,[],open);expect(atlas.project(entries,edges,open)).toEqual(first);
});
test('only unique stable UIDs preserve rename positions, and duplicate UIDs never merge documents',()=>{
 const base=layoutNetwork(nodes,[],expanded),atlas=new KnowledgeHistoryLayout(base,nodes,'total'),rename={...nodes[0]!,path:'renamed.md'};const frame=atlas.project([rename,...nodes.slice(1)],[],expanded);expect([frame.points.find(p=>p.path==='renamed.md')!.x,frame.points.find(p=>p.path==='renamed.md')!.y]).toEqual([base.points.find(p=>p.path===nodes[0]!.path)!.x,base.points.find(p=>p.path===nodes[0]!.path)!.y]);const duplicate=atlas.project([nodes[0]!,rename],[],expanded);expect(duplicate.points).toHaveLength(2);expect(validateNetwork(duplicate)).toBe(true);
});
