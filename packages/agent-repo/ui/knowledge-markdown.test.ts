import {afterEach,expect,test} from 'vitest';
import {h,render} from 'vue';
import {parseKnowledgeMarkdown,renderKnowledgeTokens,resolveKnowledgeLink} from './knowledge-markdown';

let container:HTMLElement|undefined;
afterEach(()=>{if(container){render(null,container);container.remove();container=undefined;}});
function mount(source:string,path='guide.md'){
 const parsed=parseKnowledgeMarkdown(source),links:unknown[]=[];container=document.createElement('div');document.body.append(container);
 render(h('article',renderKnowledgeTokens(parsed.tokens,{path,prefix:'test-',navigate:link=>links.push(link)})),container);
 return {element:container,parsed,links};
}
test('extracts front matter and stable Unicode heading slugs without collisions',()=>{
 const {headings,frontmatter}=parseKnowledgeMarkdown('---\ntitle: metadata\n---\n# 标题 *一*\n## 标题 一\n## 标题 一-1\n## 标题 一\n## !!!\n## !!!');
 expect(frontmatter).toBe('title: metadata');expect(headings.map(h=>h.slug)).toEqual(['标题-一','标题-一-1','标题-一-1-1','标题-一-2','section','section-1']);
 expect(headings[0]).toEqual({slug:'标题-一',text:'标题 一',level:1});
 expect(parseKnowledgeMarkdown('---\nunclosed').frontmatter).toBe('');
});
test('renders headings, tables, nested lists, blockquotes, code and formatting as semantic nodes',()=>{
 const {element}=mount('# 文档\n\n> **重点** 和 *强调*、~~过期~~\n\n3. 列表\n   - 子项\n\n| 字段 | 值 |\n| --- | ---: |\n| UID | `demo` |\n\n```js\nconst value = "<script>";\n```');
 expect(element.querySelector('h1')?.id).toBe('test-文档');expect(element.querySelector('blockquote strong')?.textContent).toBe('重点');
 expect(element.querySelector('s')?.textContent).toBe('过期');expect(element.querySelector('ol')?.getAttribute('start')).toBe('3');expect(element.querySelector('ol ul li')?.textContent).toBe('子项');
 expect(element.querySelectorAll('table td')).toHaveLength(2);expect((element.querySelector('td:last-child') as HTMLElement).style.textAlign).toBe('right');
 expect(element.querySelector('pre code')?.textContent).toContain('"<script>"');expect(element.querySelector('script')).toBeNull();
});
test('keeps raw HTML inert and never fetches Markdown images or injects source attributes',()=>{
 const {element}=mount('<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n<img src=x onerror=alert(1)>\n\n![说明](https://example.com/tracking.svg)\n\n[危险](javascript:alert(1))\n\n[SVG](data:image/svg+xml,bad)');
 expect(element.querySelector('script,iframe,img,svg,object,[onerror]')).toBeNull();expect(element.textContent).toContain('<script>alert(1)</script>');expect(element.textContent).toContain('[图片：说明]');
 expect(Array.from(element.querySelectorAll('a')).every(a=>!/^javascript:|^data:/i.test(a.href))).toBe(true);
});
test('resolves only local Markdown links within the current wiki and validated external URLs',()=>{
 expect(resolveKnowledgeLink('../other%20guide.md#%E6%A0%87%E9%A2%98','nested/start.md')).toEqual({kind:'document',path:'other guide.md',fragment:'标题'});
 expect(resolveKnowledgeLink('./start.md#part','nested/start.md')).toEqual({kind:'anchor',fragment:'part'});
 expect(resolveKnowledgeLink('#标题','guide.md')).toEqual({kind:'anchor',fragment:'标题'});
 expect(resolveKnowledgeLink('https://example.com/path?q=1#part','guide.md')).toEqual({kind:'external',url:'https://example.com/path?q=1#part'});
 expect(resolveKnowledgeLink('mailto:help@example.com','guide.md').kind).toBe('external');
});
test.each(['../../secret.md','%2e%2e/secret.md','/etc/passwd.md','//example.com/a.md','file:///tmp/a.md','javascript:alert(1)','data:text/html,bad','https://user:password@example.com','mailto:a@example.com%0d%0abcc:b@example.com','guide.md?raw=1','%2foutside.md','a%5cb.md','%00.md','a%3fb.md','%zz.md','readme.pdf','http%3Aevil.md','a\nb.md'])('blocks unsafe or unsupported link %s',href=>{
 expect(resolveKnowledgeLink(href,'guide.md').kind).toBe('blocked');
});
test('local links invoke scoped navigation while external links open separately with isolation',()=>{
 const {element,links}=mount('[本地](other.md#step) [目录](#part) [外部](https://example.com) [越界](../outside.md)');
 const anchors=element.querySelectorAll('a');anchors[0]!.click();anchors[1]!.click();anchors[3]!.click();
 expect(links).toEqual([{kind:'document',path:'other.md',fragment:'step'},{kind:'anchor',fragment:'part'},expect.objectContaining({kind:'blocked'})]);
 expect(anchors[2]!.target).toBe('_blank');expect(anchors[2]!.rel).toBe('noopener noreferrer');expect(anchors[0]!.getAttribute('href')).toBe('#test-document');
});
