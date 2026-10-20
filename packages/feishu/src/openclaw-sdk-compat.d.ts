/**
 * Type-only contracts for the public SDK exports used by this plugin that ship
 * without declarations in OpenClaw 2026.9.5 (also verified in 2026.9.8).
 * Signatures follow those versions' published runtime implementations. Reuse
 * published public types where available; never import private host modules.
 * Remove each module when the pinned SDK supplies its own declaration.
 */
declare module "openclaw/plugin-sdk/command-surface" {
  export function shouldHandleTextCommands(params: {
    cfg: import("openclaw/plugin-sdk/core").OpenClawConfig;
    surface: string;
    commandSource?: "text" | "native";
  }): boolean;
}

declare module "openclaw/plugin-sdk/number-runtime" {
  export { asDateTimestampMs } from "openclaw/plugin-sdk/string-coerce-runtime";
  export {
    MAX_TIMER_TIMEOUT_MS, finiteSecondsToTimerSafeMilliseconds,
    parseStrictNonNegativeInteger, parseStrictPositiveInteger,
    resolveExpiresAtMsFromDurationSeconds,
  } from "openclaw/plugin-sdk/infra-runtime";
  export function resolveTimerTimeoutMs(valueMs: unknown, fallbackMs: number, minMs?: number): number;
  export function resolveDateTimestampMs(value: unknown, fallbackValue?: number): number;
  export function isFutureDateTimestampMs(value: unknown, options?: { nowMs?: number }): boolean;
  export function resolveExpiresAtMsFromDurationMs(value: unknown, options?: {
    nowMs?: number; bufferMs?: number; minRemainingMs?: number;
  }): number | undefined;
}

declare module "openclaw/plugin-sdk/text-utility-runtime" {
  export { truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";
  export function sliceUtf16Safe(input: string, start: number, end?: number): string;
  export function escapeHtml(input: string): string;
}

declare module "openclaw/plugin-sdk/blob-runtime" {
  export function bufferToBlobPart(buffer: Uint8Array): Uint8Array<ArrayBuffer>;
}

declare module "openclaw/plugin-sdk/fetch-runtime" {
  export function captureChannelReadAuthority(): (() => void) | undefined;
}

declare module "openclaw/plugin-sdk/file-access-runtime" {
  export function isPathStrictlyInside(root: string, target: string): boolean;
}

declare module "openclaw/plugin-sdk/markdown-table-runtime" {
  export { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
}

declare module "openclaw/plugin-sdk/context-visibility-runtime" {
  export {
    evaluateSupplementalContextVisibility, filterSupplementalContextItems,
    resolveChannelContextVisibilityMode,
  } from "openclaw/plugin-sdk/config-runtime";
}

declare module "openclaw/plugin-sdk/retry-runtime" {
  export { retryAsync } from "openclaw/plugin-sdk/infra-runtime";
}

declare module "openclaw/plugin-sdk/provider-http" {
  export function readProviderJsonResponse<T = unknown>(response: Response, label: string, options?: {
    maxBytes?: number; requestHeaders?: HeadersInit;
  }): Promise<T>;
}

declare module "openclaw/plugin-sdk/channel-config-writes" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
  export function resolveChannelConfigWrites(params: {
    cfg: OpenClawConfig; channelId?: string; accountId?: string | null;
  }): boolean;
}

declare module "openclaw/plugin-sdk/conversation-binding-runtime" {
  import type { SessionBindingRecord, RuntimeConversationBindingRouteResult } from "openclaw/plugin-sdk/conversation-runtime";
  export { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
  export function isPluginOwnedSessionBindingRecord(record: { metadata?: Record<string, unknown> } | null | undefined): boolean;
  export function resolveRuntimeConversationBindingRoute(params: {
    route: RuntimeConversationBindingRouteResult["route"];
    conversation: SessionBindingRecord["conversation"];
    touchBinding?: boolean;
  }): RuntimeConversationBindingRouteResult;
}

declare module "openclaw/plugin-sdk/codex-session-transcript-runtime" {
  export function readCodexSessionContext<T>(target: {
    agentId: string; sessionId: string; sessionKey: string; storePath?: string;
  }, read: (messages: Iterable<Record<string, unknown> & { role: string }>) => T): T;
}

declare module "openclaw/plugin-sdk/runtime-doctor-migrations" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
  import type { ChannelDoctorConfigMutation, ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";
  type EntryParams = { entry: Record<string, unknown>; pathPrefix: string; changes: string[]; accountId?: string };
  type EntryResult = { entry: Record<string, unknown>; changed: boolean };
  export function asObjectRecord(value: unknown): Record<string, unknown> | null;
  export function hasLegacyAccountStreamingAliases(value: unknown, match: (value: unknown) => boolean): boolean;
  export function defineChannelAliasMigration(spec: {
    channelId: string;
    streaming: { defaultMode: "off" | "partial" | "block" | "progress" };
    accountStreamingReplacesRoot?: boolean;
  }): {
    legacyConfigRules: ChannelDoctorLegacyConfigRule[];
    hasLegacyAliases: (value: unknown) => boolean;
    normalizeChannelConfig: (params: { cfg: OpenClawConfig; changes?: string[] }) => ChannelDoctorConfigMutation;
  };
  export function defineKeyMoveMigration(params: {
    from: string[]; to: string[]; scope?: string[]; sourceOwn?: boolean;
    match?: (value: unknown) => boolean;
  }): { hasLegacy: (value: unknown) => boolean; normalize: (params: EntryParams) => EntryResult };
  export function normalizeChannelConfigEntries(params: {
    cfg: OpenClawConfig; channelId: string; changes?: string[];
    normalizeEntry: (params: EntryParams) => EntryResult;
  }): ChannelDoctorConfigMutation;
  export function defineStrayPluginEntryConfigMigration(params: {
    pluginId: string; channelId: string;
    validateMergedChannelConfig: (merged: Record<string, unknown>) => boolean;
  }): {
    legacyConfigRule: ChannelDoctorLegacyConfigRule;
    normalizeConfig: (params: { cfg: OpenClawConfig }) => ChannelDoctorConfigMutation;
  };
}
