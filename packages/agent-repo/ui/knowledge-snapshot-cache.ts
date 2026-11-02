import type {KnowledgeEntry,KnowledgeEdge} from './knowledge-model';
export interface SnapshotData {nodes:KnowledgeEntry[];edges:KnowledgeEdge[]}
// Component-local immutable summaries only; no body text or persistent browser storage.
export class KnowledgeSnapshotCache {
 private values=new Map<string,SnapshotData>();
 constructor(private maxEntries=3,private maxItems=400000){}
 get(id:string){const value=this.values.get(id);if(value){this.values.delete(id);this.values.set(id,value);}return value;}
 set(id:string,value:SnapshotData){this.values.delete(id);if(value.nodes.length+value.edges.length>this.maxItems)return;this.values.set(id,value);while(this.values.size>this.maxEntries||[...this.values.values()].reduce((sum,v)=>sum+v.nodes.length+v.edges.length,0)>this.maxItems)this.values.delete(this.values.keys().next().value!);}
 clear(){this.values.clear();}
}
