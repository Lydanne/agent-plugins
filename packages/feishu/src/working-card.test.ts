import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
const mocks = vi.hoisted(() => ({
  recall: vi.fn(), account: vi.fn(), upload: vi.fn(), send: vi.fn(), edit: vi.fn(), notify: vi.fn(),
}));
vi.mock("./accounts.js", () => ({ resolveFeishuRuntimeAccount: mocks.account }));
vi.mock("./client.js", () => ({ createFeishuClient: () => ({ im: { image: { create: mocks.upload }, message: {delete: mocks.recall} } }) }));
vi.mock("./send.js", () => ({ sendCardFeishu: mocks.send, editMessageFeishu: mocks.edit, sendMessageFeishu: mocks.notify }));
vi.mock("./presentation-card.js", () => ({ withinCardTableLimit: () => true }));
import { extractWorkingCardConclusion, FeishuWorkingCard, workingResultCard } from "./working-card.js";
import {clearRecentOutboundMentions,recordOutboundMentions,nativeMentionIds} from "./recent-outbound-mentions.js";
let accountNumber = 0;
function setup(requester = true) {
  const log = vi.fn();
  return { log, card: new FeishuWorkingCard({ cfg: {}, to: "oc_group", accountId: "test", replyToMessageId: "om_question", replyInThread: true,
    ...(requester ? { requester: { openId: "ou_requester", name: "同学", key: "" } } : {}), log }) };
}
beforeEach(() => {
  vi.resetAllMocks();
  clearRecentOutboundMentions();
  mocks.account.mockReturnValue({ accountId: `test-${++accountNumber}`, appId: "app_test", domain: "feishu" });
  mocks.recall.mockResolvedValue({code: 0});
  mocks.upload.mockResolvedValue({ code: 0, data: { image_key: "img_working" } });
  mocks.send.mockResolvedValue({ messageId: "om_working" });
  mocks.edit.mockImplementation(async ({card})=>({messageId:"om_working",mentionedUserIds:nativeMentionIds(card)}));
  mocks.notify.mockResolvedValue({ messageId: "om_notice" });
});

