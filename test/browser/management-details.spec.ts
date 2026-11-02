import {test,expect} from '@playwright/test';
for(const width of [320,720,1280])test(`long management tasks remain contained and keyboard-scrollable at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.goto('/?section=worker&longManagedTasks');const table=page.getByRole('table',{name:'Worker 任务列表'});await expect(table).toBeVisible();
 const cells=table.locator('tbody td');await expect(cells).toHaveCount(7);expect(await table.locator('tbody tr').evaluate(el=>el.getBoundingClientRect().height)).toBeLessThan(160);
 expect(await cells.evaluateAll(items=>items.every(el=>el.scrollWidth<=el.clientWidth+1))).toBe(true);
 const summary=table.locator('.ar-task-summary');expect(await summary.evaluate(el=>el.clientHeight<=parseFloat(getComputedStyle(el).lineHeight)*2+1)).toBe(true);await expect(summary).toHaveAttribute('title',/保留完整业务证据/);
 const scroll=page.getByRole('region',{name:'Worker 任务表格滚动区'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 if(width<1280){await scroll.focus();await page.keyboard.press('ArrowRight');await expect.poll(()=>scroll.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);}
 await page.getByRole('button',{name:'Worker 统计口径',exact:true}).click();const help=page.getByRole('dialog',{name:'Worker 统计口径',exact:true});await expect(help).toContainText('模拟宿主：可核验任务绑定');await expect(help).toContainText('历史累计');await page.keyboard.press('Escape');await expect(help).toBeHidden();
 await page.screenshot({path:`.tmp/management-details-worker-${width}.png`});
});
test('overview keeps guidance available on demand and a readable active navigation in dark mode',async({page})=>{
 await page.setViewportSize({width:1280,height:900});await page.goto('/?section=overview');await expect(page.locator('.ar-overview')).toHaveAttribute('aria-busy','false');
 await page.getByRole('button',{name:'概览数据说明',exact:true}).click();const help=page.getByRole('dialog',{name:'概览数据说明',exact:true});await expect(help).toContainText('刷新不会拉取仓库');await page.keyboard.press('Escape');
 await page.screenshot({path:'.tmp/management-details-overview.png'});await page.evaluate(()=>(window as any).fixture.setTheme('dark'));
 await expect(page.locator('.ar-management-nav [aria-current=page]')).toHaveCSS('color','rgb(229, 225, 218)');await page.screenshot({path:'.tmp/management-details-overview-dark.png'});
});
