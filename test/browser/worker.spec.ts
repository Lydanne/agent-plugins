import {test,expect,type Page} from '@playwright/test';
async function ready(page:Page,surface='worker'){
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/?surface='+surface);await expect(page.locator('html')).toHaveAttribute('data-ready','true');await expect(page.locator('.cq-row')).toHaveCount(3);return errors;
}
async function startSelection(page:Page){await page.getByRole('button',{name:'会话列表更多操作'}).click();await page.getByRole('menuitem',{name:'多选会话'}).click();await page.getByRole('checkbox',{name:'全选已加载的可删除会话'}).check();}
for(const width of [320,400,720,1280])test(`Worker four views and dialogs at ${width}px`,async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 await page.setViewportSize({width,height:900});const errors=await ready(page,width===1280?'project-tasks':'worker');
 const quick=page.locator('.cq-row').filter({hasText:'fixture-quick'});const menuButton=quick.getByRole('button',{name:'demo / 历史问题 · fixture-quick 的更多操作'});
 await menuButton.click();const menu=page.getByRole('menu');await expect(menu).toBeVisible();const menuBox=await menu.boundingBox();expect(menuBox!.x).toBeGreaterThanOrEqual(0);expect(menuBox!.x+menuBox!.width).toBeLessThanOrEqual(width);await page.keyboard.press('Escape');await expect(menu).toBeHidden();await expect(menuButton).toBeFocused();
 await quick.locator('.cq-row-open').click();await expect(page.getByRole('heading',{name:'历史问题',exact:true})).toBeVisible();await expect(page.locator('.cq-message.main')).toContainText('work_full_123');
 await page.locator('.cq-message.main').getByRole('button',{name:'原始消息'}).click();const raw=page.getByRole('dialog',{name:'Main 原始消息'});await expect(raw).toBeVisible();await expect(raw.locator('pre')).toContainText('work_full_123');await raw.getByRole('button',{name:'不换行',exact:true}).click();await expect(raw.locator('pre')).toHaveClass(/cq-nowrap/);await raw.getByRole('button',{name:'复制',exact:true}).click();await expect(raw.locator('[role=status]')).toContainText('已复制');await page.keyboard.press('Escape');await expect(raw).toBeHidden();
 await page.getByRole('tab',{name:'对话记录',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'任务过程',exact:true})).toHaveAttribute('aria-selected','true');await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'任务信息',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('.cq-task-details')).toContainText('fixture-queue');await page.getByRole('button',{name:'原始任务 JSON'}).click();await expect(page.getByRole('dialog')).toContainText('完整业务标识');await page.keyboard.press('Escape');
 await page.getByRole('tab',{name:'会话信息',exact:true}).click();await expect(page.locator('.cq-information')).toContainText('/fixture/workspace/demo-0');await expect(page.locator('.cq-information')).toContainText('独立 workspace');
 await page.getByRole('tab',{name:'任务过程',exact:true}).click();await expect(page.getByRole('tab',{name:'任务过程',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('.cq-process')).toContainText('用户 · 卡片选择');await expect(page.locator('.cq-call-elapsed')).toHaveText('1s');
 await page.evaluate(()=>{(window as any).fixture.setTheme('dark');});await expect(page.locator('.cq-panel').first()).toHaveCSS('background-color','rgb(36, 38, 37)');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);const scrollBox=await page.locator('.cq-scroll').first().boundingBox();expect(scrollBox!.height).toBeGreaterThan(150);
 await expect(page.getByRole('tab',{name:'任务过程',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('tab',{name:'任务过程',exact:true})).toHaveCSS('border-bottom-color','rgb(109, 142, 161)');await page.screenshot({path:`.tmp/worker-${width}.png`});expect(errors).toEqual([]);
});
test('Worker bulk deletion preserves exact identities and retries only failed sessions',async({page})=>{
 const errors=await ready(page);await page.evaluate(()=>{(window as any).fixture.failDeletion('d'.repeat(64));});await startSelection(page);
 await expect(page.getByRole('checkbox',{name:'选择会话 demo / 检查项目与依赖 · fixture-running'})).toBeDisabled();await expect(page.getByRole('status').filter({hasText:'已选 2 个会话'})).toBeVisible();
 await page.getByRole('button',{name:'删除所选 (2)'}).click();await expect(page.getByRole('dialog')).toContainText('fixture-quick');await expect(page.getByRole('dialog')).toContainText('fixture-deep');await page.getByRole('button',{name:'确认批量删除'}).click();await expect(page.getByRole('dialog')).toBeHidden();await expect(page.getByRole('alert')).toContainText('已删除 1 个会话，1 个未确认删除');
 const calls=await page.evaluate(()=>(window as any).fixture.calls.filter((r:any)=>r.actionId==='inspect-deleteSession'));
 expect(calls.map((r:any)=>r.payload.modelSessionScope)).toEqual(['b'.repeat(64),'d'.repeat(64)]);expect(calls.every((r:any)=>r.sessionKey==='agent:main:real-chat'&&r.payload.confirmed===true)).toBe(true);expect(calls[0].payload.revision).toBe('c'.repeat(64));
 await page.getByRole('button',{name:'删除所选 (1)'}).click();await page.getByRole('button',{name:'确认批量删除'}).click();await expect(page.getByRole('dialog')).toBeHidden();expect(await page.evaluate(()=>(window as any).fixture.calls.filter((r:any)=>r.actionId==='inspect-deleteSession').map((r:any)=>r.payload.modelSessionScope))).toEqual(['b'.repeat(64),'d'.repeat(64),'d'.repeat(64)]);expect(errors).toEqual([]);
});
test('Worker stops a bulk operation after write permission is revoked',async({page})=>{
 const errors=await ready(page);await startSelection(page);await page.getByRole('button',{name:'删除所选 (2)'}).click();await page.evaluate(()=>{(window as any).fixture.delayDeletes(true);});await page.getByRole('button',{name:'确认批量删除'}).click();await expect.poll(()=>page.evaluate(()=>(window as any).fixture.calls.filter((r:any)=>r.actionId==='inspect-deleteSession').length)).toBe(1);
 await page.evaluate(()=>{(window as any).fixture.setConnection({canWrite:false});});await expect(page.getByRole('dialog')).toBeHidden();await page.evaluate(async()=>{(window as any).fixture.releaseDeletes();await new Promise(requestAnimationFrame);});expect(await page.evaluate(()=>(window as any).fixture.calls.filter((r:any)=>r.actionId==='inspect-deleteSession').length)).toBe(1);await expect(page.locator('.cq-more')).toHaveCount(0);expect(errors).toEqual([]);
});
test('Worker hidden view releases menus, dialogs and subscriptions without restarting work',async({page})=>{
 const errors=await ready(page);await page.locator('.cq-row').filter({hasText:'fixture-quick'}).locator('.cq-row-open').click();await page.locator('.cq-message.main').getByRole('button',{name:'原始消息'}).click();await expect(page.getByRole('dialog')).toBeVisible();
 await page.evaluate(()=>{(window as any).fixture.setPresented(false);});await expect(page.getByRole('dialog')).toBeHidden();await expect(page.getByRole('region',{name:'Agent Worker 会话'})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).fixture.dispose();});await expect(page.locator('[data-ocp-overlay]')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).fixture.subscriberCount())).toBe(0);expect(await page.evaluate(()=>(window as any).fixture.calls.some((r:any)=>r.actionId==='inspect-deleteSession'))).toBe(false);expect(errors).toEqual([]);
});

