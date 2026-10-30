import {createApp, shallowRef, inject, type Component, type InjectionKey, type ShallowRef} from 'vue';
import type {ControlUiViewContext, ControlUiView} from 'openclaw/plugin-sdk/control-ui';
const contextKey:InjectionKey<ShallowRef<ControlUiViewContext>>=Symbol('control-ui-context');
const overlayKey:InjectionKey<HTMLElement>=Symbol('control-ui-overlay');
export function useHostContext(){const context=inject(contextKey);if(!context)throw Error('Missing Control UI host');return context;}
export function useOverlayTarget(){const target=inject(overlayKey);if(!target)throw Error('Missing Control UI overlay');return target;}
function snapshotWithMethods<T extends object>(value:T):T{
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typeof item==='function'?item.bind(value):item])) as T;
}
export function mountVueView(component:Component):ControlUiView{
 return (container,initial)=>{
  let current=initial,disposed=false;
  const document=container.ownerDocument;
  const root=document.createElement('div'),overlay=document.createElement('div');
  root.dataset.ocpUi='';overlay.dataset.ocpUi='';overlay.dataset.ocpOverlay='';
  container.append(root);document.body.append(overlay);
  const snapshot=()=>({...current,host:{...snapshotWithMethods(current.host),connection:{...current.host.connection},agents:snapshotWithMethods(current.host.agents),sessions:snapshotWithMethods(current.host.sessions)},props:{...current.props}});
  const context=shallowRef(snapshot());
  const syncTheme=()=>{
   const style=document.defaultView!.getComputedStyle(root);
   for(const name of ['--bg','--text','--muted','--border','--error-color','--ocp-background','--ocp-foreground','--ocp-muted','--ocp-primary','--ocp-secondary','--ocp-border','--ocp-destructive','--ocp-running','--ocp-success','--ocp-queued']){
    const value=style.getPropertyValue(name);if(value)overlay.style.setProperty(name,value);else overlay.style.removeProperty(name);
   }
  };
  const update=(next:ControlUiViewContext)=>{if(disposed)return;current=next;context.value=snapshot();syncTheme();};
  const feature=createApp(component);
  feature.provide(contextKey,context);feature.provide(overlayKey,overlay);
  let unsubscribe=()=>{};
  const dispose=()=>{if(disposed)return;disposed=true;unsubscribe();observer.disconnect();initial.signal.removeEventListener('abort',dispose);feature.unmount();overlay.remove();root.remove();};
  const observer=new document.defaultView!.MutationObserver(syncTheme);
  for(let node:HTMLElement|null=container;node;node=node.parentElement)observer.observe(node,{attributes:true,attributeFilter:['class','style','data-theme']});
  try{feature.mount(root);unsubscribe=current.host.subscribe(()=>update(current));syncTheme();initial.signal.addEventListener('abort',dispose,{once:true});if(initial.signal.aborted)dispose();}
  catch(error){dispose();throw error;}
  return {update,dispose};
 };
}
