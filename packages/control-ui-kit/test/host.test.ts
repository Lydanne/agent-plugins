import {describe,it,expect,vi} from 'vitest';
import {defineComponent,h,nextTick} from 'vue';
import type {ControlUiViewContext} from 'openclaw/plugin-sdk/control-ui';
import {mountVueView,useHostContext,useOverlayTarget} from '../src/host';
import {Button} from '../src/components/button';
import Dialog from '../src/components/Dialog.vue';
function fixture(){
 const listeners=new Set<()=>void>();
 const controller=new AbortController();
 const ctx={props:{},presented:true,signal:controller.signal,host:{connection:{canRead:true,canWrite:true},agents:{selectedId:'main'},sessions:{selectedKey:'agent:main:test'},subscribe:(fn:()=>void)=>{listeners.add(fn);return ()=>{listeners.delete(fn);};}}} as unknown as ControlUiViewContext;
 const container=document.createElement('main');document.body.append(container);
 return {ctx,container,controller,listeners,notify:()=>listeners.forEach(fn=>fn())};
}
describe('Vue Control UI host adapter',()=>{
 it('observes in-place host updates and removes its own roots/subscriptions on abort',async()=>{
  const f=fixture();
  const component=defineComponent({setup(){const ctx=useHostContext();const overlay=useOverlayTarget();expect(overlay.parentElement).toBe(document.body);return ()=>h('p',String(ctx.value.host.connection.canRead));}});
  const view=mountVueView(component)(f.container,f.ctx)!;
  expect(f.container.textContent).toBe('true');
  Object.assign(f.ctx.host.connection,{canRead:false});f.notify();await nextTick();
  expect(f.container.textContent).toBe('false');
  f.controller.abort();expect(f.container.children.length).toBe(0);expect(f.listeners.size).toBe(0);
  view.dispose?.();f.container.remove();
 });
 it('isolates simultaneous mounts and propagates presented changes',async()=>{
  const a=fixture(),b=fixture();
  const component=defineComponent({setup(){const ctx=useHostContext();return ()=>h('p',String(ctx.value.presented));}});
  const av=mountVueView(component)(a.container,a.ctx)!;const bv=mountVueView(component)(b.container,b.ctx)!;
  av.update?.({...a.ctx,presented:false});await nextTick();expect(a.container.textContent).toBe('false');expect(b.container.textContent).toBe('true');
  av.dispose?.();expect(b.container.textContent).toBe('true');bv.dispose?.();a.container.remove();b.container.remove();
 });
 it('renders the vendored shadcn Button with native disabled behavior',()=>{
  const f=fixture(),click=vi.fn();
  const view=mountVueView(defineComponent({render:()=>h(Button,{disabled:true,onClick:click},()=> '确认')}))(f.container,f.ctx)!;
  const button=f.container.querySelector('button')!;button.click();expect(click).not.toHaveBeenCalled();expect(button.className).toContain('ocp:');
  view.dispose?.();f.container.remove();
 });
});

it('portals dialogs outside clipped containers and closes on hiding the host',async()=>{
 const f=fixture();f.container.style.overflow='hidden';
 const close=vi.fn();
 const view=mountVueView(defineComponent({render:()=>h(Dialog,{open:true,title:'确认操作',description:'操作范围','onUpdate:open':close},()=> '内容')}))(f.container,f.ctx)!;
 await nextTick();
 const dialog=document.querySelector('[role="dialog"]')!;
 expect(dialog.textContent).toContain('确认操作');expect(f.container.contains(dialog)).toBe(false);
 view.update?.({...f.ctx,presented:false});await nextTick();expect(close).toHaveBeenCalledWith(false);
 view.dispose?.();expect(document.querySelector('[role="dialog"]')).toBeNull();f.container.remove();
});
