import {describe,it,expect,vi} from 'vitest';
import {defineComponent,h,nextTick,useId} from 'vue';
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

it('keeps generated accessibility IDs unique across mounted plugin apps',()=>{
 const a=fixture(),b=fixture();
 const component=defineComponent({setup(){const id=useId();return ()=>h('label',{id},'字段');}});
 const av=mountVueView(component)(a.container,a.ctx)!,bv=mountVueView(component)(b.container,b.ctx)!;
 expect(a.container.querySelector('label')!.id).not.toBe(b.container.querySelector('label')!.id);
 av.dispose?.();bv.dispose?.();a.container.remove();b.container.remove();
});

it('retires the old host and cancellation lifetime while preserving same-lifetime updates',async()=>{
 const a=fixture(),b=fixture();let mounts=0;
 const component=defineComponent({setup(){mounts++;const ctx=useHostContext();return ()=>h('input',{value:String(ctx.value.host.connection.canRead)});}});
 const view=mountVueView(component)(a.container,a.ctx)!;const original=a.container.querySelector('input');
 a.notify();view.update?.({...a.ctx,props:{topic:'same-lifetime'}});await nextTick();expect(mounts).toBe(1);expect(a.container.querySelector('input')).toBe(original);
 view.update?.(b.ctx);await nextTick();expect(mounts).toBe(2);expect(a.listeners.size).toBe(0);expect(b.listeners.size).toBe(1);
 a.controller.abort();expect(a.container.querySelector('input')).not.toBeNull();
 Object.assign(b.ctx.host.connection,{canRead:false});b.notify();await nextTick();expect(a.container.querySelector('input')!.value).toBe('false');
 const replacement=new AbortController();view.update?.({...b.ctx,signal:replacement.signal});await nextTick();expect(mounts).toBe(3);expect(b.listeners.size).toBe(1);
 b.controller.abort();expect(a.container.querySelector('input')).not.toBeNull();replacement.abort();expect(a.container.children).toHaveLength(0);expect(b.listeners.size).toBe(0);
 view.dispose?.();a.container.remove();b.container.remove();
});
it('does not mount an already-aborted lifetime and observes the public host abort signal',()=>{
 const f=fixture(),hostController=new AbortController(),setup=vi.fn();Object.assign(f.ctx.host,{signal:hostController.signal});
 const component=defineComponent({setup(){setup();return ()=>h('p','mounted');}});
 const view=mountVueView(component)(f.container,f.ctx)!;expect(setup).toHaveBeenCalledTimes(1);hostController.abort();expect(f.listeners.size).toBe(0);expect(f.container.children).toHaveLength(0);view.dispose?.();
 const cancelled=fixture();cancelled.controller.abort();const never=mountVueView(component)(cancelled.container,cancelled.ctx)!;expect(setup).toHaveBeenCalledTimes(1);expect(cancelled.listeners.size).toBe(0);expect(cancelled.container.children).toHaveLength(0);never.dispose?.();f.container.remove();cancelled.container.remove();
});

it('finishes independent cleanup even when the host disposer or a component hook throws',()=>{
 const f=fixture(),releaseError=Error('synthetic unsubscribe failure'),hookError=Error('synthetic hook failure'),unmounted=vi.fn();
 Object.assign(f.ctx.host,{subscribe:()=>()=>{throw releaseError;}});
 const component=defineComponent({setup(){return ()=>h('p','mounted');},beforeUnmount(){throw hookError;},unmounted});
 const view=mountVueView(component)(f.container,f.ctx)!;
 expect(()=>view.dispose?.()).toThrow(AggregateError);expect(unmounted).toHaveBeenCalledOnce();expect(f.container.children).toHaveLength(0);expect(document.querySelector('[data-ocp-overlay]')).toBeNull();expect(()=>view.dispose?.()).not.toThrow();f.container.remove();
});
it('still installs a replacement lifetime after an old host unsubscribe error',async()=>{
 const a=fixture(),b=fixture(),error=Error('unsubscribe failed');Object.assign(a.ctx.host,{subscribe:()=>()=>{throw error;}});
 const component=defineComponent({setup(){const context=useHostContext();return ()=>h('p',String(context.value.props.topic));}});
 const view=mountVueView(component)(a.container,a.ctx)!;
 expect(()=>view.update?.({...b.ctx,props:{topic:'replacement'}})).toThrow(error);await nextTick();expect(a.container.textContent).toBe('replacement');expect(b.listeners.size).toBe(1);
 view.dispose?.();expect(b.listeners.size).toBe(0);a.container.remove();b.container.remove();
});
