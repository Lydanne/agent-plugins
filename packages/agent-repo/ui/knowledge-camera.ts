import type {Graph} from './knowledge-g6';
// One cancellable camera transition. Public viewport calls keep all overlay layers aligned.
export class KnowledgeCamera {
 private generation=0;private frame=0;private finish:(()=>void)|undefined;
 constructor(private graph:Graph,private host:HTMLElement){}
 cancel(){this.generation++;cancelAnimationFrame(this.frame);this.finish?.();this.finish=undefined;}
 async restore(view:{x:number;y:number;zoom:number},valid:()=>boolean){return this.move(view,view.zoom,valid);}
 async focus(point:{x:number;y:number;r:number},valid:()=>boolean){
  return this.move(point,Math.min(4,Math.max(.8,64/(point.r*2))),valid);
 }
 async overview(groups:{x:number;y:number;r:number}[],valid:()=>boolean){
  if(!groups.length)return;let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;for(const g of groups){left=Math.min(left,g.x-g.r);right=Math.max(right,g.x+g.r);top=Math.min(top,g.y-g.r);bottom=Math.max(bottom,g.y+g.r);}const zoom=Math.min(this.host.clientWidth/Math.max(1,right-left),this.host.clientHeight/Math.max(1,bottom-top))*.82;
  return this.move({x:(left+right)/2,y:(top+bottom)/2},zoom,valid);
 }
 private async move(point:{x:number;y:number},target:number,valid:()=>boolean){
  this.cancel();const generation=this.generation,graph=this.graph,width=this.host.clientWidth,height=this.host.clientHeight,from=graph.getCanvasByViewport([width/2,height/2]),initial=graph.getZoom(),duration=matchMedia('(prefers-reduced-motion: reduce)').matches?0:280,start=performance.now();
  await new Promise<void>(resolve=>{this.finish=resolve;const step=async()=>{if(generation!==this.generation||graph.destroyed||!valid()){resolve();return;}try{const t=duration?Math.min(1,(performance.now()-start)/duration):1,eased=t*t*(3-2*t),zoom=Math.exp(Math.log(initial)+(Math.log(target)-Math.log(initial))*eased),x=from[0]+(point.x-from[0])*eased,y=from[1]+(point.y-from[1])*eased;await graph.zoomTo(zoom,false);if(generation!==this.generation||graph.destroyed||!valid()){resolve();return;}const current=graph.getViewportByCanvas([x,y]);await graph.translateBy([width/2-current[0],height/2-current[1]],false);if(t<1&&generation===this.generation&&valid())this.frame=requestAnimationFrame(()=>void step());else resolve();}catch{resolve();}};void step();});
  if(generation===this.generation)this.finish=undefined;
 }
}
