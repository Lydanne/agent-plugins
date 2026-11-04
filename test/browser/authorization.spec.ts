import {test,expect} from '@playwright/test';
for(const width of [400,1280])test(`permission groups and default policy editor fit ${width}px`,async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width,height:900});
 await page.goto('/?section=authorization');
 await expect(page.getByRole('heading',{name:'权限中心',exact:true})).toBeVisible();
 for(const name of ['管理员组','内部组','外部组'])await expect(page.locator('article strong').getByText(name,{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'配置新增资源默认授权',exact:true}).nth(1).click();
 await page.getByRole('button',{name:'原子且可撤销写入',exact:true}).click();
 await expect(page.getByLabel('原子性',{exact:true})).toHaveValue('guaranteed');
 await expect(page.getByLabel('可恢复性',{exact:true})).toHaveValue('reversible');
 await expect(page.getByRole('combobox',{name:/^权限组/})).toHaveValue('internal');
 await expect(page.getByRole('button',{name:'保存草稿',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 expect(errors).toEqual([]);
});
test('read-only permission center offers no changes',async({page})=>{
 await page.goto('/?section=authorization&permissionReadOnly=true');
 await expect(page.locator('article strong').getByText('管理员组',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'新增权限组',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'启用强制拦截',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'配置新增资源默认授权',exact:true})).toHaveCount(0);
});
