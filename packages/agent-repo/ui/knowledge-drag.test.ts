import {test,expect} from 'vitest';
import {constrainDrag} from './knowledge-drag';
import {layoutNetwork,validateNetwork,groupId} from './knowledge-network';
test('orbital centers have the highest weight and satellites share concentric radii',()=>{
 const nodes=Array.from({length:100},(_,i)=>({path:i+'.md',title:String(i),inDegree:i}));const n=layoutNetwork(nodes,[],new Set(nodes.map(groupId))),g=n.groups[0]!;
 expect(n.points[0]!.path).toBe('99.md');expect(Math.hypot(n.points[0]!.x-g.x,n.points[0]!.y-g.y)).toBe(0);expect(g.orbits!.length).toBeGreaterThan(1);
 for(const p of n.points.slice(1))expect(g.orbits!.some(r=>Math.abs(Math.hypot(p.x-g.x,p.y-g.y)-r)<1e-6)).toBe(true);
});
test('drag cannot cross another node even when the destination lies beyond it',()=>{
 const nodes=[{path:'a',title:'A'},{path:'b',title:'B'}],n=layoutNetwork(nodes,[],new Set(nodes.map(groupId))),p=n.points[0]!,q=n.points[1]!;const pos=constrainDrag(n,p.id,{x:p.x+(q.x-p.x)*2,y:p.y+(q.y-p.y)*2})!;
 expect(Math.hypot(pos.x-p.x,pos.y-p.y)).toBeGreaterThan(0);expect(Math.hypot(pos.x-q.x,pos.y-q.y)).toBeGreaterThan(p.r+q.r+11.9);Object.assign(p,pos);expect(validateNetwork(n)).toBe(true);
});
test('drag stays inside its Feature circle and keeps room for floating',()=>{const n=layoutNetwork([{path:'a',title:'A'}],[],new Set(['area:index'])),p=n.points[0]!,g=n.groups[0]!,pos=constrainDrag(n,p.id,{x:10000,y:-10000})!;expect(Math.hypot(pos.x-g.x,pos.y-g.y)+p.r).toBeLessThanOrEqual(g.r-11.9);Object.assign(p,pos);expect(validateNetwork(n)).toBe(true);});
test('very high weights remain ordered even after visual size reaches its cap',()=>{const nodes=[{path:'a',title:'A',inDegree:1000},{path:'z',title:'Z',inDegree:100000}];const n=layoutNetwork(nodes,[],new Set(nodes.map(groupId)));expect(n.points[0]!.path).toBe('z');});
