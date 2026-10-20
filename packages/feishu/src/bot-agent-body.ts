import { renderContextData, renderSection, CURRENT_HEADER } from "./context-sections.js";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { FeishuPermissionError } from "./bot-sender-name.js";
import type { FeishuMessageContext } from "./types.js";

const MAX_MENTION_CONTEXT_NAME_LENGTH = 80;

function formatMentionNameForAgentContext(name: string): string {
  const stripped = Array.from(name, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || char === "[" || char === "]" ? " " : char;
  }).join("");
  const normalized = stripped.replace(/\s+/g, " ").trim();
  const bounded =
    normalized.length > MAX_MENTION_CONTEXT_NAME_LENGTH
      ? `${truncateUtf16Safe(normalized, MAX_MENTION_CONTEXT_NAME_LENGTH - 3)}...`
      : normalized;
  return bounded || "unknown";
}

export function buildFeishuAgentBody(params: {
  ctx: Pick<
    FeishuMessageContext,
    "content" | "senderName" | "senderOpenId" | "mentionTargets" | "messageId" | "hasAnyMention"
  > & Partial<Pick<FeishuMessageContext, "chatType">>;
  quotedContent?: string;
  permissionErrorForAgent?: FeishuPermissionError;
  botOpenId?: string;
}): string {
  const { ctx, quotedContent, permissionErrorForAgent, botOpenId } = params;
  const sections: string[] = [];
  if (quotedContent) {
    sections.push(renderSection('QuotedMessage', JSON.stringify({ content: quotedContent })));
  }
  sections.push(renderSection('MessageId', JSON.stringify({ messageId: ctx.messageId })));
  sections.push(renderSection('CurrentMessage', (ctx.chatType === "p2p" || ctx.chatType === "private") ? ctx.content : `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`));
  if (ctx.hasAnyMention && botOpenId?.trim()) {
    sections.push(renderContextData('CurrentBot', {openId:botOpenId.trim()}));
  }
  if (ctx.mentionTargets?.length) {
    sections.push(renderContextData('MentionedPeople', ctx.mentionTargets.map(target => ({openId:target.openId,name:formatMentionNameForAgentContext(target.name)}))));
  }
  if (permissionErrorForAgent) {
    sections.push(renderContextData('FeishuPermissionError', {grantUrl:permissionErrorForAgent.grantUrl ?? null}));
  }
  return sections.join("\n\n");
}

/** Deduplicate the channel-built ID after the source lease has been built. */
export function appendFeishuTaskInstruction(body: string, input: {
  messageId: string; instruction: string;
  /** Legacy callers may pass this; source IDs are now deduplicated in both chat kinds. */
  compactPrivate?: boolean;
}): string {
  const marker = renderSection('MessageId', JSON.stringify({messageId: input.messageId})) + "\n\n";
  // The channel-built marker precedes user content. Remove exactly one copy;
  // the task source still carries this ID and native inbound metadata is intact.
  // Never search the user body for markers: only remove the channel prefix.
  const position = body.indexOf(marker), request = body.indexOf(CURRENT_HEADER);
  const current = position >= 0 && request > position ?
    (body.slice(0,position) + body.slice(position+marker.length)).trimStart() : body;
  return `${current}\n${input.instruction}`;
}
