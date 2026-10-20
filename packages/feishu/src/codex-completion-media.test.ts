import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

const mocks = vi.hoisted(() => ({
  edit: vi.fn(), send: vi.fn(), image: vi.fn(), upload: vi.fn(), load: vi.fn(),
  ambient: vi.fn(), images: [] as string[], order: [] as string[],
}));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: mocks.ambient }));
vi.mock("./client.js", () => ({
  createFeishuClient: () => ({ im: { image: { create: mocks.upload } } }),
}));
vi.mock("./send.js", () => ({
  editMessageFeishu: mocks.edit, sendMessageFeishu: mocks.send,
  sendCardFeishu: mocks.send, sendReplyOrFallbackDirect: mocks.image,
}));
vi.mock("./source-task.js", () => ({
  isCompletionSourceCurrent: () => true,
  sourceTaskBridge: { recalls: new Set(), leases: new Map() },
}));
vi.mock("./bot-sender-name.js", () => ({ resolveFeishuSenderName: async () => ({}) }));
vi.mock("./document-background.js", () => ({
  stageBackgroundDocument: async () => undefined, activateBackgroundDocument: vi.fn(),
}));
vi.mock("./document-delivery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./document-delivery.js")>(),
  prepareFeishuDocumentDelivery: async () => ({ text: "已核验结果", mediaUrls: mocks.images }),
}));

// Keep the actual media function: mocking it concealed the cross-plugin runtime lookup.
import { sendMediaFeishu } from "./media.js";
import { deliverCodexCompletion, type CompletionEvent } from "./codex-completion.js";
import { bindAsyncTaskCard, readAsyncTaskCard } from "./async-task-card.js";
import { readPreparedCompletion, savePreparedCompletion } from "./completion-outbox.js";

const cfg = { channels: { feishu: { enabled: true, appId: "fixture-app", appSecret: "fixture-secret" } } };
const event: CompletionEvent = {
  type: "agent_worker.completed", eventId: "event", jobId: "job", topic: "test",
  status: "completed", reportContent: "已核验结果", reportPaths: [],
  provenance: {
    sessionId: "current", taskId: "task", revision: 0, accountId: "default",
    chatId: "oc_fixture", sessionKey: "agent:main:feishu:group:oc_fixture",
    senderId: "ou_fixture", sourceMessageIds: ["request"], requestMessageIds: ["request"],
    replyInThread: true,
  },
};
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de", "hex");
let state: string;
let runtime: OpenClawPluginApi["runtime"];
let run: ReturnType<typeof vi.fn>;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "feishu-completion-media-"));
  mocks.order = [];
  mocks.images = ["/fixture/done.png"];
  mocks.ambient.mockReset().mockImplementation(() => { throw Error("Feishu runtime not initialized"); });
  mocks.edit.mockReset().mockImplementation(async () => {
    mocks.order.push("card"); return { messageId: "result-card", mentionedUserIds: ["ou_fixture"] };
  });
  mocks.send.mockReset();
  mocks.load.mockReset().mockImplementation(async () => {
    mocks.order.push("load"); return { buffer: png, fileName: "done.png", contentType: "image/png" };
  });
  mocks.upload.mockReset().mockImplementation(async () => {
    mocks.order.push("upload"); return { code: 0, data: { image_key: "img_fixture" } };
  });
  mocks.image.mockReset().mockImplementation(async () => {
    mocks.order.push("image"); return { messageId: "image-message", chatId: "oc_fixture" };
  });
  run = vi.fn(async ({ adapter }) => adapter.resolveTurn().delivery.deliver(
    { text: "已核验结果", mediaUrls: mocks.images }, { kind: "final" },
  ));
  runtime = {
    config: { current: () => cfg }, state: { resolveStateDir: () => state },
    media: { loadWebMedia: mocks.load },
    agent: { session: { resolveStorePath: () => join(state, "sessions.json"), getSessionEntry: () => ({ sessionId: "current" }) } },
    channel: { reply: { finalizeInboundContext: (value: unknown) => value }, inbound: { run } },
  } as unknown as OpenClawPluginApi["runtime"];
  bindAsyncTaskCard(state, event.provenance, [event.jobId], { messageId: "result-card", imageKey: "working" });
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

it.each([false, true])("delivers native completion media with the owning runtime (prepared=%s)", async (prepared) => {
  if (prepared) savePreparedCompletion(state, event, "current", { text: "已核验结果", mediaUrls: mocks.images });
  const receipt = vi.fn(() => { mocks.order.push("receipt"); });
  await deliverCodexCompletion(event, { beforeSend: vi.fn(), onReceipt: receipt }, runtime);
  expect(mocks.ambient).not.toHaveBeenCalled();
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith("/fixture/done.png", expect.objectContaining({ optimizeImages: false }));
  expect(mocks.upload).toHaveBeenCalledExactlyOnceWith({ data: { image_type: "message", image: png } });
  expect(mocks.image).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
    content: JSON.stringify({ image_key: "img_fixture" }), msgType: "image",
    replyToMessageId: "result-card", replyInThread: true,
  }));
  expect(mocks.order).toEqual(["card", "load", "upload", "image", "receipt"]);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(readPreparedCompletion(state, event, "current")).toBeUndefined();
  expect(run).toHaveBeenCalledTimes(prepared ? 0 : 1);
});

it.each(["load", "upload", "image"] as const)("does not claim completion when media %s fails", async (stage) => {
  mocks[stage].mockRejectedValueOnce(Error(`fixture ${stage} failed`));
  const receipt = vi.fn();
  await expect(deliverCodexCompletion(event, { beforeSend: vi.fn(), onReceipt: receipt }, runtime))
    .rejects.toThrow(`fixture ${stage} failed`);
  expect(mocks.edit).toHaveBeenCalledOnce();
  expect(readAsyncTaskCard(state, event.jobId, event.provenance)?.result).toBe("已核验结果");
  expect(receipt).not.toHaveBeenCalled();
  expect(readPreparedCompletion(state, event, "current")?.mediaUrls).toEqual(mocks.images);
  expect(mocks.ambient).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  if (stage === "load") expect(mocks.upload).not.toHaveBeenCalled();
  if (stage !== "image") expect(mocks.image).not.toHaveBeenCalled();
});

it("preserves ordinary media calls that use their current Feishu runtime", async () => {
  mocks.ambient.mockReturnValue({ media: runtime.media });
  await sendMediaFeishu({ cfg, to: "chat:oc_fixture", mediaUrl: "/fixture/done.png" });
  expect(mocks.ambient).toHaveBeenCalledOnce();
  expect(mocks.order).toEqual(["load", "upload", "image"]);
});
