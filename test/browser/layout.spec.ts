import {test,expect} from '@playwright/test';

test('secondary controls use dialogs while the audit list stays readable',async({page})=>{
 await page.setViewportSize({width:1280,height:900});await page.goto('/?section=audit');await expect(page.getByRole('table',{name:'审计记录列表'})).toBeVisible();
 await expect(page.getByRole('textbox',{name:'发起人 ID',exact:true})).toHaveCount(0);
 await page.screenshot({path:'.tmp/ui-polish-audit-light.png'});
 await page.getByRole('button',{name:'审计高级筛选',exact:true}).click();const filters=page.getByRole('dialog',{name:'审计高级筛选',exact:true});await expect(filters).toBeVisible();
 await filters.getByRole('textbox',{name:'发起人 ID',exact:true}).fill('draft');await page.screenshot({path:'.tmp/ui-polish-audit-filters.png'});await page.keyboard.press('Escape');await expect(filters).toBeHidden();await expect(page.getByRole('button',{name:'审计高级筛选',exact:true})).toBeFocused();
 await page.goto('/?surface=people');await expect(page.getByRole('heading',{name:'测试同事'})).toBeVisible();await page.getByRole('button',{name:'人员筛选',exact:true}).click();const people=page.getByRole('dialog',{name:'人员筛选',exact:true});
 await people.getByRole('combobox',{name:'账号关联状态',exact:true}).selectOption('unknown');await people.getByRole('button',{name:'应用筛选'}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).fixture.calls.filter((p:any)=>p.actionId==='projects-people').at(-1).payload.giteaSource)).toBe('unknown');
 await page.getByRole('button',{name:'编辑人员',exact:true}).click();const editor=page.getByRole('dialog',{name:'编辑人员资料',exact:true});await expect(editor).toBeVisible();await page.screenshot({path:'.tmp/ui-polish-person-editor.png'});
 await page.evaluate(()=>(window as any).fixture.setConnection({canWrite:false}));await expect(editor).toHaveCount(0);
});

test('compact Worker filters apply sorting and restore keyboard focus',async({page})=>{
 await page.setViewportSize({width:400,height:900});await page.goto('/?surface=worker&onlyWorker');await expect(page.getByRole('searchbox',{name:'搜索会话或标签'})).toBeVisible();await expect(page.getByRole('combobox',{name:'会话排序'})).toHaveCount(0);
 await page.getByRole('button',{name:'会话筛选',exact:true}).click();const dialog=page.getByRole('dialog',{name:'会话筛选',exact:true});await dialog.getByRole('combobox',{name:'会话排序'}).selectOption('recent');await dialog.getByRole('button',{name:'应用筛选'}).click();
 await expect(dialog).toBeHidden();await expect(page.getByRole('button',{name:'会话筛选',exact:true})).toBeFocused();
 await expect.poll(()=>page.evaluate(()=>(window as any).fixture.calls.filter((p:any)=>p.pluginId==='agent-worker'&&p.actionId==='inspect-list').at(-1)?.payload.sort)).toBe('recent');
 await page.screenshot({path:'.tmp/ui-polish-worker-400.png'});
});
