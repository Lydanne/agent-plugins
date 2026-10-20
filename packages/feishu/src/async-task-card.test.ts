import {mkdtempSync,rmSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,expect,it} from "vitest";
import {acceptAsyncCardResult,bindAsyncTaskCard,prepareAsyncCardResult,readAsyncTaskCard,continueAsyncTaskCard,saveAsyncCardQuestion,acceptAsyncCardProgress,prepareAsyncOriginalOverview} from "./async-task-card.js";
let root: string;
const source={taskId:"t",revision:0,accountId:"a",chatId:"chat",sessionKey:"s",senderId:"user"};
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"feishu-async-card-"));});
afterEach(()=>{rmSync(root,{recursive:true,force:true});});
it("restores task/card ownership from private persistent state and prevents takeover",()=>{
 bindAsyncTaskCard(root,source,["job"],{messageId:"original",imageKey:"gif"});
 bindAsyncTaskCard(root,source,["job"],{messageId:"retry"});
 expect(readAsyncTaskCard(root,"job",source)?.messageId).toBe("original");
 for(const key of ["taskId","revision","accountId","chatId","sessionKey","senderId"] as const) {
  expect(readAsyncTaskCard(root,"job",{...source,[key]:key==="revision"?1:"other"})).toBeUndefined();
 }
 expect(statSync(join(root,"feishu-async-cards","cards.sqlite")).mode & 0o777).toBe(0o600);
 expect(statSync(join(root,"feishu-async-cards")).mode & 0o777).toBe(0o700);
});
it("stores only accepted results and preserves complete identifiers and signed URLs",()=>{
 bindAsyncTaskCard(root,source,["job"],{messageId:"original"});
 const binding=readAsyncTaskCard(root,"job",source)!;
 const text="oWRk-full-id https://example.test/file.zip?signature=complete&expires=123";
 expect(prepareAsyncCardResult(root,binding,text).combined).toBe(text);
 expect(readAsyncTaskCard(root,"job",source)?.result).toBeUndefined();
 acceptAsyncCardResult(root,binding,text);
 expect(readAsyncTaskCard(root,"job",source)?.result).toBe(text);
 expect(prepareAsyncCardResult(root,binding,"长".repeat(12000)).fits).toBe(false);
});

it("uses account presentation settings while other async jobs remain pending",()=>{
 bindAsyncTaskCard(root,source,["one","two"],{messageId:"original",imageKey:"gif"});
 const binding=readAsyncTaskCard(root,"one",source)!;
 const config={workingCard:{imageSize:"128px 128px",conclusionKeywords:["Outcome"]},businessMessages:{workingAlt:"Processing",emptyConclusion:"No conclusion"}};
 const result=prepareAsyncCardResult(root,binding,"Intro\nOutcome: Success",config);
 expect(result.card).toMatchObject({config:{summary:{content:"Outcome: Success"}},body:{elements:[{tag:"img",size:"128px 128px",alt:{content:"Processing"}},{tag:"markdown"}]}});
 expect(prepareAsyncCardResult(root,binding,"",config).card).toMatchObject({config:{summary:{content:"No conclusion"}}});
});

it("moves continuation presentation once per question without changing original ownership",()=>{
 bindAsyncTaskCard(root,source,["loop","sibling"],{messageId:"initial",imageKey:"gif"});
 saveAsyncCardQuestion(root,source,"loop","question-1");
 acceptAsyncCardProgress(root,readAsyncTaskCard(root,"loop",source)!,"等待用户");
 expect(continueAsyncTaskCard(root,{...source,senderId:"other"},"loop","q1",{messageId:"stolen"})).toBe(false);
 expect(continueAsyncTaskCard(root,source,"loop","q1",{messageId:"round-1",imageKey:"working"})).toBe(true);
 expect(continueAsyncTaskCard(root,source,"loop","q1",{messageId:"duplicate"})).toBe(false);
 expect(readAsyncTaskCard(root,"loop",source)).toMatchObject({...source,messageId:"round-1",originalMessageId:"initial",questionMessageId:"question-1"});
 expect(readAsyncTaskCard(root,"loop",source)?.progress).toBeUndefined();
 expect(readAsyncTaskCard(root,"sibling",source)?.messageId).toBe("initial");
 expect(continueAsyncTaskCard(root,source,"loop","q2",{messageId:"round-2"})).toBe(true);
 const binding=readAsyncTaskCard(root,"loop",source)!;
 expect(prepareAsyncCardResult(root,binding,"最终结果").combined).toBe("最终结果");acceptAsyncCardResult(root,binding,"最终结果");
 expect(continueAsyncTaskCard(root,source,"loop","q3",{messageId:"late"})).toBe(false);
});
it("waiting progress retains sibling results without marking the paused job complete",()=>{
 bindAsyncTaskCard(root,source,["paused","done"],{messageId:"initial",imageKey:"gif"});
 acceptAsyncCardResult(root,readAsyncTaskCard(root,"done",source)!,"已有结果");
 const binding=readAsyncTaskCard(root,"paused",source)!;acceptAsyncCardProgress(root,binding,"等待用户");
 expect(readAsyncTaskCard(root,"paused",source)?.result).toBeUndefined();
 expect(prepareAsyncCardResult(root,{...binding,imageKey:undefined},"等待用户").combined).toBe("等待用户\n\n---\n\n已有结果");
});

it("binds the continuation when the original placeholder was unavailable",()=>{
 expect(continueAsyncTaskCard(root,source,"missing-placeholder","q1",{messageId:"new-card"})).toBe(true);
 expect(readAsyncTaskCard(root,"missing-placeholder",source)).toMatchObject({messageId:"new-card",continuationQuestionIds:["q1"]});
});

it("preserves results when one answer turn continues jobs from different original requests",()=>{
 const other={...source,taskId:"second-request"};
 bindAsyncTaskCard(root,source,["one"],{messageId:"initial-one"});bindAsyncTaskCard(root,other,["two"],{messageId:"initial-two"});
 continueAsyncTaskCard(root,source,"one","q1",{messageId:"answer-card"});continueAsyncTaskCard(root,other,"two","q2",{messageId:"answer-card"});
 acceptAsyncCardResult(root,readAsyncTaskCard(root,"one",source)!,"第一个结果");
 expect(prepareAsyncCardResult(root,readAsyncTaskCard(root,"two",other)!,"第二个结果").combined).toBe("第一个结果\n\n---\n\n第二个结果");
 expect(readAsyncTaskCard(root,"two",source)).toBeUndefined();
});

it("the original overview shows the loop terminal state and preserves unrelated accepted results",()=>{
 bindAsyncTaskCard(root,source,["loop","sibling"],{messageId:"initial"});
 acceptAsyncCardResult(root,readAsyncTaskCard(root,"sibling",source)!,"其他任务的完整结果");
 continueAsyncTaskCard(root,source,"loop","q1",{messageId:"latest"});const binding=readAsyncTaskCard(root,"loop",source)!;
 const overview=JSON.stringify(prepareAsyncOriginalOverview(root,binding,"failed"));
 expect(overview).toContain("任务失败");expect(overview).toContain("其他任务的完整结果");expect(overview).toContain("结果见本轮最新工作消息");
});
