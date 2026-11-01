import {expect,test} from 'vitest';
import {layoutKnowledgeGraph} from './knowledge-graph-layout';
test('graph layout is deterministic, finite, bounded and keeps isolated nodes',()=>{
 const nodes=Array.from({length:100},(_,i)=>({path:i+'.md',title:String(i)})),edges=nodes.slice(1).map(n=>({source:'0.md',target:n.path,kind:'link' as const}));
 const points=layoutKnowledgeGraph(nodes,edges);expect(points).toEqual(layoutKnowledgeGraph(nodes,edges));expect(points).toHaveLength(100);expect(points[0]!.degree).toBe(99);expect(points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=100&&p.x<=900&&p.y>=75&&p.y<=500)).toBe(true);
 expect(layoutKnowledgeGraph([],[])).toEqual([]);expect(layoutKnowledgeGraph([nodes[0]!],[{source:'missing',target:'0.md',kind:'link'}])).toEqual([{path:'0.md',x:500,y:300,degree:0}]);
});
