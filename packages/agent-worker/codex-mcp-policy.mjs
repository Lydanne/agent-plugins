// Configured native MCP servers do not carry the Worker job's authorization
// lease. Plugin operations must use the task-bound host bridge instead.
export function disabledNativeMcpConfig(response){
 const servers=response?.config?.mcp_servers;
 if(!servers||typeof servers!=='object'||Array.isArray(servers)||Object.keys(servers).length>1000)throw Error('Cannot verify Worker native MCP configuration');
 const overrides=Object.create(null);
 for(const [name,server] of Object.entries(servers)){
  if(!name||name.length>512||!server||typeof server!=='object'||Array.isArray(server))throw Error('Cannot verify Worker native MCP configuration');
  overrides[name]={enabled:false};
 }
 return {mcp_servers:{...overrides}};
}
