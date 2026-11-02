import type {Graph} from './knowledge-g6';
import type {layoutNetwork} from './knowledge-network';
type Network=ReturnType<typeof layoutNetwork>;
type Batch={path:Path2D;width:number;opacity:number};
// Dense graphs retain every relationship, but share Canvas paths instead of
// allocating a scene-graph element, hit-test entry and event target per edge.
export class KnowledgeEdgeLayer {
 readonly canvas=document.createElement('canvas');
 private batches:Batch[]=[];
 private frame=0;
 private color='';
 segments=0;
 relationships=0;
 constructor(private container:HTMLElement,private graph:Graph){
  this.canvas.className='kb-edge-layer';
  Object.assign(this.canvas.style,{position:'absolute',inset:'0',pointerEvents:'none'});
  container.prepend(this.canvas);
  graph.on('aftertransform',this.schedule);
 }
 update(network:Network,color:string,selected:string){
  const positions=new Map<string,{x:number;y:number;r:number}>([...network.points.map(p=>[p.id,p] as const),...network.groups.filter(g=>!g.expanded).map(g=>['group:'+g.id,{...g,r:36}] as const)]);
  const batches=new Map<string,Batch>();this.segments=0;this.relationships=0;this.color=color;
  for(const edge of network.edges){
   const a=positions.get(edge.source),b=positions.get(edge.target);
   if(!a||!b)throw Error('missing_edge_endpoint');
   const adjacent=edge.source==='doc:'+selected||edge.target==='doc:'+selected;
   const width=Math.min(3,1+Math.log2(edge.count)*.3),opacity=selected?(adjacent?1:.08):.2,key=width+':'+opacity;
   let batch=batches.get(key);if(!batch){batch={path:new Path2D(),width,opacity};batches.set(key,batch);}
   const distance=Math.hypot(b.x-a.x,b.y-a.y),dx=distance?(b.x-a.x)/distance:0,dy=distance?(b.y-a.y)/distance:0;
   const x=b.x-dx*b.r,y=b.y-dy*b.r;
   batch.path.moveTo(a.x+dx*a.r,a.y+dy*a.r);batch.path.lineTo(x,y);
   if(adjacent){batch.path.moveTo(x-dx*8-dy*4,y-dy*8+dx*4);batch.path.lineTo(x,y);batch.path.lineTo(x-dx*8+dy*4,y-dy*8-dx*4);}
   this.segments++;this.relationships+=edge.count;
  }
  this.batches=[...batches.values()];this.canvas.dataset.segments=String(this.segments);this.canvas.dataset.relationships=String(this.relationships);this.draw();
 }
 schedule=()=>{if(!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.draw();});};
 draw(){
  const {width,height}=this.container.getBoundingClientRect(),ratio=devicePixelRatio||1;
  if(!width||!height)return;
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
  this.canvas.style.width=width+'px';this.canvas.style.height=height+'px';
  const ctx=this.canvas.getContext('2d');if(!ctx)throw Error('canvas_2d_unavailable');
  ctx.resetTransform();ctx.clearRect(0,0,w,h);
  const origin=this.graph.getViewportByCanvas([0,0]),zoom=this.graph.getZoom();
  ctx.setTransform(zoom*ratio,0,0,zoom*ratio,origin[0]*ratio,origin[1]*ratio);ctx.strokeStyle=this.color;
  for(const batch of this.batches){ctx.globalAlpha=batch.opacity;ctx.lineWidth=batch.width;ctx.stroke(batch.path);}
 }
 destroy(){cancelAnimationFrame(this.frame);this.graph.off('aftertransform',this.schedule);this.canvas.remove();this.batches=[];}
}
