import type * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuMessageInfo, ResolvedFeishuAccount } from "./types.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import { createFeishuClient } from "./client.js";
import { isFeishuGroupReadAllowed } from "./read-policy.js";
import { getMessageFeishu } from "./send.js";
import { resolveToolsConfig } from "./tools-config.js";

type ReadStatus = "available" | "partial" | "unavailable" | "disabled";
export type GroupAnnouncement = {
  status: ReadStatus;
  type?: "doc" | "docx";
  revision?: string;
  text?: string;
  truncated?: boolean;
  representation?: "text_only";
};
export type GroupPins = {
  status: ReadStatus;
  hasMore?: boolean;
  items: { messageId: string; status: ReadStatus; message?: FeishuMessageInfo; truncated?: boolean }[];
};
export type GroupResources = { fetchedAt: number; announcement: GroupAnnouncement; pins: GroupPins };
const TTL_MS = 5 * 60 * 1000;
const MAX_PINS = 20;
const cache = new Map<string, { expiresAt: number; value: Promise<GroupResources> }>();

export function invalidateGroupResources(accountId: string, chatId: string): void {
  cache.delete(JSON.stringify([accountId, chatId]));
}

// Project only actual text and link targets; never download media or follow links.
function announcementText(value: unknown): string {
  if (Array.isArray(value)) return value.map(announcementText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  if (typeof row.text === "string") return row.text;
  if (typeof row.content === "string") return row.content;
  if (typeof row.url === "string") return [row.title, row.url].filter(v => typeof v === "string").join(" ");
  if (Array.isArray(row.elements)) return row.elements.map(announcementText).join("");
  return Object.entries(row).filter(([key]) => !["style", "text_element_style"].includes(key))
    .map(([, item]) => announcementText(item)).filter(Boolean).join("\n");
}

async function readAnnouncement(client: Lark.Client, chatId: string): Promise<GroupAnnouncement> {
  try {
    const meta = await client.docx.chatAnnouncement.get({ path: { chat_id: chatId }, params: { user_id_type: "open_id" } });
    if (meta.code !== 0 || !meta.data?.announcement_type) throw Error("Announcement metadata unavailable");
    const type = meta.data.announcement_type;
    if (type === "doc") {
      const response = await client.im.chatAnnouncement.get({ path: { chat_id: chatId }, params: { user_id_type: "open_id" } });
      if (response.code !== 0 || typeof response.data?.content !== "string") throw Error("Announcement content unavailable");
      const text = announcementText(JSON.parse(response.data.content));
      return { status: text.length > 12000 ? "partial" : "available", type, revision: response.data.revision, text: text.slice(0, 12000), truncated: text.length > 12000, representation: "text_only" };
    }
    const parts: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < 3; page++) {
      const response = await client.docx.chatAnnouncementBlock.list({
        path: { chat_id: chatId }, params: { page_size: 100, page_token: token, revision_id: meta.data.revision_id, user_id_type: "open_id" },
      });
      if (response.code !== 0 || !response.data) throw Error("Announcement blocks unavailable");
      parts.push(announcementText(response.data.items ?? []));
      const text = parts.filter(Boolean).join("\n");
      const hasMore = response.data.has_more === true;
      if (!hasMore || text.length > 12000 || page === 2) {
        const truncated = hasMore || text.length > 12000;
        return { status: truncated ? "partial" : "available", type, revision: String(meta.data.revision_id ?? ""), text: text.slice(0, 12000), truncated, representation: "text_only" };
      }
      const next = response.data.page_token;
      if (!next || next === token) throw Error("Announcement pagination did not advance");
      token = next;
    }
  } catch {
    return { status: "unavailable" };
  }
  return { status: "unavailable" };
}

async function readPins(client: Lark.Client, cfg: ClawdbotConfig, accountId: string, chatId: string): Promise<GroupPins> {
  try {
    const response = await client.im.pin.list({ params: { chat_id: chatId, page_size: MAX_PINS } });
    if (response.code !== 0 || !response.data) throw Error("Pin list unavailable");
    const pins = [...new Map((response.data.items ?? []).map(pin => [pin.message_id, pin])).values()];
    const items = await Promise.all(pins.slice(0, MAX_PINS).map(async pin => {
      const messageId = pin.message_id;
      const message = await getMessageFeishu({ cfg, accountId, messageId });
      if (!message || message.chatId !== chatId || message.messageId !== messageId) {
        return { messageId, status: "unavailable" as const };
      }
      const truncated = message.content.length > 2000;
      return { messageId, status: truncated ? "partial" as const : "available" as const,
        message: { ...message, content: message.content.slice(0, 2000) }, truncated };
    }));
    const hasMore = response.data.has_more === true || pins.length > MAX_PINS;
    return { status: hasMore || items.some(item => item.status !== "available") ? "partial" : "available", hasMore, items };
  } catch {
    return { status: "unavailable", items: [] };
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
  if (existing && existing.expiresAt > Date.now()) return existing.value;
  const value = (async (): Promise<GroupResources> => {
    const client = createFeishuClient(account);
    const bounded = async <T>(promise: Promise<T>, fallback: T): Promise<T> => {
      const result = await raceWithTimeoutAndAbort(promise, { timeoutMs: 6000 });
      return result.status === "resolved" ? result.value : fallback;
    };
    const [announcement, pins] = await Promise.all([
      bounded(readAnnouncement(client, chatId), { status: "unavailable" } as GroupAnnouncement),
      bounded(readPins(client, cfg, account.accountId, chatId), { status: "unavailable", items: [] } as GroupPins),
    ]);
    return { fetchedAt: Date.now(), announcement, pins };
  })().catch((): GroupResources => ({ fetchedAt: Date.now(), announcement: { status: "unavailable" }, pins: { status: "unavailable", items: [] } }));
  // Invalidation deletes the entry even during a read; its completion cannot restore stale state.
  cache.delete(key);
  cache.set(key, { expiresAt: Date.now() + TTL_MS, value });
  while (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}
