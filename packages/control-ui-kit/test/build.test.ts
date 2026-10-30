import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
// @ts-expect-error Build tooling is JavaScript, not browser application code.
import {buildControlUi} from '../build.mjs';
it('builds a standalone Vue entry and scopes Tailwind theme without global resets',async()=>{
 const root=await mkdtemp(path.resolve('.tmp-build-'));
 try{
  await writeFile(path.join(root,'openclaw.plugin.json'),'{}');
  await writeFile(path.join(root,'entry.ts'),`import '../src/theme.css'; export * from '../src/index';`);
  const manifest=await buildControlUi({root,entry:'entry.ts'});
  const js=await readFile(path.join(root,manifest.entry),'utf8');
  const css=await readFile(path.join(root,manifest.styles[0]),'utf8');
  expect(js).not.toMatch(/from\s*["'](?:vue|reka-ui|@openclaw-plugins)/);
  expect(css).not.toMatch(/:root|:host/);
  expect(css).toContain('[data-ocp-ui]');expect(css).toContain('ocp\\:');
  expect(JSON.parse(await readFile(path.join(root,'openclaw.plugin.json'),'utf8')).controlUi).toEqual(manifest);
 }finally{await rm(root,{recursive:true,force:true});}
});
