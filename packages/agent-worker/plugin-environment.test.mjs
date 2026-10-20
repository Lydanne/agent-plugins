import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {workerEnvironment} from './plugin-environment.mjs';

test('worker child processes do not inherit Feishu/CLI/Gateway credentials while preserving task runtime settings',()=>{
 const source={PATH:process.env.PATH,CODEX_HOME:'/tmp/codex-fixture',OPENCLAW_STATE_DIR:'/tmp/state-fixture',
  FEISHU_APP_SECRET:'fixture-private-secret',FEISHU_APP_ID:'cli_fixture',LARKSUITE_CLI_USER_ACCESS_TOKEN:'fixture-private-token',
  LARKSUITE_CLI_AUTH_PROXY:'http://127.0.0.1:1',LARKSUITE_CLI_PROFILE:'operator',OPENCLAW_GATEWAY_TOKEN:'fixture-gateway'};
 const env=workerEnvironment(source);
 assert.equal(source.FEISHU_APP_SECRET,'fixture-private-secret');
 assert.deepEqual(Object.keys(env).sort(),['CODEX_HOME','OPENCLAW_STATE_DIR','PATH']);
 const output=execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify({secret:!!process.env.FEISHU_APP_SECRET,token:!!process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,gateway:!!process.env.OPENCLAW_GATEWAY_TOKEN,codex:process.env.CODEX_HOME}))'],{env,encoding:'utf8'});
 assert.deepEqual(JSON.parse(output),{secret:false,token:false,gateway:false,codex:'/tmp/codex-fixture'});
});
