import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { registerFeishuGroupHistoryTool } from "./group-history.js";
const mocks = vi.hoisted(() => ({ list: vi.fn(), client: vi.fn() }));
vi.mock("./client.js", () => ({ createFeishuClient: mocks.client }));
const config = { channels: { feishu: { enabled: true, appId: "fixture", appSecret: "fixture-secret", groupPolicy: "allowlist" as const, groupAllowFrom: ["oc_fixture"], tools: { chat: true } } } };
function setup(cfg: OpenClawPluginApi["config"] = config) {
  const registerTool = vi.fn();
  registerFeishuGroupHistoryTool({ config: cfg, registerTool } as unknown as OpenClawPluginApi);
  return (context = {}) => registerTool.mock.calls[0][0]({ config: cfg, sessionKey: "agent:main:feishu:group:oc_fixture", agentAccountId: "default", ...context });
}
beforeEach(() => { vi.clearAllMocks(); mocks.client.mockReturnValue({ im: { message: { list: mocks.list } } }); mocks.list.mockResolvedValue({ code: 0, data: { items: [{ message_id: "fixture-message", body: { content: "reference only" } }], has_more: true } }); });
it("reads only the trusted current group using the configured bot client", async () => {
  const tool = setup()(); const result = await tool.execute("call", { limit: 7 });
  expect(tool.name).toBe("feishu_group_history");
  expect(mocks.list).toHaveBeenCalledWith({ params: { container_id_type: "chat", container_id: "oc_fixture", sort_type: "ByCreateTimeDesc", page_size: 7, card_msg_content_type: "user_card_content" } });
  expect(result.details).toMatchObject({ ok: true, chat_id: "oc_fixture", has_more: true, messages: [{ message_id: "fixture-message" }] });
  expect(result.content[0].text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  expect(mocks.client.mock.calls[0][0].accountId).toBe("default");
});
it("does not expose history to direct chats, other channels or worker sessions", () => {
  const factory = setup();
  for (const sessionKey of ["agent:main:feishu:direct:ou_fixture", "agent:main:subagent:fixture", "agent:main:telegram:group:fixture", ""]) expect(factory({ sessionKey })).toBeNull();
  expect(factory({ sessionKey: "agent:main:feishu:group:oc_fixture:topic:om_thread:sender:ou_sender" })).not.toBeNull();
});
it("respects account chat tools and group read policy before any network call", async () => {
  expect(setup({ channels: { feishu: { ...config.channels.feishu, tools: { chat: false } } } })()).toBeNull();
  const denied = setup({ channels: { feishu: { ...config.channels.feishu, groupAllowFrom: [] } } })();
  expect((await denied.execute("call", {})).isError).toBe(true);expect(mocks.list).not.toHaveBeenCalled();
  const disabled = setup({ channels: { feishu: { ...config.channels.feishu, groupPolicy: "disabled" } } })();
  expect((await disabled.execute("call", {})).isError).toBe(true);expect(mocks.list).not.toHaveBeenCalled();
});
it("validates limits and rejects caller-selected groups or accounts", async () => {
  const tool = setup()();
  for (const params of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { chat_id: "oc_other" }, { accountId: "other" }]) expect((await tool.execute("call", params)).isError).toBe(true);
  expect(mocks.list).not.toHaveBeenCalled();
  await tool.execute("call", {});expect(mocks.list.mock.calls[0][0].params.page_size).toBe(50);
});
it("permission failures and transport failures remain errors, while empty history succeeds", async () => {
  const tool = setup()();mocks.list.mockResolvedValueOnce({ code: 99991672 });
  expect(await tool.execute("call", {})).toMatchObject({ isError: true, details: { ok: false, code: 99991672 } });
  mocks.list.mockRejectedValueOnce(Error("private transport details"));const failed = await tool.execute("call", {});
  expect(failed.isError).toBe(true);expect(JSON.stringify(failed)).not.toContain("private transport details");
  mocks.list.mockResolvedValueOnce({ code: 0, data: { items: [] } });expect((await tool.execute("call", {})).details).toMatchObject({ ok: true, messages: [], has_more: false });
});

it("does not fall back from a disabled current account to a different bot", async () => {
 const cfg = { channels: { feishu: { ...config.channels.feishu, defaultAccount: "other", accounts: {
  current: { enabled: false, appId: "current", appSecret: "fixture" },
  other: { enabled: true, appId: "other", appSecret: "fixture", groupAllowFrom: ["oc_fixture"] },
 } } } };
 const tool = setup(cfg)({ agentAccountId: "current", deliveryContext: { accountId: "current" } });
 expect((await tool.execute("call", {})).isError).toBe(true);expect(mocks.list).not.toHaveBeenCalled();
 const other = setup(cfg)({ agentAccountId: "other", deliveryContext: { accountId: "other" } });
 expect((await other.execute("call", {})).details.ok).toBe(true);expect(mocks.client.mock.calls[0][0].accountId).toBe("other");
});
