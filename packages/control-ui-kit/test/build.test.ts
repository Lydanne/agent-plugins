import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
// @ts-expect-error Build tooling is JavaScript, not browser application code.
import {buildControlUi} from '../build.mjs';
// @ts-expect-error Build tooling is JavaScript, not browser application code.
import {bundledLicenses} from '../licenses.mjs';
it('collects hyphenated license filenames from the actual graph and rejects missing licenses',async()=>{
 const root=await mkdtemp(path.resolve('.tmp-license-')),dependency=path.join(root,'node_modules','fixture-dependency');
 try{
  await mkdir(dependency,{recursive:true});await writeFile(path.join(dependency,'package.json'),JSON.stringify({name:'fixture-dependency',version:'1.0.0',license:'MIT'}));
  const outputs=[{type:'chunk',modules:{[path.join(dependency,'index.js')]:{}}}];
  await expect(bundledLicenses(outputs)).rejects.toThrow('Missing bundled license: fixture-dependency@1.0.0');
  await writeFile(path.join(dependency,'LICENSE-MIT.txt'),'fixture license text');
  expect(await bundledLicenses(outputs)).toContain('fixture license text');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('builds a standalone Vue entry and scopes Tailwind theme without global resets',async()=>{
 const root=await mkdtemp(path.resolve('.tmp-build-'));
 try{
  await writeFile(path.join(root,'openclaw.plugin.json'),'{}');
  await writeFile(path.join(root,'entry.ts'),`import '../src/theme.css'; export * from '../src/index';`);
  const manifest=await buildControlUi({root,entry:'entry.ts'});
  const js=await readFile(path.join(root,manifest.entry),'utf8');
  const css=await readFile(path.join(root,manifest.styles[0]),'utf8');
  expect(js).not.toContain('process.env.NODE_ENV');
  expect(js).not.toMatch(/from\s*["'](?:vue|reka-ui|@openclaw-plugins)/);
  expect(css).not.toMatch(/:root|:host/);
  expect(css).not.toContain('--tw-');expect(css).not.toMatch(/[{}]\*,::?before/);
  const licenses=await readFile(path.join(root,path.dirname(manifest.entry),'THIRD_PARTY_LICENSES.txt'),'utf8');
  for(const dependency of ['shadcn-vue','@vue/runtime-dom@','reka-ui@','tailwindcss@'])expect(licenses).toContain(dependency);
  expect(licenses).not.toContain('/Users/');
  expect(css).toContain('[data-ocp-ui]');expect(css).toContain('ocp\\:');
  expect(JSON.parse(await readFile(path.join(root,'openclaw.plugin.json'),'utf8')).controlUi).toEqual(manifest);
 }finally{await rm(root,{recursive:true,force:true});}
});
