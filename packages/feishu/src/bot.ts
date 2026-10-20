import {collectTaskPeople,type TaskPeople} from './people-directory.js';
import {renderBusinessMessage} from "./business-config.js";
import { CURRENT_HEADER, renderSection, renderContextData } from "./context-sections.js";
import { prepareHistory, renderInputContext, type HistoryMessage } from "./input-context.js";
import { recordContextReceipts } from "./context-receipts.js";
import { SourceTask, type TaskSource } from "./source-task.js";
import { clearWorkspaceContext, prepareWorkspaceContext } from "./workspace-context.js";
import { syncAdaWorkspace } from "./workspace-sync.js";
import { registerTaskProgress } from "./task-progress.js";
import { runFeishuWorkingTurn, cancelFeishuWaitingTurns } from "./working-turn-queue.js";
import { isAbortRequestText, isBtwRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import { buildFeishuCommandDeniedReply, resolveFeishuReadOnlyCommand } from "./command-routing.js";
import { contextMessageMarker, deduplicateSessionHistory, buildRelatedPeopleContext } from "./context-history.js";
import { mergeHistoryContext } from "./history-summary.js";
import { summarizeFeishuHistory } from "./history-summary-runtime.js";
import { loadQuoteChain } from "./quote-chain.js";
import { loadMentionHistory } from "./mention-history.js";
import { captureFeishuProgress, captureFeishuSteer, registerFeishuSteerOwner } from "./keyword-steer.js";
import { buildDepartmentReplyStyleContext } from "./department-reply-style.js";
import { ColleagueProfiles } from './colleague-profile.js';
import {renderConversationPeople} from './people-context.js';
import { admitConversationWindow, getConversationWindowStore } from "./conversation-window-runtime.js";
import { windowKey } from "./conversation-window.js";
import {
  type ChannelInboundTurnPlan,
  formatAgentEnvelope,
  formatInboundMediaUnavailableText,
  recordChannelBotPairLoopAndCheckSuppression,
  resolveEnvelopeFormatOptions,
  toInboundMediaFactsWithMetadata,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  resolveAgentOutboundIdentity,
} from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { resolveStorePath, getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  evaluateSupplementalContextVisibility,
  normalizeAgentId,
  resolveChannelContextVisibilityMode,
} from "../runtime-api.js";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { buildFeishuAgentBody, appendFeishuTaskInstruction } from "./bot-agent-body.js";
import {
  buildBroadcastSessionKey,
  createFeishuBroadcastIngressSettlement,
  resolveBroadcastAgents,
} from "./bot-broadcast.js";
import {
  checkBotMentioned,
  normalizeFeishuCommandProbeBody,
  normalizeMentions,
  parseMessageContent,
  resolveFeishuGroupSession,
  resolveFeishuMediaList,
} from "./bot-content.js";
import { resolveGroupName } from "./bot-group-name.js";
import { resolveFeishuBotName } from "./bot-name.js";
import { resolveFeishuSenderName, type FeishuPermissionError } from "./bot-sender-name.js";
import { createFeishuClient } from "./client.js";
import { resolveConfiguredFeishuGroupSessionScope } from "./conversation-id.js";
import {
  claimUnprocessedFeishuMessage,
  finalizeFeishuMessageProcessing,
  type FeishuMessageProcessingClaim,
} from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import type { FeishuMessageEvent } from "./event-types.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import {
  extractMentionTargets,
  isFeishuBroadcastMention,
  isMentionForwardRequest,
} from "./mention.js";
import {
  hasExplicitFeishuGroupConfig,
  normalizeFeishuAllowEntry,
  resolveFeishuDmIngressAccess,
  resolveFeishuGroupConfig,
  resolveFeishuGroupConversationIngressAccess,
  resolveFeishuGroupSenderActivationIngressAccess,
  resolveFeishuReplyPolicy,
} from "./policy.js";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, listFeishuThreadMessages, sendMessageFeishu, parseFeishuMessageItem } from "./send.js";
import { getFeishuSyntheticDirectPreDispatchTarget } from "./synthetic-event-target.js";
import {
  isFeishuGroupChatType,
  type FeishuMessageContext,
  type FeishuMediaInfo,
  type FeishuMessageInfo,
} from "./types.js";
export type { FeishuBotAddedEvent, FeishuMessageEvent } from "./event-types.js";

// Cache permission errors to avoid spamming the user with repeated notifications.
// Key: appId or "default", Value: timestamp of last notification
const permissionErrorNotifiedAt = new Map<string, number>();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function shouldSendNoVisibleReplyFallback(dispatchResult: {
  settledReceipt?: {
    anyVisibleDelivered: boolean;
    counts: { final: { failedBeforeSend: number } };
  };
  noVisibleReplyFallbackEligible?: boolean;
  sendPolicyDenied?: boolean;
  sourceReplyDeliveryMode?: string;
}): boolean {
  const emptyEligibleDispatch =
    dispatchResult.noVisibleReplyFallbackEligible === true &&
    dispatchResult.settledReceipt?.anyVisibleDelivered !== true;
  const finalFailedBeforeSend =
    (dispatchResult.settledReceipt?.counts.final.failedBeforeSend ?? 0) > 0;
  return (
    dispatchResult.sendPolicyDenied !== true &&
    dispatchResult.sourceReplyDeliveryMode !== "message_tool_only" &&
    (emptyEligibleDispatch || finalFailedBeforeSend)
  );
}

function isFeishuTopicSessionScope(
  scope: ReturnType<typeof resolveConfiguredFeishuGroupSessionScope>,
): boolean {
  return scope === "group_topic" || scope === "group_topic_sender";
}

async function resolveFeishuAudioTranscript(params: {
  cfg: ClawdbotConfig;
  mediaList: FeishuMediaInfo[];
  content: string;
  messageType: string;
  chatType: "direct" | "group";
  log: (msg: string) => void;
}): Promise<string | undefined> {
  if (params.messageType !== "audio") {
    return undefined;
  }
  const audioMedia = params.mediaList.filter(
    (media) =>
      Boolean(media.path) && (media.kind === "audio" || media.contentType?.startsWith("audio/")),
  );
  if (audioMedia.length === 0) {
    return undefined;
  }
  // Audio content is the server transcript. Return it for the shared marker path,
  // but only after the media check so failed downloads retain their notice.
  if (params.content.trim()) {
    return params.content;
  }

  try {
    const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
    return await transcribeFirstAudio({
      ctx: {
        media: audioMedia,
        ChatType: params.chatType,
      },
      cfg: params.cfg,
    });
  } catch (err) {
    params.log(`feishu: audio preflight transcription failed: ${String(err)}`);
    return undefined;
  }
}

/**
 * Parse an inbound Feishu event into its caption and routing metadata.
 */
export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
  _botName?: string,
  preparedContent?: string,
): FeishuMessageContext {
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const hasAnyMention = (event.message.mentions?.length ?? 0) > 0;
  // Strip bot addressing for commands (#35994); debounced content already expanded
  // each message's own keys, so never reinterpret placeholder-like display names.
  const content =
    preparedContent ??
    normalizeMentions(
      parseMessageContent(event.message.content, event.message.message_type),
      event.message.mentions,
      botOpenId,
    );
  const senderOpenId = event.sender.sender_id.open_id?.trim();
  const senderUserId = event.sender.sender_id.user_id?.trim();
  const senderFallbackId = senderOpenId || senderUserId || "";

  const ctx: FeishuMessageContext = {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    replyTargetMessageId: event.message.reply_target_message_id?.trim() || undefined,
    typingTargetMessageId: event.message.typing_target_message_id?.trim() || undefined,
    suppressReplyTarget: event.message.suppress_reply_target === true,
    senderId: senderUserId || senderOpenId || "",
    // Keep the historical field name, but fall back to user_id when open_id is unavailable
    // (common in some mobile app deliveries).
    senderOpenId: senderFallbackId,
    senderType: event.sender.sender_type === "bot" ? "bot" : "user",
    chatType: event.message.chat_type,
    mentionedBot,
    hasAnyMention,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    threadId: event.message.thread_id || undefined,
    content,
    contentType: event.message.message_type,
  };

  // Detect mention forward request: message mentions bot + at least one other user
  const mentionForwardBotOpenId = botOpenId?.trim();
  if (mentionForwardBotOpenId && isMentionForwardRequest(event, mentionForwardBotOpenId)) {
    const mentionTargets = extractMentionTargets(event, mentionForwardBotOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
    }
  }

  return ctx;
}

async function shouldIncludeFetchedGroupContextMessage(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  isGroup: boolean;
  allowFrom: Array<string | number>;
  mode: "all" | "allowlist" | "allowlist_quote";
  kind: "quote" | "thread" | "history";
  senderId?: string;
  senderType?: string;
}): Promise<boolean> {
  let senderAllowed =
    !params.isGroup || params.allowFrom.length === 0 || params.senderType === "app";
  const senderId = params.senderId?.trim();
  if (!senderAllowed && senderId) {
    const access = await resolveFeishuGroupSenderActivationIngressAccess({
      cfg: params.cfg,
      accountId: params.accountId,
      chatId: params.chatId,
      allowFrom: params.allowFrom,
      senderOpenId: senderId,
      senderUserId: senderId,
      requireMention: false,
      mentionedBot: true,
    });
    senderAllowed = access.senderAccess.decision === "allow";
  }
  return evaluateSupplementalContextVisibility({
    mode: params.mode,
    kind: params.kind,
    senderAllowed,
  }).include;
}

async function filterFetchedGroupContextMessages<
  T extends Pick<FeishuMessageInfo, "senderId" | "senderType">,
>(
  messages: readonly T[],
  params: {
    cfg: ClawdbotConfig;
    accountId: string;
    chatId: string;
    isGroup: boolean;
    allowFrom: Array<string | number>;
    mode: "all" | "allowlist" | "allowlist_quote";
    kind: "quote" | "thread" | "history";
  },
): Promise<T[]> {
  const results: Array<T | undefined> = await Promise.all(
    messages.map(async (message) =>
      (await shouldIncludeFetchedGroupContextMessage({
        cfg: params.cfg,
        accountId: params.accountId,
        chatId: params.chatId,
        isGroup: params.isGroup,
        allowFrom: params.allowFrom,
        mode: params.mode,
        kind: params.kind,
        senderId: message.senderId,
        senderType: message.senderType,
      }))
        ? message
        : undefined,
    ),
  );
  return results.filter((message): message is T => message !== undefined);
}

