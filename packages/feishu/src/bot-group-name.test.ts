// Feishu tests cover bot group name plugin behavior.
import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";
import { feishuGroupNameCache } from "./bot-group-name-state.js";
import { resolveGroupName, resolveGroupInfo, invalidateGroupInfo } from "./bot-group-name.js";
import type { ResolvedFeishuAccount } from "./types.js";

const mockGetChatInfo = vi.hoisted(() => vi.fn());
const mockCreateFeishuClient = vi.hoisted(() => vi.fn());

vi.mock("./chat.js", () => ({ getChatInfo: mockGetChatInfo }));
vi.mock("./client.js", () => ({ createFeishuClient: mockCreateFeishuClient }));

function makeAccount(id = "test-account"): ResolvedFeishuAccount {
  return {
    accountId: id,
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret",
    domain: "feishu",
    config: {
      domain: "feishu",
      connectionMode: "websocket",
      webhookPath: "/feishu/events",
      dmPolicy: "pairing",
      reactionNotifications: "own",
      groupPolicy: "allowlist",
      typingIndicator: true,
      resolveSenderNames: true,
    },
  };
}

/**
 * Unit tests for resolveGroupName.
 *
 * Covers: successful lookup, API failure, empty name, positive cache,
 *         negative cache, undefined response, and cross-account isolation.
 */
