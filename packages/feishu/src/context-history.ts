import { CURRENT_HEADER, MESSAGE_MARKER, renderSection, findBlockHeader } from "./context-sections.js";
import { readCodexSessionContext } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import { readContextState, recordContextState } from "./context-receipts.js";
import { createHash } from "node:crypto";
import {
  getSessionEntry, readTranscriptStatsSync,
  evaluateSessionFreshness, resolveSessionResetPolicy, resolveSessionResetType,
  resolveChannelResetConfig,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import {readHistoryContext, renderHistoryContext} from './input-context.js';

export type ContextMessage = {
  messageId: string; senderId?: string; senderType?: string;
  content: string; contentType: string; createTime?: number; retention?: "recent" | "quote-neighbor" | "quote";
};
export type ContextScope = { accountId: string; chatId: string };
const MARKER = MESSAGE_MARKER;
const LEGACY_MARKER = "[飞书消息标识]\n";
function historyStart(text: string): number {
  return readHistoryContext(text)?.start ?? -1;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// Exclude time: an edit may retain the original timestamp. Include sender/type
// so equal text from different people or media does not collapse.
export function contextFingerprint(message: ContextMessage): string {
  return createHash("sha256").update(JSON.stringify([
    message.messageId, message.senderId ?? "", message.senderType ?? "",
    message.contentType, message.content,
  ])).digest("hex");
}
export function contextMessageMarker(scope: ContextScope, message: ContextMessage): string {
  return MARKER + JSON.stringify({ ...scope, messageId: message.messageId, fingerprint: contextFingerprint(message) });
}
function textContent(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter(object).filter(p => p.type === "text" && typeof p.text === "string")
    .map(p => p.text).join("\n");
}
export function parseHistory(text: string): ContextMessage[] | undefined {
  return readHistoryContext(text)?.context.messages;
}

// Walk only the selected parent chain; abandoned branches and side events are
// not evidence. After compaction/reset, conservatively refill a bounded window.
export function activeContextEvents(events: unknown[]): Record<string, unknown>[] {
  const rows = events.filter(object).filter(e => typeof e.id === "string" && e.type !== "session");
  // Explicit navigation has its own append-parent rules; do not infer a leaf.
  if (rows.some(e => e.type === "leaf")) return [];
  const byId = new Map(rows.map(e => [e.id, e]));
  let node = rows.filter(e => e.appendMode !== "side").at(-1);
  const chain: Record<string, unknown>[] = [];
  const visited = new Set<unknown>();
  while (node) {
    if (visited.has(node.id)) return [];
    visited.add(node.id);
    if (["compaction", "reset", "branch_summary"].includes(String(node.type)) ||
        (object(node.message) && node.message.role === "compactionSummary")) break;
    chain.push(node);
    if (node.parentId === null) break;
    if (typeof node.parentId !== "string" || !byId.has(node.parentId)) return [];
    node = byId.get(node.parentId);
  }
  return chain.reverse();
}
export function collectKnownContext(events: unknown[], scope: ContextScope): Map<string, string> {
  const known = new Map<string, string>();
  for (const event of activeContextEvents(events)) {
    if (event.type !== "message" || !object(event.message)) continue;
    const message = event.message;
    const text = textContent(message);
    if (message.role !== "user") continue;
    const markerHeader = [findBlockHeader(text,'FeishuMessage')?.header, '[Metadata: 飞书消息标识]\n', LEGACY_MARKER].filter((header):header is string => !!header && text.includes(header)).sort((a,b) => text.indexOf(a)-text.indexOf(b))[0] ?? MARKER;
    const marker = text.indexOf(markerHeader);
    const rawMessage = Math.min(...[text.indexOf("[message_id:"), findBlockHeader(text,'CurrentMessage')?.index ?? -1, text.indexOf('[Request: 当前消息]')].filter(n => n >= 0), Infinity);
    if (marker < 0 || (rawMessage >= 0 && rawMessage < marker)) continue;
    try {
      const rest = text.slice(marker + markerHeader.length);
      const stamp: unknown = JSON.parse(rest.split("\n", 1)[0]);
      if (!object(stamp) || stamp.accountId !== scope.accountId || stamp.chatId !== scope.chatId ||
          typeof stamp.messageId !== "string" || typeof stamp.fingerprint !== "string") continue;
      known.set(stamp.messageId, stamp.fingerprint);
      for (const previous of parseHistory(text.slice(0, marker)) ?? []) known.set(previous.messageId, contextFingerprint(previous));
    } catch { /* Unknown/legacy bodies are not proof: keep their history. */ }
  }
  return known;
}
export function removeKnownHistory(body: string, events: unknown[], scope: ContextScope, botAppId?: string, known = collectKnownContext(events, scope), botOpenId?: string): string {
  if (historyStart(body) !== 0) return body;
  const boundary = Math.min(...[findBlockHeader(body,'CurrentMessage')?.index ?? -1, body.indexOf('\n[Request: 当前消息]'), body.indexOf("\n[当前消息]")].filter(n => n >= 0), Infinity);
  if (!Number.isFinite(boundary)) return body;
  const messages = parseHistory(body.slice(0, boundary));
  if (!messages) return body;
  const retained = messages.filter(m => m.retention === "recent" || (known.get(m.messageId) !== contextFingerprint(m) &&
    (m.retention === "quote-neighbor" || m.retention === "quote" || (!(m.senderType === "app" && !!botAppId && m.senderId === botAppId) &&
    !(botOpenId && m.senderId === botOpenId)))));
  const block = readHistoryContext(body)!;
  const tail = body.slice(block.end + 1);
  if (!retained.length && Object.keys(block.context).length === 1) return tail;
  if (retained.length === messages.length) return body;
  return renderHistoryContext({...block.context, messages: retained}) + "\n" + tail;
}

export async function deduplicateSessionHistory(params: {
  body: string; agentId: string; sessionKey: string; storePath: string;
  scope: ContextScope; botAppId?: string; botOpenId?: string; cfg: ClawdbotConfig; isThread: boolean; receiptsPath?: string; deduplicateOlder?: boolean;
}): Promise<string> {
  // Recent mandatory replies survive even when already present in the transcript.
  // Older own replies retain the existing exclusion policy.
  const body = removeKnownHistory(params.body, [], params.scope, params.botAppId, new Map(), params.botOpenId);
  if (params.deduplicateOlder === false || historyStart(body) !== 0) return body;
  try {
    const identity = {agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath};
    const entry = getSessionEntry({...identity, readConsistency: "latest"});
    if (!entry?.sessionId) return body;
    const policy = resolveSessionResetPolicy({ sessionCfg: params.cfg.session,
      resetType: resolveSessionResetType({sessionKey: params.sessionKey, isGroup: true, isThread: params.isThread}),
      resetOverride: resolveChannelResetConfig({sessionCfg: params.cfg.session, channel: "feishu"}),
    });
    if (!evaluateSessionFreshness({now: Date.now(), updatedAt: entry.updatedAt,
      sessionStartedAt: entry.sessionStartedAt, lastInteractionAt: entry.lastInteractionAt, policy}).fresh) return body;
    const transcript = {...identity, sessionId: entry.sessionId};
    const version = (current: typeof entry) => JSON.stringify([current.sessionId, current.updatedAt,
      current.compactionCount, readTranscriptStatsSync(transcript)]);
    const snapshot = version(entry);
    const scope = {...params.scope, ...identity, sessionId: entry.sessionId};
    let known: Map<string, string> | undefined;
    if (params.receiptsPath) {
      try { known = readContextState(params.receiptsPath, scope, snapshot); } catch { /* Rebuild from host. */ }
    }
    if (!known) {
      // This public SDK reader projects actual model context (not the wider UI
      // history), including only retained messages after compaction/branching.
      // Consume inside its read snapshot; persist only IDs and content hashes.
      known = readCodexSessionContext(transcript, messages => {
        const index = new Map<string,string>();
        for (const message of messages) {
          if (message.role !== "user") continue;
          const entries = collectKnownContext([{id:"entry",parentId:null,type:"message",message}], params.scope);
          for (const [id, hash] of entries) index.set(id, hash);
        }
        return index;
      });
    }
    const current = getSessionEntry({...identity, readConsistency:"latest"});
    if (!current || current.sessionId !== entry.sessionId || version(current) !== snapshot) return body;
    if (params.receiptsPath) {
      try { recordContextState(params.receiptsPath, scope, snapshot, known); } catch { /* Storage is an optimization, not authority. */ }
    }
    return removeKnownHistory(body, [], params.scope, params.botAppId, known, params.botOpenId);
  } catch { return body; }
}

export function buildRelatedPeopleContext(params: {
  sender?: {name: string | null; open_id: string};
  profileSenderId?: string;
  targets: {name: string; openId: string; key?: string}[];
}): string {
  const people = new Map<string, {name: string | null; open_id: string}>();
  if (params.sender) people.set(params.sender.open_id, params.sender);
  for (const target of params.targets) {
    if (target.openId !== params.profileSenderId) people.set(target.openId, {name: target.name, open_id: target.openId});
  }
  if (!people.size) return "";
  return '\n' + renderSection('RelatedPeople', JSON.stringify([...people.values()]));
}
