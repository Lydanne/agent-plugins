import type {Graph} from './knowledge-g6';
import type {layoutNetwork} from './knowledge-network';
type Network=ReturnType<typeof layoutNetwork>;
type Label={anchor:{x:number;y:number};id:string;el:HTMLSpanElement;x:number;y:number;r:number;width:number;height:number;selected:boolean;document:boolean};
// Fixed screen-space type; ordinary document labels are virtualized by visible
// node size and viewport, rather than creating DOM for the complete knowledge base.
export class KnowledgeLabels {
 readonly element=document.createElement('div');private frame=0;private alive=true;private labels:Label[]=[];
 private documents=new Map<string,Label>();private network?:Network;private excluded=new Set<string>();private safe=(s:string)=>s;private positions=new Map<string,{x:number;y:number}>();
 constructor(private host:HTMLElement,private graph:Graph){this.element.className='kb-label-layer';this.element.setAttribute('aria-hidden','true');Object.assign(this.element.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'hidden'});host.append(this.element);graph.on('aftertransform',this.schedule);}
 private create(p:{id:string;x:number;y:number;r:number},text:string,selected=false,documentLabel=false):Label{
  const el=document.createElement('span');el.textContent=this.safe(text);el.title=this.safe(text);el.className=selected?'kb-selected-label':documentLabel?'kb-document-label':'kb-group-label';Object.assign(el.style,{position:'absolute',width:'max-content',maxWidth:'240px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',fontSize:selected?'16px':'14px',fontWeight:documentLabel?'500':'600',lineHeight:'22px',padding:'3px 8px',color:'#f2f6ff',background:'rgba(11,16,33,.88)',borderRadius:'6px',border:selected?'1px solid #c1d2eb':'1px solid #7185a644',boxSizing:'border-box'});this.element.append(el);return {anchor:p,id:p.id,el,x:p.x,y:p.y,r:p.r,width:0,height:0,selected,document:documentLabel};
 }
 update(network:Network,path:string,safe:(text:string)=>string,highlights:string[]=[]){
  this.element.replaceChildren();this.labels=[];this.documents.clear();this.network=network;this.safe=safe;this.positions.clear();this.excluded=new Set([path,...highlights]);
  const selected=network.points.find(p=>p.path===path),featured=highlights.filter(p=>p!==path).map(p=>network.points.find(n=>n.path===p)).filter((p):p is Network['points'][number]=>!!p);
  if(selected)this.labels.push(this.create(selected,selected.entry.title,true));for(const p of featured)this.labels.push(this.create(p,'● '+p.entry.title,true));
  for(const g of network.groups.slice().sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id)))this.labels.push(this.create(g,g.label+' · '+g.count+' 篇'));
  this.draw();
 }
 updateMotion(positions:Map<string,{x:number;y:number}>){this.positions=positions;this.schedule();}
 schedule=()=>{if(this.alive&&!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.draw();});};
 private draw(){
  if(!this.alive)return;
  const width=this.host.clientWidth,height=this.host.clientHeight,zoom=this.graph.getZoom(),origin=this.graph.getViewportByCanvas([0,0]),occupied=new Map<string,Array<{x:number;y:number;w:number;h:number}>>();let visible=0,visibleDocuments=0;
  const candidates=new Set<string>();for(const p of this.network?.points??[]){if(this.excluded.has(p.path)||p.r*zoom<12)continue;const pos=this.positions.get(p.id)??p,cx=pos.x*zoom+origin[0],cy=pos.y*zoom+origin[1];if(cx<0||cx>width||cy<0||cy>height)continue;candidates.add(p.id);if(!this.documents.has(p.id))this.documents.set(p.id,this.create(p,p.entry.title,false,true));}
  for(const [id,l]of this.documents)if(!candidates.has(id)){l.el.remove();this.documents.delete(id);}
  const labels=[...this.labels,...this.documents.values()];
  // Batch DOM measurement only for newly visible labels, never per hidden document.
  for(const l of labels)if(!l.width){l.width=l.el.offsetWidth;l.height=l.el.offsetHeight;}
  for(const l of labels){const p=this.positions.get(l.id)??l.anchor,cx=p.x*zoom+origin[0],cy=p.y*zoom+origin[1],x=cx-l.width/2,y=cy+(l.selected||l.document?l.r*zoom+8:-l.r*zoom-l.height-8),rect={x,y,w:l.width,h:l.height};
   const keys:string[]=[];for(let col=Math.floor((x-6)/256);col<=Math.floor((x+l.width+6)/256);col++)for(let row=Math.floor((y-6)/40);row<=Math.floor((y+l.height+6)/40);row++)keys.push(col+':'+row);
   const hidden=x<0||y<0||x+l.width>width||y+l.height>height||keys.some(k=>occupied.get(k)?.some(r=>x<r.x+r.w+6&&x+l.width+6>r.x&&y<r.y+r.h+6&&y+l.height+6>r.y));
   l.el.hidden=hidden;if(hidden)continue;l.el.style.transform=`translate(${Math.round(x)}px,${Math.round(y)}px)`;visible++;if(l.document)visibleDocuments++;for(const k of keys){const list=occupied.get(k)??[];list.push(rect);occupied.set(k,list);}
  }this.element.dataset.visibleLabels=String(visible);this.element.dataset.visibleDocumentLabels=String(visibleDocuments);
 }
 destroy(){this.alive=false;cancelAnimationFrame(this.frame);this.graph.off('aftertransform',this.schedule);this.element.remove();this.documents.clear();this.labels=[];this.network=undefined;this.positions.clear();}
}
