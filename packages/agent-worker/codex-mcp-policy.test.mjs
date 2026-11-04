import test from 'node:test';
import assert from 'node:assert/strict';
import {disabledNativeMcpConfig} from './codex-mcp-policy.mjs';
test('native MCP overrides preserve exact server names and retain no connection secrets',()=>{
 const result=disabledNativeMcpConfig({config:{mcp_servers:{'one.two':{command:'private command',env:{TOKEN:'private-token'}},'quoted"server':{url:'private-url',enabled:false}}}});
 assert.deepEqual(result,{mcp_servers:{'one.two':{enabled:false},'quoted"server':{enabled:false}}});
 assert.ok(!JSON.stringify(result).includes('private'));
 assert.deepEqual(disabledNativeMcpConfig({config:{mcp_servers:{}}}),{mcp_servers:{}});
});
test('missing and malformed native MCP inventories are rejected',()=>{
 for(const response of [undefined,{}, {config:{}},{config:{mcp_servers:[]}},{config:{mcp_servers:null}},{config:{mcp_servers:{fixture:null}}},{config:{mcp_servers:{'':{}}}}])assert.throws(()=>disabledNativeMcpConfig(response),/Cannot verify/);
});
