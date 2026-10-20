import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { parseFeishuMessageItem } from "./send.js";

import { prepareHistory, readHistoryContext, renderHistoryContext, type HistoryMessage, type HistoryRelation, type HistoryDiagnostics } from "./input-context.js";

/** Compatibility entrypoint: budget complete JSON records. */
export function boundMentionHistory(messages: HistoryMessage[], maxChars = 12000): string {
  return prepareHistory(messages, {maxChars});
}

export async function loadMentionHistory(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  currentMessageId: string;
  beforeMs: number;
  botOpenId?: string;
  botAppId?: string;
  quote?: { messageId: string; createTime: number };
  recentLimit?: number;
  quoteBefore?: number;
  quoteAfter?: number;
  limit?: number;
  maxChars?: number;
  deferBudget?: boolean;
  relation?: HistoryRelation;
  report?: (stats: HistoryDiagnostics) => void;
  filter?: (messages: HistoryMessage[]) => Promise<HistoryMessage[]>;
}): Promise<string> {
  const recentLimit = Math.min(50, Math.max(1, params.recentLimit ?? 5));
  const quoteBefore = Math.min(20, Math.max(0, params.quoteBefore ?? 3));
  const quoteAfter = Math.min(20, Math.max(0, params.quoteAfter ?? 3));
  const limit = Math.min(50, Math.max(recentLimit, params.limit ?? 20));
  const maxChars = params.deferBudget ? Infinity : Math.min(50000, Math.max(1000, params.maxChars ?? 12000));
  let expired = false;
  let recentFallback: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fetchHistory = async () => {
    const account = resolveFeishuRuntimeAccount(params);
    const client = createFeishuClient(account);
    const messages: HistoryMessage[] = [];
    const seen = new Set<string>();
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    // Bound pagination even if the API returns empty/duplicate pages.
    for (let page = 0; page < 3 && messages.length < limit; page++) {
      const response = await client.im.message.list({ params: {
        container_id_type: "chat", container_id: params.chatId,
        sort_type: "ByCreateTimeDesc", page_size: Math.min(50, limit + 1),
        end_time: String(Math.floor(params.beforeMs / 1000) + 1),
        card_msg_content_type: "user_card_content",
        ...(pageToken ? { page_token: pageToken } : {}),
      } });
      if (expired) throw new Error("History timeout");
      if (response.code !== 0) throw new Error("History unavailable");
      const candidates: HistoryMessage[] = [];
      for (const item of response.data?.items ?? []) {
        const time = Number(item.create_time);
        if (!item.message_id || item.message_id === params.currentMessageId || seen.has(item.message_id) ||
            item.deleted || (item.chat_id && item.chat_id !== params.chatId) ||
            !Number.isFinite(time) || time > params.beforeMs) continue;
        seen.add(item.message_id);
        const parsed = parseFeishuMessageItem(item);
        candidates.push({ messageId: parsed.messageId, senderId: parsed.senderId,
          senderType: parsed.senderType, content: parsed.content,
          contentType: parsed.contentType, createTime: parsed.createTime, rootId: parsed.rootId, threadId: parsed.threadId, parentId: parsed.parentId });
      }
      messages.push(...(params.filter ? await params.filter(candidates) : candidates).slice(0, limit - messages.length));
      recentFallback = prepareHistory([...messages].sort((a,b) => (a.createTime ?? 0) - (b.createTime ?? 0)).slice(-recentLimit).map(m => ({...m, retention:"recent" as const})), {maxChars});
      pageToken = response.data?.page_token;
      if (!response.data?.has_more || !pageToken || tokens.has(pageToken)) break;
      tokens.add(pageToken);
    }
    messages.sort((a, b) => (a.createTime ?? 0) - (b.createTime ?? 0));
    const visible = messages;
    const recent = visible.slice(-recentLimit).map(m => ({...m, retention: "recent" as const}));
    recentFallback = prepareHistory(recent, {maxChars});
    const recentIds = new Set(recent.map(m => m.messageId));
    const older = visible.filter(m => !recentIds.has(m.messageId));
    let neighborhood: HistoryMessage[] = [];
    const retrieval: Record<string, unknown>[] = recent.length < recentLimit
      ? [{scope: 'recent', status: 'short', requested: recentLimit, returned: recent.length}] : [];
    if (params.quote && Number.isFinite(params.quote.createTime) && quoteBefore + quoteAfter > 0) {
      try {
        neighborhood = await loadQuoteNeighbors(client, {...params, quoteBefore, quoteAfter, isExpired: () => expired});
        if (neighborhood.length < quoteBefore + quoteAfter) retrieval.push({scope: 'quote_neighbors', status: 'short', before: quoteBefore, after: quoteAfter, returned: neighborhood.length});
      } catch {
        retrieval.push({scope: 'quote_neighbors', status: 'unavailable', before: quoteBefore, after: quoteAfter});
      }
    }
    // The recent window deliberately survives cross-turn deduplication. Older
    // neighbors use the same active-session fingerprint policy as other history.
    const byId = new Map([...older, ...neighborhood.map(m => ({...m, retention: "quote-neighbor" as const})), ...recent].map(m => [m.messageId, m]));
    const combined = [...byId.values()].sort((a,b) => (a.createTime ?? 0) - (b.createTime ?? 0));
    const neighborIds = new Set(neighborhood.map(m => m.messageId));
    const related = params.relation ? combined.filter(m => m.retention === "recent" || neighborIds.has(m.messageId) ||
      m.messageId === params.relation?.parentId || m.messageId === params.relation?.rootId ||
      (!!params.relation?.threadId && m.threadId === params.relation.threadId) ||
      (!!params.relation?.rootId && m.rootId === params.relation.rootId)) : combined;
    return prepareHistory(related, {maxChars, report:params.report, context: retrieval.length ? {retrieval} : undefined});
  };
  try {
    return await Promise.race([
      fetchHistory(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error("History timeout")); }, 5000); }),
    ]);
  } catch {
    return renderHistoryContext({messages: recentFallback ? readHistoryContext(recentFallback)!.context.messages : [],
      retrieval: [{scope: 'history', status: recentFallback ? 'partial' : 'unavailable', reason: expired ? 'timeout' : 'read_failed'}]});
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// API time bounds have second precision: fetch the anchor second inclusively,
// then enforce the millisecond boundaries locally. Never include future input.
async function loadQuoteNeighbors(client: ReturnType<typeof createFeishuClient>, params: {
  chatId: string; currentMessageId: string; beforeMs: number;
  quote?: {messageId: string; createTime: number};
  filter?: (messages: HistoryMessage[]) => Promise<HistoryMessage[]>;
  quoteBefore: number; quoteAfter: number;
  isExpired: () => boolean;
}): Promise<HistoryMessage[]> {
  const quote = params.quote!;
  const sides = await Promise.all(["before", "after"].map(async side => {
    const count = side === "before" ? params.quoteBefore : params.quoteAfter;
    const rows: HistoryMessage[] = [];
    const seen = new Set<string>();
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 3 && rows.length < count; page++) {
      if (params.isExpired()) throw new Error("Quote neighborhood timeout");
      const response = await client.im.message.list({params: {
        container_id_type: "chat", container_id: params.chatId,
        sort_type: side === "before" ? "ByCreateTimeDesc" : "ByCreateTimeAsc",
        page_size: 50, card_msg_content_type: "user_card_content",
        ...(side === "before" ? {end_time: String(Math.floor(quote.createTime / 1000) + 1)} :
          {start_time: String(Math.floor(quote.createTime / 1000)), end_time: String(Math.floor(params.beforeMs / 1000) + 1)}),
        ...(pageToken ? {page_token: pageToken} : {}),
      }});
      if (params.isExpired()) throw new Error("Quote neighborhood timeout");
      if (response.code !== 0) throw new Error("Quote neighborhood unavailable");
      const candidates: HistoryMessage[] = [];
      for (const item of response.data?.items ?? []) {
        const time = Number(item.create_time);
        if (!item.message_id || item.message_id === quote.messageId || item.message_id === params.currentMessageId ||
          item.deleted || seen.has(item.message_id) || (item.chat_id && item.chat_id !== params.chatId) ||
          !Number.isFinite(time) || time > params.beforeMs ||
          (side === "before" ? time >= quote.createTime : time <= quote.createTime)) continue;
        seen.add(item.message_id);
        candidates.push(parseFeishuMessageItem(item));
      }
      rows.push(...(params.filter ? await params.filter(candidates) : candidates));
      pageToken = response.data?.page_token;
      if (!response.data?.has_more || !pageToken || tokens.has(pageToken)) break;
      tokens.add(pageToken);
    }
    rows.sort((a,b) => side === "before" ? (b.createTime ?? 0) - (a.createTime ?? 0) : (a.createTime ?? 0) - (b.createTime ?? 0));
    return rows.slice(0,count);
  }));
  return sides.flat();
}
