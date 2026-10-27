import {traceHostErrorDelivery} from "./host-error-delivery-diagnostic.js";
import {sendMediaFeishu} from "./media.js";
import {recordOutboundMentions,recordEditedMentions,nativeMentionIds,type FeishuMentionScope} from './recent-outbound-mentions.js';
import {prepareFeishuDocumentDelivery,documentCardText,documentLinkCard,findLocalFileReferences} from "./document-delivery.js";
// Feishu plugin module implements send behavior.
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { createFeishuClient } from "./client.js";
import { requestFeishuApi } from "./comment-shared.js";
import { parseInteractiveCardContent } from "./interactive-message-content.js";
import {
  assertFeishuPostWithinEnvelope,
  buildFeishuPostMessageContent,
  chunkFeishuMarkdownByEnvelope,
  materializeFeishuPostMarkdownSoftBreaks,
  type FeishuMarkdownChunkOptions,
} from "./markdown.js";
import type { MentionTarget } from "./mention-target.types.js";
import { buildMentionedCardContent } from "./mention.js";
import { parseMergeForwardContent } from "./message-content.js";
import { resolveFeishuCardTemplate } from "./native-card.js";
import { parsePostContent, renderPostContent } from "./post.js";
import { withFeishuMessageDispatch } from "./send-context.js";
import { resolveFeishuReceiptKind, toFeishuSendResult } from "./send-result.js";
import { resolveFeishuSendTarget } from "./send-target.js";
import type { FeishuChatType, FeishuMessageInfo, FeishuSendResult } from "./types.js";

export { resolveFeishuCardTemplate };

const WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003]);
function shouldFallbackFromReplyTarget(response: { code?: number; msg?: string }): boolean {
  if (response.code !== undefined && WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) {
    return true;
  }
  const msg = normalizeLowercaseStringOrEmpty(response.msg);
  return msg.includes("withdrawn") || msg.includes("not found");
}

/** Check whether a thrown error indicates a withdrawn/not-found reply target. */
function isWithdrawnReplyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  // SDK error shape: err.code
  const code = (err as { code?: number }).code;
  if (typeof code === "number" && WITHDRAWN_REPLY_ERROR_CODES.has(code)) {
    return true;
  }
  // AxiosError shape: err.response.data.code
  const response = (err as { response?: { data?: { code?: number; msg?: string } } }).response;
  if (
    typeof response?.data?.code === "number" &&
    WITHDRAWN_REPLY_ERROR_CODES.has(response.data.code)
  ) {
    return true;
  }
  // Wrapped error shape from createFeishuApiError: err.cause holds the original error.
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) {
    return isWithdrawnReplyError(cause);
  }
  return false;
}

