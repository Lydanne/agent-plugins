import {test,expect,type Page} from '@playwright/test';
async function bounds(page:Page,title:string,width:number,height:number,maxWidth:number){
 const dialog=page.getByRole('dialog',{name:title,exact:true});await expect(dialog).toBeVisible();const b=await dialog.boundingBox();expect(b!.width).toBeCloseTo(Math.min(width-32,maxWidth),0);expect(b!.x).toBeGreaterThanOrEqual(15);expect(b!.y).toBeGreaterThanOrEqual(11);expect(b!.y+b!.height).toBeLessThanOrEqual(height-11);return dialog;
}
for(const viewport of [{width:1280,height:900},{width:320,height:640},{width:720,height:400}])test(`dialog sizes follow purpose and fit ${viewport.width}x${viewport.height}`,async({page})=>{
 await page.setViewportSize(viewport);await page.goto('/?section=audit');await page.getByRole('button',{name:'打开回收站'}).click();const trash=await bounds(page,'回收站',viewport.width,viewport.height,1000);await page.screenshot({path:`.tmp/dialog-trash-${viewport.width}.png`});
 await trash.getByRole('button',{name:'保留期限设置'}).click();const policy=await bounds(page,'回收站保留设置',viewport.width,viewport.height,440);await policy.getByRole('button',{name:'关闭',exact:true}).click();await trash.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'审计高级筛选',exact:true}).click();const filters=await bounds(page,'审计高级筛选',viewport.width,viewport.height,520);await filters.getByRole('button',{name:'应用筛选'}).scrollIntoViewIfNeeded();await expect(filters.getByRole('button',{name:'应用筛选'})).toBeInViewport();await filters.getByRole('button',{name:'取消',exact:true}).click();
 await page.goto('/?surface=people');await page.getByRole('button',{name:'编辑人员',exact:true}).click();const editor=await bounds(page,'编辑人员资料',viewport.width,viewport.height,560);await editor.getByRole('button',{name:'保存人员资料'}).scrollIntoViewIfNeeded();await expect(editor.getByRole('button',{name:'保存人员资料'})).toBeInViewport();await page.screenshot({path:`.tmp/dialog-person-${viewport.width}.png`});await editor.getByRole('button',{name:'取消编辑'}).click();
 await page.goto('/?surface=entities');await page.getByRole('button',{name:'组织同步管理',exact:true}).click();await bounds(page,'组织同步管理',viewport.width,viewport.height,760);
});

test('log reader has a useful desktop canvas instead of a narrow default modal',async({page})=>{
 await page.setViewportSize({width:1440,height:900});await page.goto('/?surface=projects');await page.getByRole('button',{name:'日志',exact:true}).click();const dialog=await bounds(page,'日志',1440,900,1120);const b=await dialog.boundingBox();expect(b!.height).toBe(792);await page.screenshot({path:'.tmp/dialog-log-reader.png'});
});
