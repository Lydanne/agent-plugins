import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { feishuGroupNameCache, type FeishuGroupInfo } from "./bot-group-name-state.js";
import { getChatInfo } from "./chat.js";
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

const GROUP_NAME_CACHE_TTL_MS = 5 * 60 * 1000;
const GROUP_NAME_CACHE_MAX_SIZE = 500;
const pendingReads = new Map<string, symbol>();

export function invalidateGroupInfo(accountId: string, chatId: string): void {
  const key = `${accountId}:${chatId}`;
  feishuGroupNameCache.delete(key);
  pendingReads.delete(key);
}

function evictGroupNameCache(): void {
  const now = asDateTimestampMs(Date.now());
  if (now === undefined) {
    feishuGroupNameCache.clear();
    return;
  }
  for (const [key, value] of feishuGroupNameCache) {
    const expiresAt = asDateTimestampMs(value.expiresAt);
    if (expiresAt === undefined || expiresAt <= now) {
      feishuGroupNameCache.delete(key);
    }
  }

  const excess = feishuGroupNameCache.size - GROUP_NAME_CACHE_MAX_SIZE;
  if (excess <= 0) {
    return;
  }
  let removed = 0;
  for (const key of feishuGroupNameCache.keys()) {
    if (removed >= excess) {
      break;
    }
    feishuGroupNameCache.delete(key);
    removed++;
  }
}

function setCacheEntry(key: string, info: FeishuGroupInfo): void {
  const expiresAt = resolveExpiresAtMsFromDurationMs(GROUP_NAME_CACHE_TTL_MS);
  feishuGroupNameCache.delete(key);
  if (expiresAt !== undefined) {
    feishuGroupNameCache.set(key, { ...info, expiresAt });
  }
}

export async function resolveGroupInfo(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  log: (...args: unknown[]) => void;
}): Promise<FeishuGroupInfo> {
  const { account, chatId, log } = params;
  if (!account.configured) {
    return { status: "unavailable", fetchedAt: Date.now() };
  }

  const cacheKey = `${account.accountId}:${chatId}`;
  const cached = feishuGroupNameCache.get(cacheKey);
  if (cached) {
    const now = asDateTimestampMs(Date.now());
    const expiresAt = asDateTimestampMs(cached.expiresAt);
    if (now !== undefined && expiresAt !== undefined && expiresAt > now) {
      const { expiresAt: _, ...info } = cached;
      return info;
    }
    feishuGroupNameCache.delete(cacheKey);
  }

  const readVersion = Symbol();
  pendingReads.set(cacheKey, readVersion);
  while (pendingReads.size > GROUP_NAME_CACHE_MAX_SIZE) pendingReads.delete(pendingReads.keys().next().value!);
  let info: FeishuGroupInfo;
  try {
    const client = createFeishuClient(account);
    const chatInfo = await getChatInfo(client, chatId);
    info = {
      status: "available",
      name: chatInfo.name?.trim() || undefined,
      description: chatInfo.description ?? "",
      fetchedAt: Date.now(),
    };
  } catch (err) {
    log(`feishu[${account.accountId}]: getChatInfo failed for ${chatId}: ${String(err)}`);
    info = { status: "unavailable", fetchedAt: Date.now() };
  }

  if (pendingReads.get(cacheKey) === readVersion) {
    setCacheEntry(cacheKey, info);
    pendingReads.delete(cacheKey);
  }
  evictGroupNameCache();
  return info;
}

export async function resolveGroupName(
  params: Parameters<typeof resolveGroupInfo>[0],
): Promise<string | undefined> {
  return (await resolveGroupInfo(params)).name;
}
