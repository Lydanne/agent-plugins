import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control UI isolated fixture</title><style>html{--bg:#faf9f7;--text:#3b3834;--muted:#827b73}html[data-theme=dark]{--bg:#242625;--text:#e5e1da;--muted:#ada69c}body{margin:0;background:var(--bg);color:var(--text)}#view{min-width:0;overflow:hidden;min-height:100vh}button,input,select,textarea{font:inherit}</style></head><body><main id="view"></main><script type="module" src="/fixture.mjs"></script></body></html>';
createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
  if(url.pathname==='/fixture.mjs'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(root,'test/browser/fixture.mjs')));return;}
  const match=url.pathname.match(/^\/plugins\/(agent-repo|agent-worker)\/(openclaw\.plugin\.json|dist\/control-ui\/[a-f0-9]+\/index\.(?:js|css))$/);
  if(!match){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',match[2].endsWith('.css')?'text/css':match[2].endsWith('.json')?'application/json':'text/javascript');
  res.end(await readFile(path.join(root,'packages',match[1],match[2])));
 }catch{res.writeHead(500);res.end('Fixture asset unavailable; build plugins first.');}
}).listen(4187,'127.0.0.1');