export async function handleFeishuMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  preparedContent?: string;
  sourceMessages?: TaskSource[];
  botOpenId?: string;
  botName?: string;
  runtime?: RuntimeEnv;
  channelRuntime?: ReturnType<typeof getFeishuRuntime>["channel"];
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
  processingClaim?: FeishuMessageProcessingClaim;
  messageDedupeKey?: string;
  turnAdoptionLifecycle?: FeishuIngressLifecycle;
  onDispatchReady?: () => void;
}): Promise<void> {
  const {
    event,
    preparedContent,
    botOpenId,
    botName,
    runtime,
    channelRuntime,
    chatHistories,
    accountId,
    processingClaim,
    messageDedupeKey: messageDedupeKeyOverride,
    turnAdoptionLifecycle,
  } = params;

  // Resolve each turn from live config; DMs reauthorize after awaited work below.
  // SAFETY: config.current() returns the canonical host-validated ClawdbotConfig.
  const cfg = getFeishuRuntime().config.current() as ClawdbotConfig;
  // Resolve account with merged config
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const feishuCfg = account.config;

  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const messageId = event.message.message_id;
  const messageDedupeKey = messageDedupeKeyOverride ?? resolveFeishuMessageDedupeKey(event);
  if (
    !turnAdoptionLifecycle &&
    !(await finalizeFeishuMessageProcessing({
      messageId: messageDedupeKey,
      namespace: account.accountId,
      log,
      processingClaim,
    }))
  ) {
    log(`feishu: skipping duplicate message ${messageId}`);
    return;
  }

  let ctx = parseFeishuMessageEvent(event, botOpenId, botName, preparedContent);
  const explicitlyMentioned = ctx.mentionedBot;
  const isGroup = isFeishuGroupChatType(ctx.chatType);
  const isDirect = !isGroup;
  const directPreDispatchTarget = isDirect
    ? getFeishuSyntheticDirectPreDispatchTarget(event)
    : undefined;
  const senderUserId = normalizeOptionalString(event.sender.sender_id.user_id);
  const localBotOpenId = botOpenId?.trim();

  if (ctx.senderType === "bot") {
    if (!localBotOpenId) {
      log(
        `feishu[${account.accountId}]: dropping bot message ${ctx.messageId} (local bot identity unavailable)`,
      );
      return;
    }
    if (ctx.senderOpenId === localBotOpenId) {
      log(`feishu[${account.accountId}]: dropping self-authored bot message ${ctx.messageId}`);
      return;
    }
    if (feishuCfg?.allowBots !== true) {
      log(`feishu[${account.accountId}]: dropping bot message ${ctx.messageId} (allowBots=false)`);
      return;
    }
    // Feishu also offers a broad other-bot event scope, so delivery alone does not prove this
    // bot was addressed. Re-read mismatched mentions with this app's token because open_ids are
    // app-scoped (#40768); names are not stable recipient identities.
    if (isGroup && !ctx.mentionedBot) {
      let verifiedEvent: FeishuMessageEvent | undefined;
      try {
        const response = (await createFeishuClient(account).im.message.get({
          params: { user_id_type: "open_id" },
          path: { message_id: ctx.messageId },
        })) as {
          code?: number;
          data?: {
            items?: Array<{
              mentions?: Array<{ key?: string; id?: string; id_type?: string }>;
            }>;
          };
        };
        const verifiedMention = response.data?.items?.[0]?.mentions?.find(
          (mention) =>
            mention.id_type === "open_id" &&
            mention.id === localBotOpenId &&
            Boolean(mention.key?.trim()),
        );
        const verifiedKey = verifiedMention?.key?.trim();
        if (response.code === 0 && verifiedKey) {
          const eventMention = event.message.mentions?.find(
            (mention) => mention.key === verifiedKey && !isFeishuBroadcastMention(mention),
          );
          if (eventMention) {
            verifiedEvent = {
              ...event,
              message: {
                ...event.message,
                mentions: event.message.mentions?.map((mention) =>
                  mention === eventMention
                    ? { ...mention, id: { ...mention.id, open_id: localBotOpenId } }
                    : mention,
                ),
              },
            };
          }
        }
      } catch (err) {
        log(
          `feishu[${account.accountId}]: failed to verify bot mention for ${ctx.messageId}: ${String(err)}`,
        );
      }
      if (!verifiedEvent) {
        log(
          `feishu[${account.accountId}]: dropping bot message ${ctx.messageId} (local mention not verifiable)`,
        );
        return;
      }
      const deliveredCtx = parseFeishuMessageEvent(
        verifiedEvent,
        localBotOpenId,
        botName,
        preparedContent,
      );
      ctx = {
        ...deliveredCtx,
        mentionedBot: true,
        content: normalizeFeishuCommandProbeBody(deliveredCtx.content),
        // App-scoped IDs cannot safely identify additional recipients here.
        mentionTargets: undefined,
      };
    }
  }

  // Handle merge_forward messages: fetch full message via API then expand sub-messages
  if (event.message.message_type === "merge_forward") {
    log(
      `feishu[${account.accountId}]: processing merge_forward message, fetching full content via API`,
    );
    try {
      const messageInfo = await getMessageFeishu({
        cfg,
        messageId: event.message.message_id,
        accountId: account.accountId,
      });
      if (messageInfo) {
        ctx = { ...ctx, content: messageInfo.content };
      } else {
        log(`feishu[${account.accountId}]: merge_forward message retrieval returned no result`);
        ctx = { ...ctx, content: "[Merged and Forwarded Message - could not fetch]" };
      }
    } catch (err) {
      log(`feishu[${account.accountId}]: merge_forward fetch failed: ${String(err)}`);
      ctx = { ...ctx, content: "[Merged and Forwarded Message - fetch error]" };
    }
  }

  // Resolve sender display name (best-effort) so the agent can attribute messages correctly.
  // Optimization: skip if disabled to save API quota (Feishu free tier limit).
  let colleagueDirectory: Awaited<ReturnType<typeof resolveFeishuSenderName>> = {};
  let permissionErrorForAgent: FeishuPermissionError | undefined;
  if (feishuCfg?.resolveSenderNames ?? true) {
    if (ctx.senderType === "bot") {
      const senderName = await resolveFeishuBotName({
        account,
        openId: ctx.senderOpenId,
        log,
      });
      if (senderName) {
        ctx = { ...ctx, senderName };
      }
    } else {
      const senderResult = await resolveFeishuSenderName({
        account,
        senderId: ctx.senderOpenId,
        log,
      });
      colleagueDirectory = senderResult;
      if (senderResult.name) {
        ctx = { ...ctx, senderName: senderResult.name };
      }

      // Track permission error to inform agent later (with cooldown to avoid repetition)
      if (senderResult.permissionError) {
        const appKey = account.appId ?? "default";
        const now = Date.now();
        const lastNotified = permissionErrorNotifiedAt.get(appKey) ?? 0;

        if (now - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
          permissionErrorNotifiedAt.set(appKey, now);
          permissionErrorForAgent = senderResult.permissionError;
        }
      }
    }
  }

  log(
    `feishu[${account.accountId}]: received message from ${ctx.senderOpenId} in ${ctx.chatId} (${ctx.chatType})`,
  );

  // Log mention targets if detected
  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const names = ctx.mentionTargets.map((t) => t.name).join(", ");
    log(`feishu[${account.accountId}]: detected @ forward request, targets: [${names}]`);
  }

  const historyLimit = Math.max(
    0,
    feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupConfig = isGroup
    ? resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId })
    : undefined;
  const groupSessionScope = isGroup
    ? resolveConfiguredFeishuGroupSessionScope({ groupConfig, feishuCfg })
    : null;
  let effectiveThreadId = ctx.threadId;
  if (
    isGroup &&
    ctx.chatType === "topic_group" &&
    !effectiveThreadId &&
    isFeishuTopicSessionScope(groupSessionScope ?? "group")
  ) {
    // Synthetic turns keep a local dedupe ID in messageId; their explicit reply target is
    // the real Feishu message ID that topic hydration can send back to the provider.
    const topicHydrationMessageId = ctx.replyTargetMessageId ?? ctx.messageId;
    try {
      const messageInfo = await getMessageFeishu({
        cfg,
        accountId: account.accountId,
        messageId: topicHydrationMessageId,
      });
      const hydratedThreadId = messageInfo?.threadId?.trim();
      if (hydratedThreadId) {
        ctx = { ...ctx, threadId: hydratedThreadId };
        effectiveThreadId = hydratedThreadId;
        log(
          `feishu[${account.accountId}]: hydrated topic thread_id=${hydratedThreadId} for message=${topicHydrationMessageId}`,
        );
      }
    } catch (err) {
      log(
        `feishu[${account.accountId}]: failed to hydrate topic thread_id for message=${topicHydrationMessageId}: ${String(err)}`,
      );
    }
  }
  const effectiveGroupSenderAllowFrom = isGroup
    ? (groupConfig?.allowFrom?.length ?? 0) > 0
      ? (groupConfig?.allowFrom ?? [])
      : (feishuCfg?.groupSenderAllowFrom ?? [])
    : [];
  const groupSession = isGroup
    ? resolveFeishuGroupSession({
        chatId: ctx.chatId,
        senderOpenId: ctx.senderOpenId,
        messageId: ctx.messageId,
        rootId: ctx.rootId,
        threadId: effectiveThreadId,
        chatType: ctx.chatType,
        groupConfig,
        feishuCfg,
      })
    : null;
  const groupHistoryKey = isGroup ? (groupSession?.peerId ?? ctx.chatId) : undefined;
  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const rawBroadcastAgents = isGroup ? resolveBroadcastAgents(cfg, ctx.chatId) : null;
  const broadcastAgents = rawBroadcastAgents
    ? uniqueStrings(rawBroadcastAgents.map((id) => normalizeAgentId(id)))
    : null;

  // Parse message create_time early so every downstream consumer (pending
  // history, inbound payload, etc.) uses the original authoring timestamp
  // instead of the delivery/processing time.  Feishu uses a millisecond
  // epoch string; fall back to Date.now() when absent or malformed.
  const messageCreateTimeMs =
    parseStrictNonNegativeInteger(event.message.create_time) ?? Date.now();

  let requireMention = false; // DMs never require mention; groups may override below
  let activationQuoteChain: Awaited<ReturnType<typeof loadQuoteChain>> | undefined;
  let activationQuoteVisibilityMode: "all" | "allowlist" | "allowlist_quote" | undefined;
  const readCurrentQuoteChain = (parentId: string, mode: "all" | "allowlist" | "allowlist_quote", requireSameChat = false) => loadQuoteChain({
    parentId, currentMessageId: ctx.messageId, chatId: ctx.chatId,
    maxDepth: feishuCfg?.quoteChain?.maxDepth, readMaxChars: feishuCfg?.historySummary?.maxInputChars ?? 200000,
    fetch: messageId => getMessageFeishu({ cfg, messageId, accountId: account.accountId }),
    visible: async message => (!requireSameChat || message.chatId === ctx.chatId) &&
      await shouldIncludeFetchedGroupContextMessage({
        cfg, accountId: account.accountId, chatId: ctx.chatId, isGroup,
        allowFrom: effectiveGroupSenderAllowFrom, mode, kind: "quote",
        senderId: message.senderId, senderType: message.senderType,
      }),
  });
  if (isGroup) {
    if (groupConfig?.enabled === false) {
      log(`feishu[${account.accountId}]: group ${ctx.chatId} is disabled`);
      return;
    }
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.feishu !== undefined,
      groupPolicy: feishuCfg?.groupPolicy,
      defaultGroupPolicy,
    });
    warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied,
      providerKey: "feishu",
      accountId: account.accountId,
      log,
    });
    const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
    // DEBUG: log(`feishu[${account.accountId}]: groupPolicy=${groupPolicy}`);

    // A group explicitly configured under `channels.feishu.groups.<chat_id>` is
    // treated as admitted in allowlist mode even when `groupAllowFrom` is empty.
    // Wildcard defaults still configure matching groups, but they are not an
    // admission signal by themselves.
    const groupExplicitlyConfigured = hasExplicitFeishuGroupConfig({
      cfg: feishuCfg,
      groupId: ctx.chatId,
    });

    const groupIngress = await resolveFeishuGroupConversationIngressAccess({
      cfg,
      accountId: account.accountId,
      chatId: ctx.chatId,
      groupPolicy,
      groupAllowFrom,
      groupExplicitlyConfigured,
    });

    if (groupIngress.ingress.admission !== "dispatch") {
      log(
        `feishu[${account.accountId}]: group ${ctx.chatId} not in groupAllowFrom (groupPolicy=${groupPolicy})`,
      );
      return;
    }

    ({ requireMention } = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      cfg,
      accountId: account.accountId,
      groupId: ctx.chatId,
      groupPolicy,
    }));

    let groupSenderActivationIngress = await resolveFeishuGroupSenderActivationIngressAccess({
      cfg,
      accountId: account.accountId,
      chatId: ctx.chatId,
      allowFrom: effectiveGroupSenderAllowFrom,
      senderOpenId: ctx.senderOpenId,
      senderUserId,
      requireMention,
      mentionedBot: ctx.mentionedBot,
    });
    if (groupSenderActivationIngress.senderAccess.decision !== "allow") {
      log(`feishu: sender ${ctx.senderOpenId} not in group ${ctx.chatId} sender allowlist`);
      return;
    }
    const conversationWindow = groupConfig?.conversationWindow ?? feishuCfg?.conversationWindow;
    if (requireMention && conversationWindow?.enabled && ctx.senderType !== "bot" && !broadcastAgents) {
      try {
        let replyChainMentionsBot = false;
        // Only approved senders can activate through visible native mentions in the
        // actual parent chain. Keep the current message's direct-mention fact intact.
        if (!ctx.mentionedBot && !ctx.hasAnyMention && ctx.parentId && localBotOpenId) {
          const mode: "all" | "allowlist" | "allowlist_quote" = resolveChannelContextVisibilityMode({ cfg, channel: "feishu", accountId: account.accountId });
          activationQuoteVisibilityMode = mode;
          activationQuoteChain = await readCurrentQuoteChain(ctx.parentId, mode, true);
          replyChainMentionsBot = activationQuoteChain.messages.some(message =>
            message.mentionedOpenIds?.includes(localBotOpenId) ||
            (account.appId && message.mentionedAppIds?.includes(account.appId)));
        }
        const accepted = await admitConversationWindow({
          accountId: account.accountId, chatId: ctx.chatId, senderOpenId: ctx.senderOpenId,
          messageId: ctx.messageId, timestamp: messageCreateTimeMs, text: ctx.content,
          rootId: ctx.rootId, threadId: effectiveThreadId, contentType:event.message.message_type,
          mentionedBot: ctx.mentionedBot, replyChainMentionsBot,
          mentionsOthers: Boolean(ctx.hasAnyMention && !ctx.mentionedBot), isBot: false,
        }, conversationWindow.durationSeconds ?? 600);
        if (activationQuoteChain) {
          log(`feishu[${account.accountId}]: reply chain activation ${JSON.stringify({
            count: activationQuoteChain.messages.length, incomplete: !!activationQuoteChain.notice,
            matched: replyChainMentionsBot, accepted,
          })}`);
        }
        if (accepted && !ctx.mentionedBot) {
          requireMention = false;
          groupSenderActivationIngress = await resolveFeishuGroupSenderActivationIngressAccess({
            cfg, accountId: account.accountId, chatId: ctx.chatId,
            allowFrom: effectiveGroupSenderAllowFrom, senderOpenId: ctx.senderOpenId,
            senderUserId, requireMention, mentionedBot: ctx.mentionedBot,
          });
        }
      } catch { log(`feishu[${account.accountId}]: conversation window unavailable; keeping mention policy`); }
    }
    if (groupSenderActivationIngress.ingress.admission !== "dispatch") {
      log(`feishu[${account.accountId}]: message in group ${ctx.chatId} did not mention bot`);
      // Record to pending history for non-broadcast groups only. For broadcast groups,
      // the mentioned handler's broadcast dispatch writes the turn directly into all
      // agent sessions — buffering here would cause duplicate replay when this account
      // later becomes active via the channel history window.
      if (!broadcastAgents && chatHistories && groupHistoryKey) {
        createChannelHistoryWindow({ historyMap: chatHistories }).record({
          historyKey: groupHistoryKey,
          limit: historyLimit,
          entry: {
            sender: ctx.senderOpenId,
            body: `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`,
            timestamp: messageCreateTimeMs,
            messageId: ctx.messageId,
          },
        });
      }
      return;
    }

    if (ctx.senderType === "bot") {
      if (!localBotOpenId || !ctx.senderOpenId) {
        log(
          `feishu[${account.accountId}]: dropping bot message ${ctx.messageId} (loop identity unavailable)`,
        );
        return;
      }
      const loopResult = recordChannelBotPairLoopAndCheckSuppression({
        scopeId: account.accountId,
        conversationId: ctx.chatId,
        senderId: ctx.senderOpenId,
        receiverId: localBotOpenId,
        defaultsConfig: cfg.channels?.defaults?.botLoopProtection,
        defaultEnabled: true,
      });
      if (loopResult.suppressed) {
        log(
          `feishu[${account.accountId}]: bot-pair loop suppressed for ${ctx.senderOpenId} in ${ctx.chatId}`,
        );
        return;
      }
    }
  }

  try {
    const core = {
      channel: channelRuntime?.inbound ? channelRuntime : getFeishuRuntime().channel,
    } as ReturnType<typeof getFeishuRuntime>;
    const pairing = createChannelPairingController({
      core,
      channel: "feishu",
      accountId: account.accountId,
    });
    const commandProbeBody = isGroup ? normalizeFeishuCommandProbeBody(ctx.content) : ctx.content;
    const shouldComputeCommandAuthorized = core.channel.commands.shouldComputeCommandAuthorized(
      commandProbeBody,
      cfg,
    );
    const resolveDirectAuthorization = async (
      candidateCfg: ClawdbotConfig,
      mayPair: boolean,
      shouldComputeCommand = core.channel.commands.shouldComputeCommandAuthorized(
        commandProbeBody,
        candidateCfg,
      ),
    ) => {
      const candidateAccount = resolveFeishuRuntimeAccount({
        cfg: candidateCfg,
        accountId: account.accountId,
      });
      const candidateDmPolicy = candidateAccount.config.dmPolicy ?? "pairing";
      const candidateConfigAllowFrom = candidateAccount.config.allowFrom ?? [];
      const ingress = await resolveFeishuDmIngressAccess({
        cfg: candidateCfg,
        accountId: candidateAccount.accountId,
        dmPolicy: candidateDmPolicy,
        allowFrom: candidateConfigAllowFrom,
        readAllowFromStore: pairing.readAllowFromStore,
        senderOpenId: ctx.senderOpenId,
        senderUserId,
        conversationId: ctx.senderOpenId,
        mayPair,
        ...(shouldComputeCommand ? { command: { hasControlCommand: true } } : {}),
      });
      return {
        cfg: candidateCfg,
        dmPolicy: candidateDmPolicy,
        configAllowFrom: candidateConfigAllowFrom,
        ingress,
        shouldComputeCommandAuthorized: shouldComputeCommand,
      };
    };
    const rejectDirectAuthorization = async (
      authorization: Awaited<ReturnType<typeof resolveDirectAuthorization>>,
    ) => {
      if (authorization.ingress.ingress.admission === "pairing-required") {
        await pairing.issueChallenge({
          senderId: ctx.senderOpenId,
          senderIdLine: `Your Feishu user id: ${ctx.senderOpenId}`,
          meta: { name: ctx.senderName },
          onCreated: () => {
            log(`feishu[${account.accountId}]: pairing request sender=${ctx.senderOpenId}`);
          },
          sendPairingReply: async (text) => {
            await sendMessageFeishu({
              cfg: authorization.cfg,
              to: directPreDispatchTarget ?? `chat:${ctx.chatId}`,
              text,
              accountId: account.accountId,
            });
          },
          onReplyError: (err) => {
            log(
              `feishu[${account.accountId}]: pairing reply failed for ${ctx.senderOpenId}: ${String(err)}`,
            );
          },
        });
      } else {
        log(
          `feishu[${account.accountId}]: blocked unauthorized sender ${ctx.senderOpenId} ` +
            `(dmPolicy=${authorization.dmPolicy})`,
        );
      }
    };
    const directAuthorization = isDirect
      ? await resolveDirectAuthorization(cfg, true, shouldComputeCommandAuthorized)
      : null;
    const dmIngress = directAuthorization?.ingress ?? null;
    if (isDirect && dmIngress?.ingress.admission !== "dispatch") {
      if (directAuthorization) {
        await rejectDirectAuthorization(directAuthorization);
      }
      return;
    }
    let effectiveDmPolicy = directAuthorization?.dmPolicy ?? dmPolicy;
    let effectiveConfigAllowFrom = directAuthorization?.configAllowFrom ?? configAllowFrom;
    let effectiveDmIngress = dmIngress;
    let effectiveShouldComputeCommandAuthorized =
      directAuthorization?.shouldComputeCommandAuthorized ?? shouldComputeCommandAuthorized;
    let effectiveCfg = cfg;
    if (isDirect) {
      const currentCfg = getFeishuRuntime().config.current() as ClawdbotConfig;
      if (currentCfg !== effectiveCfg) {
        const currentAuthorization = await resolveDirectAuthorization(currentCfg, true);
        if (currentAuthorization.ingress.ingress.admission !== "dispatch") {
          await rejectDirectAuthorization(currentAuthorization);
          return;
        }
        effectiveCfg = currentCfg;
        effectiveDmPolicy = currentAuthorization.dmPolicy;
        effectiveConfigAllowFrom = currentAuthorization.configAllowFrom;
        effectiveDmIngress = currentAuthorization.ingress;
        effectiveShouldComputeCommandAuthorized =
          currentAuthorization.shouldComputeCommandAuthorized;
      }
    }

    // In group chats, the session is scoped to the group, but the *speaker* is the sender.
    // Using a group-scoped From causes the agent to treat different users as the same person.
    const feishuFrom = `feishu:${ctx.senderOpenId}`;
    const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
    // Reply in the inbound conversation while keeping DM routing/session identity sender-scoped.
    // Synthetic menu and card-action events do not always carry a real Feishu chat ID.
    const feishuReplyTarget = ctx.chatId.startsWith("oc_") ? `chat:${ctx.chatId}` : feishuTo;
    const peerId = isGroup ? (groupSession?.peerId ?? ctx.chatId) : ctx.senderOpenId;
    const parentPeer = isGroup ? (groupSession?.parentPeer ?? null) : null;
    const directThreadReply = !isGroup && Boolean(ctx.threadId?.trim());
    const defaultReplyTargetMessageId =
      ctx.replyTargetMessageId ?? (ctx.suppressReplyTarget ? undefined : ctx.messageId);
    const directThreadRootId = directThreadReply ? ctx.rootId?.trim() || undefined : undefined;
    const directThreadReplyTargetMessageId = directThreadReply
      ? (directThreadRootId ?? defaultReplyTargetMessageId)
      : undefined;
    const replyInThread = isGroup ? (groupSession?.replyInThread ?? false) : directThreadReply;
    const feishuAcpConversationSupported =
      !isGroup ||
      groupSession?.groupSessionScope === "group_topic" ||
      groupSession?.groupSessionScope === "group_topic_sender";

    if (isGroup && groupSession) {
      log(
        `feishu[${account.accountId}]: group session scope=${groupSession.groupSessionScope}, peer=${peerId}`,
      );
    }

    let route = core.channel.routing.resolveAgentRoute({
      cfg: effectiveCfg,
      channel: "feishu",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId,
      },
      parentPeer,
    });

    // Refresh a binding written after this request snapshot, or create the DM's
    // dynamic agent when the current account policy enables it.
    if (!isGroup && route.matchedBy === "default") {
      const runtimeLocal = getFeishuRuntime();
      const result = await maybeCreateDynamicAgent({
        cfg: effectiveCfg,
        runtime: runtimeLocal,
        accountId: account.accountId,
        senderOpenId: ctx.senderOpenId,
        canCreateForConfig: async (candidateCfg) => {
          const authorization = await resolveDirectAuthorization(candidateCfg, false);
          return authorization.ingress.ingress.admission === "dispatch";
        },
        log: (msg) => log(msg),
      });
      if (result.created || result.updatedCfg !== effectiveCfg) {
        const refreshedAuthorization = await resolveDirectAuthorization(result.updatedCfg, false);
        if (refreshedAuthorization.ingress.ingress.admission !== "dispatch") {
          log(
            `feishu[${account.accountId}]: current policy rejected stale DM from ${ctx.senderOpenId} ` +
              `before adopting refreshed dynamic route (dmPolicy=${refreshedAuthorization.dmPolicy})`,
          );
          return;
        }
        effectiveCfg = result.updatedCfg;
        effectiveDmPolicy = refreshedAuthorization.dmPolicy;
        effectiveConfigAllowFrom = refreshedAuthorization.configAllowFrom;
        effectiveDmIngress = refreshedAuthorization.ingress;
        effectiveShouldComputeCommandAuthorized =
          refreshedAuthorization.shouldComputeCommandAuthorized;
        route = core.channel.routing.resolveAgentRoute({
          cfg: result.updatedCfg,
          channel: "feishu",
          accountId: account.accountId,
          peer: { kind: "direct", id: ctx.senderOpenId },
        });
        if (result.created) {
          log(
            `feishu[${account.accountId}]: dynamic agent created, new route: ${route.sessionKey}`,
          );
        }
      }
    }

    const commandAllowFrom = isGroup
      ? (groupConfig?.allowFrom ?? effectiveConfigAllowFrom)
      : (effectiveDmIngress?.senderAccess.effectiveAllowFrom ?? effectiveConfigAllowFrom);

    const currentConversationId = peerId;
    const parentConversationId = isGroup ? (parentPeer?.id ?? ctx.chatId) : undefined;
    let configuredBinding = null;
    if (feishuAcpConversationSupported) {
      const configuredRoute = resolveConfiguredBindingRoute({
        cfg: effectiveCfg,
        route,
        conversation: {
          channel: "feishu",
          accountId: account.accountId,
          conversationId: currentConversationId,
          parentConversationId,
        },
      });
      configuredBinding = configuredRoute.bindingResolution;
      route = configuredRoute.route;

      // Bound Feishu conversations intentionally require an exact live conversation-id match.
      // Sender-scoped topic sessions therefore bind on `chat:topic:root:sender:user`, while
      // configured ACP bindings may still inherit the shared `chat:topic:root` topic session.
      const runtimeRoute = resolveRuntimeConversationBindingRoute({
        route,
        conversation: {
          channel: "feishu",
          accountId: account.accountId,
          conversationId: currentConversationId,
          ...(parentConversationId ? { parentConversationId } : {}),
        },
      });
      route = runtimeRoute.route;
      if (runtimeRoute.bindingRecord) {
        configuredBinding = null;
        log(
          runtimeRoute.boundSessionKey
            ? `feishu[${account.accountId}]: routed via bound conversation ${currentConversationId} -> ${runtimeRoute.boundSessionKey}`
            : `feishu[${account.accountId}]: plugin-bound conversation ${currentConversationId}`,
        );
      }
    }

    if (configuredBinding) {
      const ensured = await ensureConfiguredBindingRouteReady({
        cfg: effectiveCfg,
        bindingResolution: configuredBinding,
      });
      if (!ensured.ok) {
        const acpTopicReply =
          isGroup &&
          (groupSession?.groupSessionScope === "group_topic" ||
            groupSession?.groupSessionScope === "group_topic_sender");
        const replyTargetMessageId = directThreadReply
          ? directThreadReplyTargetMessageId
          : acpTopicReply
            ? (ctx.rootId ?? ctx.messageId)
            : ctx.messageId;
        await sendMessageFeishu({
          cfg: effectiveCfg,
          to: directPreDispatchTarget ?? `chat:${ctx.chatId}`,
          text: `⚠️ Failed to initialize the configured ACP session for this Feishu conversation: ${ensured.error}`,
          replyToMessageId: replyTargetMessageId,
          replyInThread,
          accountId: account.accountId,
        }).catch((err: unknown) => {
          log(`feishu[${account.accountId}]: failed to send ACP init error reply: ${String(err)}`);
        });
        return;
      }
    }

    const preview = truncateUtf16Safe(ctx.content.replace(/\s+/g, " "), 160);
    const inboundLabel = isGroup
      ? `Feishu[${account.accountId}] message in group ${ctx.chatId}`
      : `Feishu[${account.accountId}] DM from ${ctx.senderOpenId}`;
    const contextVisibilityMode = resolveChannelContextVisibilityMode({
      cfg: effectiveCfg,
      channel: "feishu",
      accountId: account.accountId,
    });

    // Do not enqueue inbound user previews as system events.
    // System events are prepended to future prompts and can be misread as
    // authoritative transcript turns.
    log(`feishu[${account.accountId}]: ${inboundLabel}: ${preview}`);

    // Resolve media from message
    const mediaMaxBytes = (feishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024; // 30MB default
    const mediaList = await resolveFeishuMediaList({
      cfg,
      messageId: ctx.messageId,
      messageType: event.message.message_type,
      content: event.message.content,
      maxBytes: mediaMaxBytes,
      log,
      accountId: account.accountId,
    });
    const unavailableMediaCount = mediaList.filter((media) => !media.path).length;
    let mediaFailureContent =
      unavailableMediaCount > 0
        ? formatInboundMediaUnavailableText({
            body: ctx.content,
            notice: renderSection('AttachmentReadError', `feishu ${unavailableMediaCount} attachment(s) unavailable`),
          })
        : ctx.content;
    // Fetch quoted/replied message content before the empty-message guard
    // so a reply with only @bot (no text, no media) is not dropped when
    // the quoted message carries meaningful content.
    let quotedMessageInfo: Awaited<ReturnType<typeof getMessageFeishu>> = null;
    let quotedContent: string | undefined;
    let quoteChainMessages: NonNullable<Awaited<ReturnType<typeof getMessageFeishu>>>[] = [];
    let quoteChainContext = "";
    if (ctx.parentId && !resolveFeishuReadOnlyCommand(ctx.content, effectiveCfg)) {
      const chain = activationQuoteChain && activationQuoteVisibilityMode === contextVisibilityMode
        ? activationQuoteChain : await readCurrentQuoteChain(ctx.parentId, contextVisibilityMode);
      quoteChainMessages = chain.messages;
      quotedMessageInfo = chain.messages[0] ?? null;
      quotedContent = quotedMessageInfo?.content;
      quoteChainContext = chain.notice;
      log(`feishu[${account.accountId}]: quote chain ${JSON.stringify({count: chain.messages.length, incomplete: !!chain.notice})}`);
    }

    // Skip messages with no text content, no media attachments, and no quoted
    // content. Feishu can deliver empty-text events (e.g. `{"text":""}`) when
    // a user sends a blank message or when media parsing produces an empty
    // string. Writing a blank user turn to the session causes downstream LLM
    // providers (e.g. MiniMax) to reject the request with "messages must not
    // be empty" errors. Logging the skip avoids silent loss without polluting
    // the agent session. Quoted content is checked too so a reply-only @bot
    // with quoted context is not dropped.
    if (!mediaFailureContent.trim() && mediaList.length === 0 && !quotedContent?.trim() &&
        isGroup && explicitlyMentioned && ctx.senderType === "user" && feishuCfg?.mentionHistory?.enabled !== false) {
      mediaFailureContent = renderContextData('RequestFeatures', {mentionOnly: true});
    }
    if (!mediaFailureContent.trim() && mediaList.length === 0 && !quotedContent?.trim()) {
      if (isGroup && ctx.mentionedBot && ctx.senderType === "user") {
        const greeting = groupConfig?.mentionGreeting ?? feishuCfg?.mentionGreeting ??
          "我在，想让我帮你做什么？请直接告诉我具体问题或任务。";
        await sendMessageFeishu({
          cfg: effectiveCfg,
          to: `chat:${ctx.chatId}`,
          text: greeting,
          replyToMessageId: ctx.replyTargetMessageId ?? ctx.messageId,
          replyInThread,
          accountId: account.accountId,
        });
        turnAdoptionLifecycle?.onAdoptionFinalizing?.();
        await turnAdoptionLifecycle?.onAdopted?.();
        if ((groupConfig?.conversationWindow ?? feishuCfg?.conversationWindow)?.enabled) {
          try {
            getConversationWindowStore().reply(
              windowKey({ accountId: account.accountId, chatId: ctx.chatId, senderOpenId: ctx.senderOpenId }),
              ctx.messageId, greeting, Date.now(),
            );
          } catch { log(`feishu[${account.accountId}]: could not retain greeting context`); }
        }
        return;
      }
      log(
        `feishu[${account.accountId}]: skipping empty message (no text, no media, no quoted) from ${ctx.senderOpenId}`,
      );
      return;
    }

    const audioTranscript = await resolveFeishuAudioTranscript({
      cfg: effectiveCfg,
      mediaList,
      content: ctx.content,
      messageType: event.message.message_type,
      chatType: isGroup ? "group" : "direct",
      log,
    });
    const transcribedAudioIndex =
      audioTranscript === undefined
        ? -1
        : mediaList.findIndex(
            (media) => media.kind === "audio" || media.contentType?.startsWith("audio/"),
          );
    const inboundMedia = await toInboundMediaFactsWithMetadata(mediaList, {
      transcribed: (_media, index) => index === transcribedAudioIndex,
    });
    const requiredMentionTargets =
      isGroup && ctx.senderType === "bot" && ctx.senderOpenId
        ? [
            {
              openId: ctx.senderOpenId,
              name: ctx.senderName ?? ctx.senderOpenId,
              key: "",
            },
          ]
        : undefined;
    const agentFacingContent = audioTranscript ?? mediaFailureContent;
    const commandFacingContent = audioTranscript ?? ctx.content;
    const readOnlyCommand = ctx.senderType !== "bot"
      ? resolveFeishuReadOnlyCommand(commandFacingContent, effectiveCfg) : undefined;
    const isControlTurn = Boolean(readOnlyCommand) || isAbortRequestText(commandFacingContent) ||
      isBtwRequestText(commandFacingContent) || /^\/(?:stop|abort|status)(?:@[\w-]+)?(?:\s|$)/i.test(commandFacingContent.trim());
    const agentFacingCtx =
      agentFacingContent === ctx.content
        ? ctx
        : {
            ...ctx,
            content: agentFacingContent,
          };
    const effectiveCommandProbeBody =
      audioTranscript === undefined
        ? commandProbeBody
        : isGroup
          ? normalizeFeishuCommandProbeBody(audioTranscript)
          : audioTranscript;
    const shouldComputeEffectiveCommandAuthorized =
      audioTranscript === undefined
        ? effectiveShouldComputeCommandAuthorized
        : core.channel.commands.shouldComputeCommandAuthorized(
            effectiveCommandProbeBody,
            effectiveCfg,
          );
    const commandAuthorized = shouldComputeEffectiveCommandAuthorized
      ? isDirect && audioTranscript === undefined && effectiveDmIngress
        ? effectiveDmIngress.commandAccess.authorized
        : isGroup
          ? (
              await resolveFeishuGroupSenderActivationIngressAccess({
                cfg: effectiveCfg,
                accountId: account.accountId,
                chatId: ctx.chatId,
                allowFrom: commandAllowFrom,
                senderOpenId: ctx.senderOpenId,
                senderUserId,
                requireMention: false,
                mentionedBot: true,
                command: { hasControlCommand: true },
              })
            ).commandAccess.authorized
          : (
              await resolveFeishuDmIngressAccess({
                cfg: effectiveCfg,
                accountId: account.accountId,
                dmPolicy: effectiveDmPolicy,
                allowFrom: effectiveConfigAllowFrom,
                readAllowFromStore: pairing.readAllowFromStore,
                senderOpenId: ctx.senderOpenId,
                senderUserId,
                conversationId: ctx.senderOpenId,
                mayPair: false,
                command: { hasControlCommand: true },
              })
            ).commandAccess.authorized
      : undefined;

    const isTopicSessionForThread =
      isGroup &&
      (groupSession?.groupSessionScope === "group_topic" ||
        groupSession?.groupSessionScope === "group_topic_sender");

    const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
    let messageBody = buildFeishuAgentBody({
      ctx: agentFacingCtx,
      permissionErrorForAgent,
      botOpenId,
    });
    const messageIdentity = isGroup ? contextMessageMarker({accountId: account.accountId, chatId: ctx.chatId},
      parseFeishuMessageItem({message_id: ctx.messageId, chat_id: ctx.chatId,
        msg_type: event.message.message_type, body: {content: event.message.content},
        sender: {id: ctx.senderOpenId, sender_type: event.sender.sender_type},
      })) : "";
    let profile: ReturnType<ColleagueProfiles["snapshot"]>;
    let profileNotice = "";
    if (ctx.senderType !== 'bot' && !readOnlyCommand) {
      try {
        const profiles = new ColleagueProfiles(feishuCfg?.colleagueProfile?.storagePath ?? getFeishuRuntime().state.resolveStateDir() + '/feishu-colleagues/preferences.sqlite', feishuCfg?.colleagueProfile);
        profile = profiles.snapshot({accountId:account.accountId, appId:account.appId,
          senderOpenId:ctx.senderOpenId, name:ctx.senderName, ...colleagueDirectory, text:ctx.content});
      } catch {
        log('feishu: colleague preferences unavailable; continuing without personalization');
        profileNotice = '\n' + renderContextData('ParticipantProfileUnavailable', {status:'unavailable'});
      }
    }
    const departmentStyleContext = ctx.senderType === "bot" ? "" : buildDepartmentReplyStyleContext({
      senderOpenId: ctx.senderOpenId,
      departments: colleagueDirectory.departments,
      rules: feishuCfg?.departmentReplyStyles,
    });
    messageBody = renderInputContext({sender:profileNotice, style:departmentStyleContext, identity:messageIdentity, current:messageBody});
    const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderOpenId}` : ctx.senderOpenId;
    if (permissionErrorForAgent) {
      // Keep the notice in a single dispatch to avoid duplicate replies (#27372).
      log(`feishu[${account.accountId}]: appending permission error notice to message body`);
    }

    const useMentionHistory = !readOnlyCommand && isGroup && (explicitlyMentioned || !!ctx.parentId) && ctx.senderType !== "bot" && feishuCfg?.mentionHistory?.enabled !== false;
    if (useMentionHistory) {
      messageBody = (await loadMentionHistory({
        cfg, accountId: account.accountId, chatId: ctx.chatId,
        botAppId: account.appId, botOpenId, currentMessageId: ctx.messageId, beforeMs: messageCreateTimeMs,
        limit: feishuCfg?.mentionHistory?.limit, maxChars: feishuCfg?.mentionHistory?.maxChars, deferBudget: true,
        recentLimit: feishuCfg?.mentionHistory?.recentLimit,
        quoteBefore: feishuCfg?.mentionHistory?.quoteBefore, quoteAfter: feishuCfg?.mentionHistory?.quoteAfter,
        quote: quotedContent !== undefined && quotedMessageInfo?.createTime !== undefined
          ? {messageId: quotedMessageInfo.messageId, createTime: quotedMessageInfo.createTime} : undefined,
        relation: {rootId:ctx.rootId, threadId:effectiveThreadId, parentId:ctx.parentId},
        report: stats => log(`feishu: input history ${JSON.stringify(stats)}`),
        filter: (messages) => filterFetchedGroupContextMessages(messages, {
          cfg, accountId: account.accountId, chatId: ctx.chatId, isGroup,
          allowFrom: effectiveGroupSenderAllowFrom, mode: contextVisibilityMode, kind: "history",
        }),
      })) + "\n" + messageBody;
    }

    const body = formatAgentEnvelope({
      channel: "Feishu",
      from: envelopeFrom,
      timestamp: messageCreateTimeMs,
      envelope: envelopeOptions,
      body: messageBody,
    });

    let combinedBody = body;
    let activeWindowContext = "";
    const historyKey = groupHistoryKey;

    if (!readOnlyCommand && !useMentionHistory && isGroup && historyKey && chatHistories) {
      const channelHistory = createChannelHistoryWindow({ historyMap: chatHistories });
      combinedBody = channelHistory.buildPendingContext({
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          formatAgentEnvelope({
            channel: "Feishu",
            // Preserve speaker identity in group history as well.
            from: `${ctx.chatId}:${entry.sender}`,
            timestamp: entry.timestamp,
            body: entry.body,
            envelope: envelopeOptions,
          }),
      });
    }

    if (!readOnlyCommand && !useMentionHistory && isGroup && (groupConfig?.conversationWindow ?? feishuCfg?.conversationWindow)?.enabled && !broadcastAgents) {
      try {
        const recent = getConversationWindowStore().recentGroup({accountId:account.accountId,chatId:ctx.chatId,messageId:ctx.messageId},Date.now());
        if (recent.length) activeWindowContext = prepareHistory(recent.filter(m => m.senderOpenId !== botOpenId && m.timestamp <= messageCreateTimeMs).map(m => ({
          messageId:m.messageId,senderId:m.senderOpenId,senderType:"user",contentType:m.contentType ?? "text",content:m.text,createTime:m.timestamp,rootId:m.rootId,threadId:m.threadId,
        })), {relation:{rootId:ctx.rootId,threadId:effectiveThreadId,parentId:ctx.parentId},maxChars:Infinity,
          report:stats => log(`feishu: input history ${JSON.stringify(stats)}`)}) + '\n';
        combinedBody = activeWindowContext + combinedBody;
      } catch { log(`feishu[${account.accountId}]: could not read active group context`); }
    }

    const inboundHistory =
      !readOnlyCommand && !useMentionHistory && isGroup && historyKey && historyLimit > 0 && chatHistories
        ? createChannelHistoryWindow({ historyMap: chatHistories }).buildInboundHistory({
            historyKey,
            limit: historyLimit,
          })
        : undefined;

    const threadContextBySessionKey = new Map<
      string,
      {
        records?: HistoryMessage[];
        threadLabel?: string;
      }
    >();
    let rootMessageInfo: Awaited<ReturnType<typeof getMessageFeishu>> | undefined;
    let rootMessageThreadId: string | undefined;
    let rootMessageFetched = false;
    const getRootMessageInfo = async () => {
      if (!ctx.rootId) {
        return null;
      }
      if (!rootMessageFetched) {
        rootMessageFetched = true;
        if (ctx.rootId === ctx.parentId && quotedMessageInfo) {
          rootMessageInfo = quotedMessageInfo;
        } else {
          try {
            rootMessageInfo = await getMessageFeishu({
              cfg,
              messageId: ctx.rootId,
              accountId: account.accountId,
            });
          } catch (err) {
            log(`feishu[${account.accountId}]: failed to fetch root message: ${String(err)}`);
            rootMessageInfo = null;
          }
        }
        rootMessageThreadId = rootMessageInfo?.threadId;
        if (
          rootMessageInfo &&
          !(await shouldIncludeFetchedGroupContextMessage({
            cfg,
            accountId: account.accountId,
            chatId: ctx.chatId,
            isGroup,
            allowFrom: effectiveGroupSenderAllowFrom,
            mode: contextVisibilityMode,
            kind: "thread",
            senderId: rootMessageInfo.senderId,
            senderType: rootMessageInfo.senderType,
          }))
        ) {
          log(
            `feishu[${account.accountId}]: skipped thread starter from sender ${rootMessageInfo.senderId ?? "unknown"} (mode=${contextVisibilityMode})`,
          );
          rootMessageInfo = null;
        }
      }
      return rootMessageInfo ?? null;
    };
    let groupNamePromise: Promise<string | undefined> | undefined;
    const resolveGroupNameForLabel = (): Promise<string | undefined> => {
      if (!isGroup) {
        return Promise.resolve(undefined);
      }
      groupNamePromise ??= resolveGroupName({ account, chatId: ctx.chatId, log });
      return groupNamePromise;
    };

    const resolveThreadContextForAgent = async (
      agentId: string,
      agentSessionKey: string,
      groupName: string | undefined,
    ) => {
      const cached = threadContextBySessionKey.get(agentSessionKey);
      if (cached) {
        return cached;
      }

      const threadContext: {
        records?: HistoryMessage[];
        threadLabel?: string;
      } = {
        threadLabel:
          (ctx.rootId || ctx.threadId) && isTopicSessionForThread
            ? `Feishu thread in ${groupName ?? ctx.chatId}`
            : undefined,
      };

      if (readOnlyCommand || !(ctx.rootId || ctx.threadId) || !isTopicSessionForThread) {
        threadContextBySessionKey.set(agentSessionKey, threadContext);
        return threadContext;
      }

      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      const previousThreadSessionTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: agentSessionKey,
      });
      if (previousThreadSessionTimestamp) {
        log(
          `feishu[${account.accountId}]: skipping thread bootstrap for existing session ${agentSessionKey}`,
        );
        threadContextBySessionKey.set(agentSessionKey, threadContext);
        return threadContext;
      }

      const rootMsg = await getRootMessageInfo();
      const feishuThreadId = ctx.threadId ?? rootMessageThreadId ?? rootMsg?.threadId;
      if (feishuThreadId) {
        log(`feishu[${account.accountId}]: resolved thread ID: ${feishuThreadId}`);
      }
      if (!feishuThreadId) {
        log(
          `feishu[${account.accountId}]: no threadId found for root message ${ctx.rootId ?? "none"}, skipping thread history`,
        );
        threadContextBySessionKey.set(agentSessionKey, threadContext);
        return threadContext;
      }

      try {
        const threadMessages = await listFeishuThreadMessages({
          cfg,
          threadId: feishuThreadId,
          currentMessageId: ctx.messageId,
          rootMessageId: ctx.rootId,
          limit: 20,
          accountId: account.accountId,
        });
        const senderScoped = groupSession?.groupSessionScope === "group_topic_sender";
        const senderIds = new Set(
          [ctx.senderOpenId, senderUserId]
            .map((id) => id?.trim())
            .filter((id): id is string => id !== undefined && id.length > 0),
        );
        const allowlistedMessages = await filterFetchedGroupContextMessages(threadMessages, {
          cfg,
          accountId: account.accountId,
          chatId: ctx.chatId,
          isGroup,
          allowFrom: effectiveGroupSenderAllowFrom,
          mode: contextVisibilityMode,
          kind: "history",
        });
        const relevantMessages =
          (senderScoped
            ? allowlistedMessages.filter(
                (msg) =>
                  msg.senderType === "app" ||
                  (msg.senderId !== undefined && senderIds.has(msg.senderId.trim())),
              )
            : allowlistedMessages) ?? [];

        threadContext.records = [
          ...(rootMsg ? [{...rootMsg,retention:"quote" as const,contextKinds:["thread-root"]}] : []),
          ...relevantMessages.map(msg => ({...msg,retention:"quote" as const,contextKinds:["thread"]})),
        ];
        log(`feishu[${account.accountId}]: populated unified thread context count=${threadContext.records.length}`);
      } catch (err) {
        log(`feishu[${account.accountId}]: failed to fetch thread history: ${String(err)}`);
      }

      threadContextBySessionKey.set(agentSessionKey, threadContext);
      return threadContext;
    };

    // --- Shared context builder for dispatch ---
    const summaryConfig = {...feishuCfg?.historySummary,
      triggerChars:feishuCfg?.historySummary?.triggerChars ?? Math.min(feishuCfg?.mentionHistory?.maxChars ?? 12000,feishuCfg?.quoteChain?.maxChars ?? 24000)};
    const taskPeopleByAgent = new Map<string,TaskPeople>();
    const buildCtxPayloadForAgent = async (
      agentId: string,
      agentSessionKey: string,
      agentAccountId: string,
      wasMentioned: boolean,
    ) => {
      const groupName = await resolveGroupNameForLabel();
      const threadContext = await resolveThreadContextForAgent(agentId, agentSessionKey, groupName);
      const contextBinding = {
        agentId,
        sessionKey: agentSessionKey,
        messageId: ctx.messageId,
        inboundEventKind: "user_request" as const,
      };
      // Broadcast fan-out has one final session per agent; each context needs its own bound result.
      const boundChannelIngress = isGroup
        ? await resolveFeishuGroupSenderActivationIngressAccess({
            cfg: effectiveCfg,
            accountId: account.accountId,
            chatId: ctx.chatId,
            allowFrom: effectiveGroupSenderAllowFrom,
            senderOpenId: ctx.senderOpenId,
            senderUserId,
            requireMention,
            mentionedBot: ctx.mentionedBot,
            contextBinding,
            threadId: ctx.rootId && isTopicSessionForThread ? ctx.rootId : undefined,
          })
        : await resolveFeishuDmIngressAccess({
            cfg: effectiveCfg,
            accountId: account.accountId,
            dmPolicy: effectiveDmPolicy,
            allowFrom: effectiveConfigAllowFrom,
            readAllowFromStore: pairing.readAllowFromStore,
            senderOpenId: ctx.senderOpenId,
            senderUserId,
            conversationId: ctx.senderOpenId,
            mayPair: false,
            contextBinding,
          });
      let peopleContext='';
      if(ctx.senderType!=='bot'&&!readOnlyCommand){
        try{
          const people=await collectTaskPeople({agentId,account,senderId:ctx.senderOpenId,senderName:ctx.senderName,directory:colleagueDirectory,mentions:extractMentionTargets(event,botOpenId??''),log});
          if(people) taskPeopleByAgent.set(agentId,people);
        }catch{log('feishu: Agent Repo people unavailable; continuing without people snapshot');}
        peopleContext = renderConversationPeople({isGroup, senderOpenId:ctx.senderOpenId, senderName:ctx.senderName, people:taskPeopleByAgent.get(agentId), profile, text:ctx.content, guidance:feishuCfg?.colleagueProfile?.guidance});
      }
      return core.channel.inbound.buildContext({
        channelIngress: boundChannelIngress,
        channel: "feishu",
        supplemental: {
          quote: undefined, // The original is carried once by the unified history below.
          thread: {
            starterBody: undefined,
            historyBody: undefined,
            label: threadContext.threadLabel,
          },
          groupSystemPrompt: isGroup
            ? normalizeOptionalString(groupConfig?.systemPrompt)
            : undefined,
        },
        media: inboundMedia,
        messageId: ctx.messageId,
        timestamp: messageCreateTimeMs,
        from: feishuFrom,
        sender: {
          id: ctx.senderOpenId,
          name: ctx.senderName ?? ctx.senderOpenId,
          isBot: ctx.senderType === "bot",
        },
        conversation: {
          kind: isGroup ? "group" : "direct",
          id: ctx.chatId,
          routePeer: { kind: isGroup ? "group" : "direct", id: peerId },
          nativeChannelId: ctx.chatId,
          parentId: parentPeer?.id,
          label: isGroup && groupName && !isTopicSessionForThread ? groupName : undefined,
          threadId: ctx.rootId && isTopicSessionForThread ? ctx.rootId : undefined,
        },
        route: {
          agentId,
          dmScope: route.dmScope,
          accountId: agentAccountId,
          routeSessionKey: agentSessionKey,
        },
        reply: {
          to: feishuTo,
          replyToId: ctx.parentId,
          messageThreadId: ctx.rootId && isTopicSessionForThread ? ctx.rootId : undefined,
        },
        message: {
          body: combinedBody,
          bodyForAgent: mergeHistoryContext(activeWindowContext + messageBody.replace('[MessageId]', peopleContext + '\n[MessageId]').replace(`\n${CURRENT_HEADER}\n`, `${buildRelatedPeopleContext({
            sender: isGroup && !peopleContext && ctx.senderType !== "bot" && event.sender.sender_id.open_id
              ? {name: ctx.senderName ?? null, open_id: event.sender.sender_id.open_id} : undefined,
            targets: (ctx.mentionTargets ?? []).filter(target => !taskPeopleByAgent.get(agentId)?.mentions.some(person => person.openId === target.openId)),
            profileSenderId: peopleContext ? ctx.senderOpenId : undefined,
          })}\n${CURRENT_HEADER}\n`), [
            ...[...quoteChainMessages].reverse().map(message => ({...message,retention:"quote" as const,contextKinds:[message.messageId === ctx.parentId ? "direct-quote" : "quote-ancestor"]})),
            ...(threadContext.records ?? []),
          ], quoteChainContext ? {quoteChain: {status: 'incomplete', reason: quoteChainContext}} : {}),

          inboundHistory,
          rawBody: commandFacingContent,
          commandBody: commandFacingContent,
        },
        sessionTranscript: { historyLimit: isGroup ? historyLimit : 0 },
        access: {
          mentions: {
            canDetectMention: isGroup,
            wasMentioned,
            requireMention,
          },
          commands: {
            authorized: commandAuthorized === true,
          },
        },
        extra: {
          RootMessageId: ctx.rootId,
          Transcript: audioTranscript,
          GroupSubject: isGroup ? groupName || ctx.chatId : undefined,
        },
      });
    };

    // Determine reply target based on group session mode:
    // - Topic-mode groups (group_topic / group_topic_sender): reply to the topic
    //   root so the bot stays in the same thread.
    // - Groups with explicit replyInThread config: reply to the root so the bot
    //   stays in the thread the user expects.
    // - Normal groups (auto-detected threadReply from root_id): reply to the
    //   triggering message itself. Using rootId here would silently push the
    //   reply into a topic thread invisible in the main chat view (#32980).
    const isTopicSession =
      isGroup &&
      (groupSession?.groupSessionScope === "group_topic" ||
        groupSession?.groupSessionScope === "group_topic_sender");
    const configReplyInThread =
      isGroup &&
      (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled";
    const topicReplyTargetMessageId = ctx.rootId ?? defaultReplyTargetMessageId;
    const replyTargetMessageId = directThreadReply
      ? directThreadReplyTargetMessageId
      : isTopicSession || configReplyInThread
        ? topicReplyTargetMessageId
        : defaultReplyTargetMessageId;
    const typingTargetMessageId =
      ctx.typingTargetMessageId ?? (ctx.suppressReplyTarget ? undefined : ctx.messageId);
    const threadReply = isGroup ? (groupSession?.threadReply ?? false) : directThreadReply;
    const lastRouteThreadId =
      isGroup && (isTopicSession || configReplyInThread || threadReply)
        ? replyTargetMessageId
        : undefined;
    const pinnedMainDmOwner = !isGroup
      ? resolvePinnedMainDmOwnerFromAllowlist({
          dmScope: effectiveCfg.session?.dmScope,
          allowFrom: effectiveConfigAllowFrom,
          normalizeEntry: normalizeFeishuAllowEntry,
        })
      : null;
    const pinnedMainDmSenderRecipient = pinnedMainDmOwner
      ? [ctx.senderOpenId, senderUserId]
          .map((id) => (id ? normalizeFeishuAllowEntry(id) : ""))
          .find((recipient) => recipient === pinnedMainDmOwner)
      : undefined;
    const buildFeishuInboundLastRouteUpdate = (paramsLocal: {
      accountId: string;
      sessionKey: string;
    }) => {
      const inboundLastRouteSessionKey =
        paramsLocal.sessionKey === route.sessionKey
          ? resolveInboundLastRouteSessionKey({
              route,
              sessionKey: paramsLocal.sessionKey,
            })
          : paramsLocal.sessionKey;
      return {
        sessionKey: inboundLastRouteSessionKey,
        channel: "feishu" as const,
        to: feishuTo,
        accountId: paramsLocal.accountId,
        ...(lastRouteThreadId ? { threadId: lastRouteThreadId } : {}),
        mainDmOwnerPin:
          !isGroup && inboundLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner
            ? {
                ownerRecipient: pinnedMainDmOwner,
                senderRecipient: pinnedMainDmSenderRecipient ?? feishuTo,
                onSkip: (skipParams: { ownerRecipient: string; senderRecipient: string }) => {
                  log(
                    `feishu[${account.accountId}]: skip main-session last route for ${skipParams.senderRecipient} (pinned owner ${skipParams.ownerRecipient})`,
                  );
                },
              }
            : undefined,
      };
    };

    if (!account.config.workspaceSync?.enabled) clearWorkspaceContext(account.accountId);

    // Keep the host's authorization decision, including commands.allowFrom
    // overrides. Do not turn a silent command rejection into a model failure.
    if (readOnlyCommand && !resolveCommandAuthorization({
      cfg: effectiveCfg,
      commandAuthorized: commandAuthorized === true,
      ctx: { Provider: "feishu", Surface: "feishu", AccountId: account.accountId,
        From: feishuFrom, To: feishuTo, SenderId: ctx.senderOpenId,
        ChatType: isGroup ? "group" : "direct" },
    }).isAuthorizedSender) {
      log(`feishu[${account.accountId}]: rejected unauthorized command ${readOnlyCommand}`);
      await sendMessageFeishu({ cfg: effectiveCfg, accountId: account.accountId, to: feishuReplyTarget,
        replyToMessageId: replyTargetMessageId, replyInThread,
        text: buildFeishuCommandDeniedReply(readOnlyCommand) });
      turnAdoptionLifecycle?.onAdoptionFinalizing?.();
      await turnAdoptionLifecycle?.onAdopted?.();
      params.onDispatchReady?.();
      return;
    }

    // Deterministic admission preflight, before any agent/model run. Recovery controls
    // must remain usable even when the workspace cannot be updated.
    const activeProgressQuery = !broadcastAgents && event.message.message_type === "text"
      ? captureFeishuProgress({accountId: account.accountId, chatId: ctx.chatId, rootId: ctx.rootId,
          sessionKey: route.sessionKey, senderId: ctx.senderOpenId, text: commandFacingContent, commands:account.config.conversationCommands, parentId: ctx.parentId})
      : undefined;
    if (ctx.senderType !== "bot" && !activeProgressQuery && !readOnlyCommand && !isAbortRequestText(commandFacingContent) && !/^\/(?:stop|abort|status)(?:@[\w-]+)?(?:\s|$)/i.test(commandFacingContent.trim())) {
      let sync = await syncAdaWorkspace(account.config.workspaceSync);
      if (sync.ok && sync.rootHead && account.config.workspaceSync?.enabled) {
        try {
          await prepareWorkspaceContext({root: account.config.workspaceSync.root,
            accountId: account.accountId, agentIds: broadcastAgents ?? [route.agentId], cfg: effectiveCfg, config: account.config.workspaceSync});
        } catch {
          sync = {ok: false, reason: "技能/角色刷新失败，请核对同步目录与 Agent 工作区、技能索引读取权限"};
        }
      }
      if (!sync.ok) {
        log(`feishu[${account.accountId}]: workspace sync blocked: ${sync.reason}`);
        await sendMessageFeishu({cfg: effectiveCfg, accountId: account.accountId, to: feishuReplyTarget,
          replyToMessageId: replyTargetMessageId, replyInThread,
          text: renderBusinessMessage(account.config.businessMessages,"syncFailure",{reason:sync.reason}),
        });
        turnAdoptionLifecycle?.onAdoptionFinalizing?.();
        await turnAdoptionLifecycle?.onAdopted?.();
        params.onDispatchReady?.();
        return;
      }
      if (sync.rootHead) log(`feishu[${account.accountId}]: workspace sync ready root=${sync.rootHead} wiki=${sync.wikiHead} upstream=${sync.upstreamHead ?? "disabled"}`);
    }

    if (broadcastAgents) {
      // Cross-account dedup: in multi-account setups, Feishu delivers the same
      // event to every bot account in the group. Only one account should handle
      // broadcast dispatch to avoid duplicate agent sessions and race conditions.
      // Hold the shared claim until the complete fan-out adopts. Failed fan-out
      // releases it so a transport retry can dispatch the broadcast again.
      const broadcastDedupeKey = messageDedupeKey ?? ctx.messageId;
      const broadcastClaim = await claimUnprocessedFeishuMessage({
        messageId: broadcastDedupeKey,
        namespace: "broadcast",
        log,
      });
      if (broadcastClaim.kind === "duplicate" || broadcastClaim.kind === "inflight") {
        log(
          `feishu[${account.accountId}]: broadcast already claimed by another account for message ${ctx.messageId}; skipping`,
        );
        return;
      }
      const broadcastSettlement = createFeishuBroadcastIngressSettlement({
        lifecycle: turnAdoptionLifecycle,
        replayClaim: broadcastClaim.kind === "claimed" ? broadcastClaim.handle : undefined,
        onReplayCommitError: (err) =>
          error(
            `feishu[${account.accountId}]: failed to commit broadcast replay guard: ${String(err)}`,
          ),
        onAdopted: () => {
          if (isGroup && historyKey && chatHistories) {
            createChannelHistoryWindow({ historyMap: chatHistories }).clear({
              historyKey,
              limit: historyLimit,
            });
          }
        },
      });
      const abandonBroadcast = async (err: unknown) => {
        try {
          await broadcastSettlement.onDispatchFailed(err);
        } catch (abandonError) {
          error(
            `feishu[${account.accountId}]: failed to abandon broadcast ingress: ${String(abandonError)}`,
          );
        }
      };

      // --- Broadcast dispatch: send message to all configured agents ---
      const rawStrategy = (
        (cfg as Record<string, unknown>).broadcast as Record<string, unknown> | undefined
      )?.strategy;
      const strategy = rawStrategy === "sequential" ? "sequential" : "parallel";
      const activeAgentId =
        ctx.mentionedBot || !requireMention ? normalizeAgentId(route.agentId) : null;
      const agentIds = (cfg.agents?.list ?? []).map((a: { id: string }) => normalizeAgentId(a.id));
      const hasKnownAgents = agentIds.length > 0;

      log(
        `feishu[${account.accountId}]: broadcasting to ${broadcastAgents.length} agents (strategy=${strategy}, active=${activeAgentId ?? "none"})`,
      );

      type BroadcastInboundVariant =
        | { kind: "observeOnly" }
        | { kind: "active"; dispatcher: ReturnType<typeof createFeishuReplyDispatcher> };
      const createBroadcastInboundAdapter = (paramsLocal: {
        agentId: string;
        sessionKey: string;
        ctxPayload: Awaited<ReturnType<typeof buildCtxPayloadForAgent>>;
        record: {
          updateLastRoute: ReturnType<typeof buildFeishuInboundLastRouteUpdate>;
          onRecordError: (err: unknown) => void;
        };
        lifecycle: FeishuIngressLifecycle;
        variant: BroadcastInboundVariant;
      }) => ({
        ingest: () => ({
          id: ctx.messageId,
          timestamp: messageCreateTimeMs,
          rawText: ctx.content,
          textForAgent: paramsLocal.ctxPayload.BodyForAgent,
          textForCommands: paramsLocal.ctxPayload.CommandBody,
          raw: ctx,
        }),
        resolveTurn: () => ({
          cfg,
          channel: "feishu" as const,
          accountId: route.accountId,
          route: { agentId: paramsLocal.agentId, sessionKey: paramsLocal.sessionKey },
          ctxPayload: paramsLocal.ctxPayload,
          record: paramsLocal.record,
          ...(paramsLocal.variant.kind === "observeOnly"
            ? {
                admission: { kind: "observeOnly" as const, reason: "broadcast-observer" },
                delivery: { deliver: async () => ({ visibleReplySent: false }) },
                replyOptions: bindIngressLifecycleToReplyOptions(paramsLocal.lifecycle),
              }
            : {
                dispatcherOptions: paramsLocal.variant.dispatcher.dispatcherOptions,
                delivery: paramsLocal.variant.dispatcher.delivery,
                replyOptions: {
                  ...paramsLocal.variant.dispatcher.replyOptions,
                  ...bindIngressLifecycleToReplyOptions(paramsLocal.lifecycle),
                },
              }),
        }),
      });

      const dispatchForAgent = async (agentId: string) => {
        const normalizedAgentId = normalizeAgentId(agentId);
        if (hasKnownAgents && !agentIds.includes(normalizedAgentId)) {
          log(
            `feishu[${account.accountId}]: broadcast agent ${agentId} not found in agents.list; skipping`,
          );
          return;
        }

        let agentClaim: Awaited<ReturnType<typeof claimUnprocessedFeishuMessage>> | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          agentClaim = await claimUnprocessedFeishuMessage({
            messageId: broadcastDedupeKey,
            namespace: `broadcast:${normalizedAgentId}`,
            log,
          });
          if (agentClaim.kind === "duplicate") {
            return;
          }
          if (agentClaim.kind !== "inflight") {
            break;
          }
          broadcastSettlement.onLanePending();
          try {
            await agentClaim.pending;
            return;
          } catch (err) {
            if (attempt === 1) {
              throw err;
            }
          }
        }
        const lane = broadcastSettlement.createLane(
          agentClaim?.kind === "claimed" ? agentClaim.handle : undefined,
        );

        try {
          const agentSessionKey = buildBroadcastSessionKey(
            route.sessionKey,
            route.agentId,
            agentId,
          );
          const agentStorePath = resolveStorePath(cfg.session?.store, {
            agentId,
          });
          const agentRecord = {
            updateLastRoute: buildFeishuInboundLastRouteUpdate({
              sessionKey: agentSessionKey,
              accountId: route.accountId,
            }),
            onRecordError: (err: unknown) => {
              log(
                `feishu[${account.accountId}]: failed to record broadcast inbound session ${agentSessionKey}: ${String(err)}`,
              );
            },
          };
          const allowReasoningPreview = resolveFeishuReasoningPreviewEnabled({
            cfg,
            agentId,
            storePath: agentStorePath,
            sessionKey: agentSessionKey,
          });
          const agentCtx = await buildCtxPayloadForAgent(
            agentId,
            agentSessionKey,
            route.accountId,
            ctx.mentionedBot && agentId === activeAgentId,
          );

          if (agentCtx.BodyForAgent) {
            agentCtx.BodyForAgent = await deduplicateSessionHistory({body:agentCtx.BodyForAgent,
              agentId,sessionKey:agentSessionKey,storePath:agentStorePath,scope:{accountId:account.accountId,chatId:ctx.chatId},
              cfg, isThread:isTopicSessionForThread,botAppId:account.appId,botOpenId,
              deduplicateOlder:feishuCfg?.mentionHistory?.deduplicateOlder});
            agentCtx.BodyForAgent = await summarizeFeishuHistory(agentCtx.BodyForAgent, summaryConfig, agentId);
            agentCtx.agentText = agentCtx.BodyForAgent;
          }
          let variant: BroadcastInboundVariant;
          if (agentId === activeAgentId) {
            // Active agent: real Feishu dispatcher (responds on Feishu)
            const identity = resolveAgentOutboundIdentity(cfg, agentId);
            variant = {
              kind: "active",
              dispatcher: createFeishuReplyDispatcher({
                cfg,
                agentId,
                runtime: runtime as RuntimeEnv,
                chatId: ctx.chatId,
                sendTarget: feishuReplyTarget,
                allowReasoningPreview,
                replyToMessageId: replyTargetMessageId,
                typingTargetMessageId,
                skipReplyToInMessages: !isGroup && !directThreadReply,
                replyInThread,
                rootId: ctx.rootId,
                threadReply,
                accountId: account.accountId,
                identity,
                mentionTargets: ctx.mentionTargets,
                requiredMentionTargets,
                messageCreateTimeMs,
                sessionKey: agentSessionKey,
              }),
            };

            log(
              `feishu[${account.accountId}]: broadcast active dispatch agent=${agentId} (session=${agentSessionKey})`,
            );
          } else {
            // Observer agent: no-op dispatcher (session entry + inference, no Feishu reply).
            // Strip CommandAuthorized so slash commands (e.g. /reset) don't silently
            // mutate observer sessions — only the active agent should execute commands.
            delete (agentCtx as Record<string, unknown>).CommandAuthorized;
            variant = { kind: "observeOnly" };
            log(
              `feishu[${account.accountId}]: broadcast observer dispatch agent=${agentId} (session=${agentSessionKey})`,
            );
          }

          const turnResult = await core.channel.inbound.run({
            channel: "feishu",
            accountId: route.accountId,
            raw: ctx,
            adapter: createBroadcastInboundAdapter({
              agentId,
              sessionKey: agentSessionKey,
              ctxPayload: agentCtx,
              record: agentRecord,
              lifecycle: lane.lifecycle,
              variant,
            }),
          });
          if (
            variant.kind === "active" &&
            turnResult.dispatched &&
            shouldSendNoVisibleReplyFallback(turnResult.dispatchResult)
          ) {
            await variant.dispatcher.ensureNoVisibleReplyFallback(
              "broadcast-dispatch-complete-no-visible-reply",
            );
          }
          await lane.onDispatchComplete(turnResult.dispatched);
        } catch (err) {
          await lane.onDispatchFailed(err);
          throw err;
        }
      };

      const results: PromiseSettledResult<void>[] = [];
      if (strategy === "sequential") {
        for (const agentId of broadcastAgents) {
          try {
            await dispatchForAgent(agentId);
            results.push({ status: "fulfilled", value: undefined });
          } catch (reason) {
            results.push({ status: "rejected", reason });
          }
        }
      } else {
        results.push(...(await Promise.allSettled(broadcastAgents.map(dispatchForAgent))));
      }
      const failures: unknown[] = [];
      for (const [i, result] of results.entries()) {
        if (result.status === "rejected") {
          const agentId = broadcastAgents.at(i);
          if (agentId === undefined) {
            continue;
          }
          log(
            `feishu[${account.accountId}]: broadcast dispatch failed for agent=${agentId}: ${String(result.reason)}`,
          );
          failures.push(result.reason);
        }
      }
      if (failures.length > 0) {
        const failure =
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Feishu broadcast dispatch failed");
        await abandonBroadcast(failure);
        throw failure;
      }

      try {
        await broadcastSettlement.onDispatchComplete();
      } catch (err) {
        await abandonBroadcast(err);
        throw err;
      }

      log(
        `feishu[${account.accountId}]: broadcast dispatch complete for ${broadcastAgents.length} agents`,
      );
    } else {
      // --- Single-agent dispatch (existing behavior) ---
      const ctxPayload = await buildCtxPayloadForAgent(
        route.agentId,
        route.sessionKey,
        route.accountId,
        ctx.mentionedBot,
      );

      const steerScope = {
        accountId: account.accountId, chatId: ctx.chatId,
        rootId: ctx.rootId, sessionKey: route.sessionKey,
      };
      const progressNudge = event.message.message_type === "text" && ctx.senderType !== "bot"
        ? captureFeishuProgress({...steerScope, senderId: ctx.senderOpenId, text: commandFacingContent, commands:account.config.conversationCommands, parentId: ctx.parentId}) : undefined;
      if (progressNudge && await progressNudge(ctx.messageId)) {
        turnAdoptionLifecycle?.onAdoptionFinalizing?.();
        await turnAdoptionLifecycle?.onAdopted?.();
        params.onDispatchReady?.();
        return;
      }
      const steering = event.message.message_type === "text" && ctx.senderType !== "bot"
        ? captureFeishuSteer({ ...steerScope, senderId: ctx.senderOpenId, text: commandFacingContent, commands:account.config.conversationCommands })
        : undefined;
      if (steering) {
        ctxPayload.BodyForAgent = `${ctxPayload.BodyForAgent ?? ""}\n${renderContextData('TaskCorrection', {kind:'correction',workerSteerSupported:false})}`;
      }
      // Override only this admitted input. Stored session overrides and host authority
      // checks still apply; the global followup policy is not changed.
      const turnCfg = steering ? {
        ...effectiveCfg,
        messages: { ...effectiveCfg.messages, queue: { ...effectiveCfg.messages?.queue, mode: "steer" as const } },
      } : effectiveCfg;
      const makeSourceTask = () => new SourceTask({accountId: account.accountId, chatId: ctx.chatId, sessionKey: route.sessionKey, senderId: ctx.senderOpenId, rootId:ctx.rootId, replyInThread, people:taskPeopleByAgent.get(route.agentId)}, [
        ...(params.sourceMessages ?? [{messageId: ctx.messageId, text: ctx.content, kind: "request" as const}]),
        ...quoteChainMessages.map(message => ({messageId: message.messageId, text: message.content, kind: "reference" as const})),
      ]);
      let sourceTask = !steering && ctx.senderType !== "bot" && !isControlTurn ? makeSourceTask() : undefined;
      let attemptedRevision: number | undefined;
      const originalPayload = { ...ctxPayload };
      const executeRevision = async () => {
        let lease = sourceTask?.begin();
        attemptedRevision = lease?.revision;
        const sourceAbort = new AbortController();
        const bindLease = () => {
          if (lease?.signal.aborted) sourceAbort.abort();
          else lease?.signal.addEventListener("abort", () => sourceAbort.abort(), {once: true});
        };
        bindLease();
        Object.assign(ctxPayload, originalPayload);
        if (sourceTask) {
          if (sourceTask.withdrawn.size) {
            // Do not re-inject the old merged text, quoted message, or media after
            // withdrawal. Historical transcript is reference only, never authority.
            ctxPayload.Body = ctxPayload.BodyForAgent = mergeHistoryContext(sourceTask.instruction(true),
              sourceTask.remaining().filter(s => s.kind === "reference").map(s => ({messageId:s.messageId,content:s.text,contentType:"text",retention:"quote" as const,contextKinds:["reference"]})));
            ctxPayload.RawBody = ctxPayload.CommandBody = sourceTask.remainingRequests().map(s => s.text).join("\n");
            if (!sourceTask.remaining().some(s => s.messageId === ctx.messageId)) {
              ctxPayload.MediaPath = undefined; ctxPayload.MediaPaths = undefined;
              ctxPayload.MediaUrl = undefined; ctxPayload.MediaUrls = undefined;
              ctxPayload.media = [];
            }
            ctxPayload.ReplyToBody = undefined; ctxPayload.ThreadStarterBody = undefined; ctxPayload.ThreadHistoryBody = undefined;
          } else {
            const sources = sourceTask.remaining();
            const compactPrivate = !isGroup && !ctx.parentId && !ctx.rootId && quoteChainMessages.length === 0 &&
              sources.length === 1 && sources[0].messageId === ctx.messageId && sources[0].kind !== "reference";
            ctxPayload.BodyForAgent = appendFeishuTaskInstruction(ctxPayload.BodyForAgent ?? "", {
              messageId: ctx.messageId, compactPrivate,
              instruction: sourceTask.instruction(false, {compactPrivate}),
            });
          }
        }
        let releaseSteerOwner: (() => void) | undefined;
        sourceAbort.signal.addEventListener("abort", () => releaseSteerOwner?.(), {once: true});
        let currentReplyMessageId = ctx.messageId;
        const identity = resolveAgentOutboundIdentity(effectiveCfg, route.agentId);
        const storePath = resolveStorePath(effectiveCfg.session?.store, {
          agentId: route.agentId,
        });
        const allowReasoningPreview = resolveFeishuReasoningPreviewEnabled({
          cfg: effectiveCfg,
          agentId: route.agentId,
          storePath,
          sessionKey: route.sessionKey,
        });
        const workingTurnKey = JSON.stringify([account.accountId, route.sessionKey]);
        if (commandAuthorized === true && isAbortRequestText(commandFacingContent)) {
          cancelFeishuWaitingTurns(workingTurnKey, ctx.senderOpenId);
        }
        const { dispatcherOptions, delivery, replyOptions, ensureNoVisibleReplyFallback, retargetAfterSteer,
          workingCardEnabled, showQueuedCard, cancelQueuedCard, taskProgress, refreshProgress, matchesProgressReply } =
          createFeishuReplyDispatcher({
            cfg: effectiveCfg,
            getSourceTaskLease: () => lease,
            sourceSignal: sourceTask || steering ? sourceAbort.signal : undefined,
            sourceCancellationReason: () => sourceTask?.remainingRequests().length ? "部分任务消息已撤回，已请求停止旧执行，将按剩余消息重新核对和调整。" : "任务依据的消息已全部撤回，已请求停止本轮执行；已发生的外部操作不会自动回滚。",
            agentId: route.agentId,
            runtime: runtime as RuntimeEnv,
            chatId: ctx.chatId,
            sendTarget: feishuReplyTarget,
            allowReasoningPreview,
            replyToMessageId: sourceTask?.withdrawn.size ? sourceTask.remainingRequests().at(-1)?.messageId : replyTargetMessageId,
            typingTargetMessageId: sourceTask?.withdrawn.size ? sourceTask.remainingRequests().at(-1)?.messageId : typingTargetMessageId,
            suppressPreview: Boolean(steering) || isControlTurn,
            isGroup,
            requester: ctx.senderType !== "bot" && event.sender.sender_id.open_id
              ? { openId: event.sender.sender_id.open_id, name: ctx.senderName ?? "提问同学", key: "" }
              : undefined,
            skipReplyToInMessages: !isGroup && !directThreadReply,
            replyInThread,
            rootId: ctx.rootId,
            threadReply,
            accountId: account.accountId,
            identity,
            mentionTargets: ctx.mentionTargets,
            requiredMentionTargets,
            messageCreateTimeMs,
            sessionKey: route.sessionKey,
          });

        const ingressReplyOptions: NonNullable<ChannelInboundTurnPlan["replyOptions"]> = turnAdoptionLifecycle
          ? bindIngressLifecycleToReplyOptions(turnAdoptionLifecycle) : {};
        log(`feishu[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);
        let activeContextSessionId: string | undefined;
        const receiptsPath = getFeishuRuntime().state.resolveStateDir() + '/feishu-context/receipts.sqlite';
        const dispatchTurn = async () => {
          if (lease?.signal.aborted) return;
          sourceTask?.activate();
          if (!sourceTask?.withdrawn.size && !isControlTurn && ctxPayload.BodyForAgent) {
            const inputCharsBeforeDedup = ctxPayload.BodyForAgent.length;
            ctxPayload.BodyForAgent = await deduplicateSessionHistory({
              body: ctxPayload.BodyForAgent, agentId: route.agentId, sessionKey: route.sessionKey,
              storePath, scope: {accountId: account.accountId, chatId: ctx.chatId},
              botAppId: account.appId, botOpenId, cfg: effectiveCfg, isThread: isTopicSessionForThread, receiptsPath,
              deduplicateOlder: feishuCfg?.mentionHistory?.deduplicateOlder,
            });
            log(`feishu: input assembly ${JSON.stringify({protocol:1,beforeChars:inputCharsBeforeDedup,afterChars:ctxPayload.BodyForAgent.length})}`);
          }
          if (lease?.signal.aborted) return;
          if (!isControlTurn && ctxPayload.BodyForAgent) {
            ctxPayload.BodyForAgent = await summarizeFeishuHistory(ctxPayload.BodyForAgent, summaryConfig, route.agentId, lease?.signal);
          }
          if (lease?.signal.aborted) return;
          // buildContext has already finalized these canonical fields. Keep them
          // in sync after source rebuilding, steering and history deduplication.
          ctxPayload.agentText = ctxPayload.BodyForAgent;
          ctxPayload.rawText = ctxPayload.RawBody;
          ctxPayload.commandText = ctxPayload.CommandInterpretationSuppressed ? "" : ctxPayload.CommandBody;
          ctxPayload.BodyForCommands = ctxPayload.commandText;
          if (sourceTask?.withdrawn.size) ctxPayload.CommandTurn = undefined;
          const turnResult = await core.channel.inbound.run({
            channel: "feishu",
            accountId: route.accountId,
            raw: ctx,
            adapter: {
              ingest: () => ({
                id: ctx.messageId,
                timestamp: messageCreateTimeMs,
                rawText: ctx.content,
                textForAgent: ctxPayload.BodyForAgent,
                textForCommands: ctxPayload.CommandBody,
                raw: ctx,
              }),
              resolveTurn: () => ({
                cfg: sourceTask?.withdrawn.size ? effectiveCfg : turnCfg,
                channel: "feishu",
                accountId: route.accountId,
                route: { agentId: route.agentId, sessionKey: route.sessionKey },
                ctxPayload,
                record: {
                  updateLastRoute: buildFeishuInboundLastRouteUpdate({
                    sessionKey: route.sessionKey,
                    accountId: route.accountId,
                  }),
                  onRecordError: (err) => {
                    log(
                      `feishu[${account.accountId}]: failed to record inbound session ${route.sessionKey}: ${String(err)}`,
                    );
                  },
                },
                history: {
                  isGroup,
                  historyKey,
                  historyMap: chatHistories,
                  limit: historyLimit,
                },
                dispatcherOptions,
                delivery: {
                  ...delivery,
                  deliver: async (payload, info) => {
                    if (lease?.signal.aborted) return {visibleReplySent: false};
                    const result = await delivery.deliver(payload, info);
                    const receiptSessionId = activeContextSessionId;
                    if (isGroup && info?.kind === "final" && payload.text && !payload.isReasoning && receiptSessionId) {
                      const recordReceipt = (receipt: {visibleReplySent?: boolean; messageIds?: string[]; content?: string} | void) => {
                        if (receipt?.visibleReplySent !== true || !receipt.messageIds?.length) return;
                        try {
                          recordContextReceipts(receiptsPath, {agentId: route.agentId, sessionId: receiptSessionId,
                            accountId: account.accountId, chatId: ctx.chatId}, receipt.messageIds, receipt.content ?? payload.text!);
                        } catch { log(`feishu[${account.accountId}]: context receipt unavailable; retaining history`); }
                      };
                      if (result && "finalization" in result && result.finalization) {
                        void result.finalization.then(recordReceipt).catch(() => {});
                      } else recordReceipt(result);
                    }
                    if (isGroup && info?.kind === "final" && payload.text && !payload.isReasoning &&
                        (groupConfig?.conversationWindow ?? feishuCfg?.conversationWindow)?.enabled) {
                      const recordVisibleReply = (receipt: {visibleReplySent?: boolean; content?: string} | void) => {
                        if (receipt?.visibleReplySent !== true) return;
                        try {
                          getConversationWindowStore().reply(
                            windowKey({accountId:account.accountId,chatId:ctx.chatId,senderOpenId:ctx.senderOpenId}),
                            currentReplyMessageId, receipt.content ?? payload.text!, Date.now(),
                          );
                        } catch { log(`feishu[${account.accountId}]: could not retain conversation reply context`); }
                      };
                      if (result && "finalization" in result && result.finalization) {
                        void result.finalization.then(recordVisibleReply).catch(() => {});
                      } else { recordVisibleReply(result); }
                    }
                    return result;
                  },
                },
                replyOptions: {
                  ...replyOptions,
                  ...ingressReplyOptions,
                  abortSignal: sourceTask || steering ? AbortSignal.any([sourceAbort.signal, ...(ingressReplyOptions.abortSignal ? [ingressReplyOptions.abortSignal] : [])]) : ingressReplyOptions.abortSignal,
                  onAgentRunStart: () => {
                    try { activeContextSessionId = getSessionEntry({agentId: route.agentId, sessionKey: route.sessionKey, storePath, readConsistency: "latest"})?.sessionId; }
                    catch { activeContextSessionId = undefined; }
                    // An unaccepted steer can become a real follow-up run later.
                    // Only that actual start may claim its own source lease.
                    if (steering && !sourceTask) {
                      sourceTask = makeSourceTask(); lease = sourceTask.begin();
                      attemptedRevision = lease.revision;
                      sourceTask.activate(); bindLease();
                    }
                    if (sourceAbort.signal.aborted) return;
                    replyOptions.onAgentRunStart?.();
                    releaseSteerOwner?.();
                    const releaseProgress = workingCardEnabled ? registerTaskProgress(route.sessionKey, account.accountId, ctx.senderOpenId, taskProgress) : () => {};
                    const releaseOwner = registerFeishuSteerOwner({
                      ...steerScope, senderId: ctx.senderOpenId, messageId: ctx.messageId,
                      matchesProgressReply,
                      refreshProgress: workingCardEnabled ? async (messageId) => {
                        const consumed = await refreshProgress(messageId);
                        if (matchesProgressReply(messageId)) currentReplyMessageId = messageId;
                        return consumed;
                      } : undefined,
                      retarget: async (messageId, sourceText) => {
                        if (sourceText) sourceTask?.add({messageId, text: sourceText, kind: "request"});
                        await retargetAfterSteer(messageId);
                        currentReplyMessageId = messageId;
                      },
                    });
                    releaseSteerOwner = () => { releaseOwner(); releaseProgress(); };
                  },
                  ...(steering ? {
                    turnAdoptionLifecycle: {
                      ...ingressReplyOptions.turnAdoptionLifecycle,
                      onAdopted: async () => {
                        await ingressReplyOptions.turnAdoptionLifecycle?.onAdopted();
                        await steering.adopted(ctx.messageId);
                      },
                    },
                  } : {}),
                },
              }),
            },
          });
          if (lease?.signal.aborted) return;
          if (!turnResult.dispatched) {
            await cancelQueuedCard?.();
            return;
          }
          const { dispatchResult } = turnResult;
          const { queuedFinal, counts } = dispatchResult;
          if (shouldSendNoVisibleReplyFallback(dispatchResult)) {
            await ensureNoVisibleReplyFallback("dispatch-complete-no-visible-reply");
          }

          log(
            `feishu[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
          );
        };
        try {
          if ((workingCardEnabled || sourceTask) && (!steering || sourceTask) && !isControlTurn) {
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            try {
              await runFeishuWorkingTurn({
                key: workingTurnKey,
                senderId: ctx.senderOpenId,
                signal: lease ? AbortSignal.any([lease.signal, ...(turnAdoptionLifecycle ? [turnAdoptionLifecycle.abortSignal] : [])]) : turnAdoptionLifecycle?.abortSignal,
                prepare: async (queued) => {
                  // Release durable and transport admission only after all channel gates.
                  turnAdoptionLifecycle?.onDeferred();
                  if (turnAdoptionLifecycle?.onDeferredHeartbeat) {
                    heartbeat = setInterval(() => turnAdoptionLifecycle.onDeferredHeartbeat?.(),
                      turnAdoptionLifecycle.deferredHeartbeatIntervalMs ?? 10_000);
                    heartbeat.unref();
                  }
                  params.onDispatchReady?.();
                  if (queued) await showQueuedCard?.();
                },
                run: async () => {
                  if (heartbeat) clearInterval(heartbeat);
                  await dispatchTurn();
                },
                cancel: async (reason) => {
                  await cancelQueuedCard?.(lease?.signal.aborted ? (sourceTask?.remainingRequests().length ? "部分任务消息已撤回，正在按剩余消息调整。" : "任务依据的消息已全部撤回，已请求停止本轮执行；已发生的外部操作不会自动回滚。") : reason === "cancelled" ? "本条请求已取消。" : "本条请求处理失败，请查看错误说明。");
                  // Explicit cancellation consumes this admitted message, not a retry.
                  if (!turnAdoptionLifecycle?.abortSignal.aborted) {
                    turnAdoptionLifecycle?.onAdoptionFinalizing();
                    await turnAdoptionLifecycle?.onAdopted();
                  } else {
                    await turnAdoptionLifecycle?.onAbandoned();
                  }
                },
              });
            } finally { if (heartbeat) clearInterval(heartbeat); }
          } else {
            await dispatchTurn();
          }
        } finally { releaseSteerOwner?.(); }
      };
      try {
        for (;;) {
          try { await executeRevision(); }
          catch (error) { if (!sourceTask || sourceTask.revision === attemptedRevision) throw error; }
          finally { sourceTask?.endRevision(); }
          if (!sourceTask || sourceTask.stopped.signal.aborted || sourceTask.revision === attemptedRevision) break;
        }
      } finally { sourceTask?.close(); }
    }
  } catch (err) {
    error(`feishu[${account.accountId}]: failed to dispatch message: ${String(err)}`);
    if (turnAdoptionLifecycle) {
      throw err;
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
