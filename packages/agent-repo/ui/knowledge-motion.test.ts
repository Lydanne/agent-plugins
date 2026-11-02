import {afterEach,expect,test,vi} from 'vitest';
import type {Graph} from './knowledge-g6';
import {KnowledgeMotion} from './knowledge-motion';
import {layoutNetwork,groupId} from './knowledge-network';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function fixture(){
 vi.useFakeTimers();vi.spyOn(document,'hidden','get').mockReturnValue(false);
 const host=document.createElement('div');Object.defineProperties(host,{clientWidth:{value:800},clientHeight:{value:600}});
 const graph={destroyed:false,on:vi.fn(),off:vi.fn(),getZoom:()=>2,getViewportByCanvas:()=>[300,200],updateNodeData:vi.fn(),draw:vi.fn(async()=>{})};
 const nodes=[{path:'a',title:'A'}],network=layoutNetwork(nodes,[],new Set(nodes.map(groupId))),move=vi.fn();
 const motion=new KnowledgeMotion(graph as unknown as Graph,host,network,move);return {motion,graph,move,network};
}
test('motion stops its clock, restores anchors and releases the camera listener',async()=>{
 const {motion,graph,move,network}=fixture();await vi.advanceTimersByTimeAsync(110);expect(move).toHaveBeenCalledTimes(1);await motion.stop();const calls=graph.draw.mock.calls.length;await vi.advanceTimersByTimeAsync(1000);expect(graph.draw).toHaveBeenCalledTimes(calls);expect(graph.updateNodeData).toHaveBeenLastCalledWith([{id:network.points[0]!.id,style:{x:network.points[0]!.x,y:network.points[0]!.y}}]);expect(graph.off).toHaveBeenCalledWith('aftertransform',expect.any(Function));
});
test('disposal while a frame is drawing cannot restore into a destroyed graph',async()=>{
 const {motion,graph,move}=fixture();let finish!:()=>void;graph.draw.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));await vi.advanceTimersByTimeAsync(110);const stopped=motion.stop();graph.destroyed=true;finish();await stopped;expect(graph.updateNodeData).toHaveBeenCalledTimes(1);expect(move).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1000);expect(graph.draw).toHaveBeenCalledTimes(1);
});