describe("resolveGroupName", () => {
  const account = makeAccount();
  const log = vi.fn();

  afterAll(() => {
    vi.doUnmock("./chat.js");
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChatInfo.mockReset();
    mockCreateFeishuClient.mockReset();
    mockCreateFeishuClient.mockReturnValue({});
    feishuGroupNameCache.clear();
  });

  it("returns the trimmed group name on successful API call", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "  Engineering Team  " });
    const result = await resolveGroupName({ account, chatId: "oc_test1", log });
    expect(result).toBe("Engineering Team");
    expect(mockGetChatInfo).toHaveBeenCalledOnce();
  });

  it("returns undefined and logs on API failure", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("network timeout"));
    const result = await resolveGroupName({ account, chatId: "oc_test2", log });
    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "feishu[test-account]: getChatInfo failed for oc_test2: Error: network timeout",
    );
  });

  it("returns undefined for whitespace-only name", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "   " });
    const result = await resolveGroupName({ account, chatId: "oc_test3", log });
    expect(result).toBeUndefined();
  });

  it("serves subsequent calls from cache (positive hit)", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "Cached Group" });
    await resolveGroupName({ account, chatId: "oc_test4", log });
    const result = await resolveGroupName({ account, chatId: "oc_test4", log });
    expect(result).toBe("Cached Group");
    expect(mockGetChatInfo).toHaveBeenCalledOnce(); // only 1 API call
  });

  it("does not cache group names when the expiry would exceed a valid Date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    try {
      mockGetChatInfo.mockResolvedValue({ name: "Boundary Group" });

      const first = await resolveGroupName({ account, chatId: "oc_boundary", log });
      const second = await resolveGroupName({ account, chatId: "oc_boundary", log });

      expect(first).toBe("Boundary Group");
      expect(second).toBe("Boundary Group");
      expect(mockGetChatInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts cached group names when the current clock is invalid", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "Cached Group" });
    await resolveGroupName({ account, chatId: "oc_invalid_clock", log });
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      const result = await resolveGroupName({ account, chatId: "oc_invalid_clock", log });

      expect(result).toBe("Cached Group");
    } finally {
      dateNow.mockRestore();
    }
    expect(mockGetChatInfo).toHaveBeenCalledTimes(2);
  });

  it("caches negative result (API failure) and skips retry", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("fail"));
    await resolveGroupName({ account, chatId: "oc_test5", log });
    mockGetChatInfo.mockResolvedValue({ name: "Recovered" });
    const result = await resolveGroupName({ account, chatId: "oc_test5", log });
    expect(result).toBeUndefined(); // still cached negative
    expect(mockGetChatInfo).toHaveBeenCalledOnce();
  });

  it("returns undefined when API returns object with missing name field", async () => {
    mockGetChatInfo.mockResolvedValue({ name: undefined });
    const result = await resolveGroupName({ account, chatId: "oc_test6", log });
    expect(result).toBeUndefined();
  });

  it("isolates cache entries across different accounts", async () => {
    const accountA = makeAccount("account-A");
    const accountB = makeAccount("account-B");
    mockGetChatInfo
      .mockResolvedValueOnce({ name: "Team Alpha" })
      .mockResolvedValueOnce({ name: "Team Beta" });

    const nameA = await resolveGroupName({ account: accountA, chatId: "oc_shared", log });
    const nameB = await resolveGroupName({ account: accountB, chatId: "oc_shared", log });

    expect(nameA).toBe("Team Alpha");
    expect(nameB).toBe("Team Beta");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(2); // separate API calls
  });
  it("shares name and description lookup and refreshes changed or cleared descriptions after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T01:00:00Z"));
    try {
      mockGetChatInfo.mockResolvedValue({ name: "Support", description: "生产客服\n默认查询环境：生产" });
      const first = await resolveGroupInfo({ account, chatId: "oc_info", log });
      expect(first).toEqual({ status: "available", name: "Support", description: "生产客服\n默认查询环境：生产", fetchedAt: Date.now() });
      expect(await resolveGroupName({ account, chatId: "oc_info", log })).toBe("Support");
      mockGetChatInfo.mockResolvedValue({ name: "Renamed", description: "" });
      vi.advanceTimersByTime(5 * 60 * 1000 - 1);
      expect(await resolveGroupInfo({ account, chatId: "oc_info", log })).toEqual(first);
      vi.advanceTimersByTime(1);
      expect(await resolveGroupInfo({ account, chatId: "oc_info", log })).toEqual({ status: "available", name: "Renamed", description: "", fetchedAt: Date.now() });
      expect(mockGetChatInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes unavailable metadata from empty description and retries after expiry", async () => {
    vi.useFakeTimers();
    try {
      mockGetChatInfo.mockRejectedValue(new Error("permission denied"));
      expect(await resolveGroupInfo({ account, chatId: "oc_error", log })).toEqual({ status: "unavailable", fetchedAt: Date.now() });
      mockGetChatInfo.mockResolvedValue({ description: "Description without name" });
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(await resolveGroupInfo({ account, chatId: "oc_error", log })).toMatchObject({ status: "available", description: "Description without name" });
      expect(mockGetChatInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates descriptions between chats and accounts", async () => {
    mockGetChatInfo
      .mockResolvedValueOnce({ name: "A", description: "A defaults" })
      .mockResolvedValueOnce({ name: "B", description: "B defaults" })
      .mockResolvedValueOnce({ name: "C", description: "C defaults" });
    expect((await resolveGroupInfo({ account, chatId: "oc_a", log })).description).toBe("A defaults");
    expect((await resolveGroupInfo({ account, chatId: "oc_b", log })).description).toBe("B defaults");
    expect((await resolveGroupInfo({ account: makeAccount("other"), chatId: "oc_a", log })).description).toBe("C defaults");
    expect((await resolveGroupInfo({ account, chatId: "oc_a", log })).description).toBe("A defaults");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(3);
  });

  it("does not query an unconfigured account", async () => {
    expect(await resolveGroupInfo({ account: { ...account, configured: false }, chatId: "oc_none", log })).toMatchObject({ status: "unavailable" });
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("does not restore stale group information after an update invalidates an in-flight read", async () => {
    let release!: (value: unknown) => void;
    mockGetChatInfo.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = resolveGroupInfo({ account, chatId: "oc_updating", log });
    invalidateGroupInfo(account.accountId, "oc_updating");
    release({ name: "old" });
    expect(await pending).toMatchObject({ status: "unavailable" });
    mockGetChatInfo.mockResolvedValue({ name: "new", description: "updated defaults" });
    expect((await resolveGroupInfo({ account, chatId: "oc_updating", log })).name).toBe("new");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(2);
  });

});
