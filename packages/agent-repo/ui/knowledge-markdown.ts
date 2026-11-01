import MarkdownIt, {type Token} from 'markdown-it';
import {h, type VNodeChild} from 'vue';

const markdown = new MarkdownIt({html:false,linkify:false,typographer:false,maxNesting:32});
export interface KnowledgeHeading {slug:string;text:string;level:number}
export type KnowledgeLink = {kind:'anchor';fragment:string}|{kind:'document';path:string;fragment:string}|{kind:'external';url:string}|{kind:'blocked';reason:string};

export function headingSlug(text:string){
 return text.normalize('NFC').trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu,'').replace(/\s/g,'-');
}
function inlineText(tokens:Token[]):string{return tokens.map(token=>token.type==='image'?token.content:token.children?inlineText(token.children):token.content).join('');}
export function parseKnowledgeMarkdown(source:string){
 // Front matter is metadata, not a Markdown thematic break and heading.
 const match=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source);
 const tokens=markdown.parse(match?source.slice(match[0].length):source,{}),headings:KnowledgeHeading[]=[],used=new Set<string>();
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i]!;if(token.type!=='heading_open')continue;
  const text=inlineText(tokens[i+1]?.children??[]),base=headingSlug(text)||'section';let slug=base,index=0;
  while(used.has(slug))slug=base+'-'+(++index);used.add(slug);
  token.attrSet('data-kb-heading',slug);headings.push({slug,text,level:Number(token.tag.slice(1))});
 }
 return {tokens,headings,frontmatter:match?.[1]??''};
}

export function resolveKnowledgeLink(href:string,currentPath:string):KnowledgeLink{
 const blocked=(reason='此链接不在当前知识库可读取的 Markdown 范围内。'):KnowledgeLink=>({kind:'blocked',reason});
 if(!href||/[\u0000-\u0020\u007f\\]/.test(href))return blocked();
 if(/^(?:https?:|mailto:)/i.test(href)){
  try{const url=new URL(href);if(url.username||url.password||/%(?:0[ad]|00)/i.test(url.href))return blocked();return {kind:'external',url:url.href};}catch{return blocked('链接地址无效。');}
 }
 // Absolute paths, protocol-relative URLs and all other schemes stay inert.
 if(href.startsWith('/')||/^[a-z][a-z\d+.-]*:/i.test(href))return blocked();
 const hash=href.indexOf('#'),rawPath=hash<0?href:href.slice(0,hash);let fragment='',decoded='';
 try{fragment=hash<0?'':decodeURIComponent(href.slice(hash+1)).normalize('NFC');decoded=decodeURIComponent(rawPath);}catch{return blocked('链接编码无效。');}
 if(/[\u0000-\u001f\u007f\\]/.test(fragment)||/[\u0000-\u001f\u007f\\?#]/.test(decoded)||decoded.startsWith('/')||/^[a-z][a-z\d+.-]*:/i.test(decoded))return blocked();
 if(!rawPath)return {kind:'anchor',fragment};
 const segments=currentPath.split('/').slice(0,-1);
 for(const part of decoded.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!segments.length)return blocked('链接超出当前知识库目录。');segments.pop();}else segments.push(part);}
 const path=segments.join('/');if(!/\.md$/i.test(path))return blocked();
 return path===currentPath?{kind:'anchor',fragment}:{kind:'document',path,fragment};
}

const tags=new Set(['p','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','strong','em','s','table','thead','tbody','tr','th','td']);
interface RenderOptions {path:string;prefix:string;navigate:(link:KnowledgeLink)=>void}
// Vue text nodes and an explicit tag/attribute allowlist: never inject rendered HTML.
export function renderKnowledgeTokens(tokens:Token[],options:RenderOptions):VNodeChild[]{
 const root:VNodeChild[]=[],stack:{tag:string;attrs:Record<string,unknown>;children:VNodeChild[]}[]=[];
 const add=(node:VNodeChild)=>{(stack.at(-1)?.children??root).push(node);};
 for(const token of tokens){
  if(token.hidden)continue;
  if(token.nesting===-1){const item=stack.pop();if(item)add(h(item.tag,item.attrs,item.children));continue;}
  if(token.type==='inline'){for(const node of renderKnowledgeTokens(token.children??[],options))add(node);continue;}
  if(token.type==='text'||token.type==='html_inline'||token.type==='html_block'){add(token.content);continue;}
  if(token.type==='code_inline'){add(h('code',token.content));continue;}
  if(token.type==='fence'||token.type==='code_block'){add(h('pre',{tabindex:0},[h('code',token.content)]));continue;}
  if(token.type==='softbreak'){add('\n');continue;}
  if(token.type==='hardbreak'||token.type==='hr'){add(h(token.type==='hr'?'hr':'br'));continue;}
  if(token.type==='image'){add(h('span',{class:'kb-image',title:'图片不自动加载，避免访问未核验的资源。'},'[图片：'+(token.content||'未提供说明')+']'));continue;}
  if(token.type==='link_open'){
   const link=resolveKnowledgeLink(String(token.attrGet('href')??''),options.path);
   const attrs:Record<string,unknown>=link.kind==='external'?{href:link.url,target:'_blank',rel:'noopener noreferrer'}:{href:'#'+options.prefix+(link.kind==='anchor'?link.fragment:'document'),onClick:(event:Event)=>{event.preventDefault();options.navigate(link);}};
   if(link.kind==='blocked'){attrs.class='kb-blocked-link';attrs.title=link.reason;}
   const title=token.attrGet('title');if(title&&link.kind!=='blocked')attrs.title=title;
   stack.push({tag:'a',attrs,children:[]});continue;
  }
  if(token.nesting===1&&tags.has(token.tag)){
   const attrs:Record<string,unknown>={};
   const slug=token.attrGet('data-kb-heading');if(slug){attrs.id=options.prefix+slug;attrs['data-kb-heading']=slug;attrs.tabindex=-1;}
   if(token.tag==='ol'){const start=token.attrGet('start');if(start&&/^\d{1,9}$/.test(String(start)))attrs.start=Number(start);}
   if(token.tag==='th'||token.tag==='td'){const align=/^text-align:(left|right|center)$/.exec(String(token.attrGet('style')??''))?.[1];if(align)attrs.style={textAlign:align};}
   stack.push({tag:token.tag,attrs,children:[]});continue;
  }
  if(token.content)add(token.content);
 }
 while(stack.length){const item=stack.pop()!;add(h(item.tag,item.attrs,item.children));}
 return root;
}