describe("working GIF lifecycle", () => {
  it("holds an accepted backend task after the Ada turn ends without a completion mention", async () => {
    const {card} = setup(); await card.start();
    expect(await card.holdForBackground()).toEqual({messageId: "om_working", imageKey: "img_working"});
    await card.finish(); await card.finish();
    expect(mocks.edit).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled();
    await card.finish("任务来源已撤回，已请求取消。");
    expect(JSON.stringify(mocks.edit.mock.calls)).toContain("已撤回");
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("reuses an image-only waiting card for working and final states", async () => {
    mocks.upload.mockResolvedValueOnce({ image_key: "img_waiting" }).mockResolvedValueOnce({ image_key: "img_working" });
    const {card}=setup();
    await Promise.all([card.wait(), card.wait()]);
    const waiting = mocks.send.mock.calls[0][0].card;
    expect(waiting.body.elements).toHaveLength(1);
    expect(waiting.body.elements[0]).toMatchObject({tag:"img",img_key:"img_waiting"});
    expect(waiting.config.summary).toBeUndefined();
    await Promise.all([card.start(), card.start()]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const working = mocks.edit.mock.calls[0][0];
    expect(working.messageId).toBe("om_working");
    expect(working.card.body.elements).toHaveLength(1);
    expect(working.card.body.elements[0]).toMatchObject({tag:"img",img_key:"img_working"});
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    await card.complete("结论：完成。"); await card.finish();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
  it("seals cancelled waiting cards without a later working transition or completion ping", async () => {
    const {card}=setup(); await card.wait(); await card.finish("本条请求已取消。");
    await card.start(); await card.wait();
    expect(await card.complete("late result")).toBeUndefined();
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.edit.mock.calls[0])).toContain("已取消");
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("does not create a duplicate after an uncertain waiting send", async () => {
    mocks.send.mockRejectedValue(new Error("timeout"));
    const {card}=setup(); await card.wait(); await card.start();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(await card.complete("result")).toBeUndefined();
  });
  it("keeps the known card usable if the working-image update fails", async () => {
    const {card}=setup(); await card.wait();
    mocks.edit.mockRejectedValueOnce(new Error("timeout")); await card.start();
    expect(await card.complete("结论：完成。")).toBe("om_working");
    await card.finish(); expect(mocks.notify).toHaveBeenCalledOnce();
  });
  it("ships a separate looping waiting GIF", async () => {
    const gif = await readFile(new URL("../assets/ada-waiting.gif", import.meta.url));
    expect(gif.subarray(0,6).toString()).toBe("GIF89a");
    expect(gif.includes(Buffer.from("NETSCAPE2.0"))).toBe(true);
    expect(gif.length).toBeLessThan(1024*1024);
  });

  it("ships a genuine looping GIF inside the package", async () => {
    const gif = await readFile(new URL("../assets/ada-working.gif", import.meta.url));
    expect(gif.subarray(0, 6).toString()).toBe("GIF89a");
    expect(gif.includes(Buffer.from("NETSCAPE2.0"))).toBe(true);
    expect(gif.length).toBeLessThan(10 * 1024 * 1024);
  });
  it("replaces the same card and only then quotes the result to the requester", async () => {
    const { card } = setup();
    await Promise.all([card.start(), card.start()]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0]).toMatchObject({replyToMessageId:"om_question", card:{config:{update_multi:true}, body:{elements:[{tag:"img",img_key:"img_working"}]}}});
    const messageId = await card.complete("## 结论\n已修复 3 条记录，全部校验通过。\n\n详细过程如下。");
    expect(messageId).toBe("om_working");
    expect(mocks.edit.mock.calls[0][0]).toMatchObject({messageId:"om_working",card:{config:{update_multi:true},body:{elements:[{tag:"markdown"}]}}});
    expect(mocks.notify).not.toHaveBeenCalled();
    await Promise.all([card.finish(), card.finish()]);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0]).toMatchObject({replyToMessageId:"om_working",replyInThread:true,mentions:[{openId:"ou_requester"}],plainText:true,text:expect.stringMatching(/^老师，(?:搞定了|完成了|处理好了)$/)});
  });
  it("awaits placeholder creation before replacing it", async () => {
    let release!: (value: {messageId: string}) => void;
    mocks.send.mockReturnValue(new Promise(resolve => {release=resolve;}));
    const {card}=setup();
    const start=card.start();
    const complete=card.complete("结论：完成。");
    await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalled());
    expect(mocks.edit).not.toHaveBeenCalled();
    release({messageId:"om_working"});
    await Promise.all([start,complete]);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
  });
  it("retains all accepted results on the card without quoting them in the notification",async()=>{
    const {card}=setup(); await card.start();
    await card.complete("初步结果：还需检查。");
    await card.complete("结论：检查未通过，尚未修复。");
    await card.finish();
    expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).toContain("初步结果");
    expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).toContain("结论：检查未通过，尚未修复。");
    expect(mocks.notify.mock.calls[0][0].text).toMatch(/^老师，(?:搞定了|完成了|处理好了)$/);
  });
  it("does not notify in direct messages", async()=>{
    const {card}=setup(false); await card.start(); await card.complete("结论：已完成。"); await card.finish();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("does not retry an uncertain placeholder send", async()=>{
    mocks.send.mockRejectedValue(new Error("timeout"));
    const {card}=setup(); await card.start(); await card.start();
    expect(await card.complete("result")).toBeUndefined();
    await card.finish(); expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("falls back after an update rejection and notifies only an accepted fallback result", async()=>{
    const {card}=setup(); await card.start(); mocks.edit.mockRejectedValueOnce(new Error("rejected"));
    expect(await card.complete("结论：已完成。")).toBeUndefined();
    expect(mocks.notify).not.toHaveBeenCalled();
    card.acceptExternalResult("om_fallback","结论：已完成。"); await card.finish();
    expect(mocks.notify.mock.calls[0][0].replyToMessageId).toBe("om_fallback");
  });
  it("keeps oversized results for the normal chunked path",async()=>{
    const {card}=setup(); await card.start();
    expect(await card.complete("长".repeat(12000))).toBeUndefined();
    expect(JSON.stringify(mocks.edit.mock.calls[0])).toContain("完整内容将在下方分段发送");
    await card.finish(); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("ends empty, suppressed and failed turns without completion mentions",async()=>{
    for (const failed of [false,true]) {
      const {card}=setup(); await card.start(); if(failed) card.fail(); await card.finish();
    }
    expect(mocks.edit).toHaveBeenCalledTimes(2); expect(mocks.notify).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).toContain("本轮处理未完成");
  });
  it("retires an old card on steer without claiming a completed result",async()=>{
    const {card}=setup(); await card.start(); await card.finish("已按补充调整，后续结果将回复到新的提问消息。");
    expect(await card.complete("old result")).toBeUndefined(); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("preserves already accepted results when retiring a card for correction",async()=>{
    const {card}=setup(); await card.start(); await card.complete("已取得第一份结果。");
    await card.finish("已按补充调整，后续结果将回复到新的提问消息。");
    expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).toContain("已取得第一份结果");
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("does not resend a result after notification failure",async()=>{
    const {card,log}=setup(); await card.start(); await card.complete("结论：未找到异常。");
    mocks.notify.mockRejectedValue(new Error("timeout")); await card.finish(); await card.finish();
    expect(mocks.notify).toHaveBeenCalledTimes(1);expect(mocks.send).toHaveBeenCalledTimes(1);expect(log).toHaveBeenCalled();
  });
  it("suppresses success reminders when attachment delivery failed",async()=>{
    const {card}=setup(); await card.start(); await card.complete("已导出附件。"); card.fail(); await card.finish();
    expect(JSON.stringify(mocks.edit.mock.calls.at(-1))).toContain("交付尚未完成"); expect(mocks.notify).not.toHaveBeenCalled();
  });
});
describe("conclusion excerpt",()=>{
  it("preserves uncertainty and excludes code, image and mention markup",()=>{
    expect(extractWorkingCardConclusion("```js\nthrow Error('success')\n```\n## 结论\n**尚未确认原因，需要补充日志。**\n<at id=all></at>"))
      .toBe("尚未确认原因，需要补充日志。");
  });
  it("bounds excerpt size without splitting emoji",()=>{
    const s=extractWorkingCardConclusion("😀".repeat(181)); expect(Array.from(s)).toHaveLength(181); expect(s.endsWith("…")).toBe(true);
  });
});

describe("progress nudge card relocation", () => {
  it("sends GIF plus progress before recalling old card and delivers final on newest card", async () => {
    const {card} = setup(); await card.start();
    mocks.send.mockResolvedValueOnce({messageId: "new-card"});
    expect(await card.refreshProgress("nudge", "真实进度")).toBe(true);
    expect(mocks.send.mock.calls[1][0]).toMatchObject({replyToMessageId: "nudge", card: {body: {elements: [{tag: "img"}, {tag: "markdown", content: "真实进度"}]}}});
    expect(mocks.recall).toHaveBeenCalledExactlyOnceWith({path: {message_id: "om_working"}});
    expect(mocks.send.mock.invocationCallOrder[1]).toBeLessThan(mocks.recall.mock.invocationCallOrder[0]);
    expect(await card.complete("结论：完成")).toBe("new-card"); await card.finish();
    expect(mocks.notify.mock.calls[0][0].replyToMessageId).toBe("new-card");
    expect(await card.refreshProgress("late", "late")).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("consumes uncertain sends without recalling the original or duplicating work", async () => {
    const {card}=setup(); await card.start(); mocks.send.mockRejectedValueOnce(new Error("timeout"));
    expect(await card.refreshProgress("nudge", "progress")).toBe(true);
    expect(mocks.recall).not.toHaveBeenCalled();
    expect(await card.complete("done")).toBe("om_working");
  });
  it("keeps new card authoritative when recall is rejected", async () => {
    const {card, log}=setup(); await card.start(); mocks.send.mockResolvedValueOnce({messageId:"new"});
    mocks.recall.mockResolvedValueOnce({code: 999}); await card.refreshProgress("nudge", "progress");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("recall failed"));
    expect(mocks.edit.mock.calls[0][0].messageId).toBe("om_working");
    expect(await card.complete("done")).toBe("new");
  });
  it("never withdraws a delivered result or promotes a waiting request", async () => {
    const {card}=setup(); await card.wait(); expect(await card.refreshProgress("nudge", "progress")).toBe(false);
    await card.start(); await card.complete("done"); expect(await card.refreshProgress("nudge", "progress")).toBe(false);
    expect(mocks.recall).not.toHaveBeenCalled();
  });
  it("serializes final delivery behind an in-flight move", async () => {
    const {card}=setup(); await card.start();
    let release!: (v: {messageId: string}) => void;
    mocks.send.mockReturnValueOnce(new Promise(r=>{release=r;}));
    const move=card.refreshProgress("nudge", "progress"); const final=card.complete("done");
    await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.edit).not.toHaveBeenCalled(); release({messageId:"new"});
    await move; expect(await final).toBe("new");
  });
});

it("suppresses result and completion mention when the task source is recalled",async()=>{
 const controller=new AbortController();
 const card=new FeishuWorkingCard({cfg:{},to:"oc_group",log:vi.fn(),sourceSignal:controller.signal,requester:{openId:"ou_requester",name:"老师",key:""}});
 await card.start();controller.abort();
 expect(await card.complete("obsolete conclusion")).toBeUndefined();
 await card.finish("任务来源已撤回");
 expect(mocks.notify).not.toHaveBeenCalled();
 expect(JSON.stringify(mocks.edit.mock.calls)).not.toContain("obsolete conclusion");
});

it('uses configured card assets, image labels, conclusion headings and completion wording',async()=>{
 const imagePath=new URL('../assets/ada-waiting.gif',import.meta.url).pathname;
 mocks.account.mockReturnValue({accountId:'configured',appId:'configured-app',domain:'feishu',config:{workingCard:{workingImage:imagePath,imageSize:'128px 128px',conclusionKeywords:['Outcome']},businessMessages:{workingAlt:'Processing',completionMention:'Your result is ready.'}}});
 const {card}=setup();await card.start();
 expect(mocks.upload.mock.calls[0][0].data.image).toEqual(await readFile(imagePath));
 const image=mocks.send.mock.calls[0][0].card.body.elements[0];
 expect(image.alt.content).toBe('Processing');expect(image.size).toBe('128px 128px');
 await card.complete('Intro\nOutcome: verified');await card.finish();
 expect(mocks.edit.mock.calls[0][0].card.config.summary.content).toBe('Outcome: verified');
 expect(mocks.notify.mock.calls[0][0].text).toBe('Your result is ready.');
 expect(extractWorkingCardConclusion('Intro\nOutcome: verified',['Outcome'])).toBe('Outcome: verified');
});

it("preserves whitespace around default conclusion headings",()=>{
 expect(extractWorkingCardConclusion("背景说明\n结论 ：成功")).toBe("结论 ：成功");
 expect(extractWorkingCardConclusion("背景说明\n结论 ：\n成功")).toBe("成功");
 expect(extractWorkingCardConclusion("Background\nOutcome :\nVerified",["Outcome"])).toBe("Verified");
});
it("uses configured heading and empty text in actual card summaries",()=>{
 const config={workingCard:{conclusionKeywords:["Outcome"]},businessMessages:{emptyConclusion:"No conclusion"}};
 expect(workingResultCard("Background\nOutcome: Success",config)).toMatchObject({config:{summary:{content:"Outcome: Success"}}});
 expect(workingResultCard("```js\nprivate code\n```",config)).toMatchObject({config:{summary:{content:"No conclusion"}}});
});

describe("completion mention deduplication", () => {
  it("skips the reminder when the accepted result mentions the requester despite a working GIF", async () => {
    const {card}=setup(); await card.start();
    await card.complete('<at id="ou_requester"></at>老师，已核验完成。'); await card.finish();
    await card.finish();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("always reminds for a working GIF after a recent acknowledged mention in the same thread", async () => {
    recordOutboundMentions({accountId:mocks.account().accountId,to:"oc_group",replyInThread:true,replyToMessageId:"om_question"},"om_working",{tag:"at",user_id:"ou_requester"});
    const {card}=setup(); await card.start(); await card.complete("完成"); await card.finish();
    await card.finish();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
  it.each(['<at id="ou_other"></at>完成', '`<at id="ou_requester"></at>`', '@同学 已完成'])("keeps the reminder for a different or non-native mention: %s", async text => {
    const {card}=setup(); await card.start(); await card.complete(text); await card.finish();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
  it("does not treat a failed result update as an accepted mention", async () => {
    const {card}=setup(); await card.start(); mocks.edit.mockRejectedValueOnce(new Error("timeout"));
    await card.complete('<at id="ou_requester"></at>完成');
    await card.acceptExternalResult("om_external","已完成"); await card.finish();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
});

it("does not suppress the external-result reminder using an unsent draft mention",async()=>{
 const {card}=setup();await card.start();
 await card.acceptExternalResult("external",'<at id="ou_requester"></at>draft');await card.finish();
 expect(mocks.notify).toHaveBeenCalledOnce();
});

it('distinguishes image preparation failure from uncertain dispatch and confirmed creation',async()=>{
 mocks.upload.mockRejectedValueOnce(Error('upload unavailable'));
 const first=setup();await first.card.start();
 expect(first.card.placeholderCreationState()).toBe('not_sent');
 expect(await first.card.holdForBackground()).toBeUndefined();expect(mocks.send).not.toHaveBeenCalled();
 const retry=setup();await retry.card.start();expect(retry.card.placeholderCreationState()).toBe('created');
 expect(await retry.card.holdForBackground()).toMatchObject({messageId:'om_working'});
 mocks.send.mockRejectedValueOnce(Error('timeout'));
 const uncertain=setup();await uncertain.card.start();expect(uncertain.card.placeholderCreationState()).toBe('uncertain');
 await uncertain.card.start();expect(mocks.send).toHaveBeenCalledTimes(2);
});
