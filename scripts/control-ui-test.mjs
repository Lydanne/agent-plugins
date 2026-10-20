import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Window} from 'happy-dom';

// Exercise the shipped browser entry without production config, Gateway or sessions.
export async function browserFixture(t,entry){
 const window=new Window({url:'https://fixture.invalid/'}),previous=globalThis.document,views=[];
 globalThis.document=window.document;
 t.after(async()=>{for(const view of views)view.dispose();globalThis.document=previous;await window.happyDOM.close();});
 const bundle=await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}});
 const ui=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
 const container=window.document.createElement('main');window.document.body.append(container);
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
