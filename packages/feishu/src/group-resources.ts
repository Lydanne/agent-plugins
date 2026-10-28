import type * as Lark from "@larksuiteoapi/node-sdk";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuMessageInfo, ResolvedFeishuAccount } from "./types.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import { createFeishuClient } from "./client.js";
import { isFeishuGroupReadAllowed } from "./read-policy.js";
import { getMessageFeishu } from "./send.js";
import { resolveToolsConfig } from "./tools-config.js";

type ReadStatus = "available" | "partial" | "unavailable" | "disabled";
type ReadError = {
  reason: "permission_denied" | "not_in_chat" | "timeout" | "network_error" | "api_error" |
    "invalid_response" | "pagination_error" | "message_unavailable" | "scope_mismatch" | "invalidated";
  retryable: boolean;
  code?: number;
  requiredScope?: "im:chat.announcement:read";
};
export type GroupAnnouncement = {
  status: ReadStatus;
  type?: "doc" | "docx";
  revision?: string;
  text?: string;
  truncated?: boolean;
  representation?: "text_only";
  error?: ReadError;
};
export type GroupPins = {
  status: ReadStatus;
  hasMore?: boolean;
  error?: ReadError;
  items: { messageId: string; status: ReadStatus; message?: FeishuMessageInfo; truncated?: boolean; error?: ReadError }[];
};
export type GroupResources = { fetchedAt: number; announcement: GroupAnnouncement; pins: GroupPins };
const TTL_MS = 5 * 60 * 1000;
const READ_TIMEOUT_MS = 6000;
const MAX_PINS = 20;
type CacheEntry = { expiresAt: number; value: Promise<GroupResources>; valid: boolean };
const cache = new Map<string, CacheEntry>();
const snapshots = new WeakMap<GroupResources, CacheEntry>();

function isGroupResourcesCurrent(resources: GroupResources): boolean {
  if (resources.announcement.status === "disabled" && resources.pins.status === "disabled") return true;
  return snapshots.get(resources)?.valid === true;
}
function invalidatedResources(fetchedAt: number): GroupResources {
  const error: ReadError = { reason: "invalidated", retryable: true };
  return { fetchedAt, announcement: { status: "unavailable", error }, pins: { status: "unavailable", items: [], error } };
}
export function currentGroupResources(resources: GroupResources): GroupResources {
  return isGroupResourcesCurrent(resources) ? resources : invalidatedResources(resources.fetchedAt);
}
async function readCurrentEntry(entry: CacheEntry): Promise<GroupResources> {
  const resources = await entry.value;
  if (!entry.valid) return invalidatedResources(resources.fetchedAt);
  snapshots.set(resources, entry);
  return resources;
}

