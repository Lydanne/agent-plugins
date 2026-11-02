import type {Graph} from './knowledge-g6';
import type {layoutNetwork} from './knowledge-network';
export class KnowledgeOrbits {
 readonly canvas=document.createElement('canvas');private frame=0;private path=new Path2D();
 constructor(private host:HTMLElement,private graph:Graph){this.canvas.className='kb-orbit-layer';Object.assign(this.canvas.style,{position:'absolute',inset:'0',pointerEvents:'none'});host.prepend(this.canvas);graph.on('aftertransform',this.schedule);}
 update(network:ReturnType<typeof layoutNetwork>){this.path=new Path2D();let count=0;for(const g of network.groups)for(const r of g.orbits??[]){this.path.moveTo(g.x+r,g.y);this.path.arc(g.x,g.y,r,0,Math.PI*2);count++;}this.canvas.dataset.orbits=String(count);this.draw();}
 schedule=()=>{if(!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.draw();});};
 draw(){const width=this.host.clientWidth,height=this.host.clientHeight,dpr=devicePixelRatio||1;if(!width||!height)return;const w=Math.round(width*dpr),h=Math.round(height*dpr);if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}this.canvas.style.width=width+'px';this.canvas.style.height=height+'px';const ctx=this.canvas.getContext('2d');if(!ctx)return;ctx.resetTransform();ctx.clearRect(0,0,w,h);const zoom=this.graph.getZoom(),origin=this.graph.getViewportByCanvas([0,0]);ctx.setTransform(zoom*dpr,0,0,zoom*dpr,origin[0]*dpr,origin[1]*dpr);ctx.strokeStyle='rgba(155,184,227,.16)';ctx.lineWidth=.7/zoom;ctx.stroke(this.path);}
 destroy(){cancelAnimationFrame(this.frame);this.graph.off('aftertransform',this.schedule);this.canvas.remove();}
}