test('independent plugin bundles and multiple Worker views keep DOM IDs and local filters isolated',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1280,height:900});await page.goto('/?section=audit');await expect(page.locator('html')).toHaveAttribute('data-ready','true');
 await page.evaluate(()=>{(window as any).fixture.mountExtraWorker('worker-one',380);(window as any).fixture.mountExtraWorker('worker-two',0);});
 await expect(page.locator('#worker-one .cq-row')).toHaveCount(3);await expect(page.locator('#worker-two .cq-row')).toHaveCount(3);
 const duplicateIds=()=>page.evaluate(()=>{const ids=Array.from(document.querySelectorAll('[id]')).map(node=>node.id);return ids.filter((id,index)=>ids.indexOf(id)!==index);});expect(await duplicateIds()).toEqual([]);
 await page.locator('#worker-one').getByRole('button',{name:'会话列表更多操作'}).click();await expect(page.getByRole('menu')).toBeVisible();expect(await duplicateIds()).toEqual([]);await page.keyboard.press('Escape');
 await page.locator('#worker-two').getByRole('searchbox',{name:'搜索会话或标签'}).fill('第二视图的独立搜索');await page.locator('#worker-two').getByRole('searchbox',{name:'搜索会话或标签'}).press('Enter');await expect(page.locator('#worker-two .cq-row')).toHaveCount(0);await expect(page.locator('#worker-one .cq-row')).toHaveCount(3);await expect(page.locator('.ar-audit')).toBeVisible();
 await page.evaluate(()=>{(window as any).fixture.dispose();});await expect(page.locator('[data-ocp-overlay]')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).fixture.subscriberCount())).toBe(0);expect(errors).toEqual([]);
});
