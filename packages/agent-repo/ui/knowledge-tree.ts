import type {KnowledgeEntry} from './knowledge-model';
export interface KnowledgeTreeNode {path:string;title:string;folder:boolean;entry?:KnowledgeEntry;children:KnowledgeTreeNode[]}
export interface KnowledgeTreeRow extends KnowledgeTreeNode {depth:number}
export function buildKnowledgeTree(entries:KnowledgeEntry[]){
 const root:KnowledgeTreeNode={path:'',title:'',folder:true,children:[]},folders=new Map([['',root]]);
 for(const entry of entries){const parts=entry.path.split('/');let parent=root;for(let i=1;i<parts.length;i++){const path=parts.slice(0,i).join('/');let folder=folders.get(path);if(!folder){folder={path,title:parts[i-1]!,folder:true,children:[]};folders.set(path,folder);parent.children.push(folder);}parent=folder;}parent.children.push({path:entry.path,title:entry.title,entry,folder:false,children:[]});}
 for(const folder of folders.values()){
  if(folder!==root){const index=folder.children.find(n=>!n.folder&&n.path===folder.path+'/index.md')??folder.children.find(n=>!n.folder&&n.path===folder.path+'/README.md');if(index){folder.entry=index.entry;folder.title=index.title;folder.children=folder.children.filter(n=>n!==index);}}
 }
 for(const folder of folders.values()){
  folder.children.sort((a,b)=>{const priority=(n:KnowledgeTreeNode)=>n.path==='index.md'?-2:n.path==='README.md'?-1:0;return priority(a)-priority(b)||a.title.localeCompare(b.title,'zh-CN')||a.path.localeCompare(b.path);});
 }
 return root.children;
}
export function flattenKnowledgeTree(nodes:KnowledgeTreeNode[],opened:Set<string>,query:string){
 const q=query.trim().toLowerCase(),rows:KnowledgeTreeRow[]=[];
 function visit(n:KnowledgeTreeNode,depth:number,ancestorMatch=false):KnowledgeTreeRow[]{const match=ancestorMatch||!q||`${n.title} ${n.path} ${n.entry?.path??''} ${n.entry?.uid??''}`.toLowerCase().includes(q);const children=q?n.children.flatMap(c=>visit(c,depth+1,match)):[];if(q&&!match&&!children.length)return [];const row={...n,depth};return [row,...(q?children:opened.has(n.path)?n.children.flatMap(c=>visit(c,depth+1)):[])];}
 for(const n of nodes)rows.push(...visit(n,0));return rows;
}
