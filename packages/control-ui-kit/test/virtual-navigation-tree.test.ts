import {afterEach,expect,it,vi} from 'vitest';
import {mount} from '@vue/test-utils';
import {nextTick} from 'vue';
import VirtualNavigationTree from '../src/components/VirtualNavigationTree.vue';
afterEach(()=>{vi.unstubAllGlobals();document.body.replaceChildren();});
it('keeps the focused row visible on resize inside a ShadowRoot and releases its observer',async()=>{
 let notify=()=>{};const disconnect=vi.fn();vi.stubGlobal('ResizeObserver',class{constructor(cb:()=>void){notify=cb;}observe(){}disconnect(){disconnect();}});
 const host=document.createElement('div'),mountPoint=document.createElement('div');document.body.append(host);const shadow=host.attachShadow({mode:'open'});shadow.append(mountPoint);
 const items=Array.from({length:100},(_,i)=>({id:String(i),label:'文档 '+i,depth:0,expandable:false,expanded:false,current:i===0,hasDocument:true}));const view=mount(VirtualNavigationTree,{attachTo:mountPoint,props:{items,label:'文档'}});
 try{const scroll=view.get('.ocp-navigation-scroll').element as HTMLElement;let height=1000;Object.defineProperty(scroll,'clientHeight',{get:()=>height});notify();await nextTick();const first=view.get('[data-row-index="0"]');(first.element as HTMLElement).focus();await first.trigger('keydown',{key:'End'});await nextTick();expect(shadow.activeElement?.getAttribute('data-row-index')).toBe('99');const before=scroll.scrollTop;height=560;notify();await nextTick();expect(scroll.scrollTop).toBeGreaterThan(before);expect(shadow.activeElement?.getAttribute('data-row-index')).toBe('99');}finally{view.unmount();expect(disconnect).toHaveBeenCalledOnce();}
});
