import type {Graph} from './knowledge-g6';
import type {layoutNetwork} from './knowledge-network';
type Network=ReturnType<typeof layoutNetwork>;
type Batch={path:Path2D;width:number;opacity:number};
// Graphs retain every relationship, but share Canvas paths instead of
// allocating a scene-graph element, hit-test entry and event target per edge.
export class KnowledgeEdgeLayer {
 readonly canvas=document.createElement('canvas');
 private batches:Batch[]=[];
 private frame=0;
 private flowing=false;private disposed=false;private flowFrame=0;private lastPaint=0;private elapsed=0;private lastTick=0;
 private network?:Network;
 private base:Batch[]=[];
 private reciprocal=new Set<string>();
 private overview:Network['edges']=[];
 private neighbors=new Map<string,Network['edges']>();
 private positions=new Map<string,{x:number;y:number;r:number}>();
 private color='';
 private selected='';
 private motionKey:string|undefined;
 private motionBase:Batch[]=[];
 private motionEdges:Network['edges']=[];
 segments=0;
 relationships=0;
 constructor(private container:HTMLElement,private graph:Graph,private onError:(cause:unknown)=>void=()=>{}){
  this.canvas.className='kb-edge-layer';
  Object.assign(this.canvas.style,{position:'absolute',inset:'0',pointerEvents:'none'});
  container.prepend(this.canvas);
  graph.on('aftertransform',this.schedule);
 }
 private append(path:Path2D,edge:Network['edges'][number]){
  const a=this.positions.get(edge.source),b=this.positions.get(edge.target);if(!a||!b)throw Error('missing_edge_endpoint');
  const distance=Math.hypot(b.x-a.x,b.y-a.y),dx=distance?(b.x-a.x)/distance:0,dy=distance?(b.y-a.y)/distance:0,x=b.x-dx*b.r,y=b.y-dy*b.r;
  path.moveTo(a.x+dx*a.r,a.y+dy*a.r);
  if(this.reciprocal.has(JSON.stringify([edge.target,edge.source]))){const bend=Math.min(100,distance*.15);path.quadraticCurveTo((a.x+b.x)/2-dy*bend,(a.y+b.y)/2+dx*bend,x,y);}else path.lineTo(x,y);
 }
 update(network:Network,color:string,selected:string){
  this.color=color;this.selected=selected;this.motionKey=undefined;
  if(this.network!==network){
   this.network=undefined;this.positions=new Map<string,{x:number;y:number;r:number}>([...network.points.map(p=>[p.id,p] as const),...network.groups.filter(g=>!g.expanded).map(g=>['group:'+g.id,{...g,r:36}] as const)]);
   const base=new Map<number,Batch>();this.neighbors.clear();this.segments=0;this.relationships=0;
   for(const edge of network.edges){
    if(!this.positions.has(edge.source)||!this.positions.has(edge.target))throw Error('missing_edge_endpoint');
    for(const id of new Set([edge.source,edge.target])){if(!this.neighbors.has(id))this.neighbors.set(id,[]);this.neighbors.get(id)!.push(edge);}
    this.segments++;this.relationships+=edge.count;
   }
   this.overview=overviewEdges(network);this.reciprocal=new Set([...network.edges,...this.overview].map(e=>JSON.stringify([e.source,e.target])));
   for(const edge of this.overview){const width=Math.min(3.5,1.6+Math.log2(edge.count)*.3);let batch=base.get(width);if(!batch){batch={path:new Path2D(),width,opacity:.48};base.set(width,batch);}this.append(batch.path,edge);}
   this.base=[...base.values()];this.network=network;
  }
  // Reuse complete geometry; selection only adds an adjacency overlay.
  this.batches=this.base.map(batch=>({...batch,opacity:selected?.12:.48}));const highlight=new Map<number,Batch>();
  for(const edge of this.neighbors.get('doc:'+selected)??[]){const width=Math.min(3.5,1.6+Math.log2(edge.count)*.3);let batch=highlight.get(width);if(!batch){batch={path:new Path2D(),width,opacity:.7};highlight.set(width,batch);}this.append(batch.path,edge);}
  this.batches.push(...highlight.values());this.canvas.dataset.segments=String(this.segments);this.canvas.dataset.relationships=String(this.relationships);this.canvas.dataset.overviewSegments=String(this.overview.length);this.canvas.dataset.detailSegments=String((this.neighbors.get('doc:'+selected)??[]).length);this.draw();
 }
 // Rebuild only incident paths during local drift; all other relations stay batched.
 updateMotion(positions:Map<string,{x:number;y:number}>){
  if(!this.network)return;
  const key=[...positions.keys()].join('\n');
  if(key!==this.motionKey){
   this.motionKey=key;const ids=new Set(positions.keys());this.motionEdges=[];const batches=new Map<number,Batch>();
   for(const p of this.network.points)this.positions.set(p.id,p);
   for(const g of this.network.groups)if(!g.expanded)this.positions.set('group:'+g.id,{...g,r:36});
   for(const e of this.overview){if(ids.has(e.source)||ids.has(e.target)){this.motionEdges.push(e);continue;}const width=Math.min(3.5,1.6+Math.log2(e.count)*.3);let b=batches.get(width);if(!b){b={path:new Path2D(),width,opacity:this.selected?.12:.48};batches.set(width,b);}this.append(b.path,e);}
   this.motionBase=[...batches.values()];
  }
  for(const [id,p] of positions){const old=this.positions.get(id);if(old)this.positions.set(id,{...p,r:old.r});}
  const moving=new Map<number,Batch>();for(const e of this.motionEdges){const width=Math.min(3.5,1.6+Math.log2(e.count)*.3);let b=moving.get(width);if(!b){b={path:new Path2D(),width,opacity:this.selected?.12:.48};moving.set(width,b);}this.append(b.path,e);}
  const highlight:Batch={path:new Path2D(),width:2.2,opacity:.7};for(const e of this.neighbors.get('doc:'+this.selected)??[])this.append(highlight.path,e);
  this.batches=[...this.motionBase,...moving.values(),highlight];this.draw();
 }
 setFlow(enabled:boolean){this.flowing=enabled&&!this.disposed;this.canvas.dataset.flow=this.flowing?'running':'paused';if(!this.flowing){cancelAnimationFrame(this.flowFrame);this.flowFrame=0;this.lastTick=0;this.schedule();}else this.animate();}
 private animate=()=>{if(!this.flowing||this.disposed||this.flowFrame||!this.batches.length)return;this.flowFrame=requestAnimationFrame(time=>{this.flowFrame=0;if(!this.flowing||this.disposed)return;if(document.hidden){this.lastTick=0;return;}if(time-this.lastPaint>=32){this.elapsed+=this.lastTick?Math.min(64,time-this.lastTick):0;this.lastTick=time;this.lastPaint=time;try{this.draw();}catch(cause){this.fail(cause);return;}}this.animate();});};
 private fail(cause:unknown){this.flowing=false;cancelAnimationFrame(this.flowFrame);this.flowFrame=0;this.canvas.dataset.flow='paused';this.onError(cause);}
 schedule=()=>{if(!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;try{this.draw();}catch(cause){this.fail(cause);}});};
 draw(){
  if(this.disposed)return;const {width,height}=this.container.getBoundingClientRect(),ratio=devicePixelRatio||1;
  if(!width||!height)return;
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
  this.canvas.style.width=width+'px';this.canvas.style.height=height+'px';
  const ctx=this.canvas.getContext('2d');if(!ctx)throw Error('canvas_2d_unavailable');
  ctx.resetTransform();ctx.clearRect(0,0,w,h);
  const origin=this.graph.getViewportByCanvas([0,0]),zoom=this.graph.getZoom();
  ctx.setTransform(zoom*ratio,0,0,zoom*ratio,origin[0]*ratio,origin[1]*ratio);ctx.strokeStyle=this.color;ctx.lineCap='round';ctx.setLineDash([]);
  // Widths and travelling dash lengths remain readable in screen space at overview zoom.
  for(const batch of this.batches){ctx.globalAlpha=batch.opacity;ctx.lineWidth=batch.width/zoom;ctx.stroke(batch.path);}
  if(this.flowing){ctx.setLineDash([9/zoom,43/zoom]);ctx.lineDashOffset=-this.elapsed*.035/zoom;for(const batch of this.batches){ctx.globalAlpha=Math.min(1,batch.opacity*1.65);ctx.lineWidth=(batch.width+.8)/zoom;ctx.stroke(batch.path);}ctx.setLineDash([]);ctx.lineDashOffset=0;this.canvas.dataset.flowFrames=String(Number(this.canvas.dataset.flowFrames??0)+1);this.animate();}
 }
 destroy(){this.disposed=true;this.flowing=false;cancelAnimationFrame(this.flowFrame);cancelAnimationFrame(this.frame);this.graph.off('aftertransform',this.schedule);this.canvas.remove();this.batches=[];this.base=[];this.network=undefined;this.positions.clear();this.neighbors.clear();this.overview=[];this.reciprocal.clear();this.motionBase=[];this.motionEdges=[];this.motionKey=undefined;}
}

// A center represents its Feature in the overview. Counts are aggregated, not
// invented direct document links; selecting a node reveals only real adjacency.
export function overviewEdges(network:Network){
 const hubs=new Map<string,string>(),owners=new Map<string,string>();
 for(const p of network.points){if(!hubs.has(p.group))hubs.set(p.group,p.id);owners.set(p.id,p.group);}
 for(const g of network.groups)if(!g.expanded){hubs.set(g.id,'group:'+g.id);owners.set('group:'+g.id,g.id);}
 const links=new Map<string,Network['edges'][number]>();
 for(const edge of network.edges){const a=owners.get(edge.source),b=owners.get(edge.target);if(a===undefined||b===undefined)throw Error('missing_edge_endpoint');if(a===b)continue;const source=hubs.get(a)!,target=hubs.get(b)!,key=JSON.stringify([source,target]),old=links.get(key);if(old)old.count+=edge.count;else links.set(key,{source,target,count:edge.count});}
 return [...links.values()];
}
