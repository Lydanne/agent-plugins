/** Resolve only the host's bare warning; never infer failures from user prose or expose raw logs. */
export function explainCodexQueryWarning(text: string | undefined, context: {
  accountId: string; sessionKey?: string; requesterId?: string; since?: number;
}): string | undefined {
  if (!text || !/^⚠️\s*(?:\*\*)?(?:Codex Query|Agent Worker|agent_worker)(?:\*\*)?\s+(?:failed|blocked)\.?\s*$/i.test(text.trim())) return text;
  const fallback = "⚠️ Codex 查询未完成：宿主没有提供可确认的具体原因。请先核对原任务状态，不要直接重做业务操作。";
  const registry = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("ada.codex-query-diagnostics.v1")];
  if (!(registry instanceof Map) || !context.sessionKey || !context.requesterId) return fallback;
  const entry = registry.get(JSON.stringify([context.accountId, context.sessionKey, context.requesterId]));
  if (!entry || entry.updatedAt < (context.since ?? 0) || Date.now() - entry.updatedAt > 600_000 || typeof entry.read !== "function") return fallback;
  try { return `⚠️ ${entry.read()}`; } catch { return fallback; }
}