export function invalidateGroupResources(accountId: string, chatId: string): void {
  const key = JSON.stringify([accountId, chatId]);
  const entry = cache.get(key);
  if (entry) entry.valid = false;
  cache.delete(key);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
class GroupReadFailure extends Error {
  constructor(readonly detail: ReadError) {
    super("Group context read failed");
  }
}
// Only project known scalar diagnostics. SDK request objects, messages and headers
// may contain secrets and must never enter the model context or cached failures.
function readError(error: unknown, requiredScope?: ReadError["requiredScope"]): ReadError {
  if (error instanceof GroupReadFailure) return error.detail;
  const row = record(error), response = record(row?.response), data = record(response?.data);
  const rawCode = data?.code ?? row?.code;
  const code = typeof rawCode === "number" && Number.isSafeInteger(rawCode) ? rawCode : undefined;
  const status = typeof response?.status === "number" ? response.status : undefined;
  if (code === 99991672 || status === 403) {
    return { reason: "permission_denied", retryable: false, code, ...(code === 99991672 && requiredScope ? { requiredScope } : {}) };
  }
  if (code === 230002) return { reason: "not_in_chat", retryable: false, code };
  if (typeof rawCode === "string" && ["ETIMEDOUT", "ECONNABORTED"].includes(rawCode)) return { reason: "timeout", retryable: true };
  if (code !== undefined || status !== undefined) {
    return { reason: "api_error", retryable: status === 429 || (status !== undefined && status >= 500), code };
  }
  return { reason: "network_error", retryable: true };
}
function assertResponse(response: { code?: number }, requiredScope?: ReadError["requiredScope"]): void {
  if (!Number.isSafeInteger(response.code)) invalidResponse();
  if (response.code !== 0) throw new GroupReadFailure(readError({ code: response.code }, requiredScope));
}
function invalidResponse(): never {
  throw new GroupReadFailure({ reason: "invalid_response", retryable: false });
}
async function beforeDeadline<T>(read: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new GroupReadFailure({ reason: "timeout", retryable: true });
  const result = await raceWithTimeoutAndAbort(read(), { timeoutMs: remaining });
  if (result.status !== "resolved") throw new GroupReadFailure({ reason: "timeout", retryable: true });
  return result.value;
}

// Project actual text and link targets; never download media or follow links.
function announcementText(value: unknown): string {
  if (Array.isArray(value)) return value.map(announcementText).filter(Boolean).join("\n");
  const row = record(value);
  if (!row) return "";
  const text = typeof row.text === "string" ? row.text : typeof row.content === "string" ? row.content : undefined;
  if (text !== undefined) {
    const style = record(row.text_element_style) ?? record(row.style);
    const link = style?.link;
    const url = typeof link === "string" ? link : record(link)?.url;
    return typeof url === "string" && url && url !== text ? `${text} (${url})` : text;
  }
  if (typeof row.url === "string") return [row.title, row.url].filter(v => typeof v === "string").join(" ");
  if (Array.isArray(row.elements)) return row.elements.map(announcementText).join("");
  return Object.entries(row).filter(([key]) => !["style", "text_element_style"].includes(key))
    .map(([, item]) => announcementText(item)).filter(Boolean).join("\n");
}

async function readAnnouncement(client: Lark.Client, chatId: string, deadline: number): Promise<GroupAnnouncement> {
  const scope = "im:chat.announcement:read";
  const parts: string[] = [];
  let type: "doc" | "docx" | undefined;
  let revision: string | undefined;
  let pagesRead = 0;
  const snapshot = (partial: boolean, truncated = false, error?: ReadError): GroupAnnouncement => {
    const text = parts.filter(Boolean).join("\n");
    return { status: partial || text.length > 12000 ? "partial" : "available", type, revision,
      text: truncateUtf16Safe(text, 12000), truncated: truncated || text.length > 12000, representation: "text_only", ...(error ? { error } : {}) };
  };
  try {
    const meta = await beforeDeadline(() => client.docx.chatAnnouncement.get({ path: { chat_id: chatId }, params: { user_id_type: "open_id" } }), deadline);
    assertResponse(meta, scope);
    if (meta.data?.announcement_type !== "doc" && meta.data?.announcement_type !== "docx") invalidResponse();
    type = meta.data.announcement_type;
    if (type === "doc") {
      const response = await beforeDeadline(() => client.im.chatAnnouncement.get({ path: { chat_id: chatId }, params: { user_id_type: "open_id" } }), deadline);
      assertResponse(response, scope);
      if (typeof response.data?.content !== "string") invalidResponse();
      let body: unknown;
      try { body = JSON.parse(response.data.content); } catch { invalidResponse(); }
      if (!record(body)) invalidResponse();
      parts.push(announcementText(body));
      revision = response.data.revision;
      return snapshot(false);
    }
    revision = meta.data.revision_id === undefined ? undefined : String(meta.data.revision_id);
    let token: string | undefined;
    const seenTokens = new Set<string>();
    for (let page = 0; page < 3; page++) {
      const response = await beforeDeadline(() => client.docx.chatAnnouncementBlock.list({
        path: { chat_id: chatId }, params: { page_size: 100, page_token: token, revision_id: meta.data?.revision_id, user_id_type: "open_id" },
      }), deadline);
      assertResponse(response, scope);
      if (!Array.isArray(response.data?.items)) invalidResponse();
      parts.push(announcementText(response.data.items));
      pagesRead++;
      const hasMore = response.data.has_more === true;
      if (!hasMore || parts.join("\n").length > 12000 || page === 2) return snapshot(hasMore, hasMore);
      const next = response.data.page_token;
      if (!next || seenTokens.has(next)) throw new GroupReadFailure({ reason: "pagination_error", retryable: true });
      seenTokens.add(next);
      token = next;
    }
  } catch (error) {
    const detail = readError(error, scope);
    // Preserve pages already fetched; a later page failure is a coverage gap.
    if (pagesRead) return snapshot(true, false, detail);
    return { status: "unavailable", error: detail };
  }
  return { status: "unavailable", error: { reason: "invalid_response", retryable: false } };
}

async function readPins(client: Lark.Client, cfg: ClawdbotConfig, accountId: string, chatId: string, deadline: number): Promise<GroupPins> {
  try {
    const response = await beforeDeadline(() => client.im.pin.list({ params: { chat_id: chatId, page_size: MAX_PINS } }), deadline);
    assertResponse(response);
    if (!Array.isArray(response.data?.items)) invalidResponse();
    if (response.data.items.some(pin => typeof pin.message_id !== "string" || !pin.message_id)) invalidResponse();
    const pins = [...new Map(response.data.items.map(pin => [pin.message_id, pin])).values()];
    const items = await Promise.all(pins.slice(0, MAX_PINS).map(async pin => {
      const messageId = pin.message_id;
      try {
        if (!messageId || typeof messageId !== "string") invalidResponse();
        const message = await beforeDeadline(() => getMessageFeishu({ cfg, accountId, messageId }), deadline);
        if (!message) throw new GroupReadFailure({ reason: "message_unavailable", retryable: true });
        if (message.chatId !== chatId || message.messageId !== messageId) {
          throw new GroupReadFailure({ reason: "scope_mismatch", retryable: false });
        }
        const truncated = message.content.length > 2000;
        return { messageId, status: truncated ? "partial" as const : "available" as const,
          message: { ...message, content: truncateUtf16Safe(message.content, 2000) }, truncated };
      } catch (error) {
        return { messageId, status: "unavailable" as const, error: readError(error) };
      }
    }));
    const hasMore = response.data.has_more === true || pins.length > MAX_PINS;
    return { status: hasMore || items.some(item => item.status !== "available") ? "partial" : "available", hasMore, items };
  } catch (error) {
    return { status: "unavailable", items: [], error: readError(error) };
  }
}

/** Read only the admitted current group, using its bot account and chat-read policy. */
export async function resolveGroupResources(params: {
  cfg: ClawdbotConfig; account: ResolvedFeishuAccount; chatId: string;
}): Promise<GroupResources> {
  const { cfg, account, chatId } = params;
  if (!account.configured || !resolveToolsConfig(account.config.tools).chat || !isFeishuGroupReadAllowed(cfg, account, chatId, true)) {
    return { fetchedAt: Date.now(), announcement: { status: "disabled" }, pins: { status: "disabled", items: [] } };
  }
  const key = JSON.stringify([account.accountId, chatId]);
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return readCurrentEntry(existing);
  if (existing) existing.valid = false;
  const value = (async (): Promise<GroupResources> => {
    const client = createFeishuClient(account);
    const deadline = Date.now() + READ_TIMEOUT_MS;
    const [announcement, pins] = await Promise.all([
      readAnnouncement(client, chatId, deadline), readPins(client, cfg, account.accountId, chatId, deadline),
    ]);
    return { fetchedAt: Date.now(), announcement, pins };
  })().catch((error): GroupResources => {
    const detail = readError(error);
    return { fetchedAt: Date.now(), announcement: { status: "unavailable", error: detail }, pins: { status: "unavailable", items: [], error: detail } };
  });
  // Invalidation deletes the entry even during a read; its completion cannot restore stale state.
  cache.delete(key);
  const entry = { expiresAt: Date.now() + TTL_MS, value, valid: true };
  cache.set(key, entry);
  while (cache.size > 500) {
    const oldest = cache.keys().next().value!;
    cache.get(oldest)!.valid = false;
    cache.delete(oldest);
  }
  return readCurrentEntry(entry);
}
