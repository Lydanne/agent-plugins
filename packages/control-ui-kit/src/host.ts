import {createApp, shallowRef, inject, type Component, type InjectionKey, type ShallowRef} from 'vue';
import type {ControlUiViewContext, ControlUiView} from 'openclaw/plugin-sdk/control-ui';
const contextKey:InjectionKey<ShallowRef<ControlUiViewContext>>=Symbol('control-ui-context');
const overlayKey:InjectionKey<HTMLElement>=Symbol('control-ui-overlay');
export function useHostContext(){const context=inject(contextKey);if(!context)throw Error('Missing Control UI host');return context;}
export function useOverlayTarget(){const target=inject(overlayKey);if(!target)throw Error('Missing Control UI overlay');return target;}
function snapshotWithMethods<T extends object>(value:T):T{
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typeof item==='function'?item.bind(value):item])) as T;
}
function mountInstance(component:Component,options:{density?:'sidebar'|'page'},container:HTMLElement,initial:ControlUiViewContext){
  if(initial.signal.aborted||initial.host.signal?.aborted)return {update:(_next:ControlUiViewContext)=>{},dispose:()=>{}};
  let current=initial,disposed=false;
  const document=container.ownerDocument;
  const root=document.createElement('div'),overlay=document.createElement('div');
  root.dataset.ocpViewRoot='';root.dataset.ocpUi='';overlay.dataset.ocpUi='';overlay.dataset.ocpOverlay='';
  if(options.density){root.dataset.ocpDensity=options.density;overlay.dataset.ocpDensity=options.density;}
  container.append(root);document.body.append(overlay);
  const snapshot=()=>({...current,host:{...snapshotWithMethods(current.host),connection:{...current.host.connection},agents:snapshotWithMethods(current.host.agents),sessions:snapshotWithMethods(current.host.sessions)},props:{...current.props}});
  const context=shallowRef(snapshot());
  const syncTheme=()=>{
   if(disposed)return;
   const style=document.defaultView!.getComputedStyle(root);
   for(const name of ['--bg','--text','--muted','--border','--error-color','--ocp-background','--ocp-foreground','--ocp-muted','--ocp-primary','--ocp-secondary','--ocp-border','--ocp-destructive','--ocp-running','--ocp-success','--ocp-queued']){
    const value=style.getPropertyValue(name);if(value)overlay.style.setProperty(name,value);else overlay.style.removeProperty(name);
   }
  };
  const update=(next:ControlUiViewContext)=>{if(disposed)return;current=next;context.value=snapshot();syncTheme();};
  const feature=createApp(component);
  // Vue IDs are application-local. Plugin bundles may have independent Vue runtimes.
  const sequenceKey=Symbol.for('openclaw-plugins.control-ui-view-sequence.v1');
  const registry=globalThis as unknown as Record<symbol,unknown>;
  const previous=registry[sequenceKey];
  const sequence=typeof previous==='number'&&Number.isSafeInteger(previous)?previous+1:1;
  registry[sequenceKey]=sequence;feature.config.idPrefix='ocp-'+sequence;

  feature.provide(contextKey,context);feature.provide(overlayKey,overlay);
  let unsubscribe=()=>{},mounted=false;
  const signals=[...new Set([initial.signal,initial.host.signal].filter(Boolean))];
  const dispose=()=>{if(disposed)return;disposed=true;unsubscribe();observer.disconnect();for(const signal of signals)signal.removeEventListener('abort',dispose);if(mounted)feature.unmount();overlay.remove();root.remove();};
  const observer=new document.defaultView!.MutationObserver(syncTheme);
  for(let node:Element|null=container;node;){
   observer.observe(node,{attributes:true,attributeFilter:['class','style','data-theme']});
   const tree=node.getRootNode();node=node.parentElement??('host' in tree?(tree as ShadowRoot).host:null);
  }
  try{
   for(const signal of signals)signal.addEventListener('abort',dispose,{once:true});
   feature.mount(root);mounted=true;
   if(disposed)feature.unmount();
   else{const release=current.host.subscribe(()=>{if(!disposed)update(current);});if(disposed)release();else unsubscribe=release;syncTheme();}
  }
  catch(error){dispose();throw error;}
  return {update,dispose};
}

export function mountVueView(component:Component,options:{density?:'sidebar'|'page'}={}):ControlUiView{
 return (container,initial)=>{
  let current=initial,active=mountInstance(component,options,container,initial),disposed=false;
  return {
   update(next){
    if(disposed)return;
    // A different host or cancellation signal denotes a new public view lifetime.
    // Retire old requests, dialogs and leases before accepting the new authority.
    if(next.host!==current.host||next.signal!==current.signal){
     active.dispose();const replacement=mountInstance(component,options,container,next);
     current=next;active=replacement;
    }else{current=next;active.update(next);}
   },
   dispose(){if(disposed)return;disposed=true;active.dispose();},
  };
 };
}
