import type {Graph} from './knowledge-g6';
import {driftAmplitude,driftOffset,type layoutNetwork} from './knowledge-network';
type Network=ReturnType<typeof layoutNetwork>;
// One bounded clock, no force simulation. Subpixel drift is left at its anchor;
// offscreen nodes retain all data and return smoothly when the viewport moves.
export class KnowledgeMotion {
 private timer:ReturnType<typeof setTimeout>|undefined;
 private stopped=false;
 private busy=false;
 private pending:Promise<void>=Promise.resolve();
 private anchors:({id:string;x:number;y:number;r:number})[];
 private moved=new Map<string,{x:number;y:number}>();
 private idleUntil=0;
 private time=0;
 private last=performance.now();
 constructor(private graph:Graph,private container:HTMLElement,network:Network,private onMove:(positions:Map<string,{x:number;y:number}>)=>void){
  this.anchors=[...network.points,...network.groups.filter(g=>!g.expanded).map(g=>({...g,id:'group:'+g.id,r:36}))];
  graph.on('aftertransform',this.interact);this.tick();
 }
 private interact=()=>{this.idleUntil=performance.now()+350;};
 private tick=()=>{if(this.stopped)return;this.timer=setTimeout(()=>void this.frame(),100);};
 private async frame(){
  if(this.stopped)return;
  const now=performance.now(),elapsed=Math.min(200,now-this.last);this.last=now;
  if(document.hidden||now<this.idleUntil||this.busy){this.tick();return;}
  this.time+=elapsed;const zoom=this.graph.getZoom(),origin=this.graph.getViewportByCanvas([0,0]),width=this.container.clientWidth,height=this.container.clientHeight;
  const positions=new Map<string,{x:number;y:number}>(),updates:{id:string;style:{x:number;y:number}}[]=[];
  for(const p of this.anchors){const x=p.x*zoom+origin[0],y=p.y*zoom+origin[1],visible=x>-60&&y>-60&&x<width+60&&y<height+60;
   if(visible&&driftAmplitude(p.r)*zoom>=.6){const offset=driftOffset(p.id,p.r,this.time),blend=Math.min(1,this.time/600),position={x:p.x+offset.x*blend,y:p.y+offset.y*blend};positions.set(p.id,position);updates.push({id:p.id,style:position});}
   else if(this.moved.has(p.id))updates.push({id:p.id,style:{x:p.x,y:p.y}});
  }
  if(updates.length){this.busy=true;try{this.graph.updateNodeData(updates);this.moved=positions;this.pending=this.graph.draw();await this.pending;if(!this.stopped){this.onMove(positions);this.container.dataset.motionFrames=String(Number(this.container.dataset.motionFrames??0)+1);}}catch{void this.stop(false);}finally{this.busy=false;}}
  this.tick();
 }
 stop(reset=true){this.stopped=true;clearTimeout(this.timer);this.graph.off('aftertransform',this.interact);return this.pending.catch(()=>{}).then(async()=>{if(!reset||this.graph.destroyed)return;const updates=this.anchors.filter(p=>this.moved.has(p.id)).map(p=>({id:p.id,style:{x:p.x,y:p.y}}));if(updates.length){this.graph.updateNodeData(updates);await this.graph.draw();if(!this.graph.destroyed)this.onMove(new Map());}}).catch(()=>{});}
}
