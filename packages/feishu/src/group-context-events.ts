import { invalidateGroupInfo } from "./bot-group-name.js";
import { invalidateGroupResources } from "./group-resources.js";

export function invalidateGroupContext(accountId: string, chatId: string): void {
  if (!chatId) return;
  invalidateGroupInfo(accountId, chatId);
  invalidateGroupResources(accountId, chatId);
}

// The SDK exposes group configuration changes, but no announcement/Pin change event.
// Only invalidate here: a later admitted group turn performs the read, never starts a task.
export function groupContextEventHandlers(accountId: string) {
  return {
    "im.chat.updated_v1": async (data: { chat_id?: string }) => {
      if (data.chat_id) invalidateGroupContext(accountId, data.chat_id);
    },
  };
}
