export interface KnowledgeEntry {path:string;title:string;uid?:string;type?:string;status?:string;excerpt?:string;line?:number}
export interface KnowledgeScope {available:boolean;complete:boolean;knowledgePath:string;normalized:boolean;metadataNamespace:string;issues?:{path?:string;code:string}[]}
export interface KnowledgePage extends KnowledgeScope {entries:KnowledgeEntry[];total:number;offset:number;nextOffset:number|null}
export interface KnowledgeDocument extends KnowledgeScope {found:boolean;entry:KnowledgeEntry;content:string;startLine:number;endLine:number;totalLines:number;nextLine:number|null;sha256:string;lineTruncated:boolean}
export interface KnowledgeValidation extends KnowledgeScope {valid:boolean|null;errors:{path?:string;code:string}[];warnings:{path?:string;code:string}[]}
export interface KnowledgeCatalog {projects:{projectId:string;name:string}[]}
