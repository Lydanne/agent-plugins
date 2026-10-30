import {test,onTestFinished,vi} from 'vitest';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {browserFixture,uiContext,settle} from '../../../scripts/control-ui-test.mjs';
test('audit preserves ordinary names and actor IDs while translating only deliveryMode',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../audit-page.mjs'));
 f.track(f.ui.mountAudit(f.container,{context:uiContext(async()=>({})),invoke:async()=>({records:[{id:'event',at:1000,targetId:'plan',targetName:'group',action:'update',status:'succeeded',actor:{id:'source'},changes:[{field:'name',before:'source',after:'group'},{field:'deliveryMode',before:'source',after:'group'},{field:'name',before:'constructor',after:'toString'}]}],total:1,nextOffset:null})}));await settle();f.container.querySelector('[aria-label="\u67e5\u770b\u5ba1\u8ba1 group"]').click();await settle();
 const rows=[...f.container.querySelectorAll('[role=dialog] table tr')].map(r=>[...r.children].map(c=>c.textContent));assert.deepEqual(rows.slice(1),[['名称','source','group'],['投递位置','原请求位置','群主会话'],['名称','constructor','toString']]);assert.match(f.container.textContent,/发起指派：source/);
});
