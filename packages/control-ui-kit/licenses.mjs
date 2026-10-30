import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
// Use Rollup's actual module graph, rather than a hand-maintained dependency list.
export async function bundledLicenses(outputs){
 const packages=new Map(),directories=new Map();
 async function owner(directory){
  if(directories.has(directory))return directories.get(directory);
  const result=(async()=>{
   try{const manifest=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));if(manifest.name&&manifest.version)return {directory,manifest};}catch{}
   const parent=path.dirname(directory);return parent===directory?null:owner(parent);
  })();directories.set(directory,result);return result;
 }
 for(const file of outputs)if(file.type==='chunk')for(const id of Object.keys(file.modules)){
  const clean=id.split('?')[0];if(!path.isAbsolute(clean)||!clean.includes('/node_modules/'))continue;
  const found=await owner(path.dirname(clean));if(found)packages.set(found.manifest.name+'@'+found.manifest.version,found);
 }
 // Generated utilities/theme CSS also incorporates Tailwind source, outside Rollup's JS graph.
 const cssOwner=await owner(path.dirname(createRequire(import.meta.url).resolve('tailwindcss')));
 if(!cssOwner)throw Error('Missing Tailwind CSS package');
 packages.set(cssOwner.manifest.name+'@'+cssOwner.manifest.version,cssOwner);
 const kit=path.dirname(fileURLToPath(import.meta.url));
 const sections=[await readFile(path.join(kit,'THIRD_PARTY_NOTICES.md'),'utf8'),await readFile(path.join(kit,'LICENSE.shadcn-vue'),'utf8')];
 for(const [name,{directory,manifest}] of [...packages].sort(([a],[b])=>a.localeCompare(b))){
  const files=(await readdir(directory,{withFileTypes:true})).filter(file=>file.isFile()&&/^(licen[cs]e|copying|notice)(\.|$)/i.test(file.name));
  if(!files.length)throw Error('Missing bundled license: '+name);
  sections.push('\n## '+name+' ('+String(manifest.license??'see license')+')\n'+(await Promise.all(files.map(file=>readFile(path.join(directory,file.name),'utf8')))).join('\n'));
 }
 return sections.join('\n\n');
}
