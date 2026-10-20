import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('standalone plugin file lists include the shared API and every local module import',async()=>{
 const source=await readFile(new URL('../agent-repo-api/index.mjs',import.meta.url),'utf8');
 for(const name of ['agent-repo','agent-worker']){
  const root=new URL('../'+name+'/',import.meta.url),manifest=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
  assert.ok(manifest.files.includes('dist/agent-repo-api.mjs'));
  assert.equal(await readFile(new URL('dist/agent-repo-api.mjs',root),'utf8'),source);
  assert.ok(manifest.files.includes('dist/ui-navigation.mjs'));
  assert.equal(await readFile(new URL('dist/ui-navigation.mjs',root),'utf8'),await readFile(new URL('../agent-repo-api/ui-navigation.mjs',import.meta.url),'utf8'));
  const plugin=JSON.parse(await readFile(new URL('openclaw.plugin.json',root),'utf8'));
  for(const file of [plugin.controlUi.entry,...plugin.controlUi.styles]){
   assert.ok(file.startsWith('dist/control-ui/'));assert.ok((await readFile(new URL(file,root))).length>0);
  }
  assert.ok(!Object.values(manifest.dependencies??{}).some(value=>value.startsWith('workspace:')));
  for(const file of manifest.files.filter(file=>file.endsWith('.mjs'))){
   const url=new URL(file,root),text=await readFile(url,'utf8');
   for(const [,specifier] of text.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)){
    const target=new URL(specifier,url);assert.ok(target.href.startsWith(root.href),'Local import escapes plugin: '+specifier);
    const path=target.href.slice(root.href.length);assert.ok(manifest.files.includes(path),'Missing packaged module: '+name+'/'+path);
   }
  }
 }
});
