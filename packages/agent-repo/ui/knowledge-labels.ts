import type {Graph} from './knowledge-g6';
import type {layoutNetwork} from './knowledge-network';
type Network=ReturnType<typeof layoutNetwork>;
type Label={id:string;el:HTMLSpanElement;x:number;y:number;r:number;width:number;height:number;selected:boolean};
// Screen-space labels retain readable type at overview zoom without scaling nodes.
export class KnowledgeLabels {
 readonly element=document.createElement('div');private frame=0;private alive=true;private labels:Label[]=[];
 constructor(private host:HTMLElement,private graph:Graph){this.element.className='kb-label-layer';this.element.setAttribute('aria-hidden','true');Object.assign(this.element.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'hidden'});host.append(this.element);graph.on('aftertransform',this.schedule);}
 update(network:Network,path:string,safe:(text:string)=>string,highlights:string[]=[]){
  this.element.replaceChildren();this.labels=[];
  const selected=network.points.find(p=>p.path===path);
  const featured=highlights.filter(p=>p!==path).map(p=>network.points.find(n=>n.path===p)).filter((p):p is Network['points'][number]=>!!p);
  const entries=[...(selected?[{...selected,text:selected.entry.title,selected:true}]:[]),...featured.map(p=>({...p,text:'● '+p.entry.title,selected:true})),...network.groups.slice().sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id)).map(g=>({...g,text:g.label+' · '+g.count+' 篇',selected:false}))];
  for(const p of entries){const el=document.createElement('span');el.textContent=safe(p.text);el.className=p.selected?'kb-selected-label':'kb-group-label';Object.assign(el.style,{position:'absolute',width:'max-content',maxWidth:'240px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',fontSize:p.selected?'16px':'14px',fontWeight:'600',lineHeight:'22px',padding:'3px 8px',color:'#f2f6ff',background:'rgba(11,16,33,.88)',borderRadius:'6px',border:p.selected?'1px solid #c1d2eb':'1px solid #7185a644',boxSizing:'border-box'});this.element.append(el);this.labels.push({id:p.id,el,x:p.x,y:p.y,r:p.r,width:0,height:0,selected:p.selected});}
  // Batch layout reads once, never measure every document during camera motion.
  for(const label of this.labels){label.width=label.el.offsetWidth;label.height=label.el.offsetHeight;}this.draw();
 }
 updateMotion(positions:Map<string,{x:number;y:number}>){let changed=false;for(const label of this.labels){const p=positions.get(label.id);if(p&&label.selected){label.x=p.x;label.y=p.y;changed=true;}}if(changed)this.schedule();}
 schedule=()=>{if(this.alive&&!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.draw();});};
 private draw(){
  if(!this.alive)return;
  const width=this.host.clientWidth,height=this.host.clientHeight,zoom=this.graph.getZoom(),origin=this.graph.getViewportByCanvas([0,0]),occupied=new Map<string,Array<{x:number;y:number;w:number;h:number}>>();let visible=0;
  for(const l of this.labels){const cx=l.x*zoom+origin[0],cy=l.y*zoom+origin[1],x=cx-l.width/2,y=cy+(l.selected?l.r*zoom+8:-l.r*zoom-l.height-8),rect={x,y,w:l.width,h:l.height};
   const keys:string[]=[];for(let col=Math.floor((x-6)/256);col<=Math.floor((x+l.width+6)/256);col++)for(let row=Math.floor((y-6)/40);row<=Math.floor((y+l.height+6)/40);row++)keys.push(col+':'+row);
   const hidden=x<0||y<0||x+l.width>width||y+l.height>height||keys.some(k=>occupied.get(k)?.some(r=>x<r.x+r.w+6&&x+l.width+6>r.x&&y<r.y+r.h+6&&y+l.height+6>r.y));
   l.el.hidden=hidden;if(hidden)continue;l.el.style.transform=`translate(${Math.round(x)}px,${Math.round(y)}px)`;visible++;for(const k of keys){const list=occupied.get(k)??[];list.push(rect);occupied.set(k,list);}
  }this.element.dataset.visibleLabels=String(visible);
 }
 destroy(){this.alive=false;cancelAnimationFrame(this.frame);this.graph.off('aftertransform',this.schedule);this.element.remove();}
}
