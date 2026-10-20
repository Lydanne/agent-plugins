// Feishu plugin module implements bot sender name behavior.
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type FeishuPermissionError = {
  code: number;
  message: string;
  grantUrl?: string;
};

type SenderNameResult = {
  name?: string;
  email?: string;
  jobTitle?: string;
  jobTitleStatus?: "available" | "empty" | "unavailable";
  departments?: {id:string; name?:string; code?:number}[];
  departmentIds?: string[];
  permissionError?: FeishuPermissionError;
};

type FeishuContactUserGetResponse = Awaited<
  ReturnType<ReturnType<typeof createFeishuClient>["contact"]["user"]["get"]>
>;

type FeishuLogger = (...args: unknown[]) => void;

type FeishuApiError = {
  code: number;
  message: string;
};

type SenderNameCacheEntry =
  | { kind: "resolved"; name: string; email?: string; jobTitle?: string; jobTitleStatus?: "available" | "empty" | "unavailable"; departments?: {id:string; name?:string; code?:number}[]; departmentIds?: string[]; expireAt: number }
  | { kind: "unavailable"; expireAt: number };

const IGNORED_PERMISSION_SCOPE_TOKENS = ["contact:contact.base:readonly"];
const FEISHU_SCOPE_CORRECTIONS: Record<string, string> = {
  "contact:contact.base:readonly": "contact:user.base:readonly",
};
const FEISHU_USER_LOOKUP_UNAUTHORIZED_CODE = 41050;
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const SENDER_NAME_NEGATIVE_TTL_MS = 30 * 60 * 1000;
const SENDER_NAME_CACHE_MAX_SIZE = 500;
const senderNameCache = new Map<string, SenderNameCacheEntry>();

function correctFeishuScopeInUrl(url: string): string {
  let corrected = url;
  for (const [wrong, right] of Object.entries(FEISHU_SCOPE_CORRECTIONS)) {
    corrected = corrected.replaceAll(encodeURIComponent(wrong), encodeURIComponent(right));
    corrected = corrected.replaceAll(wrong, right);
  }
  return corrected;
}

function shouldSuppressPermissionErrorNotice(permissionError: FeishuPermissionError): boolean {
  const message = normalizeLowercaseStringOrEmpty(permissionError.message);
  return IGNORED_PERMISSION_SCOPE_TOKENS.some((token) => message.includes(token));
}

function extractFeishuApiError(err: unknown): FeishuApiError | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const feishuErr = data as { code?: unknown; msg?: unknown };
  if (typeof feishuErr.code !== "number") {
    return null;
  }
  return {
    code: feishuErr.code,
    message: typeof feishuErr.msg === "string" ? feishuErr.msg : "",
  };
}

function extractPermissionError(feishuErr: FeishuApiError | null): FeishuPermissionError | null {
  if (feishuErr?.code !== 99991672) {
    return null;
  }
  const urlMatch = feishuErr.message.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  return {
    code: feishuErr.code,
    message: feishuErr.message,
    grantUrl: urlMatch?.[0] ? correctFeishuScopeInUrl(urlMatch[0]) : undefined,
  };
}

function writeSenderNameCache(key: string, entry: SenderNameCacheEntry): void {
  senderNameCache.delete(key);
  senderNameCache.set(key, entry);
  pruneMapToMaxSize(senderNameCache, SENDER_NAME_CACHE_MAX_SIZE);
}

function resolveSenderLookupIdType(senderId: string): "open_id" | "user_id" | "union_id" {
  const trimmed = senderId.trim();
  if (trimmed.startsWith("ou_")) {
    return "open_id";
  }
  if (trimmed.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}

export async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderId: string;
  log: FeishuLogger;
}): Promise<SenderNameResult> {
  const { account, senderId, log } = params;
  if (!account.configured) {
    return {};
  }

  const normalizedSenderId = senderId.trim();
  if (!normalizedSenderId) {
    return {};
  }

  const cacheKey = `${account.accountId}:${account.appId ?? ""}:${normalizedSenderId}`;
  const cached = senderNameCache.get(cacheKey);
  const now = asDateTimestampMs(Date.now());
  const cachedExpireAt = cached ? asDateTimestampMs(cached.expireAt) : undefined;
  if (cached && now !== undefined && cachedExpireAt !== undefined && cachedExpireAt > now) {
    return cached.kind === "resolved" ? { name: cached.name, ...(cached.email !== undefined ? {email:cached.email} : {}), ...(cached.jobTitleStatus ? {jobTitleStatus:cached.jobTitleStatus} : {}), ...(cached.departments?.length ? {departments:cached.departments} : {}), ...(cached.jobTitle ? {jobTitle:cached.jobTitle} : {}), ...(cached.departmentIds?.length ? {departmentIds:cached.departmentIds} : {}) } : {};
  }
  if (cached) {
    senderNameCache.delete(cacheKey);
  }

  try {
    const client = createFeishuClient(account);
    const userIdType = resolveSenderLookupIdType(normalizedSenderId);
    const res: FeishuContactUserGetResponse = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType, department_id_type: "open_department_id" },
    });
    const user = res.data?.user;
    const name = user?.name ?? user?.nickname ?? user?.en_name;

    const departments = await Promise.all((user?.department_ids ?? []).slice(0,20).map(async id => {
      try {
        const result = await client.contact.department.get({path:{department_id:id},params:{department_id_type:'open_department_id'}});
        return {id, ...(result.data?.department?.name ? {name:result.data.department.name} : {}), ...(result.code ? {code:result.code} : {})};
      } catch { return {id,code:-1}; }
    }));
    const jobTitleStatus = user && Object.hasOwn(user,'job_title') ? (user.job_title?.trim() ? 'available' : 'empty') : 'unavailable';
    const email=user?.enterprise_email ?? user?.email;
    const details = { ...(email !== undefined ? {email} : {}), ...(user?.job_title ? {jobTitle:user.job_title} : {}), ...(user && Object.hasOwn(user,'job_title') ? {jobTitleStatus:jobTitleStatus as 'available'|'empty'} : {}), ...(departments.length ? {departments} : {}), ...(user?.department_ids?.length ? {departmentIds:user.department_ids} : {}) };
    if (name) {
      const expireAt = resolveExpiresAtMsFromDurationMs(SENDER_NAME_TTL_MS);
      if (expireAt !== undefined) {
        writeSenderNameCache(cacheKey, { kind: "resolved", name, ...details, expireAt });
      }
      return { name, ...details };
    }
    return {};
  } catch (err) {
    const feishuErr = extractFeishuApiError(err);
    const permErr = extractPermissionError(feishuErr);
    if (permErr) {
      if (shouldSuppressPermissionErrorNotice(permErr)) {
        log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
        return {};
      }
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }
    if (feishuErr?.code === FEISHU_USER_LOOKUP_UNAUTHORIZED_CODE) {
      // 41050 means this app cannot see the user. Cache the account-scoped miss
      // so later messages avoid repeating the same failing API request and SDK log.
      const expireAt = resolveExpiresAtMsFromDurationMs(SENDER_NAME_NEGATIVE_TTL_MS);
      if (expireAt !== undefined) {
        writeSenderNameCache(cacheKey, { kind: "unavailable", expireAt });
      }
      return {};
    }
    log(`feishu: failed to resolve sender name for ${normalizedSenderId}: ${String(err)}`);
    return {};
  }
}