type FeishuCreateMessageClient = {
  im: {
    message: {
      reply: (opts: {
        path: { message_id: string };
        data: { content: string; msg_type: string; reply_in_thread?: true };
      }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
      create: (opts: {
        params: { receive_id_type: "chat_id" | "email" | "open_id" | "union_id" | "user_id" };
        data: { receive_id: string; content: string; msg_type: string };
      }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
    };
  };
};

type FeishuMessageSender = {
  id?: string;
  id_type?: string;
  sender_type?: string;
};

type FeishuMessageGetItem = {
  message_id?: string;
  chat_id?: string;
  chat_type?: FeishuChatType;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type?: string;
  body?: { content?: string };
  sender?: FeishuMessageSender;
  create_time?: string;
  upper_message_id?: string;
  deleted?: boolean;
  mentions?: Array<{ id?: string; id_type?: string; key?: string }>;
};

type FeishuGetMessageResponse = {
  code?: number;
  msg?: string;
  data?: FeishuMessageGetItem & {
    items?: FeishuMessageGetItem[];
  };
};

/** Send a direct message as a fallback when a reply target is unavailable. */
async function sendFallbackDirect(
  client: FeishuCreateMessageClient,
  params: {
    receiveId: string;
    receiveIdType: "chat_id" | "email" | "open_id" | "union_id" | "user_id";
    content: string;
    msgType: string;
  },
  errorPrefix: string,
): Promise<FeishuSendResult> {
  const response = await requestFeishuApi(
    () =>
      withFeishuMessageDispatch(() =>
        client.im.message.create({
          params: { receive_id_type: params.receiveIdType },
          data: {
            receive_id: params.receiveId,
            content: params.content,
            msg_type: params.msgType,
          },
        }),
      ),
    errorPrefix,
    { includeNestedErrorLogId: true },
  );
  assertFeishuApiSuccess(response, errorPrefix);
  return toFeishuSendResult(
    response,
    params.receiveId,
    resolveFeishuReceiptKind(params.msgType),
    errorPrefix,
  );
}

export async function sendReplyOrFallbackDirect(
  client: FeishuCreateMessageClient,
  params: {
    replyToMessageId?: string;
    replyInThread?: boolean;
    allowTopLevelReplyFallback?: boolean;
    content: string;
    msgType: string;
    directParams: {
      receiveId: string;
      receiveIdType: "chat_id" | "email" | "open_id" | "union_id" | "user_id";
      content: string;
      msgType: string;
    };
    directErrorPrefix: string;
    replyErrorPrefix: string;
  },
): Promise<FeishuSendResult> {
  if (!params.replyToMessageId) {
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }

  const replyTargetFallbackError =
    params.replyInThread && params.allowTopLevelReplyFallback !== true
      ? new Error(
          "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
        )
      : null;

  let response: { code?: number; msg?: string; data?: { message_id?: string } };
  try {
    response = await requestFeishuApi(
      () =>
        withFeishuMessageDispatch(() =>
          client.im.message.reply({
            path: { message_id: params.replyToMessageId! },
            data: {
              content: params.content,
              msg_type: params.msgType,
              ...(params.replyInThread ? { reply_in_thread: true } : {}),
            },
          }),
        ),
      params.replyErrorPrefix,
      { includeNestedErrorLogId: true },
    );
  } catch (err) {
    if (!isWithdrawnReplyError(err)) {
      throw err;
    }
    if (replyTargetFallbackError) {
      throw replyTargetFallbackError;
    }
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }
  if (shouldFallbackFromReplyTarget(response)) {
    if (replyTargetFallbackError) {
      throw replyTargetFallbackError;
    }
    return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
  }
  assertFeishuApiSuccess(response, params.replyErrorPrefix);
  return toFeishuSendResult(
    response,
    params.directParams.receiveId,
    resolveFeishuReceiptKind(params.msgType),
    params.replyErrorPrefix,
    params.replyToMessageId,
  );
}

function parseFeishuMessageContent(
  rawContent: string,
  msgType: string,
  messageId?: string,
): string {
  if (!rawContent) {
    return "";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const safeId = messageId ? ` (id: ${messageId})` : "";
    logVerbose(`feishu message content parse failed for ${msgType} message${safeId}`);
    return rawContent;
  }

  if (msgType === "text") {
    const text = (parsed as { text?: unknown })?.text;
    return typeof text === "string" ? text : "[Text message]";
  }

  if (msgType === "post") {
    return renderPostContent(parsed).textContent;
  }

  if (msgType === "interactive") {
    return parseInteractiveCardContent(parsed);
  }

  if (typeof parsed === "string") {
    return parsed;
  }

  const genericText = (parsed as { text?: unknown; title?: unknown } | null)?.text;
  if (typeof genericText === "string" && genericText.trim()) {
    return genericText;
  }
  const genericTitle = (parsed as { title?: unknown } | null)?.title;
  if (typeof genericTitle === "string" && genericTitle.trim()) {
    return genericTitle;
  }

  return `[${msgType || "unknown"} message]`;
}

export function parseFeishuMessageItem(
  item: FeishuMessageGetItem,
  fallbackMessageId?: string,
): FeishuMessageInfo {
  const msgType = item.msg_type ?? "text";
  const rawContent = item.body?.content ?? "";
  const mentionedOpenIds = (item.mentions?.length
    ? item.mentions.filter(mention => mention.id_type === "open_id").map(mention => mention.id)
    : msgType === "post" ? parsePostContent(rawContent).mentionedOpenIds : [])
    .filter((id): id is string => typeof id === "string" && !!id.trim() && !["all", "here"].includes(id.toLowerCase()));
  const mentionedAppIds = (item.mentions ?? [])
    .filter(mention => mention.id_type === "app_id")
    .map(mention => mention.id)
    .filter((id): id is string => typeof id === "string" && !!id.trim());

  return {
    messageId: item.message_id ?? fallbackMessageId ?? "",
    chatId: item.chat_id ?? "",
    ...(mentionedOpenIds.length ? { mentionedOpenIds: [...new Set(mentionedOpenIds)] } : {}),
    ...(mentionedAppIds.length ? { mentionedAppIds: [...new Set(mentionedAppIds)] } : {}),
    chatType:
      item.chat_type === "group" ||
      item.chat_type === "topic_group" ||
      item.chat_type === "private" ||
      item.chat_type === "p2p"
        ? item.chat_type
        : undefined,
    senderId: item.sender?.id,
    senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : undefined,
    senderType: item.sender?.sender_type,
    content: parseFeishuMessageContent(rawContent, msgType, item.message_id),
    contentType: msgType,
    createTime: parseStrictNonNegativeInteger(item.create_time),
    ...(item.root_id ? { rootId: item.root_id } : {}),
    ...(item.parent_id ? { parentId: item.parent_id } : {}),
    threadId: item.thread_id || undefined,
  };
}

/**
 * Get a message by its ID.
 * Useful for fetching quoted/replied message content.
 */
export async function getMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
  includeResourceContent?: boolean;
}): Promise<FeishuMessageInfo | null> {
  const { cfg, messageId, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  try {
    const response = (await client.im.message.get({
      params: { card_msg_content_type: "user_card_content", user_id_type: "open_id" },
      path: { message_id: messageId },
    })) as FeishuGetMessageResponse;

    if (response.code !== 0) {
      return null;
    }

    // Support both list shape (including flattened merged forwards) and single-object shape.
    const responseItems = response.data?.items;
    const rawItem =
      responseItems?.find((item) => item.msg_type === "merge_forward" && !item.upper_message_id) ??
      responseItems?.[0] ??
      response.data;
    const item =
      rawItem &&
      (rawItem.body !== undefined || (rawItem as { message_id?: string }).message_id !== undefined)
        ? rawItem
        : null;
    if (!item || item.deleted) {
      return null;
    }

    const parsedItem = parseFeishuMessageItem(item, messageId);
    if (parsedItem.contentType === "merge_forward" && responseItems) {
      return {
        ...parsedItem,
        content: parseMergeForwardContent(responseItems),
      };
    }
    return params.includeResourceContent ? {...parsedItem,resourceContent:item.body?.content??""} : parsedItem;
  } catch {
    return null;
  }
}

type FeishuThreadMessageInfo = {
  messageId: string;
  senderId?: string;
  senderType?: string;
  content: string;
  contentType: string;
  createTime?: number;
};

/**
 * List messages in a Feishu thread (topic).
 * Uses container_id_type=thread to directly query thread messages,
 * which includes both the root message and all replies (including bot replies).
 */
export async function listFeishuThreadMessages(params: {
  cfg: ClawdbotConfig;
  threadId: string;
  currentMessageId?: string;
  /** Exclude the root message (already provided separately as ThreadStarterBody). */
  rootMessageId?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuThreadMessageInfo[]> {
  const { cfg, threadId, currentMessageId, rootMessageId, limit = 20, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const results: FeishuThreadMessageInfo[] = [];
  const seenMessageIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  while (results.length < limit) {
    const response = (await client.im.message.list({
      params: {
        container_id_type: "thread",
        container_id: threadId,
        // Feishu pages newest-first; reverse only after all accepted pages are gathered.
        sort_type: "ByCreateTimeDesc",
        page_size: Math.min(limit + 1, 50),
        ...(pageToken ? { page_token: pageToken } : {}),
        card_msg_content_type: "user_card_content",
      },
    })) as {
      code?: number;
      msg?: string;
      data?: {
        items?: Array<
          {
            message_id?: string;
            root_id?: string;
            parent_id?: string;
          } & FeishuMessageGetItem
        >;
        has_more?: boolean;
        page_token?: string;
      };
    };

    if (response.code !== 0) {
      throw new Error(
        `Feishu thread list failed: code=${response.code} msg=${response.msg ?? "unknown"}`,
      );
    }

    for (const item of response.data?.items ?? []) {
      if (
        (currentMessageId && item.message_id === currentMessageId) ||
        (rootMessageId && item.message_id === rootMessageId) ||
        (item.message_id && seenMessageIds.has(item.message_id))
      ) {
        continue;
      }

      const parsed = parseFeishuMessageItem(item);
      if (parsed.messageId) {
        seenMessageIds.add(parsed.messageId);
      }
      results.push({
        messageId: parsed.messageId,
        senderId: parsed.senderId,
        senderType: parsed.senderType,
        content: parsed.content,
        contentType: parsed.contentType,
        createTime: parsed.createTime,
      });

      if (results.length >= limit) {
        break;
      }
    }

    if (results.length >= limit || response.data?.has_more !== true) {
      break;
    }

    const nextPageToken = response.data.page_token?.trim();
    if (!nextPageToken || seenPageTokens.has(nextPageToken)) {
      throw new Error(
        `Feishu thread history pagination returned a ${nextPageToken ? "repeated" : "missing"} page token`,
      );
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  // Restore chronological order (oldest first) since we fetched newest-first.
  results.reverse();
  return results;
}

type SendFeishuMessageParams = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  /** The outbound adapter already projected and envelope-chunked this post text. @internal */
  preparedPostText?: true;
  /** Use an inline native text element, e.g. for a one-line mention reminder. */
  plainText?: boolean;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  /** Mention target users */
  mentions?: MentionTarget[];
  /** Account ID (optional, uses default if not specified) */
  accountId?: string;
};

export async function sendMessageFeishu(
  params: SendFeishuMessageParams,
): Promise<FeishuSendResult> {
  const {
    cfg,
    to,
    text,
    preparedPostText,
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    mentions,
    accountId,
  } = params;
  const traceHostError = traceHostErrorDelivery({text,to,accountId,replyToMessageId});
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  const document=await prepareFeishuDocumentDelivery({cfg,accountId,to,text});
  let messageText = document?.text ?? text;
  if (!preparedPostText && !params.plainText) {
    const tableMode = resolveMarkdownTableMode({ cfg, channel: "feishu" });
    messageText = materializeFeishuPostMarkdownSoftBreaks(
      convertMarkdownTables(messageText ?? "", tableMode),
    );
  }

  const content = buildFeishuPostMessageContent({ messageText, mentions, plainText: params.plainText });
  const msgType = "post";
  assertFeishuPostWithinEnvelope(content, "Feishu post");

  const directParams = { receiveId, receiveIdType, content, msgType };
  const result = await sendReplyOrFallbackDirect(client, {
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    content,
    msgType,
    directParams,
    directErrorPrefix: "Feishu send failed",
    replyErrorPrefix: "Feishu reply failed",
  });
  traceHostError?.(result.messageId);
  const sentContent = JSON.parse(content);
  recordOutboundMentions({...params,accountId:resolveFeishuRuntimeAccount(params).accountId,
    replyToMessageId:result.receipt.replyToId,replyInThread:!!result.receipt.replyToId && replyInThread},result.messageId,sentContent);
  for(const mediaUrl of document?.mediaUrls ?? [])await sendMediaFeishu({cfg,to,accountId,mediaUrl,replyToMessageId:result.messageId,replyInThread,allowTopLevelReplyFallback});
  return {...result,mentionedUserIds:nativeMentionIds(sentContent)};
}

type SendFeishuCardParams = {
  cfg: ClawdbotConfig;
  to: string;
  card: Record<string, unknown>;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  accountId?: string;
};

export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  const { cfg, to, card, replyToMessageId, replyInThread, allowTopLevelReplyFallback, accountId } =
    params;
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  const document=await prepareFeishuDocumentDelivery({cfg,accountId,to,text:documentCardText(card)});
  const content = JSON.stringify(document ? documentLinkCard(document.text) : card);

  const directParams = { receiveId, receiveIdType, content, msgType: "interactive" };
  const result = await sendReplyOrFallbackDirect(client, {
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    content,
    msgType: "interactive",
    directParams,
    directErrorPrefix: "Feishu card send failed",
    replyErrorPrefix: "Feishu card reply failed",
  });
  const sentContent = JSON.parse(content);
  recordOutboundMentions({...params,accountId:resolveFeishuRuntimeAccount(params).accountId,
    replyToMessageId:result.receipt.replyToId,replyInThread:!!result.receipt.replyToId && replyInThread},result.messageId,sentContent);
  for(const mediaUrl of document?.mediaUrls ?? [])await sendMediaFeishu({cfg,to,accountId,mediaUrl,replyToMessageId:result.messageId,replyInThread,allowTopLevelReplyFallback});
  return {...result,mentionedUserIds:nativeMentionIds(sentContent)};
}

export async function editMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  text?: string;
  card?: Record<string, unknown>;
  accountId?: string;
  /** Trusted delivery context used to recover a persisted card after restart. */
  mentionScope?: FeishuMentionScope;
}): Promise<{ messageId: string; contentType: "post" | "interactive"; mentionedUserIds: string[] }> {
  const { cfg, messageId, accountId } = params;
  let {text,card}=params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const hasText = typeof text === "string" && text.trim().length > 0;
  const hasCard = Boolean(card);
  if (hasText === hasCard) {
    throw new Error("Feishu edit requires exactly one of text or card.");
  }

  const client = createFeishuClient(account);
  const body=card?documentCardText(card):text ?? "";
  if(account.config.documentDelivery?.enabled !== false && findLocalFileReferences(body,account.config.documentDelivery?.workspaceDir ?? account.config.workspaceSync?.root ?? cfg.agents?.defaults?.workspace).length) {
    const target=await getMessageFeishu({cfg,messageId,accountId});
    if(!target?.chatId)throw Error("Cannot resolve edited message document recipient");
    const document=await prepareFeishuDocumentDelivery({cfg,accountId,to:"chat:"+target.chatId,text:body});
    if(document){if(card)card=documentLinkCard(document.text);else text=document.text;}
  }

  if (card) {
    const content = JSON.stringify(card);
    const response = await client.im.message.patch({
      path: { message_id: messageId },
      data: { content },
    });

    assertFeishuApiSuccess(response, "Feishu message edit failed");

    recordEditedMentions(account.accountId,messageId,JSON.parse(content),Date.now(),params.mentionScope);
    return { messageId, contentType: "interactive", mentionedUserIds:nativeMentionIds(JSON.parse(content)) };
  }

  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });
  const messageText = convertMarkdownTables(text!, tableMode);
  const normalizedText = materializeFeishuPostMarkdownSoftBreaks(messageText);
  const content = buildFeishuPostMessageContent({ messageText: normalizedText });
  assertFeishuPostWithinEnvelope(content, "Feishu message edit");
  // Feishu's PATCH endpoint only edits cards; rich-post edits require the typed PUT endpoint.
  const response = await client.im.message.update({
    path: { message_id: messageId },
    data: { msg_type: "post", content },
  });

  assertFeishuApiSuccess(response, "Feishu message edit failed");

  recordEditedMentions(account.accountId,messageId,JSON.parse(content),Date.now(),params.mentionScope);
  return { messageId, contentType: "post", mentionedUserIds:nativeMentionIds(JSON.parse(content)) };
}

