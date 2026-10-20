import { maybeResolveTextAlias } from "openclaw/plugin-sdk/command-auth-native";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import type { OpenClawConfig } from "../runtime-api.js";

// These host handlers return a terminal result without starting a model task.
// Skill invocation and commands such as /compact retain normal task admission.
const readOnlyCommands = new Set(["/help", "/commands", "/status", "/whoami", "/agents", "/subagents"]);

export function resolveFeishuReadOnlyCommand(text: string, cfg: OpenClawConfig): string | undefined {
  if (!shouldHandleTextCommands({ cfg, surface: "feishu", commandSource: "text" })) return;
  const alias = maybeResolveTextAlias(text.trim(), cfg);
  return alias && readOnlyCommands.has(alias) ? alias : undefined;
}

export function buildFeishuCommandDeniedReply(command: string): string {
  return `当前发送者没有执行 ${command} 的指令权限。请管理员核对 commands.allowFrom 的 feishu 项或飞书发送者 allowFrom；群聊准入及 ownerAllowFrom 不等于指令授权。`;
}
