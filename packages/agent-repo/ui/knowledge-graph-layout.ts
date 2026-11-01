import type {KnowledgeEntry,KnowledgeEdge} from './knowledge-model';
export interface GraphPoint {path:string;x:number;y:number;degree:number}
// A bounded, deterministic layout: no timers, network, random state or external renderer.
export function layoutKnowledgeGraph(nodes:KnowledgeEntry[],edges:KnowledgeEdge[]):GraphPoint[]{
 const points=nodes.map((node,i)=>({path:node.path,x:500+Math.cos(i*2.399963)*Math.sqrt(i+1)*34,y:300+Math.sin(i*2.399963)*Math.sqrt(i+1)*24,degree:0}));
 const byPath=new Map(points.map(p=>[p.path,p])),links=edges.flatMap(e=>{const a=byPath.get(e.source),b=byPath.get(e.target);if(!a||!b||a===b)return [];a.degree++;b.degree++;return [{a,b}];});
 for(let step=0;step<70;step++){
  const forces=points.map(()=>({x:0,y:0}));
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
   const a=points[i]!,b=points[j]!,dx=a.x-b.x,dy=a.y-b.y,d2=Math.max(64,dx*dx+dy*dy),f=700/d2;
   forces[i]!.x+=dx*f;forces[i]!.y+=dy*f;forces[j]!.x-=dx*f;forces[j]!.y-=dy*f;
  }
  const indexed=new Map(points.map((p,i)=>[p.path,i]));
  for(const {a,b} of links){const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1,f=(length-150)*.025;forces[indexed.get(a.path)!]!.x+=dx/length*f;forces[indexed.get(a.path)!]!.y+=dy/length*f;forces[indexed.get(b.path)!]!.x-=dx/length*f;forces[indexed.get(b.path)!]!.y-=dy/length*f;}
  for(let i=0;i<points.length;i++){const p=points[i]!,f=forces[i]!;p.x+=Math.max(-10,Math.min(10,f.x+(500-p.x)*.003));p.y+=Math.max(-10,Math.min(10,f.y+(300-p.y)*.003));}
 }
 if(points.length===1){points[0]!.x=500;points[0]!.y=300;}
 if(points.length>1){const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y));const scale=Math.min(700/Math.max(1,maxX-minX),390/Math.max(1,maxY-minY));for(const p of points){p.x=500+(p.x-(minX+maxX)/2)*scale;p.y=280+(p.y-(minY+maxY)/2)*scale;}}
 return points;
}
