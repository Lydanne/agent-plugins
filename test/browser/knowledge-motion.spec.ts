import {test,expect} from '@playwright/test';
test('graph has no directory and bounded floating pauses with user and system controls',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'no-preference'});
 await page.goto('/?section=knowledge&knowledgeNodes=200');await expect(page.locator('html')).toHaveAttribute('data-ready','true');await expect(page.getByRole('navigation',{name:'知识目录树'})).toBeVisible();
 await page.getByRole('tab',{name:'图谱',exact:true}).click();await expect(page.getByRole('navigation',{name:'知识目录树'})).toHaveCount(0);await expect(page.locator('.kb-graph-detail')).toHaveCount(0);
 await page.getByRole('button',{name:'全部展开',exact:true}).click();const canvas=page.locator('.kb-network');await expect(canvas).toHaveAttribute('data-render-state','ready');
 for(let i=0;i<4;i++)await page.getByRole('button',{name:'放大图谱',exact:true}).click();await expect.poll(async()=>Number(await canvas.getAttribute('data-motion-frames'))).toBeGreaterThan(2);
 await page.getByRole('button',{name:'暂停漂浮',exact:true}).click();await expect(canvas).toHaveAttribute('data-render-state','ready');const paused=await canvas.getAttribute('data-motion-frames');await page.waitForTimeout(450);expect(await canvas.getAttribute('data-motion-frames')).toBe(paused);
 await page.getByRole('button',{name:'开启漂浮',exact:true}).click();await expect.poll(async()=>Number(await canvas.getAttribute('data-motion-frames'))).toBeGreaterThan(Number(paused));
 await page.emulateMedia({reducedMotion:'reduce'});await expect(canvas).toHaveAttribute('data-render-state','ready');const reduced=await canvas.getAttribute('data-motion-frames');await page.waitForTimeout(450);expect(await canvas.getAttribute('data-motion-frames')).toBe(reduced);
 await page.getByRole('textbox',{name:'查找图谱文档'}).fill('features/f0/0.md');await page.locator('.kb-matches button').first().click();await expect(page.locator('.kb-graph-detail')).toBeVisible();await page.waitForTimeout(500);await page.screenshot({path:'.tmp/knowledge-delivery/organic-floating.png',fullPage:true});
 await page.getByRole('tab',{name:'文档',exact:true}).click();await expect(page.getByRole('navigation',{name:'知识目录树'})).toBeVisible();await expect(canvas).toHaveCount(0);expect(errors).toEqual([]);
});
test('10000-node floating retains all relationships at detail zoom and stops on unmount',async({page})=>{
 test.setTimeout(90000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'no-preference'});await page.goto('/?section=knowledge&knowledgeNodes=10000');await expect(page.locator('html')).toHaveAttribute('data-ready','true');await page.getByRole('tab',{name:'图谱',exact:true}).click();await page.getByRole('button',{name:'全部展开',exact:true}).click();const canvas=page.locator('.kb-network');await expect(canvas).toHaveAttribute('data-render-state','ready');
 await page.getByRole('textbox',{name:'查找图谱文档'}).fill('features/f0/0.md');await page.locator('.kb-matches button').first().click();await expect(canvas).toHaveAttribute('data-render-state','ready');for(let i=0;i<15;i++)await page.getByRole('button',{name:'放大图谱',exact:true}).click();await expect.poll(async()=>Number(await canvas.getAttribute('data-motion-frames'))).toBeGreaterThan(3);
 await expect(canvas).toHaveAttribute('data-rendered-nodes','10000');await expect(page.locator('.kb-edge-layer')).toHaveAttribute('data-relationships','100000');
 const fps=await page.evaluate(async()=>{let frames=0;const start=performance.now();return new Promise<number>(resolve=>{function step(){frames++;if(performance.now()-start>1500)resolve(frames*1000/(performance.now()-start));else requestAnimationFrame(step);}requestAnimationFrame(step);});});expect(fps).toBeGreaterThanOrEqual(30);
 await page.getByRole('tab',{name:'文档',exact:true}).click();await page.waitForTimeout(300);await expect(canvas).toHaveCount(0);expect(errors).toEqual([]);
});
