import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import Ajv from 'ajv';
import {resolveSync} from './configuration.mjs';

test('shipped synchronization schema and runtime accept the same channel, Git and timeout boundaries',async()=>{
 const manifest=JSON.parse(await readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
 const schema=manifest.configSchema.properties.agents.additionalProperties.properties.sync;
 const validate=new Ajv({strict:false}).compile(schema);
 const channels=count=>Object.fromEntries(Array.from({length:count},(_,i)=>['channel'+i,{messageIdPrefix:'id-'}]));
 const cases=[
  [{},true], [{enabled:true},true], [{timeoutMs:1000},true], [{timeoutMs:60000},true],
  [{timeoutMs:999},false], [{timeoutMs:60001},false], [{timeoutMs:1.5},false],
  [{enabled:null},false], [{preserveLocalMemory:false},true], [{preserveLocalMemory:null},false],
  [{branch:'feature/release-1',remote:'origin'},true], [{branch:'main..old'},false], [{remote:'origin..other'},false],
  [{branch:'main\n'},false], [{remote:'origin\r'},false], [{branch:'-main'},false], [{remote:null},false],
  [{gitEnvironment:{}},true], [{gitEnvironment:{CUSTOM_SYNC_MARKER:'1'}},true],
  [{gitEnvironment:{CUSTOM_SYNC_MARKER:'',PATH:'/fixture/bin'}},true],
  [{gitEnvironment:null},false], [{gitEnvironment:[]},false],
  [{gitEnvironment:{'1INVALID':'1'}},false], [{gitEnvironment:{'BAD-NAME':'1'}},false],
  [{gitEnvironment:{['BAD\n']:'1'}},false], [{gitEnvironment:{KEY:1}},false],
  [{gitEnvironment:{KEY:'😀'.repeat(20001)}},true],
  [{gitEnvironment:{KEY:'a\0b'}},false], [{gitEnvironment:{KEY:'a'.repeat(40001)}},false],
  [{gitEnvironment:Object.fromEntries(Array.from({length:101},(_,i)=>['KEY_'+i,'1']))},false],
  [{inboundChannels:{}},false], [{inboundChannels:null},false], [{inboundChannels:[]},false],
  [{inboundChannels:channels(20)},true], [{inboundChannels:channels(21)},false],
  [{inboundChannels:{Slack:{messageIdPrefix:'S-'}}},false],
  [{inboundChannels:{'1channel':{messageIdPrefix:'S-'}}},false],
  [{inboundChannels:{'feishu\n':{messageIdPrefix:'om_'}}},false],
  [{inboundChannels:{['a'.repeat(65)]:{messageIdPrefix:'om_'}}},false],
  [{inboundChannels:{feishu:{messageIdPrefix:''}}},false],
  [{inboundChannels:{feishu:{messageIdPrefix:'a'.repeat(100)}}},true],
  [{inboundChannels:{feishu:{messageIdPrefix:'a'.repeat(101)}}},false],
  [{inboundChannels:{feishu:{messageIdPrefix:'😀'.repeat(60)}}},true],
  [{inboundChannels:{feishu:{messageIdPrefix:'😀'.repeat(101)}}},false],
  ...['\n','\r','\0'].map(control=>[{inboundChannels:{feishu:{messageIdPrefix:'om_'+control}}},false]),
  [{inboundChannels:{feishu:{}}},false], [{inboundChannels:{feishu:{messageIdPrefix:'om_',extra:true}}},false],
  [{submoduleSchedule:{time:'08:00',timeZone:'Asia/Shanghai'}},true],
  [{submoduleSchedule:{time:'23:59',timeZone:'UTC'}},true],
  [{submoduleSchedule:{time:'24:00',timeZone:'UTC'}},false],
  [{submoduleSchedule:{time:'08:00\n',timeZone:'UTC'}},false],
  [{submoduleSchedule:{time:'08:00'}},false],
  [{submoduleSchedule:{time:'08:00',timeZone:''}},false],
  [{submoduleSchedule:{time:'08:00',timeZone:'UTC',extra:true}},false],
  [{submoduleSchedule:null},false],
  [{unexpected:true},false], [null,false],
 ];
 for(const [value,expected] of cases){
  const label=JSON.stringify(value);
  assert.equal(validate(structuredClone(value)),expected,'schema: '+label);
  let accepted=true;try{resolveSync(structuredClone(value));}catch{accepted=false;}
  assert.equal(accepted,expected,'runtime: '+label);
 }
});


test('Git environment is copied without inventing an operator override',()=>{
 assert.ok(!Object.hasOwn(resolveSync({}),'gitEnvironment'));
 const input={gitEnvironment:{CUSTOM_SYNC_MARKER:'1'}},resolved=resolveSync(input);
 resolved.gitEnvironment.CUSTOM_SYNC_MARKER='changed';
 assert.equal(input.gitEnvironment.CUSTOM_SYNC_MARKER,'1');
 assert.deepEqual(resolveSync({gitEnvironment:{}}).gitEnvironment,{});
});
