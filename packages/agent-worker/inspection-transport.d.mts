export const inspectionChunkSize:32000;
export const inspectionMaxChunks:512;
export function readInspectionResponse<T=unknown>(request:(action:string,payload:Record<string,unknown>)=>Promise<unknown>,action:string,payload:Record<string,unknown>):Promise<T>;
