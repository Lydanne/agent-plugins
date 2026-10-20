import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMainPluginCatalogReader} from './plugin-catalog.mjs';
test('native catalog support avoids launching a child process',async()=>{
 const reader=createMainPluginCatalogReader({gatewayRequest:async(method,params)=>({method,params}),run:()=>{throw Error('unexpected child');}});
 assert.deepEqual(await reader('plugins.list',{}),{method:'plugins.list',params:{}});
});
test('third-party Gateway restriction uses only the official read-only CLI without shell expansion',async()=>{
 let called;
 const reader=createMainPluginCatalogReader({gatewayRequest:async()=>{throw Error('Gateway requests are only available to bundled or trusted official plugins. Plugin "agent-repo" is neither.');},run:async(...args)=>{called=args;return {stdout:'{"agentId":"main","groups":[]}'}}});
 assert.deepEqual(await reader('tools.catalog',{agentId:'main',includePlugins:true}),{agentId:'main',groups:[]});
 assert.equal(called[0],'openclaw');assert.deepEqual(called[1],['gateway','call','tools.catalog','--params','{"agentId":"main","includePlugins":true}','--json','--timeout','45000']);
 assert.equal(called[2].shell,undefined);assert.equal(called[2].timeout,60000);
 await assert.rejects(reader('tools.invoke',{}),/Unsupported/);
 await assert.rejects(reader('tools.catalog',{agentId:'$(command)',includePlugins:true}),/parameters/);
 await assert.rejects(reader('plugins.list',{agentId:'main'}),/parameters/);
});
test('unrelated host failures are not masked and child failures never expose stderr or credentials',async()=>{
 const host=createMainPluginCatalogReader({gatewayRequest:async()=>{throw Error('secret=fixture');},run:()=>{throw Error('unexpected child');}});
 await assert.rejects(host('plugins.list',{}),error=>error.message==='Unable to read Main plugin catalog through host API');
 const cli=createMainPluginCatalogReader({run:async()=>{throw Error('stderr secret=fixture');}});
 await assert.rejects(cli('plugins.list',{}),error=>error.message==='Unable to read Main plugin catalog through OpenClaw CLI');
});

test('managed services reuse the exact Node and CLI entrypoint without depending on shell PATH',async()=>{
 let called;
 const reader=createMainPluginCatalogReader({cliCommand:['/fixture/node','/fixture/openclaw.mjs'],run:async(...args)=>{called=args;return {stdout:'{"plugins":[]}'}}});
 assert.deepEqual(await reader('plugins.list',{}),{plugins:[]});
 assert.equal(called[0],'/fixture/node');assert.deepEqual(called[1].slice(0,4),['/fixture/openclaw.mjs','gateway','call','plugins.list']);
});
