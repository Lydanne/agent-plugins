import { createHash, randomUUID } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Trace host rejection delivery without logging message content, credentials or user IDs. */
export function traceHostErrorDelivery(
  input: { text: string; to: string; accountId?: string; replyToMessageId?: string },
  log: (message: string) => void = message => console.warn(message),
) {
  if (!/^Your (?:request couldn't be completed: Your )?message could not be sent:/.test(input.text.trim()) || !/\(blocked by [A-Za-z0-9_-]+\)\s*$/.test(input.text.trim())) return undefined;
  const traceId = randomUUID();
  // Retain only executable code frames, never the Error message or arbitrary path contents.
  const frames = (new Error().stack ?? "").split("\n").slice(1, 18).map(line => {
    const location = /([A-Za-z0-9_.-]+\.(?:mjs|cjs|js|ts)):(\d+):(\d+)\)?$/.exec(line);
    return location ? `${location[1]}:${location[2]}:${location[3]}` : undefined;
  }).filter(Boolean);
  const base = { traceId, pid: process.pid, textHash: digest(input.text), targetHash: digest(JSON.stringify([input.accountId ?? "default", input.to])), replyBound: !!input.replyToMessageId };
  const emit = (event: Record<string, unknown>) => {
    try { log(`feishu: host-error-delivery ${JSON.stringify({ ...base, ...event })}`); } catch { /* Diagnostics must not change delivery outcome. */ }
  };
  emit({ stage: "attempt", frames });
  return (messageId: string) => emit({ stage: "acknowledged", messageId });
}
