import { readHistoryContext, renderHistoryContext, type HistoryMessage, type HistoryContext } from "./input-context.js";
import { contextFingerprint } from "./context-history.js";

export type HistorySummaryConfig = {
  enabled?: boolean; triggerChars?: number; targetChars?: number;
  timeoutMs?: number; maxInputChars?: number; model?: string;
};
export type SummaryRequest = { records: HistoryMessage[]; perMessageChars: number; signal: AbortSignal };
export type SummaryComplete = (request: SummaryRequest) => Promise<string>;

function split(body: string) {
  const block = readHistoryContext(body);
  if (!block || block.start !== 0) return {records: [] as HistoryMessage[], context: {messages: []} as HistoryContext, tail: body};
  return {records: block.context.messages, context: block.context, tail: body.slice(block.end + 1)};
}
function raw(records: HistoryMessage[], context: HistoryContext) { return renderHistoryContext({...context, messages: records}); }

/** Merge only this turn's sources. A recent record keeps its mandatory status. */
export function mergeHistoryContext(body: string, extra: HistoryMessage[], metadata: Omit<HistoryContext, 'messages'> = {}): string {
  const {records, context, tail} = split(body);
  const byId = new Map<string, HistoryMessage>();
  for (const m of [...records, ...extra]) {
    const previous = byId.get(m.messageId);
    byId.set(m.messageId, {...previous, ...m,
      retention: previous?.retention === "recent" || m.retention === "recent" ? "recent" : m.retention ?? previous?.retention,
      contextKinds: [...new Set([...(previous?.contextKinds ?? []), ...(m.contextKinds ?? [])])],
    });
  }
  if (!byId.size && !Object.keys(metadata).length) return body;
  const all = [...byId.values()].sort((a,b) => (a.createTime ?? 0) - (b.createTime ?? 0));
  return raw(all, {...context, ...metadata}) + "\n" + tail;
}

export async function summarizeHistoryContext(params: {
  body: string; config?: HistorySummaryConfig; complete: SummaryComplete; signal?: AbortSignal;
}): Promise<string> {
  const {records, context, tail} = split(params.body);
  const cfg = params.config ?? {};
  const threshold = cfg.triggerChars ?? 12000;
  if (!records.length || raw(records, context).length <= threshold) return params.body;
  const target = Math.min(cfg.targetChars ?? 4000, Math.floor(threshold / 2));
  const mandatory = records.filter(m => m.retention === "recent" || m.contextKinds?.includes("direct-quote"));
  // Keep recent messages verbatim where they fit. Otherwise summarize each one,
  // retaining one host-owned source record per message, including every recent one.
  const keep = mandatory.length < records.length && raw(mandatory, context).length + target + 512 <= threshold ? mandatory : [];
  const keptIds = new Set(keep.map(m => m.messageId));
  const selected = records.filter(m => !keptIds.has(m.messageId));
  const perMessageChars = Math.max(16, Math.floor(target / selected.length));
  let mode = "AI 生成，非原文";
  let texts: string[];
  const controller = new AbortController();
  const abort = () => controller.abort();
  params.signal?.addEventListener("abort", abort, {once:true});
  if (params.signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure = "摘要不可用";
  try {
    if (cfg.enabled === false) { failure = "AI 摘要已关闭"; throw new Error(failure); }
    if (JSON.stringify(selected).length > (cfg.maxInputChars ?? 200000)) {
      failure = "原文超过摘要读取预算"; throw new Error(failure);
    }
    if (controller.signal.aborted) throw new Error("Summary aborted");
    const completion = params.complete({records:selected, perMessageChars, signal:controller.signal});
    const text = await Promise.race([completion, new Promise<never>((_, reject) => {
      const fail = () => reject(new Error("Summary aborted"));
      controller.signal.addEventListener("abort",fail,{once:true});
      if (controller.signal.aborted) fail();
      timer = setTimeout(() => { failure = "AI 摘要超时"; controller.abort(); },cfg.timeoutMs ?? 8000);
    })]);
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data) || data.length !== selected.length) throw new Error("Invalid summary coverage");
    const summaries = new Map<string,string>();
    for (const row of data) {
      if (!row || typeof row !== "object" || typeof row.messageId !== "string" ||
        typeof row.summary !== "string" || !row.summary.trim() || row.summary.length > perMessageChars ||
        summaries.has(row.messageId)) throw new Error("Invalid summary entry");
      summaries.set(row.messageId,row.summary);
    }
    texts = selected.map(m => {
      const text = summaries.get(m.messageId);
      if (!text) throw new Error("Missing source");
      return text;
    });
  } catch {
    mode = `原文摘录，非 AI 摘要；${failure}`;
    texts = selected.map(m => {
      if (m.content.length <= perMessageChars) return m.content;
      const half = Math.max(1,Math.floor((perMessageChars - 8) / 2));
      return m.content.slice(0,half) + "…[截取]…" + m.content.slice(-half);
    });
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    params.signal?.removeEventListener("abort",abort);
  }
  const sources = selected.map((m,i) => ({
    messageId:m.messageId, parentId:m.parentId, senderId:m.senderId,
    contextKinds:m.contextKinds, representation:mode.startsWith("AI") ? "summary" : "excerpt",
    sourceFingerprint:contextFingerprint(m), content:texts[i],
  }));
  // Summaries stay outside the messages array, within the same history block.
  // Reading a summary must never mark its originals as seen in the transcript.
  return raw(keep, {...context, summary: {mode, sources}}) + "\n" + tail;
}
