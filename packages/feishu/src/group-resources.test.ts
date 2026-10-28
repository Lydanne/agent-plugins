import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResolvedFeishuAccount } from "./types.js";
import { resolveGroupResources, invalidateGroupResources } from "./group-resources.js";
import { groupContextEventHandlers } from "./group-context-events.js";
import { feishuGroupNameCache } from "./bot-group-name-state.js";
const mocks = vi.hoisted(() => ({ client: vi.fn(), message: vi.fn() }));
vi.mock("./client.js", () => ({ createFeishuClient: mocks.client }));
vi.mock("./send.js", () => ({ getMessageFeishu: mocks.message }));
const account = { accountId: "resources", configured: true, config: { groupPolicy: "open" } } as ResolvedFeishuAccount;
let sequence = 0;
let chatId: string;
let client: ReturnType<typeof makeClient>;
const params = () => ({ cfg: {}, account, chatId });
function makeClient() {
  return {
    docx: {
      chatAnnouncement: { get: vi.fn().mockResolvedValue({ code: 0, data: { announcement_type: "docx", revision_id: 2 } }) },
      chatAnnouncementBlock: { list: vi.fn().mockResolvedValue({ code: 0, data: { items: [
        { block_type: 2, text: { elements: [{ text_run: { content: "客服默认约定" } }, { text_run: { content: "：测试环境" } }] } },
      ], has_more: false } }) },
    },
    im: {
      chatAnnouncement: { get: vi.fn().mockResolvedValue({ code: 0, data: { content: JSON.stringify({ body: { blocks: [{ paragraph: { elements: [{ textRun: { text: "旧版约定" } }] } }] } }), revision: "1" } }) },
      pin: { list: vi.fn().mockResolvedValue({ code: 0, data: { items: [{ message_id: "pin-1" }], has_more: false } }) },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  chatId = `oc_resources_${++sequence}`;
  client = makeClient();
  mocks.client.mockReturnValue(client);
  mocks.message.mockImplementation(async ({ messageId }: { messageId: string }) => ({ messageId, chatId, senderId: "ou_sender", contentType: "text", content: "Pin 中的群用途" }));
});
afterEach(() => vi.useRealTimers());

it("reads new announcement blocks and Pin message bodies and shares cached lookups", async () => {
  const result = await resolveGroupResources(params());
  expect(result.announcement).toMatchObject({ status: "available", type: "docx", revision: "2", text: "客服默认约定：测试环境", representation: "text_only" });
  expect(result.pins).toMatchObject({ status: "available", items: [{ messageId: "pin-1", message: { content: "Pin 中的群用途" } }] });
  expect(await resolveGroupResources(params())).toBe(result);
  expect(client.im.pin.list).toHaveBeenCalledOnce();
  expect(client.docx.chatAnnouncementBlock.list).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ revision_id: 2 }) }));
});
it("selects the legacy announcement API for doc announcements", async () => {
  client.docx.chatAnnouncement.get.mockResolvedValue({ code: 0, data: { announcement_type: "doc", revision_id: 1 } });
  expect((await resolveGroupResources(params())).announcement).toMatchObject({ status: "available", type: "doc", text: "旧版约定", revision: "1" });
  expect(client.docx.chatAnnouncementBlock.list).not.toHaveBeenCalled();
});
it("collects all announcement pages at the same revision", async () => {
  client.docx.chatAnnouncementBlock.list
    .mockResolvedValueOnce({ code: 0, data: { items: [{ text: { elements: [{ text_run: { content: "first" } }] } }], has_more: true, page_token: "page-2" } })
    .mockResolvedValueOnce({ code: 0, data: { items: [{ text: { elements: [{ text_run: { content: "second" } }] } }], has_more: false } });
  expect((await resolveGroupResources(params())).announcement.text).toBe("first\nsecond");
  expect(client.docx.chatAnnouncementBlock.list.mock.calls[1][0].params).toMatchObject({ page_token: "page-2", revision_id: 2 });
});
it("marks capped Pin lists, truncated text and unavailable message bodies as partial", async () => {
  client.im.pin.list.mockResolvedValue({ code: 0, data: { items: [{ message_id: "pin-1" }, { message_id: "other-chat" }], has_more: true } });
  mocks.message.mockImplementation(async ({ messageId }: { messageId: string }) => ({ messageId, chatId: messageId === "other-chat" ? "foreign" : chatId, content: "x".repeat(3000) }));
  const { pins } = await resolveGroupResources(params());
  expect(pins).toMatchObject({ status: "partial", hasMore: true, items: [{ status: "partial", truncated: true }, { status: "unavailable" }] });
  expect(pins.items[0].message?.content).toHaveLength(2000);
  expect(pins.items[1]).not.toHaveProperty("message");
});
it("does not call errors empty results and allows one resource to succeed independently", async () => {
  client.docx.chatAnnouncement.get.mockRejectedValue(new Error("permission denied"));
  const result = await resolveGroupResources(params());
  expect(result.announcement).toEqual({ status: "unavailable" });
  expect(result.pins.status).toBe("available");
  invalidateGroupResources(account.accountId, chatId);
  client.im.pin.list.mockResolvedValue({ code: 999, data: { items: [], has_more: false } });
  expect((await resolveGroupResources(params())).pins).toEqual({ status: "unavailable", items: [] });
});
it("distinguishes a readable empty announcement and Pin list", async () => {
  client.docx.chatAnnouncementBlock.list.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
  client.im.pin.list.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
  const result = await resolveGroupResources(params());
  expect(result.announcement).toMatchObject({ status: "available", text: "" });
  expect(result.pins).toEqual({ status: "available", hasMore: false, items: [] });
});
it("refreshes changed and removed content after five minutes", async () => {
  vi.useFakeTimers();
  const first = await resolveGroupResources(params());
  client.im.pin.list.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
  vi.advanceTimersByTime(299999);
  expect(await resolveGroupResources(params())).toBe(first);
  vi.advanceTimersByTime(1);
  expect((await resolveGroupResources(params())).pins.items).toEqual([]);
  expect(client.im.pin.list).toHaveBeenCalledTimes(2);
});
it("isolates cache by account and group and rechecks disabled reads before cache reuse", async () => {
  await resolveGroupResources(params());
  await resolveGroupResources({ ...params(), chatId: chatId + "_other" });
  await resolveGroupResources({ ...params(), account: { ...account, accountId: "other-account" } });
  expect(client.im.pin.list).toHaveBeenCalledTimes(3);
  expect((await resolveGroupResources({ ...params(), account: { ...account, config: { ...account.config, tools: { chat: false } } } })).pins.status).toBe("disabled");
  expect(client.im.pin.list).toHaveBeenCalledTimes(3);
});
it("invalidates group metadata and resources on the real group updated event without starting reads", async () => {
  await resolveGroupResources(params());
  feishuGroupNameCache.set(`${account.accountId}:${chatId}`, { status: "available", name: "old", fetchedAt: Date.now(), expiresAt: Date.now() + 300000 });
  await groupContextEventHandlers(account.accountId)["im.chat.updated_v1"]({ chat_id: chatId });
  expect(feishuGroupNameCache.has(`${account.accountId}:${chatId}`)).toBe(false);
  expect(client.im.pin.list).toHaveBeenCalledOnce();
  await resolveGroupResources(params());
  expect(client.im.pin.list).toHaveBeenCalledTimes(2);
});
it("does not restore an invalidated in-flight cache entry", async () => {
  let release!: (value: unknown) => void;
  client.im.pin.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }) as never);
  const pending = resolveGroupResources(params());
  invalidateGroupResources(account.accountId, chatId);
  release({ code: 0, data: { items: [], has_more: false } });
  await pending;
  await resolveGroupResources(params());
  expect(client.im.pin.list).toHaveBeenCalledTimes(2);
});
it("bounds unresponsive reads without claiming they succeeded", async () => {
  vi.useFakeTimers();
  client.im.pin.list.mockImplementation(() => new Promise(() => {}) as never);
  const pending = resolveGroupResources(params());
  await vi.advanceTimersByTimeAsync(6000);
  expect((await pending).pins.status).toBe("unavailable");
});
it("marks announcement page caps and malformed legacy content as incomplete", async () => {
  client.docx.chatAnnouncementBlock.list.mockImplementation(async (input) => ({ code: 0, data: {
    items: [], has_more: true, page_token: `${input?.params?.page_token ?? ""}next`,
  } }));
  expect((await resolveGroupResources(params())).announcement.status).toBe("partial");
  expect(client.docx.chatAnnouncementBlock.list).toHaveBeenCalledTimes(3);
  invalidateGroupResources(account.accountId, chatId);
  client.docx.chatAnnouncement.get.mockResolvedValue({ code: 0, data: { announcement_type: "doc", revision_id: 1 } });
  client.im.chatAnnouncement.get.mockResolvedValue({ code: 0, data: { content: "bad json", revision: "1" } });
  expect((await resolveGroupResources(params())).announcement.status).toBe("unavailable");
});
