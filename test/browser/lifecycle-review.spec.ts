import {test,expect} from '@playwright/test';

test('a view mounted in a ShadowRoot keeps its body portal synchronized with host theme changes',async({page})=>{
 await page.goto('/?surface=worker');await expect(page.locator('html')).toHaveAttribute('data-ready','true');
 await page.evaluate(async()=>{
  const fixture=(window as any).fixture,manifest=await fetch('/plugins/agent-worker/openclaw.plugin.json').then(r=>r.json()),module=await import('/plugins/agent-worker/'+manifest.controlUi.entry);
  const host=document.createElement('aside');host.id='shadow-host';host.style.setProperty('--bg','rgb(30, 40, 50)');host.style.setProperty('--text','rgb(230, 220, 210)');document.body.append(host);const container=document.createElement('div');host.attachShadow({mode:'open'}).append(container);
  const view=module.mountPanel(container,{host:fixture.host,props:{agentId:'main',sessionKey:'agent:main:real-chat'},signal:new AbortController().signal,presented:true});
  (window as any).shadowView={view,host,overlay:document.querySelector('[data-ocp-overlay]:last-child')};
 });
 await expect.poll(()=>page.evaluate(()=>(window as any).shadowView.overlay.style.getPropertyValue('--bg'))).toBe('rgb(30, 40, 50)');
 await page.evaluate(()=>(window as any).shadowView.host.style.setProperty('--bg','rgb(60, 70, 80)'));await expect.poll(()=>page.evaluate(()=>(window as any).shadowView.overlay.style.getPropertyValue('--bg'))).toBe('rgb(60, 70, 80)');
 await page.evaluate(()=>{const s=(window as any).shadowView;s.view.dispose();s.host.remove();});await expect.poll(()=>page.evaluate(()=>(window as any).shadowView.overlay.isConnected)).toBe(false);
});

test('replacing a host retires its active log lease and routes fresh reads only through the new host',async({page})=>{
 await page.goto('/?section=logs');await expect(page.locator('html')).toHaveAttribute('data-ready','true');await page.getByRole('button',{name:'实时调试',exact:true}).click();await page.getByRole('button',{name:'开启实时调试'}).click();await expect(page.locator('.ar-console-status')).toHaveText('采集中');
 await page.evaluate(()=>{
  const f=(window as any).fixture,old=f.host,listeners=new Set<()=>void>(),controller=new AbortController(),calls:any[]=[];
  const next={...old,signal:controller.signal,request(method:string,p:any){calls.push(p);return old.request(method,p);},subscribe(fn:()=>void){listeners.add(fn);return ()=>listeners.delete(fn);}};
  (window as any).newLifetime={controller,calls,listeners};f.updateContext({host:next,signal:new AbortController().signal});
 });
 await expect.poll(()=>page.evaluate(()=>(window as any).fixture.logLeases().length)).toBe(0);await expect(page.locator('.ar-console-stats')).toHaveText('24 条记录');await expect.poll(()=>page.evaluate(()=>(window as any).newLifetime.calls.some((p:any)=>p.actionId==='projects-diagnosticHistory'))).toBe(true);expect(await page.evaluate(()=>(window as any).fixture.subscriberCount())).toBe(0);
 await page.evaluate(()=>(window as any).newLifetime.controller.abort());await expect(page.locator('[data-ocp-view-root]')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).newLifetime.listeners.size)).toBe(0);await expect(page.locator('[data-ocp-overlay]')).toHaveCount(0);
});
