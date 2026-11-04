import test from 'node:test';
import assert from 'node:assert/strict';
import {networkOperation,createNetworkTool} from './authorization-network.mjs';
test('network requires execution, read and transfer with a normalized destination',()=>{
 const result=networkOperation({toolName:'agent_network',params:{url:'https://EXAMPLE.com/a'}});assert.equal(result.context.destinationHost,'example.com');assert.deepEqual(result.requirements.map(r=>r.action),['execute','read','transfer']);
 for(const url of ['http://example.com','https://user:secret@example.com','https://example.com/#secret'])assert.equal(networkOperation({toolName:'agent_network',params:{url}}),undefined);
});
test('network reader refuses redirects and oversized output and always releases transport',async()=>{
 let released=0;const tool=createNetworkTool({fetchGuard:async options=>{assert.equal(options.maxRedirects,0);assert.equal(options.pinDns,true);return {response:new Response('too long'),release:async()=>released++};}});
 await assert.rejects(tool.execute('id',{url:'https://example.com',maxBytes:2}),/limit/);assert.equal(released,1);
 const redirect=createNetworkTool({fetchGuard:async()=>({response:new Response('',{status:302}),release:async()=>released++})});await assert.rejects(redirect.execute('id',{url:'https://example.com'}),/Redirect/);assert.equal(released,2);
});
