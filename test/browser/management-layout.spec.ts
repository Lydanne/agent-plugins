import {test,expect} from '@playwright/test';
const modules=['概览','项目与技能','Worker 任务','实体库','知识库','定时任务','审计','日志'];
for(const width of [320,400,720,1280,1920])test(`management workspace adapts to container ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.goto('/?section=audit');await expect(page.locator('html')).toHaveAttribute('data-ready','true');
 const root=page.getByRole('region',{name:'审计内容',exact:true}),sidebar=page.locator('.ar-management-sidebar'),nav=page.getByRole('navigation',{name:'AgentRepo 功能模块'}),select=page.getByRole('combobox',{name:'管理中心模块'});
 if(width>640){await expect(nav).toBeVisible();await expect(select).toBeHidden();const a=await sidebar.boundingBox(),b=await root.boundingBox();expect(b!.x).toBeCloseTo(a!.x+a!.width,0);expect(b!.width).toBeGreaterThan(width-185);}
 else{await expect(nav).toBeHidden();await expect(select).toBeVisible();await select.selectOption('logs');await expect(page.getByRole('region',{name:'日志内容',exact:true})).toBeVisible();await select.selectOption('audit');}
 await expect(root).toBeVisible();const box=await page.locator('.ar-management').boundingBox();expect(box!.width).toBe(width);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 const recycle=page.getByRole('button',{name:'打开回收站'});await expect(recycle).toBeVisible();expect(await recycle.evaluate(el=>getComputedStyle(el).position)).toBe('static');await recycle.click();await expect(page.getByRole('dialog',{name:'回收站',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(recycle).toBeFocused();
 await page.screenshot({path:`.tmp/management-workspace-${width}.png`,fullPage:false});
});
test('navigation keeps all modules, supports keyboard and responds to host updates',async({page})=>{
 await page.setViewportSize({width:1440,height:900});await page.goto('/');const nav=page.getByRole('navigation',{name:'AgentRepo 功能模块'});
 await expect(nav.getByRole('button')).toHaveText(modules);
 for(const label of modules){const button=nav.getByRole('button',{name:label,exact:true});await button.focus();await page.keyboard.press('Enter');await expect(button).toHaveAttribute('aria-current','page');await expect(button).toBeFocused();await expect(page.locator('.ar-management-body')).toHaveAttribute('aria-label',label+'内容');}
 await page.evaluate(()=>(window as any).fixture.setProps({section:'projects'}));await expect(nav.getByRole('button',{name:'项目与技能',exact:true})).toHaveAttribute('aria-current','page');
});
test('host sidebar width controls compact navigation and knowledge columns independently of viewport',async({page})=>{
 await page.setViewportSize({width:1440,height:900});await page.goto('/?section=knowledge');await expect(page.locator('.kb-workspace')).toBeVisible();
 await page.locator('#view').evaluate(el=>{el.style.width='800px';});const columns=await page.locator('.kb-workspace').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);expect(columns).toBe(1);await expect(page.getByRole('navigation',{name:'AgentRepo 功能模块'})).toBeVisible();
 await page.locator('#view').evaluate(el=>{el.style.width='580px';});await expect(page.getByRole('combobox',{name:'管理中心模块'})).toBeVisible();await expect(page.getByRole('navigation',{name:'AgentRepo 功能模块'})).toBeHidden();
 await page.locator('#view').evaluate(el=>{el.style.width='';});await page.evaluate(()=>(window as any).fixture.setTheme('dark'));await expect(page.getByRole('navigation',{name:'AgentRepo 功能模块'})).toBeVisible();await expect(page.locator('.ar-management')).toHaveCSS('color','rgb(229, 225, 218)');await page.screenshot({path:'.tmp/management-workspace-knowledge-dark.png'});
});
