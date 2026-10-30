import {test,expect} from '@playwright/test';
// This fixture exercises the real built browser entries with a synthetic public host.
async function ready(page:import('@playwright/test').Page,section='audit'){
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/?section='+section);await expect(page.locator('html')).toHaveAttribute('data-ready','true');
 return errors;
}
for(const width of [320,400,720,1280])test(`audit and portal fit ${width}px with inherited light/dark theme`,async({page})=>{
 await page.setViewportSize({width,height:900});const errors=await ready(page);
 await expect(page.getByRole('heading',{name:'审计',exact:true})).toBeVisible();
 await page.getByText(/测试计划 0/).first().click();await expect(page.getByRole('cell',{name:'source',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'打开回收站'}).click();const dialog=page.getByRole('dialog',{name:'回收站',exact:true});await expect(dialog).toBeVisible();await expect(dialog).toContainText('共 26 项');
 const box=await dialog.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);
 await page.evaluate(()=>{(window as any).fixture.setTheme('dark');});await expect(dialog).toHaveCSS('background-color','rgb(36, 38, 37)');
 await page.keyboard.press('Tab');await expect.poll(()=>page.evaluate(()=>document.querySelector('[role=dialog]')?.contains(document.activeElement))).toBe(true);
 await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(page.getByRole('button',{name:'打开回收站'})).toBeFocused();
 await expect(page.getByRole('button',{name:'刷新审计'})).toHaveCSS('background-color','rgb(36, 38, 37)');
 await page.screenshot({path:`.tmp/ui-audit-${width}.png`,fullPage:true});expect(errors).toEqual([]);
});
test('trash writes retain original request IDs for an unknown outcome and close on permission loss',async({page})=>{
 const errors=await ready(page);await page.getByRole('button',{name:'打开回收站'}).click();
 await page.getByRole('button',{name:'恢复测试计划 0',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('保持暂停');
 await page.evaluate(()=>{(window as any).fixture.setMutationStatus('unknown');});await page.getByRole('button',{name:'确认执行'}).click();await expect(page.getByRole('alert')).toContainText('不要新建请求');
 await page.getByRole('button',{name:'确认执行'}).click();
 const requests=await page.evaluate(()=>(window as any).fixture.calls.filter((p:any)=>p.actionId==='projects-recycleRestore'));
 expect(requests).toHaveLength(2);expect(requests[0].payload.requestId).toBe(requests[1].payload.requestId);expect(requests[0].payload.expectedRevision).toBe('rev-0');
 await page.evaluate(()=>{(window as any).fixture.setConnection({canWrite:false});});await expect(page.getByRole('dialog')).toBeHidden();
 await page.getByRole('button',{name:'打开回收站'}).click();await expect(page.getByRole('button',{name:'恢复测试计划 0',exact:true})).toBeDisabled();
 await page.evaluate(()=>{(window as any).fixture.dispose();});await expect(page.locator('[data-ocp-overlay]')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).fixture.subscriberCount())).toBe(0);expect(errors).toEqual([]);
});
test('Worker management preserves typed search text on timed refresh and uses the original task link',async({page})=>{
 const errors=await ready(page,'worker');await expect(page.getByRole('table',{name:'Worker 任务列表'})).toBeVisible();
 await page.getByRole('searchbox',{name:'搜索 Worker 任务'}).fill('尚未提交的搜索');await page.waitForTimeout(5200);await expect(page.getByRole('searchbox',{name:'搜索 Worker 任务'})).toHaveValue('尚未提交的搜索');
 await page.getByRole('button',{name:'查看详情'}).click();const opened=await page.evaluate(()=>(window as any).fixture.opened);
 expect(opened[0].params.jobId).toBe('11111111-1111-4111-8111-111111111111');expect(opened[0].params.sessionKey).toBe('agent:main:real-chat');expect(errors).toEqual([]);
});

test('Agent selection preserves the host method receiver and rejects late previous-Agent data',async({page})=>{
 const errors=await ready(page);
 await page.evaluate(()=>{(window as any).fixture.delayReads(true);});
 await page.getByRole('button',{name:'刷新审计'}).click();
 await page.getByRole('combobox',{name:'AgentRepo 所属 Agent'}).selectOption('other');
 await page.evaluate(()=>{(window as any).fixture.releaseReads();});
 await expect(page.getByText(/其他 Agent 测试计划 0/).first()).toBeVisible();
 expect(await page.evaluate(()=>(window as any).fixture.host.agents.selectedId)).toBe('other');
 const calls=await page.evaluate(()=>(window as any).fixture.calls.filter((r:any)=>r.actionId==='projects-audit'));
 expect(calls.at(-1).agentId).toBe('other');expect(calls.at(-1).sessionKey).toBe('agent:other:agent-repo-management');
 await page.evaluate(()=>{(window as any).fixture.setPresented(false);});await expect(page.getByRole('heading',{name:'审计',exact:true})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).fixture.setPresented(true);});await expect(page.getByRole('heading',{name:'审计',exact:true})).toBeVisible();
 await page.evaluate(()=>{(window as any).fixture.setConnection({canRead:false});});await expect(page.getByRole('alert')).toContainText('operator.read');await expect(page.locator('.ar-audit')).toHaveCount(0);expect(errors).toEqual([]);
});

test('a native host modal stays interactive above a plugin modal',async({page})=>{
 await ready(page);await page.getByRole('button',{name:'打开回收站'}).click();const plugin=page.getByRole('dialog',{name:'回收站',exact:true});await expect(plugin).toBeVisible();
 await page.evaluate(()=>{const dialog=document.createElement('dialog');dialog.id='native-host';dialog.setAttribute('aria-label','Host confirmation');const button=document.createElement('button');button.textContent='Host close';button.onclick=()=>dialog.close();dialog.append(button);document.body.append(dialog);dialog.showModal();});
 const host=page.getByRole('dialog',{name:'Host confirmation'});await expect(host).toBeVisible();await host.getByRole('button',{name:'Host close'}).click();await expect(host).toBeHidden();await expect(plugin).toBeVisible();
 await page.evaluate(()=>{(document.getElementById('native-host') as HTMLDialogElement).showModal();});await page.keyboard.press('Escape');await expect(host).toBeHidden();await expect(plugin).toBeVisible();
 await plugin.getByRole('button',{name:'关闭',exact:true}).click();await expect(plugin).toBeHidden();await expect.poll(()=>page.evaluate(()=>document.body.style.pointerEvents)).toBe('');await expect(page.getByRole('button',{name:'打开回收站'})).toBeFocused();
});
