import {afterEach,expect,test,vi} from 'vitest';
import type {Graph} from './knowledge-g6';
import {KnowledgeEdgeLayer,overviewEdges} from './knowledge-edge-layer';
import {layoutNetwork,groupId} from './knowledge-network';
class TestPath {moves:number[][]=[];lines:number[][]=[];moveTo(...xy:number[]){this.moves.push(xy);}lineTo(...xy:number[]){this.lines.push(xy);}}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();document.body.replaceChildren();});
function fixture(){
 vi.stubGlobal('Path2D',TestPath);vi.stubGlobal('devicePixelRatio',2);
 let pending:FrameRequestCallback|undefined;const cancel=vi.fn();vi.stubGlobal('requestAnimationFrame',vi.fn((cb:FrameRequestCallback)=>{pending=cb;return 7;}));vi.stubGlobal('cancelAnimationFrame',cancel);
 const strokes:TestPath[]=[],ctx={resetTransform:vi.fn(),clearRect:vi.fn(),setTransform:vi.fn(),stroke:(path:TestPath)=>strokes.push(path),globalAlpha:1,lineWidth:1,strokeStyle:''};
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
 const host=document.createElement('div');document.body.append(host);vi.spyOn(host,'getBoundingClientRect').mockReturnValue({width:300,height:200} as DOMRect);
 const graph={on:vi.fn(),off:vi.fn(),getViewportByCanvas:vi.fn(()=>[10,20]),getZoom:vi.fn(()=>2)};
 const layer=new KnowledgeEdgeLayer(host,graph as unknown as Graph);
 return {layer,host,graph,strokes,ctx,cancel,frame:()=>{const cb=pending;pending=undefined;cb?.(0);}};
}
test('overview keeps all 100000 relationships indexed while rendering 250 inter-Feature summaries',()=>{
 const f=fixture(),nodes=Array.from({length:10000},(_,i)=>({path:i+'.md',title:String(i),featureId:'f'+Math.floor(i/40)}));
 const edges=nodes.flatMap((n,i)=>Array.from({length:10},(_,j)=>({source:n.path,target:nodes[(i+j+1)%nodes.length]!.path,kind:'link' as const})));
 const network=layoutNetwork(nodes,edges,new Set(nodes.map(groupId)));f.layer.update(network,'#888','');
 expect(f.layer.segments).toBe(100000);expect(f.layer.relationships).toBe(edges.length);expect(f.strokes.reduce((sum,p)=>sum+p.lines.length,0)).toBe(750);expect(f.strokes).toHaveLength(1);
 expect(f.ctx.setTransform).toHaveBeenLastCalledWith(4,0,0,4,20,40);expect(f.layer.canvas.width).toBe(600);expect(f.layer.canvas.height).toBe(400);
 f.layer.update(network,'#ddd',nodes[0]!.path);expect(f.layer.relationships).toBe(100000);expect(f.layer.canvas.dataset.segments).toBe('100000');f.layer.destroy();
});
test('camera events coalesce, redraw with current coordinates and detach on disposal',()=>{
 const f=fixture();f.layer.schedule();f.layer.schedule();expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
 f.graph.getZoom.mockReturnValue(3);f.graph.getViewportByCanvas.mockReturnValue([40,50]);f.frame();expect(f.ctx.setTransform).toHaveBeenLastCalledWith(6,0,0,6,80,100);
 f.layer.schedule();f.layer.destroy();expect(f.cancel).toHaveBeenCalledWith(7);expect(f.graph.off).toHaveBeenCalledWith('aftertransform',f.layer.schedule);expect(f.host.querySelector('canvas')).toBeNull();
});
test('bad endpoints fail explicitly instead of silently dropping a relationship',()=>{const f=fixture();expect(()=>f.layer.update({points:[],groups:[],edges:[{source:'missing',target:'other',count:1}]},'#888','')).toThrow('missing_edge_endpoint');f.layer.destroy();});
test('unavailable Canvas fails explicitly rather than reporting invisible edges as ready',()=>{const f=fixture();vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);expect(()=>f.layer.update({points:[],groups:[],edges:[]},'#888','')).toThrow('canvas_2d_unavailable');f.layer.destroy();});
test('selection and theme reuse all base paths and only rebuild adjacent highlights',()=>{const f=fixture(),nodes=[{path:'a',title:'A',featureId:'a'},{path:'b',title:'B',featureId:'b'},{path:'c',title:'C',featureId:'c'}],edges=[{source:'a',target:'b',kind:'link' as const},{source:'b',target:'c',kind:'link' as const}],network=layoutNetwork(nodes,edges,new Set(nodes.map(groupId)));f.layer.update(network,'#888','');const base=f.strokes[0];f.layer.update(network,'#fff','a');expect(f.strokes[1]).toBe(base);expect(f.strokes[2]!.lines).toHaveLength(3);expect(f.layer.segments).toBe(2);f.layer.update({...network,points:network.points.map(p=>({...p,x:p.x+20}))},'#fff','b');expect(f.strokes[3]).not.toBe(base);f.layer.destroy();});
test('floating rebuilds incident endpoints, retains static paths and resets to anchored geometry',()=>{
 const f=fixture(),nodes=['a','b','c','d'].map(path=>({path,title:path,featureId:path})),edges=[{source:'a',target:'b',kind:'link' as const},{source:'c',target:'d',kind:'link' as const}],network=layoutNetwork(nodes,edges,new Set(nodes.map(groupId)));
 f.layer.update(network,'#888','');const anchor=network.points[0]!;f.strokes.length=0;
 f.layer.updateMotion(new Map([[anchor.id,{x:anchor.x+3,y:anchor.y+2}]]));expect(f.strokes.reduce((s,p)=>s+p.lines.length,0)).toBe(6);const staticPath=f.strokes[0],movingPath=f.strokes[1];f.strokes.length=0;
 f.layer.updateMotion(new Map([[anchor.id,{x:anchor.x-3,y:anchor.y-2}]]));expect(f.strokes[0]).toBe(staticPath);expect(f.strokes[1]!.moves).not.toEqual(movingPath!.moves);expect(f.layer.relationships).toBe(2);f.strokes.length=0;
 f.layer.updateMotion(new Map());expect(f.strokes.reduce((s,p)=>s+p.lines.length,0)).toBe(6);expect(f.strokes[0]!.moves[0]).not.toEqual(movingPath!.moves[0]);f.layer.destroy();
});

