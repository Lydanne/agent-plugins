import { describe, expect, it } from "vitest";
import { resolveFeishuReadOnlyCommand } from "./command-routing.js";

describe("read-only host command routing", () => {
  it.each(["/subagents list", " /agents ", "/help", "/commands", "/whoami", "/status"])(
    "recognizes %s through the public host registry", (text) => {
      expect(resolveFeishuReadOnlyCommand(text, {})).toBeDefined();
    },
  );
  it.each(["/skill review", "/compact", "/read-wiki 查询资料", "/subagents-extra list", "请执行 /subagents list"])(
    "keeps %s in normal task admission", (text) => {
      expect(resolveFeishuReadOnlyCommand(text, {})).toBeUndefined();
    },
  );
  it("follows the host policy for a surface without native slash commands", () => {
    // The host keeps text commands active on Feishu even with commands.text=false.
    expect(resolveFeishuReadOnlyCommand("/subagents list", {commands:{text:false}})).toBe("/subagents");
  });
  it("normalizes identity aliases and rejects unexpected arguments", () => {
    expect(resolveFeishuReadOnlyCommand(" /ID ", {})).toBe("/whoami");
    expect(resolveFeishuReadOnlyCommand("/help unexpected", {})).toBeUndefined();
  });
});
