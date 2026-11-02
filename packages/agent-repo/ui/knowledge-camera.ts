import type {Graph} from './knowledge-g6';
// One cancellable camera transition. Public viewport calls keep all overlay layers aligned.
export class KnowledgeCamera {
 private generation=0;private frame=0;private finish:(()=>void)|undefined;
 constructor(private graph:Graph,private host:HTMLElement){}
 cancel(){this.generation++;cancelAnimationFrame(this.frame);this.finish?.();this.finish=undefined;}
 async focus(point:{x:number;y:number;r:number},valid:()=>boolean){
  this.cancel();const generation=this.generation,graph=this.graph,width=this.host.clientWidth,height=this.host.clientHeight,from=graph.getCanvasByViewport([width/2,height/2]),initial=graph.getZoom(),target=Math.min(4,Math.max(.8,64/(point.r*2))),duration=matchMedia('(prefers-reduced-motion: reduce)').matches?0:280,start=performance.now();
  await new Promise<void>(resolve=>{this.finish=resolve;const step=async()=>{if(generation!==this.generation||graph.destroyed||!valid()){resolve();return;}try{const t=duration?Math.min(1,(performance.now()-start)/duration):1,eased=t*t*(3-2*t),zoom=Math.exp(Math.log(initial)+(Math.log(target)-Math.log(initial))*eased),x=from[0]+(point.x-from[0])*eased,y=from[1]+(point.y-from[1])*eased;await graph.zoomTo(zoom,false);if(generation!==this.generation||graph.destroyed||!valid()){resolve();return;}const current=graph.getViewportByCanvas([x,y]);await graph.translateBy([width/2-current[0],height/2-current[1]],false);if(t<1&&generation===this.generation&&valid())this.frame=requestAnimationFrame(()=>void step());else resolve();}catch{resolve();}};void step();});
  if(generation===this.generation)this.finish=undefined;
 }
}
