import type {Graph} from './knowledge-g6';
import type {layoutNetwork} from './knowledge-network';
type Network=ReturnType<typeof layoutNetwork>;
// Sweep the whole segment, not only the destination, so fast pointer moves cannot cross a neighbor.
export function constrainDrag(network:Network,id:string,target:{x:number;y:number}){
 const p=network.points.find(p=>p.id===id);if(!p)return undefined;const g=network.groups.find(g=>g.id===p.group)!;
 const radius=g.r-p.r-12,dist=Math.hypot(target.x-g.x,target.y-g.y);let x=target.x,y=target.y;if(dist>radius){x=g.x+(x-g.x)*radius/dist;y=g.y+(y-g.y)*radius/dist;}
 const dx=x-p.x,dy=y-p.y,a=dx*dx+dy*dy;let t=1;
 if(a)for(const q of network.points){if(q.id===id||q.group!==p.group)continue;const ox=p.x-q.x,oy=p.y-q.y,r=p.r+q.r+12,b=2*(ox*dx+oy*dy),c=ox*ox+oy*oy-r*r,disc=b*b-4*a*c;if(disc<0||b>=0)continue;const hit=(-b-Math.sqrt(disc))/(2*a);if(hit>=0&&hit<t)t=Math.max(0,hit-.0001);}
 return {x:p.x+dx*t,y:p.y+dy*t};
}
export class KnowledgeDrag {
 private active?:{pointerId:number;id:string;startX:number;startY:number;x:number;y:number;moved:boolean;offsetX:number;offsetY:number};
 private chain=Promise.resolve();private disposed=false;private frame=0;
 constructor(private host:HTMLElement,private graph:Graph,private network:Network,private pause:()=>Promise<void>,private moved:(network:Network,id:string)=>void,private finish:()=>void,private select:(path:string)=>void){host.addEventListener('pointerdown',this.down,true);host.addEventListener('pointermove',this.move,true);host.addEventListener('pointerup',this.up,true);host.addEventListener('pointercancel',this.cancel,true);host.addEventListener('lostpointercapture',this.cancel,true);window.addEventListener('blur',this.blur);}
 private down=(e:PointerEvent)=>{if(e.button!==0||this.active)return;const [x,y]=this.graph.getCanvasByClient([e.clientX,e.clientY]);const p=this.network.points.find(p=>Math.hypot(p.x-x,p.y-y)<p.r+5);if(!p)return;e.stopPropagation();e.preventDefault();this.host.setPointerCapture(e.pointerId);this.active={pointerId:e.pointerId,id:p.id,startX:e.clientX,startY:e.clientY,x:p.x,y:p.y,moved:false,offsetX:p.x-x,offsetY:p.y-y};this.chain=this.pause();};
 private move=(e:PointerEvent)=>{const a=this.active;if(!a)return;e.stopPropagation();e.preventDefault();const [x,y]=this.graph.getCanvasByClient([e.clientX,e.clientY]);a.x=x+a.offsetX;a.y=y+a.offsetY;a.moved ||= Math.hypot(e.clientX-a.startX,e.clientY-a.startY)>4;if(a.moved&&!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.flush();});};
 private flush(){const a=this.active;if(!a||!a.moved)return;const {id,x,y}=a;this.chain=this.chain.then(async()=>{if(this.disposed||this.graph.destroyed)return;const pos=constrainDrag(this.network,id,{x,y});if(!pos)return;const p=this.network.points.find(p=>p.id===id)!;p.x=pos.x;p.y=pos.y;this.graph.updateNodeData([{id,style:pos}]);await this.graph.draw();if(!this.disposed){this.moved(this.network,id);this.host.dataset.draggedNode=p.path;this.host.dataset.dragPosition=JSON.stringify(pos);}}).catch(()=>{});}
 private up=(e:PointerEvent)=>{if(!this.active)return;e.stopPropagation();e.preventDefault();cancelAnimationFrame(this.frame);this.frame=0;this.flush();const a=this.active;this.active=undefined;if(this.host.hasPointerCapture(e.pointerId))this.host.releasePointerCapture(e.pointerId);void this.chain.then(()=>{if(this.disposed)return;if(!a.moved)this.select(a.id.slice(4));else this.finish();});};
 private cancel=(e:PointerEvent)=>{if(this.active)this.active.moved=true;this.up(e);};
 private blur=()=>{if(this.active)this.cancel(new PointerEvent('pointercancel',{pointerId:this.active.pointerId}));};
 destroy(){this.disposed=true;const active=this.active;this.active=undefined;if(active&&this.host.hasPointerCapture(active.pointerId))this.host.releasePointerCapture(active.pointerId);cancelAnimationFrame(this.frame);this.host.removeEventListener('pointerdown',this.down,true);this.host.removeEventListener('pointermove',this.move,true);this.host.removeEventListener('pointerup',this.up,true);this.host.removeEventListener('pointercancel',this.cancel,true);this.host.removeEventListener('lostpointercapture',this.cancel,true);window.removeEventListener('blur',this.blur);return this.chain;}
}
