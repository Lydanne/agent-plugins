import { HISTORY_TITLE, findBlockHeader } from "./context-sections.js";
/** Structured supplemental context. Provider IDs, never text similarity, establish relevance. */
export type HistoryMessage = {
  messageId: string; senderId?: string; senderType?: string;
  content: string; contentType: string; createTime?: number;
  rootId?: string; threadId?: string; parentId?: string; contextKinds?: string[];
  retention?: "recent" | "quote-neighbor" | "quote";
};
export type HistoryRelation = { rootId?: string; threadId?: string; parentId?: string };
export type HistoryDiagnostics = {
  protocol: 1; candidates: number; unrelated: number; budgetDropped: number;
  retained: number; chars: number;
};
export const HISTORY_HEADER = HISTORY_TITLE + "\n";
/** One data block owns history records, retrieval facts and lossy summaries.
 * Unknown optional fields survive merging and deduplication. */
export type HistoryContext = {messages: HistoryMessage[]; [key: string]: unknown};
export const renderHistoryContext = (context: HistoryContext) => HISTORY_HEADER + JSON.stringify(context);
export function readHistoryContext(text: string) {
  const typed = findBlockHeader(text, 'GroupChatHistory');
  const start = Math.min(...[typed?.index ?? -1, text.indexOf('[Context: 群聊历史]\n'), text.indexOf('[群聊历史：')].filter(n => n >= 0), Infinity);
  if (!Number.isFinite(start)) return undefined;
  let jsonStart = text.indexOf('\n', start) + 1;
  if (!jsonStart) return undefined;
  // Old tagged envelopes included a prose boundary before their array.
  if (!['[', '{'].includes(text[jsonStart])) jsonStart = text.indexOf('\n', jsonStart) + 1;
  if (!jsonStart) return undefined;
  const newline = text.indexOf('\n', jsonStart), end = newline < 0 ? text.length : newline;
  try {
    const value = JSON.parse(text.slice(jsonStart, end));
    const context = Array.isArray(value) ? {messages: value} : value;
    if (!context || typeof context !== 'object' || !Array.isArray(context.messages) ||
      !context.messages.every((m: HistoryMessage) => m && typeof m.messageId === 'string' && typeof m.content === 'string' && typeof m.contentType === 'string')) return undefined;
    return {start, jsonStart, end, context: context as HistoryContext};
  } catch { return undefined; }
}
export function selectRelatedHistory(messages: HistoryMessage[], relation?: HistoryRelation): HistoryMessage[] {
  if (!relation) return messages;
  if (!relation.rootId && !relation.threadId && !relation.parentId) return messages.slice(-5);
  return messages.filter(m => m.messageId === relation.parentId || m.messageId === relation.rootId ||
    (!!relation.threadId && m.threadId === relation.threadId) ||
    (!!relation.rootId && m.rootId === relation.rootId));
}
export function prepareHistory(messages: HistoryMessage[], options: {
  relation?: HistoryRelation; maxChars?: number; report?: (stats: HistoryDiagnostics) => void;
  context?: Omit<HistoryContext, 'messages'>;
} = {}): string {
  const related = new Set(selectRelatedHistory(messages, options.relation));
  const selected = messages.filter(m => m.retention === "recent" || related.has(m));
  const retained = [...selected];
  const render = () => renderHistoryContext({...options.context, messages: retained});
  while (retained.length && render().length > (options.maxChars ?? 12000)) {
    const ordinary = retained.findIndex(m => m.retention !== "recent" && m.messageId !== options.relation?.parentId && m.messageId !== options.relation?.rootId);
    const removable = ordinary < 0 ? retained.findIndex(m => m.retention !== "recent") : ordinary;
    if (removable < 0) break; // The mandatory recent window takes priority over the soft budget.
    retained.splice(removable, 1);
  }
  const body = render();
  options.report?.({protocol:1,candidates:messages.length,unrelated:messages.length-selected.length,
    budgetDropped:selected.length-retained.length,retained:retained.length,chars:body.length});
  return body;
}
export type InputContext = { sender: string; style: string; identity: string; current: string };
export function renderInputContext(input: InputContext): string {
  return `${input.sender}${input.style}\n${input.identity}\n${input.current}`;
}
