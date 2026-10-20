import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {workerEnvironment} from './plugin-environment.mjs';

test('both worker process boundaries preserve independent CLI access but remove host plugin credentials',()=>{
 const source={PATH:process.env.PATH,CODEX_HOME:'/tmp/codex-fixture',OPENCLAW_STATE_DIR:'/tmp/state-fixture',
  FEISHU_APP_SECRET:'fixture-private-secret',FEISHU_APP_ID:'cli_fixture',LARK_APP_SECRET:'fixture-host-secret',
  LARKSUITE_CLI_USER_ACCESS_TOKEN:'fixture-cli-token',LARKSUITE_CLI_TENANT_ACCESS_TOKEN:'fixture-cli-bot-token',
  LARKSUITE_CLI_CONFIG_DIR:'/tmp/cli-fixture',LARKSUITE_CLI_AUTH_PROXY:'http://127.0.0.1:1',
  LARKSUITE_CLI_PROFILE:'operator',OPENCLAW_GATEWAY_TOKEN:'fixture-gateway',OPENCLAW_GATEWAY_PASSWORD:'fixture-password'};
 const env=workerEnvironment(workerEnvironment(source));
 assert.equal(source.FEISHU_APP_SECRET,'fixture-private-secret');
 const expected={...source};
 for(const key of ['FEISHU_APP_SECRET','FEISHU_APP_ID','LARK_APP_SECRET','OPENCLAW_GATEWAY_TOKEN','OPENCLAW_GATEWAY_PASSWORD'])delete expected[key];
 assert.deepEqual(env,expected);
 const output=execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify({secret:!!process.env.FEISHU_APP_SECRET,token:process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,profile:process.env.LARKSUITE_CLI_PROFILE,gateway:!!process.env.OPENCLAW_GATEWAY_TOKEN,codex:process.env.CODEX_HOME}))'],{env,encoding:'utf8'});
 assert.deepEqual(JSON.parse(output),{secret:false,token:'fixture-cli-token',profile:'operator',gateway:false,codex:'/tmp/codex-fixture'});
});
