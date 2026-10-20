import {expect,it,vi} from "vitest";
import {writeDoc} from "./docx.js";
import {parseFeishuMarkdown} from "./markdown.js";
import type {FeishuDocxBlock} from "./docx-types.js";

it("splits a short wide table by converted block count, repeating headers without losing rows",async()=>{
  const header="| "+Array.from({length:10},(_,i)=>`H${i}`).join(" | ")+" |\n";
  const separator="| "+Array(10).fill("---").join(" | ")+" |\n";
  const rows=Array.from({length:63},(_,r)=>"| "+Array.from({length:10},(_,c)=>`r${r}c${c}`).join(" | ")+" |");
  const markdown=header+separator+rows.join("\n");
  expect(markdown.length).toBeLessThan(20000);
  let generation=0;
  const convert=vi.fn(async({data}:{data:{content:string}})=>{
    const table=parseFeishuMarkdown(data.content).children?.[0];
    expect(table?.type).toBe("table");
    expect(data.content.startsWith(header+separator)).toBe(true);
    const prefix=`convert-${generation++}-`,cells:FeishuDocxBlock[]=[],texts:FeishuDocxBlock[]=[];
    for(const [r,row] of (table?.children ?? []).entries()) {
      for(const [c,cell] of (row.children ?? []).entries()) {
        const id=prefix+`${r}-${c}`;
        cells.push({block_type:32,block_id:id,children:[id+"-text"]});
        texts.push({block_type:2,block_id:id+"-text",text:{elements:[{text_run:{content:cell.children?.map(node=>node.value ?? "").join("")}}]}});
      }
    }
    return {code:0,data:{first_level_block_ids:[prefix+"table"],blocks:[{block_type:31,block_id:prefix+"table",children:cells.map(cell=>cell.block_id!),table:{property:{row_size:table?.children?.length,column_size:10}}},...cells,...texts]}};
  });
  const insert=vi.fn(async({data}:{data:{descendants:FeishuDocxBlock[]}})=>{
    expect(data.descendants.length).toBeLessThanOrEqual(1000);
    return {code:0,data:{children:[]}};
  });
  const list=vi.fn(async()=>({code:0,data:{items:[]}}));
  const client={docx:{document:{convert},documentBlock:{list},documentBlockDescendant:{create:insert}}} as unknown as Parameters<typeof writeDoc>[0];
  const result=await writeDoc(client,"document",markdown,20*1024*1024,30000);
  expect(result.success).toBe(true);
  expect(convert.mock.calls.length).toBeGreaterThan(1);
  expect(list.mock.invocationCallOrder[0]).toBeGreaterThan(convert.mock.invocationCallOrder.at(-1)!);
  const insertedValues=insert.mock.calls.flatMap(([request])=>request.data.descendants.flatMap(block=>block.text?.elements?.map(element=>element.text_run?.content) ?? [])).filter(value=>value?.startsWith("r"));
  expect(insertedValues).toEqual(Array.from({length:63},(_,r)=>Array.from({length:10},(_,c)=>`r${r}c${c}`)).flat());
});

it("leaves the existing document untouched when an oversized subtree cannot be split",async()=>{
  const children=Array.from({length:1000},(_,i)=>`child-${i}`);
  const convert=vi.fn(async()=>({code:0,data:{first_level_block_ids:["table"],blocks:[{block_type:31,block_id:"table",children},...children.map(block_id=>({block_type:32,block_id}))]}}));
  const list=vi.fn(),insert=vi.fn();
  const client={docx:{document:{convert},documentBlock:{list},documentBlockDescendant:{create:insert}}} as unknown as Parameters<typeof writeDoc>[0];
  await expect(writeDoc(client,"document","x",1024,30000)).rejects.toMatchObject({code:"DOCX_BLOCK_LIMIT"});
  expect(list).not.toHaveBeenCalled();expect(insert).not.toHaveBeenCalled();
});
