import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,settle} from '../../scripts/control-ui-test.mjs';
test('audit preserves ordinary names and actor IDs while translating only deliveryMode',async t=>{
 const f=await browserFixture(t,new URL('./audit-page.mjs',import.meta.url).pathname);
 f.track(f.ui.mountAudit(f.container,{invoke:async()=>({records:[{id:'event',at:1000,targetId:'plan',targetName:'group',action:'update',status:'succeeded',actor:{id:'source'},changes:[{field:'name',before:'source',after:'group'},{field:'deliveryMode',before:'source',after:'group'},{field:'name',before:'constructor',after:'toString'}]}],total:1,nextOffset:null})}));await settle();
 const rows=[...f.container.querySelectorAll('table tr')].map(r=>[...r.children].map(c=>c.textContent));assert.deepEqual(rows.slice(1),[['名称','source','group'],['投递位置','原请求位置','群主会话'],['名称','constructor','toString']]);assert.match(f.container.textContent,/发起指派：source/);
});
