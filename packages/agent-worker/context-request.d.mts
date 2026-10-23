export type ContextField = {id:string;label:string;type:'text'|'number'|'single_select'|'multi_select'|'date'|'date_range'|'datetime';required?:boolean;options?:{label:string;value:string}[];timezone?:string;min?:number;max?:number;placeholder?:string};
export type ContextRequest = {question:string;reason:string;progress:string;requestKind?:'context'|'plugin';waitKind?:'optional'|'required'|'decision'|'authorization';pluginCall?:{callId:string;capability:string;arguments:Record<string,unknown>;purpose:string};fields?:ContextField[];allowFreeText?:boolean;recommendation?:string};
export function parseContextRequest(text:string):ContextRequest|undefined;
export function validateContextAnswers(request:ContextRequest,values:unknown,options?:{partial?:boolean}):Record<string,unknown>;
