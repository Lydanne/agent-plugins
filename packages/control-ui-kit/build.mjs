import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwind from '@tailwindcss/vite';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
export async function buildControlUi({root,entry}){
 const result=await build({configFile:false,root,define:{'process.env.NODE_ENV':JSON.stringify('production')},plugins:[vue(),tailwind(),{name:'control-ui-css-scope',enforce:'post',generateBundle(_,bundle){for(const file of Object.values(bundle)){if(file.type==='asset'&&file.fileName.endsWith('.css'))file.source=String(file.source).replaceAll(':root,:host','[data-ocp-ui]');}}}],build:{write:false,target:'es2022',lib:{entry:path.resolve(root,entry),formats:['es'],fileName:()=> 'index.js'},rollupOptions:{output:{inlineDynamicImports:true,assetFileNames:'index.[ext]'}}}});
 const outputs=(Array.isArray(result)?result:[result]).flatMap(bundle=>bundle.output);
 const revision=createHash('sha256').update(Buffer.concat(outputs.map(file=>Buffer.from(file.type==='chunk'?file.code:file.source)))).digest('hex').slice(0,20);
 const directory='dist/control-ui/'+revision;await mkdir(path.join(root,directory),{recursive:true});
 for(const file of outputs)await writeFile(path.join(root,directory,file.fileName),file.type==='chunk'?file.code:file.source);
 const manifestPath=path.join(root,'openclaw.plugin.json');const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 manifest.controlUi={entry:directory+'/index.js',styles:outputs.filter(file=>file.fileName.endsWith('.css')).map(file=>directory+'/'+file.fileName)};
 await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 return manifest.controlUi;
}