test('only center summaries show by default; selecting a satellite reveals its actual edges',()=>{
 const f=fixture(),nodes=[{path:'hub-a',title:'A',featureId:'a',inDegree:20},{path:'leaf-a',title:'a',featureId:'a'},{path:'hub-b',title:'B',featureId:'b',inDegree:20},{path:'leaf-b',title:'b',featureId:'b'}],edges=[{source:'leaf-a',target:'hub-a',kind:'link' as const},{source:'leaf-a',target:'leaf-b',kind:'link' as const},{source:'leaf-b',target:'hub-a',kind:'link' as const}],network=layoutNetwork(nodes,edges,new Set(nodes.map(groupId)));
 expect(overviewEdges(network)).toEqual([{source:'doc:hub-a',target:'doc:hub-b',count:1},{source:'doc:hub-b',target:'doc:hub-a',count:1}]);f.layer.update(network,'#888','');expect(f.layer.canvas.dataset.detailSegments).toBe('0');expect(f.layer.relationships).toBe(3);f.layer.update(network,'#888','leaf-a');expect(f.layer.canvas.dataset.detailSegments).toBe('2');f.layer.updateMotion(new Map([['doc:leaf-a',{x:1,y:2}]]));expect(f.layer.canvas.dataset.detailSegments).toBe('2');f.layer.update(network,'#888','');expect(f.layer.canvas.dataset.detailSegments).toBe('0');f.layer.destroy();
});
