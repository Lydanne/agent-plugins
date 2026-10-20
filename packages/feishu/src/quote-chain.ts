import type { FeishuMessageInfo } from "./types.js";
import { renderSection } from "./context-sections.js";

export async function loadQuoteChain(params: {
  parentId: string;
  currentMessageId: string;
  chatId: string;
  maxDepth?: number;
  maxChars?: number;
  readMaxChars?: number;
  timeoutMs?: number;
  fetch: (id: string) => Promise<FeishuMessageInfo | null>;
  visible: (message: FeishuMessageInfo) => Promise<boolean>;
}): Promise<{ messages: FeishuMessageInfo[]; notice: string }> {
  const messages: FeishuMessageInfo[] = [];
  const seen = new Set([params.currentMessageId]);
  const depth = params.maxDepth ?? 20;
  const budget = params.readMaxChars ?? params.maxChars ?? 200000;
  let chars = 0;
  let next: string | undefined = params.parentId;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const incomplete = (reason: string) => `引用链不完整：${reason}`;
  const read = async (): Promise<string> => {
    while (next) {
      if (seen.has(next)) return incomplete("检测到重复引用或循环");
      if (messages.length >= depth) return incomplete(`达到 ${depth} 层上限`);
      seen.add(next);
      const message = await params.fetch(next);
      if (expired) return "";
      if (!message || message.messageId !== next) return incomplete("消息不存在、已撤回或读取失败");
      if (message.chatId && message.chatId !== params.chatId) return incomplete("引用指向其他会话");
      const allowed = await params.visible(message);
      if (expired) return "";
      if (!allowed) return incomplete("引用消息不可见");
      const size = JSON.stringify(message).length;
      // Preserve the direct quote, as before; bound supplemental ancestors.
      if (messages.length && chars + size > budget) return incomplete("达到引用链读取字符预算");
      messages.push(message);
      chars += size;
      next = message.parentId;
    }
    return "";
  };
  try {
    const notice = await Promise.race([
      read(),
      new Promise<string>(resolve => { timer = setTimeout(() => {
        expired = true;
        resolve(incomplete("读取超时"));
      }, params.timeoutMs ?? 5000); }),
    ]);
    return {messages: [...messages], notice};
  } catch {
    expired = true;
    return {messages: [...messages], notice: incomplete("读取失败")};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Direct quote is already carried by the host quote field and message body. */
export function renderQuoteAncestors(messages: FeishuMessageInfo[], notice: string): string {
  const ancestors = messages.slice(1).reverse().map(m => ({
    messageId: m.messageId, parentId: m.parentId, senderId: m.senderId,
    senderType: m.senderType, contentType: m.contentType, content: m.content,
    createTime: m.createTime,
  }));
  const context = ancestors.length ? renderSection('QuotedMessages',
    JSON.stringify({directQuoteId: messages[0].messageId, directQuoteParentId: messages[0].parentId, ancestors})) : "";
  return [context, notice].filter(Boolean).join("\n");
}
