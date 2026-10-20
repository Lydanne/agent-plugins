import type {FeishuConfig} from "./types.js";
type Commands=FeishuConfig["conversationCommands"];
/** Explicit correction prefixes only; quoted examples and bare keywords are not commands. */
export function isFeishuSteerText(text: string, config?: Commands): boolean {
  return (config?.steerPrefixes ?? ["更正一下","刚才说错了","改成","补充一下"]).some(prefix=>text.trim().startsWith(prefix) && /^\s*[:：，,]\s*\S/u.test(text.trim().slice(prefix.length)));
}

export function isFeishuRawSteerMessage(message: Record<string, unknown>, config?: Commands): boolean {
  if (message.message_type !== "text" || typeof message.content !== "string") return false;
  try {
    const text: unknown = JSON.parse(message.content).text;
    return typeof text === "string" &&
      isFeishuSteerText(text.replace(/^(?:\s*@_user_\d+\s*)+/u, ""),config);
  } catch { return false; }
}

type OwnerScope = { accountId: string; chatId: string; rootId?: string; sessionKey: string };
type Owner = OwnerScope & {
  senderId: string;
  messageId: string;
  retarget: (messageId: string, sourceText?: string) => Promise<void>;
  matchesProgressReply?: (messageId: string) => boolean;
  refreshProgress?: (messageId: string) => Promise<boolean>;
};
const owners = new Map<string, Owner>();
const key = (scope: OwnerScope) => JSON.stringify([
  scope.accountId, scope.chatId, scope.rootId ?? "", scope.sessionKey,
]);

/** Register only when a real agent run starts, never for a merely received message. */
export function registerFeishuSteerOwner(owner: Owner): () => void {
  owners.set(key(owner), owner);
  return () => { if (owners.get(key(owner)) === owner) owners.delete(key(owner)); };
}

export function captureFeishuSteer(scope: OwnerScope & { senderId: string; text: string; commands?: Commands }) {
  if (!isFeishuSteerText(scope.text,scope.commands)) return undefined;
  const owner = owners.get(key(scope));
  if (!owner || !scope.senderId || owner.senderId !== scope.senderId) return undefined;
  let applied = false;
  return {
    async adopted(messageId: string) {
      // A queued fallback may be adopted much later. Never redirect a successor run.
      if (applied || owners.get(key(scope)) !== owner) return false;
      applied = true;
      await owner.retarget(messageId, scope.text);
      return true;
    },
  };
}

/** Full short utterances only. Never reinterpret a new task or quoted example as a nudge. */
export function isFeishuProgressText(text: string, config?: Commands): boolean {
  if(config?.progressPhrases)return config.progressPhrases.some(phrase=>text.trim()===phrase);
  const escape = (value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const aliases=(config?.progressAliases ?? ["ada","Ada","老师"]).map(escape).join("|");
  return new RegExp(String.raw`^(?:(?:${aliases})[，,、\s]*)?(?:请问|麻烦)?\s*(?:(?:上面|刚才|之前)(?:的|那个)?(?:任务|事情|请求)[，,、\s]*)?(?:好了吗|好了没|还没好吗|还没完成吗|还在处理吗|现在到哪一步了|怎么这么久|做完了吗|完成了吗|处理完了吗|怎么样了|进度(?:怎么样|如何|呢|到哪了|到哪里了)|现在什么进度|还(?:要|需)多久(?:能(?:做完|完成))?|什么时候(?:能)?(?:做完|完成)|催一下|快点(?:呀|吧)?|怎么还没好)[？?！!。～~\s]*$`,"u").test(text.trim());
}
export function isFeishuRawProgressMessage(message: Record<string, unknown>, config?: Commands): boolean {
  if (message.message_type !== "text" || typeof message.content !== "string") return false;
  try { const text = JSON.parse(message.content).text;
    return typeof text === "string" && isFeishuProgressText(text.replace(/^(?:\s*@_user_\d+\s*)+/u, ""),config);
  } catch { return false; }
}
export function captureFeishuProgress(scope: OwnerScope & {senderId: string; text: string; parentId?: string; commands?: Commands}) {
  if (!isFeishuProgressText(scope.text,scope.commands)) return undefined;
  const owner = owners.get(key(scope));
  if (!owner?.refreshProgress || !scope.senderId || owner.senderId !== scope.senderId) return undefined;
  if (scope.parentId && scope.parentId !== owner.messageId && !owner.matchesProgressReply?.(scope.parentId)) return undefined;
  return async (messageId: string) => owners.get(key(scope)) === owner
    ? owner.refreshProgress!(messageId) : false;
}