/** Header configuration for structured Feishu cards. */
export type CardHeaderConfig = {
  /** Header title text, e.g. "💻 Coder" */
  title: string;
  /** Feishu header color template (blue, green, red, orange, purple, grey, etc.). Defaults to "blue". */
  template?: string;
};

/**
 * Build a Feishu interactive card with optional header and note footer.
 */
function buildStructuredCard(
  text: string,
  options?: {
    header?: CardHeaderConfig;
    note?: string;
    mentions?: MentionTarget[];
  },
): Record<string, unknown> {
  const content = options?.mentions?.length
    ? buildMentionedCardContent(options.mentions, text)
    : text;
  const elements: Record<string, unknown>[] = [{ tag: "markdown", content }];
  if (options?.note) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `<font color='grey'>${options.note}</font>` });
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: { width_mode: "fill" },
    body: { elements },
  };
  if (options?.header) {
    card.header = {
      title: { tag: "plain_text", content: options.header.title },
      template: resolveFeishuCardTemplate(options.header.template) ?? "blue",
    };
  }
  return card;
}

export function chunkFeishuCardMarkdown(
  params: FeishuMarkdownChunkOptions & {
    header?: CardHeaderConfig;
    note?: string;
  },
): string[] {
  return chunkFeishuMarkdownByEnvelope({
    ...params,
    contentBytes: (text, isFirst) =>
      Buffer.byteLength(
        JSON.stringify(
          buildStructuredCard(text, {
            header: params.header,
            note: params.note,
            mentions: [
              ...(params.chunkMentions ?? []),
              ...(isFirst ? (params.firstChunkMentions ?? []) : []),
            ],
          }),
        ),
        "utf8",
      ),
  });
}

/**
 * Send a message as a structured card with optional header and note.
 */
export async function sendStructuredCardFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  mentions?: MentionTarget[];
  accountId?: string;
  header?: CardHeaderConfig;
  note?: string;
}): Promise<FeishuSendResult> {
  const {
    cfg,
    to,
    text,
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    mentions,
    accountId,
    header,
    note,
  } = params;
  const card = buildStructuredCard(text, { header, note, mentions });
  return sendCardFeishu({
    cfg,
    to,
    card,
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    accountId,
  });
}
