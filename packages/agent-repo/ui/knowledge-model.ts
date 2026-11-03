export interface KnowledgeEntry {path:string;title:string;uid?:string;type?:string;status?:string;excerpt?:string;line?:number;featureId?:string;featureSource?:string;area?:string;contentHash?:string;neighborDegree?:number;inDegree?:number;outDegree?:number;createdAt?:string;updatedAt?:string}
export interface KnowledgeScope {available:boolean;complete:boolean;knowledgePath:string;normalized:boolean;metadataNamespace:string;issues?:{path?:string;code:string}[]}
export interface KnowledgePage extends KnowledgeScope {entries:KnowledgeEntry[];total:number;offset:number;nextOffset:number|null}
export interface KnowledgeDocument extends KnowledgeScope {found:boolean;entry:KnowledgeEntry;content:string;startLine:number;endLine:number;totalLines:number;nextLine:number|null;sha256:string;lineTruncated:boolean}
export interface KnowledgeValidation extends KnowledgeScope {valid:boolean|null;errors:{path?:string;code:string}[];warnings:{path?:string;code:string}[]}
export interface KnowledgeCatalog {projects:{projectId:string;name:string;knowledge?:{available?:boolean;exists?:boolean;state?:string}}[]}
export interface KnowledgeEdge {source:string;target:string;kind:'link'|'relation';relation?:string}
export interface KnowledgeGraph extends KnowledgeScope {nodes:KnowledgeEntry[];edges:KnowledgeEdge[];totalNodes:number;nodeLimit:number;edgeLimit:number;scanComplete:boolean;truncated:boolean;unresolvedReferences:number;ignoredReferences:number;omittedEdges:number;invalidDocuments:number;referenceLimit:boolean}
export interface KnowledgeIndex extends KnowledgeScope {snapshotId?:string;state:'building'|'ready'|'error';entrypoint?:string;totalNodes:number;totalEdges:number;processed:number;total:number;error?:string;stale?:boolean;commit?:string;at?:string;source?:string;indexedAt?:string}
export interface KnowledgeHistoryRecord {pullRequest?:number;decisionCount?:number;decisionPaths?:string[];id:string;parent?:string;at:string;title:string;snapshotId?:string}
export interface KnowledgeHistory {granularity?:string;omittedRecords?:number;head:string;source:string;complete:boolean;reason?:string;records:KnowledgeHistoryRecord[];total:number;nextCursor:string|null}
export interface KnowledgeChange {kind:string;path:string;previousPath?:string;entry:KnowledgeEntry}
export interface KnowledgeDiff {beforeSnapshotId?:string;afterSnapshotId:string;changes:KnowledgeChange[];commit:string;at:string;relationsAdded?:KnowledgeEdge[];relationsRemoved?:KnowledgeEdge[]}
