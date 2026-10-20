import { isFeishuProgressText, isFeishuSteerText } from "./keyword-steer.js";
// Feishu plugin module implements sequential key behavior.
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  preparedContent?: string;
  botOpenId?: string;
  botName?: string;
}): string {
  const { accountId, event, botOpenId, botName, preparedContent } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";
  const baseKey = `feishu:${accountId}:${chatId}`;
  const text = (
    preparedContent ?? parseFeishuMessageEvent(event, botOpenId, botName).content
  ).trim();

  if (event.message.message_type === "text" && isFeishuSteerText(text)) {
    return `${baseKey}:steer`;
  }

  if (event.message.message_type === "text" && isFeishuProgressText(text)) return `${baseKey}:progress`;

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  return baseKey;
}
