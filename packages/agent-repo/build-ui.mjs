import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const result=await build({entryPoints:['control-ui.mjs'],bundle:true,format:'esm',platform:'browser',target:'es2022',outdir:'dist/control-ui',write:false});
const revision=createHash('sha256').update(Buffer.concat(result.outputFiles.map(file=>Buffer.from(file.contents)))).digest('hex').slice(0,20);
const directory='dist/control-ui/'+revision;await mkdir(directory,{recursive:true});
for(const file of result.outputFiles)await writeFile(directory+'/'+(file.path.endsWith('.css')?'index.css':'index.js'),file.contents);
const manifest=JSON.parse(await readFile('openclaw.plugin.json','utf8'));manifest.controlUi={entry:directory+'/index.js',styles:[directory+'/index.css']};await writeFile('openclaw.plugin.json',JSON.stringify(manifest,null,2)+'\n');
