import { describe, expect, it, vi } from "vitest";
import { captureFeishuProgress, isFeishuProgressText, isFeishuRawProgressMessage, captureFeishuSteer, isFeishuRawSteerMessage, isFeishuSteerText, registerFeishuSteerOwner } from "./keyword-steer.js";

const scope = { accountId: "test", chatId: "chat", sessionKey: "session", senderId: "sender" };

describe("keyword steering", () => {
  it.each(["更正一下：查昨天的", "刚才说错了，应该是任务 B", "改成: CSV", "补充一下：环境是测试环境"])("matches explicit correction %s", (text) => {
    expect(isFeishuSteerText(text)).toBe(true);
  });
  it.each(["更正一下", "改成：", "能把它改成 CSV 吗", "> 更正一下：示例", "他说：补充一下：文本", "```\n改成：CSV\n```", "帮我查一下任务"])("does not promote ordinary/quoted text %s", (text) => {
    expect(isFeishuSteerText(text)).toBe(false);
  });
  it("only parses text envelopes, including native bot mention placeholders", () => {
    expect(isFeishuRawSteerMessage({ message_type: "text", content: '{"text":"@_user_1 更正一下：昨天"}' })).toBe(true);
    expect(isFeishuRawSteerMessage({ message_type: "post", content: '{"text":"更正一下：昨天"}' })).toBe(false);
    expect(isFeishuRawSteerMessage({ message_type: "text", content: "invalid" })).toBe(false);
  });
  it("requires a live owner with the same sender, account, session and thread", async () => {
    const retarget = vi.fn(async () => {});
    const input = { ...scope, text: "改成：CSV" };
    expect(captureFeishuSteer(input)).toBeUndefined();
    const release = registerFeishuSteerOwner({ ...scope, messageId: "first", retarget });
    try {
      for (const change of [{senderId:"other"}, {accountId:"other"}, {sessionKey:"other"}, {rootId:"thread"}]) {
        expect(captureFeishuSteer({ ...input, ...change })).toBeUndefined();
      }
      const steer = captureFeishuSteer(input)!;
      expect(retarget).not.toHaveBeenCalled();
      expect(await steer.adopted("second")).toBe(true);
      expect(await steer.adopted("second")).toBe(false);
      expect(retarget).toHaveBeenCalledExactlyOnceWith("second", "改成：CSV");
    } finally { release(); }
  });
  it("never redirects a successor when steering falls back to a later turn", async () => {
    const oldRetarget = vi.fn(async () => {});
    const releaseOld = registerFeishuSteerOwner({ ...scope, messageId: "first", retarget: oldRetarget });
    const captured = captureFeishuSteer({ ...scope, text: "改成：CSV" })!;
    const nextRetarget = vi.fn(async () => {});
    const releaseNext = registerFeishuSteerOwner({ ...scope, messageId: "next", retarget: nextRetarget });
    try {
      releaseOld();
      expect(await captured.adopted("second")).toBe(false);
      expect(oldRetarget).not.toHaveBeenCalled();
      expect(nextRetarget).not.toHaveBeenCalled();
      expect(captureFeishuSteer({ ...scope, text: "改成：JSON" })).toBeDefined();
    } finally { releaseNext(); }
  });
});

describe("progress nudge ownership", () => {
  it.each(["好了吗？", "上面的任务怎么样了", "ada，还要多久能完成？", "进度到哪了", "催一下", "快点吧"])("recognizes %s", text => expect(isFeishuProgressText(text)).toBe(true));
  it.each(["> 好了吗", "他说好了吗", "好了吗？再帮我查昨天的", "检查进度怎么样这个字段", "```好了吗```"])("does not consume new work or quotes %s", text => expect(isFeishuProgressText(text)).toBe(false));
  it("parses native mention but rejects non-text", () => {
    expect(isFeishuRawProgressMessage({message_type:"text",content:JSON.stringify({text:"@_user_1 好了吗"})})).toBe(true);
    expect(isFeishuRawProgressMessage({message_type:"post",content:"{}"})).toBe(false);
  });
  it("isolates owners and quote targets and expires captured nudges", async () => {
    const refreshProgress=vi.fn(async()=>true);
    const release=registerFeishuSteerOwner({...scope,messageId:"first",retarget:async()=>{},refreshProgress,matchesProgressReply:id=>id==="card"});
    const input={...scope,text:"好了吗"};
    for(const change of [{senderId:"other"},{chatId:"other"},{sessionKey:"other"},{rootId:"other"},{parentId:"unrelated"}]) expect(captureFeishuProgress({...input,...change})).toBeUndefined();
    const nudge=captureFeishuProgress({...input,parentId:"card"})!;
    expect(await nudge("nudge")).toBe(true); release();
    expect(await nudge("late")).toBe(false); expect(refreshProgress).toHaveBeenCalledTimes(1);
  });
});

describe('operator-owned literal command vocabulary',()=>{
 it('replaces correction prefixes, nudge phrases and assistant aliases',()=>{
  expect(isFeishuSteerText('Update: target B',{steerPrefixes:['Update']})).toBe(true);
  expect(isFeishuSteerText('改成：目标B',{steerPrefixes:['Update']})).toBe(false);
  expect(isFeishuSteerText('Update:',{steerPrefixes:['Update']})).toBe(false);
  expect(isFeishuProgressText('Status?',{progressPhrases:['Status?']})).toBe(true);
  expect(isFeishuProgressText('好了吗',{progressPhrases:['Status?']})).toBe(false);
  expect(isFeishuProgressText('Helper，好了吗',{progressAliases:['Helper']})).toBe(true);
  expect(isFeishuProgressText('Ada，好了吗',{progressAliases:['Helper']})).toBe(false);
  expect(isFeishuProgressText('好了吗',{progressPhrases:[]})).toBe(false);
 });
});
