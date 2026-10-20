import {buildFeishuPostMessageContent} from './markdown.js';
import {normalizeFeishuTarget} from './targets.js';

export type FeishuMentionScope = {accountId?: string; to: string; replyInThread?: boolean; replyToMessageId?: string};
type Entry = {at: number; messageId: string; mentions: string[]};
const ttl = 5 * 60_000;
const histories = new Map<string, Entry[]>();
// Keep only IDs and scope bindings so a long-running card can retain its thread.
const messages = new Map<string, {scope: string; target: string | null; at: number}>();
const identity = (accountId: string | undefined, id: string) => JSON.stringify([accountId ?? 'default', id]);

function scopeKey(scope: FeishuMentionScope) {
  const target = normalizeFeishuTarget(scope.to);
  const parent = scope.replyToMessageId ? messages.get(identity(scope.accountId, scope.replyToMessageId)) : undefined;
  return parent?.target === target ? parent.scope : JSON.stringify([
    scope.accountId ?? 'default', target, scope.replyInThread ? scope.replyToMessageId ?? 'unknown-thread' : 'chat',
  ]);
}

function prune(now: number) {
  for (const [key, history] of histories) {
    const current = history.filter(entry => now - entry.at < ttl);
    if (current.length) histories.set(key, current);
    else histories.delete(key);
  }
  for (const [key, entry] of messages) if (now - entry.at > 24 * 60 * 60_000) messages.delete(key);
  while (histories.size > 2000) histories.delete(histories.keys().next().value!);
  while (messages.size > 5000) messages.delete(messages.keys().next().value!);
}

export function nativeMentionIds(content: unknown): string[] {
  const ids = new Set<string>();
  function visit(value: unknown) {
    if (Array.isArray(value)) {for (const child of value) visit(child); return;}
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.tag === 'at' && typeof node.user_id === 'string' && node.user_id !== 'all') ids.add(node.user_id);
    const markdown = node.tag === 'markdown' ? node.content : node.tag === 'lark_md' ? node.content ?? node.text : undefined;
    if (typeof markdown === 'string') {
      // Use the outbound rich-post parser, which protects code and escaped markup.
      visit(JSON.parse(buildFeishuPostMessageContent({messageText: markdown})));
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'summary' && key !== 'alt') visit(child);
  }
  // Bookkeeping must never turn an acknowledged provider send into a failure.
  try {visit(content);} catch {return [];}
  return [...ids];
}

export function textMentionsUser(text: string, userId: string) {
  return nativeMentionIds({tag: 'markdown', content: text}).includes(userId);
}

export function recordOutboundMentions(scope: FeishuMentionScope, messageId: string, content: unknown, now = Date.now()) {
  if (!messageId) return;
  prune(now);
  const key = scopeKey(scope), history = histories.get(key) ?? [];
  histories.delete(key);
  histories.set(key, [...history.filter(entry => entry.messageId !== messageId), {at: now, messageId, mentions: nativeMentionIds(content)}].slice(-5));
  messages.delete(identity(scope.accountId, messageId));
  messages.set(identity(scope.accountId, messageId), {scope: key, target: normalizeFeishuTarget(scope.to), at: now});
}

export function recordEditedMentions(accountId: string | undefined, messageId: string, content: unknown, now = Date.now(), scope?: FeishuMentionScope) {
  prune(now);
  const binding = messages.get(identity(accountId, messageId));
  if (!binding) {
    if (scope) recordOutboundMentions({...scope, accountId}, messageId, content, now);
    return;
  }
  const history = histories.get(binding.scope) ?? [];
  histories.set(binding.scope, [...history.filter(entry => entry.messageId !== messageId), {at: now, messageId, mentions: nativeMentionIds(content)}].slice(-5));
  binding.at = now;
}

export function recentlyMentioned(scope: FeishuMentionScope, userId: string, now = Date.now()) {
  prune(now);
  return histories.get(scopeKey(scope))?.some(entry => entry.mentions.includes(userId)) ?? false;
}

export function clearRecentOutboundMentions() {histories.clear(); messages.clear();}
