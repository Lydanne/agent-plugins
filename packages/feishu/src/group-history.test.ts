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
beforeEach(() => { vi.clearAllMocks(); mocks.client.mockReturnValue({ im: { message: { list: mocks.list } } }); mocks.list.mockResolvedValue({ code: 0, data: { items: [{ message_id: "fixture-message", body: { content: "reference only" } }], has_more: true, page_token: "next-page" } }); });
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

it("reads more than 50 messages across a fixed daily window and forwards only scoped continuation", async () => {
  const tool = setup()(), bounds = { start_time: 1792512000, end_time: 1792598400 };
  const messages = Array.from({length: 61}, (_, i) => ({message_id: `m${i}`, create_time: String((bounds.start_time + i) * 1000)}));
  mocks.list.mockResolvedValueOnce({code: 0, data: {items: messages.slice(0,50), has_more: true, page_token: 'upstream-page-2'}});
  const first = (await tool.execute('first', bounds)).details;
  expect(first.messages).toHaveLength(50);expect(first.window_complete).toBe(false);
  expect(first.next_page_token).not.toBe('upstream-page-2');
  mocks.list.mockResolvedValueOnce({code: 0, data: {items: messages.slice(50), has_more: false}});
  const last = (await setup()().execute('second', {...bounds, page_token: first.next_page_token})).details;
  expect(mocks.list.mock.calls[1][0].params).toMatchObject({start_time: String(bounds.start_time),end_time: String(bounds.end_time),page_token:'upstream-page-2'});
  expect([...first.messages,...last.messages]).toHaveLength(61);expect(last.window_complete).toBe(true);expect(last.next_page_token).toBeUndefined();
});
it("rejects cursor tampering and changes of group, account, session, page size or window before network access", async () => {
  const tool=setup()(), bounds={start_time:100,end_time:200};
  mocks.list.mockResolvedValueOnce({code:0,data:{items:[],has_more:true,page_token:'next'}});
  const token=(await tool.execute('first',bounds)).details.next_page_token;
  mocks.list.mockClear();
  for(const params of [{...bounds,page_token:token+'x'},{...bounds,page_token:token,limit:5},{start_time:101,end_time:200,page_token:token},{page_token:token}])expect((await tool.execute('bad',params)).isError).toBe(true);
  const cfg={channels:{feishu:{...config.channels.feishu,groupAllowFrom:['oc_fixture','oc_other']}}};
  for(const context of [{sessionKey:'agent:main:feishu:group:oc_other'},{sessionKey:'agent:main:feishu:group:oc_fixture:topic:om_other'},{agentId:'other'}])expect((await setup(cfg)(context).execute('bad',{...bounds,page_token:token})).isError).toBe(true);
  const multi={channels:{feishu:{...config.channels.feishu,accounts:{other:{appId:'other',appSecret:'other-secret'}}}}};
  expect((await setup(multi)({agentAccountId:'other',deliveryContext:{accountId:'other'}}).execute('bad',{...bounds,page_token:token})).isError).toBe(true);
  expect(mocks.list).not.toHaveBeenCalled();
});
it("validates paired second timestamps, handles exclusive midnight, and never treats broken pagination as complete", async () => {
  const tool=setup()();
  for(const p of [{start_time:100},{end_time:200},{start_time:200,end_time:100},{start_time:-1,end_time:1},{start_time:1.5,end_time:10},{page_token:''}])expect((await tool.execute('bad',p)).isError).toBe(true);
  expect(mocks.list).not.toHaveBeenCalled();
  mocks.list.mockResolvedValueOnce({code:0,data:{items:[{message_id:'before',create_time:'99999'},{message_id:'inside',create_time:'100000'},{message_id:'end',create_time:'200000'}],has_more:false}});
  expect((await tool.execute('bounds',{start_time:100,end_time:200})).details.messages.map((x: {message_id: string})=>x.message_id)).toEqual(['inside']);
  mocks.list.mockResolvedValueOnce({code:0,data:{items:[],has_more:true}});expect((await tool.execute('missing',{})).isError).toBe(true);
  mocks.list.mockResolvedValueOnce({code:0,data:{items:[],has_more:true,page_token:'same'}});const first=(await tool.execute('empty',{start_time:100,end_time:200})).details;expect(first.has_more).toBe(true);expect(first.window_complete).toBe(false);
  mocks.list.mockResolvedValueOnce({code:0,data:{items:[],has_more:true,page_token:'same'}});expect((await tool.execute('stuck',{start_time:100,end_time:200,page_token:first.next_page_token})).isError).toBe(true);
});
