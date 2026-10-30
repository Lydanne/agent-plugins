import assert from 'node:assert/strict';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import {createRequire} from 'node:module';
import path from 'node:path';
import {Window} from 'happy-dom';

// Exercise the shipped browser entry without production config, Gateway or sessions.
export async function browserFixture(t,entry){
 const window=new Window({url:'https://fixture.invalid/'}),views=[],previous=new Map();
 const directory=await mkdtemp(path.join(os.tmpdir(),'control-ui-fixture-'));
 const errors=[];window.addEventListener('error',event=>errors.push(event.error));
 const previousError=console.error;console.error=(...args)=>errors.push(args.map(String).join(' '));
 for(const name of ['window','Document','HTMLDocument','DocumentFragment','document','navigator','Element','Node','HTMLElement','SVGElement','NodeFilter','HTMLInputElement','HTMLSelectElement','HTMLTextAreaElement','HTMLButtonElement','HTMLFormElement','FocusEvent','KeyboardEvent','PointerEvent','ShadowRoot','DOMRect','MutationObserver','ResizeObserver','CustomEvent','MouseEvent','Event','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']){
  previous.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
  const value=window[name];Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(name)?value?.bind(window):value});
 }
 t.after(async()=>{for(const view of views)view.dispose();for(const [name,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}await window.happyDOM.close();await rm(directory,{recursive:true,force:true});console.error=previousError;assert.deepEqual(errors,[],'Browser fixture raised an exception');});
 const bundle=await build({root:path.dirname(entry),configFile:false,logLevel:'silent',plugins:[vue()],build:{write:false,minify:false,lib:{entry,formats:['es']},rollupOptions:{output:{inlineDynamicImports:true}}}});
 const code=(Array.isArray(bundle)?bundle[0]:bundle).output.find(file=>file.type==='chunk').code;
 const compiled=path.join(directory,'fixture.mjs');await writeFile(compiled,code);
 // Load the emitted ESM as an artifact, without Vitest re-transforming it.
 const ui=createRequire(import.meta.url)(compiled);
 // Each fixture owns a document: include body portals in user-visible assertions.
 const container=window.document.body;
 return {window,container,ui,track:view=>(views.push(view),view)};
}
export async function settle(){for(let turn=0;turn<8;turn++)await new Promise(resolve=>setImmediate(resolve));}
export function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
export function uiContext(request,props={}){
 const listeners=new Set(),host={redact:String,connection:{canRead:true,assistantAgentId:'main'},agents:{selectedId:'main',defaultId:'main'},sessions:{selectedKey:'agent:main:test'},request,subscribe:listener=>(listeners.add(listener),()=>listeners.delete(listener))};
 return {host,props,presented:true,signal:new AbortController().signal,notify:()=>{for(const listener of listeners)listener();}};
}
export function select(window,container,label,value){const input=container.querySelector(`[aria-label="${label}"]`);assert.ok(input);input.value=value;input.dispatchEvent(new window.Event('change'));}
export function click(container,label){const button=[...container.querySelectorAll('button')].find(node=>node.textContent===label);assert.ok(button,'Missing button: '+label);button.click();}
