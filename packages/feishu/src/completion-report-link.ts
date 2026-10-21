import {fromMarkdown} from "mdast-util-from-markdown";

/** Only extract a standalone report link, never code examples or business links. */
export function splitCompletionReportLink(text:string):{text:string;link?:string} {
 for(const node of fromMarkdown(text).children) {
  if(node.type!=="paragraph" || node.children.length!==1)continue;
  const link=node.children[0];
  if(link.type!=="link" || !/^https?:\/\//.test(link.url) || link.children.length!==1 ||
   link.children[0].type!=="text" || link.children[0].value!=="完整报告")continue;
  const start=node.position?.start.offset,end=node.position?.end.offset;
  if(start===undefined || end===undefined)continue;
  return {text:(text.slice(0,start).trimEnd()+"\n\n"+text.slice(end).trimStart()).trim(),link:text.slice(start,end)};
 }
 return {text};
}

export function hasCloudReportLink(text:string):boolean {
 const visit=(node:ReturnType<typeof fromMarkdown>|ReturnType<typeof fromMarkdown>["children"][number]):boolean=>{
  if(node.type==="link" && /^https?:\/\//.test(node.url) &&
   node.children.some(child=>child.type==="text" && /报告/.test(child.value)))return true;
  return "children" in node && node.children.some(child=>visit(child as typeof node));
 };
 return visit(fromMarkdown(text));
}
