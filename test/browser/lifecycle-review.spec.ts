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

test('a parent-realm entry rejects a foreign document before acquiring global modal effects',async({page})=>{
 await page.goto('/?surface=worker');await expect(page.locator('html')).toHaveAttribute('data-ready','true');
 const result=await page.evaluate(async()=>{
  const f=(window as any).fixture,manifest=await fetch('/plugins/agent-repo/openclaw.plugin.json').then(r=>r.json()),module=await import('/plugins/agent-repo/'+manifest.controlUi.entry);
  const frame=document.createElement('iframe');frame.srcdoc='<body><main id="mount"></main></body>';document.body.append(frame);await new Promise(resolve=>frame.onload=resolve);
  const doc=frame.contentDocument!,calls=f.calls.length,subscriptions=f.subscriberCount(),parentOverflow=document.body.style.overflow,parentPointer=document.body.style.pointerEvents;let error='';
  try{module.mountAgentRepo(doc.getElementById('mount'),{host:f.host,props:{section:'audit'},signal:new AbortController().signal,presented:true});}catch(e){error=String(e);}
  const result={error,newCalls:f.calls.length-calls,newSubscriptions:f.subscriberCount()-subscriptions,frameRoots:doc.querySelectorAll('[data-ocp-view-root],[data-ocp-overlay]').length,parentIntact:document.body.style.overflow===parentOverflow&&document.body.style.pointerEvents===parentPointer,frameOverflow:doc.body.style.overflow};frame.remove();return result;
 });
 expect(result.error).toContain('mounting document window');expect(result.newCalls).toBe(0);expect(result.newSubscriptions).toBe(0);expect(result.frameRoots).toBe(0);expect(result.parentIntact).toBe(true);expect(result.frameOverflow).toBe('');
});
