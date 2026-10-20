import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import { captureChannelReadAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { isPathStrictlyInside } from "openclaw/plugin-sdk/file-access-runtime";
import { resolveTimerTimeoutMs, resolveDateTimestampMs, isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs, finiteSecondsToTimerSafeMilliseconds } from "openclaw/plugin-sdk/number-runtime";
import { sliceUtf16Safe, truncateUtf16Safe, escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { readCodexSessionContext } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/context-visibility-runtime";
import { defineChannelAliasMigration, defineKeyMoveMigration, normalizeChannelConfigEntries } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveRuntimeConversationBindingRoute, isPluginOwnedSessionBindingRecord } from "openclaw/plugin-sdk/conversation-binding-runtime";

// Checked by tsc only. These examples must never run against a host session.
function contracts() {
  const timeout: number = resolveTimerTimeoutMs(undefined, 1_000);
  const timestamp: number = resolveDateTimestampMs(undefined);
  const future: boolean = isFutureDateTimestampMs(timestamp, {nowMs: 0});
  const expiry: number | undefined = resolveExpiresAtMsFromDurationMs(timeout, {bufferMs: 100});
  const millis: number | undefined = finiteSecondsToTimerSafeMilliseconds(1, {floorSeconds: true});
  const bytes: Uint8Array<ArrayBuffer> = bufferToBlobPart(Buffer.from("data"));
  const assertCurrent: (() => void) | undefined = captureChannelReadAuthority();
  const inside: boolean = isPathStrictlyInside("/root", "/root/file");
  const text: string = escapeHtml(truncateUtf16Safe(sliceUtf16Safe("😀abc", 0), 2));
  const response: Promise<{ok: boolean}> = readProviderJsonResponse<{ok: boolean}>(new Response(), "test", {maxBytes: 10});
  const retried: Promise<number> = retryAsync(async () => 1, {shouldRetry: (error: unknown) => error instanceof Error});
  const writes: boolean = resolveChannelConfigWrites({cfg: {}, channelId: "feishu"});
  resolveMarkdownTableMode({cfg: {}, channel: "feishu"});
  evaluateSupplementalContextVisibility({mode: "allowlist", kind: "quote", senderAllowed: false});
  const known: Map<string, string> = readCodexSessionContext({agentId: "main",sessionId: "isolated",sessionKey: "isolated"}, messages => {
    const index = new Map<string, string>();
    for (const message of messages) if (message.role === "user") index.set("key", String(message.content));
    return index;
  });
  const aliases = defineChannelAliasMigration({channelId: "feishu", streaming: {defaultMode: "partial"}});
  const moved = defineKeyMoveMigration({from: ["old"], to: ["new"], match: value => typeof value === "boolean"});
  normalizeChannelConfigEntries({cfg: aliases.normalizeChannelConfig({cfg: {}}).config, channelId: "feishu", normalizeEntry: params => moved.normalize(params)});
  isPluginOwnedSessionBindingRecord({metadata: {owner: "plugin"}});
  void future;void expiry;void millis;void bytes;void assertCurrent;void inside;void text;void response;void retried;void writes;void known;

  // These fail if contracts become untyped or excessively permissive.
  // @ts-expect-error Return value may be absent.
  const requiredExpiry: number = resolveExpiresAtMsFromDurationMs(1);
  // @ts-expect-error Blob adapter requires bytes, not arbitrary strings.
  bufferToBlobPart("data");
  // @ts-expect-error Numeric fallback is required.
  resolveTimerTimeoutMs(1, "1000");
  // @ts-expect-error String utility preserves a string return type.
  const wrongText: number = escapeHtml("text");
  // @ts-expect-error Authority is optional; it must be checked before use.
  captureChannelReadAuthority()();
  // @ts-expect-error Transcript target must identify its session.
  readCodexSessionContext({agentId: "main"}, () => []);
  // @ts-expect-error Callback must infer Map, not any.
  const wrongContext: number = readCodexSessionContext({agentId: "main", sessionId: "isolated", sessionKey: "isolated"}, () => new Map<string, string>());
  // @ts-expect-error Migration stream modes are bounded.
  defineChannelAliasMigration({channelId: "feishu", streaming: {defaultMode: "unknown"}});
  // @ts-expect-error Runtime binding route must include a valid route.
  resolveRuntimeConversationBindingRoute({conversation: {channel: "feishu", conversationId: "chat", accountId: "default"}});
  // @ts-expect-error JSON byte limit must be numeric.
  readProviderJsonResponse(new Response(), "test", {maxBytes: "10"});
  // @ts-expect-error Retry retains the resolved value type.
  const wrongRetry: Promise<string> = retryAsync(async () => 1);
  // @ts-expect-error Config write decision is boolean.
  const wrongWrites: string = resolveChannelConfigWrites({cfg: {}});
  void requiredExpiry;void wrongText;void wrongContext;void wrongRetry;void wrongWrites;
}
void contracts;
