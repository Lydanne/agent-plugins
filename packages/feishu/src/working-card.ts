import {recentlyMentioned} from './recent-outbound-mentions.js';
import { renderBusinessMessage } from "./business-config.js";
import type { FeishuConfig } from "./types.js";
import { readFile } from "node:fs/promises";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import type { MentionTarget } from "./mention-target.types.js";
import { withinCardTableLimit } from "./presentation-card.js";
import { editMessageFeishu, sendCardFeishu, sendMessageFeishu } from "./send.js";

const imageKeys = new Map<string, { expiresAt: number; pending: Promise<string> }>();
const MAX_CARD_BYTES = 28_000;

/** Quote accepted final prose, not a new model inference or tool/reasoning output. */
export function extractWorkingCardConclusion(text: string, keywords = ["结论","结果","处理结果","最终结果"], empty = "本轮未提供可摘录的文字结论，请查看结果卡片及附件。"): string {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`]/g, "");
  const lines = prose.split(/\r?\n/).map((line) => line.replace(/^\s*(?:#{1,6}\s*|>\s*|[-+]\s+)/, "").trim()).filter(Boolean);
  const isHeading = (line:string) => keywords.some(keyword=>line.startsWith(keyword) && (line===keyword || /^\s*[:：]/.test(line.slice(keyword.length))));
  const conclusionIndex = lines.findIndex((line) => isHeading(line));
  const selected = conclusionIndex >= 0
    ? lines.slice(conclusionIndex).find((line) => !keywords.some(keyword=>line.startsWith(keyword) && /^\s*[:：]?$/.test(line.slice(keyword.length))))
    : lines.find((line) => !/^[\s|:—-]+$/.test(line));
  if (!selected) return empty;
  // Array.from counts code points, so an excerpt never splits an emoji surrogate pair.
  const chars = Array.from(selected);
  return chars.slice(0, 180).join("") + (chars.length > 180 ? "…" : "");
}

export function workingResultCard(text: string, config: Pick<FeishuConfig,"workingCard"|"businessMessages"> = {}): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: extractWorkingCardConclusion(text,config.workingCard?.conclusionKeywords,renderBusinessMessage(config.businessMessages,"emptyConclusion")) } },
    body: { elements: [{ tag: "markdown", content: text }] },
  };
}

type WorkingCardParams = {
  sourceSignal?: AbortSignal;
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  requester?: MentionTarget;
  log: (message: string) => void;
};

async function uploadWorkingImage(params: WorkingCardParams, phase: "waiting" | "working"): Promise<string> {
  const account = resolveFeishuRuntimeAccount(params);
  const path = phase === "waiting" ? account.config?.workingCard?.waitingImage : account.config?.workingCard?.workingImage;
  const key = JSON.stringify([account.accountId, account.domain, account.appId, phase, path]);
  const cached = imageKeys.get(key);
  let pending = cached && cached.expiresAt > Date.now() ? cached.pending : undefined;
  if (!pending) {
    pending = (async () => {
      const image = await readFile(path ?? new URL(`../assets/ada-${phase}.gif`, import.meta.url));
      const response = await createFeishuClient(account).im.image.create({
        data: { image_type: "message", image },
      });
      const uploaded = response as { code?: number; image_key?: string; data?: { image_key?: string } } | undefined;
      if (uploaded?.code !== undefined && uploaded.code !== 0) throw new Error("Working GIF upload rejected");
      const imageKey = uploaded?.image_key ?? uploaded?.data?.image_key;
      if (!imageKey) throw new Error("Working GIF upload returned no image_key");
      return imageKey;
    })();
    if (imageKeys.size >= 64) imageKeys.delete(imageKeys.keys().next().value!);
    imageKeys.set(key, { expiresAt: Date.now() + 60 * 60_000, pending });
    void pending.catch(() => { if (imageKeys.get(key)?.pending === pending) imageKeys.delete(key); });
  }
  return pending;
}

/** One admitted human turn owns one placeholder and at most one completion mention. */
export class FeishuWorkingCard {
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;
  private placeholderAttempted = false;
  private creationState: "not_sent" | "uncertain" | "created" = "not_sent";
  private waiting = false;
  private ended = false;
  private messageId?: string;
  private resultMessageId?: string;
  private acceptedText = "";
  private latestConclusion = "";
  private failed = false;
  private notificationAttempted = false;
  private background = false;
  private backgroundProgress?: string;
  private resultMentionedRequester = false;
  private workingImageKey?: string;

  private readonly config: FeishuConfig;
  constructor(private readonly params: WorkingCardParams) { this.config = resolveFeishuRuntimeAccount(params).config ?? {}; }
  private message(key: Parameters<typeof renderBusinessMessage>[1], values: Record<string,string> = {}) { return renderBusinessMessage(this.config.businessMessages,key,values); }
  private conclusion(text:string) { return extractWorkingCardConclusion(text,this.config.workingCard?.conclusionKeywords,this.message("emptyConclusion")); }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  wait(): Promise<void> {
    return this.serial(async () => {
      if (this.params.sourceSignal?.aborted || this.started || this.ended || this.waiting) return;
      this.waiting = true;
      await this.showImage("waiting");
    });
  }

  start(): Promise<void> {
    return this.serial(async () => {
      if (this.params.sourceSignal?.aborted || this.started || this.ended) return;
      this.started = true;
      await this.showImage("working");
    });
  }

  placeholderCreationState(): "not_sent" | "uncertain" | "created" { return this.creationState; }

  private async showImage(phase: "waiting" | "working"): Promise<void> {
    // Never retry an uncertain create. A later stage may only edit a known ID.
    if (!this.messageId && this.placeholderAttempted) return;
    this.placeholderAttempted = true;
    try {
      const imageKey = await uploadWorkingImage(this.params, phase);
      if (this.params.sourceSignal?.aborted) return;
      const card = {
        schema: "2.0",
        config: { update_multi: true },
        body: { elements: [
          { tag: "img", img_key: imageKey, alt: { tag: "plain_text", content: this.message(phase === "waiting" ? "waitingAlt" : "workingAlt") }, scale_type: "crop_center", size: this.config.workingCard?.imageSize ?? "240px 240px", preview: false },
        ] },
      };
      if (this.messageId) {
        await editMessageFeishu({ cfg: this.params.cfg, accountId: this.params.accountId, messageId: this.messageId, card });
      } else {
        // Mark before dispatch: a rejected transport may still have delivered.
        this.creationState = "uncertain";
        this.messageId = (await sendCardFeishu({ ...this.params, card })).messageId;
        if (this.messageId) this.creationState = "created";
      }
      if (phase === "working") this.workingImageKey = imageKey;
    } catch {
      this.params.log(`working card ${phase} image failed; final delivery will continue`);
    }
  }

  ownsMessage(messageId: string): boolean { return this.messageId === messageId || this.params.replyToMessageId === messageId; }

  questionTarget(): {messageId:string} | undefined {
    return this.messageId && !this.ended && !this.params.sourceSignal?.aborted ? {messageId:this.messageId} : undefined;
  }

  /** End Main's placeholder without reporting business completion or overwriting its question. */
  waitForUser(questionMessageId: string | undefined, text: string): Promise<string | undefined> {
    return this.serial(async () => {
      if (this.ended) return this.messageId;
      this.ended = true;
      if (this.messageId !== questionMessageId) await this.replaceStatus(text);
      return this.messageId;
    });
  }

  /** Keep the known placeholder alive after the dispatching model turn ends. */
  holdForBackground(progress?: string): Promise<{messageId: string; imageKey?: string} | undefined> {
    return this.serial(async () => {
      if (this.ended || this.params.sourceSignal?.aborted) return undefined;
      this.background = true;
      if (progress && this.messageId && this.backgroundProgress !== progress) {
        const card = workingResultCard(progress, this.config);
        if (this.workingImageKey) {
          (card.body as {elements: Record<string, unknown>[]}).elements.unshift({
            tag: "img", img_key: this.workingImageKey,
            alt: {tag: "plain_text", content: this.message("workingAlt")},
            scale_type: "crop_center", size: this.config.workingCard?.imageSize ?? "240px 240px", preview: false,
          });
        }
        try {
          await editMessageFeishu({cfg: this.params.cfg, accountId: this.params.accountId, messageId: this.messageId, card});
          this.backgroundProgress = progress;
        } catch { this.params.log("continuation card progress update failed; keeping known working card"); }
      }
      return this.messageId ? {messageId: this.messageId, imageKey: this.workingImageKey} : undefined;
    });
  }

  /** Create first, then recall only the placeholder owned by this live turn. */
  refreshProgress(replyToMessageId: string, text: string): Promise<boolean> {
    return this.serial(async () => {
      if (!this.started || this.ended || this.resultMessageId || !this.messageId) return false;
      const oldId = this.messageId;
      try {
        const imageKey = await uploadWorkingImage(this.params, "working");
        if (this.params.sourceSignal?.aborted) return true;
        const result = await sendCardFeishu({ ...this.params, replyToMessageId, card: {
          schema: "2.0", config: {update_multi: true}, body: {elements: [
            {tag: "img", img_key: imageKey, alt: {tag: "plain_text", content: this.message("workingAlt")}, scale_type: "crop_center", size: this.config.workingCard?.imageSize ?? "240px 240px", preview: false},
            {tag: "markdown", content: text},
          ]},
        }});
        if (!result.messageId) throw new Error("No new message ID");
        this.messageId = result.messageId;
        this.workingImageKey = imageKey;
        this.params.replyToMessageId = replyToMessageId;
      } catch {
        this.params.log("progress card send failed or unconfirmed; keeping original card without retry");
        // The nudge is consumed even when sending is uncertain: never start duplicate work.
        return true;
      }
      try {
        const response = await createFeishuClient(resolveFeishuRuntimeAccount(this.params)).im.message.delete({path: {message_id: oldId}});
        if (response.code !== undefined && response.code !== 0) throw new Error("Recall rejected");
      } catch {
        this.params.log("progress card moved, but old placeholder recall failed or is unconfirmed");
        try { await editMessageFeishu({cfg: this.params.cfg, accountId: this.params.accountId, messageId: oldId, card: workingResultCard(this.message("progressMoved"),this.config)}); } catch { /* Keep newest card authoritative. */ }
      }
      return true;
    });
  }

  complete(text: string, card?: Record<string, unknown>): Promise<string | undefined> {
    return this.serial(async () => {
      if (this.params.sourceSignal?.aborted) return undefined;
      if (!this.messageId || this.ended) return undefined;
      if (!card && text === this.acceptedText && this.resultMessageId === this.messageId) return this.messageId;
      const combined = !this.acceptedText || text.startsWith(this.acceptedText)
        ? text : this.acceptedText === text ? text : `${this.acceptedText}\n\n${text}`;
      const nextCard = card
        ? { ...card, config: { ...(card.config as Record<string, unknown> ?? {}), update_multi: true, streaming_mode: false } }
        : workingResultCard(combined,this.config);
      if (Buffer.byteLength(JSON.stringify(nextCard), "utf8") > MAX_CARD_BYTES || !withinCardTableLimit(combined)) {
        await this.replaceStatus(this.message("oversizedResult"));
        return undefined;
      }
      let acceptedMentions: string[] = [];
      try {
        const receipt = await editMessageFeishu({ cfg: this.params.cfg, accountId: this.params.accountId, messageId: this.messageId, card: nextCard });
        acceptedMentions = receipt.mentionedUserIds ?? [];
      } catch {
        this.params.log("working card result update failed; using ordinary final delivery");
        await this.replaceStatus(this.message("updateFailed"));
        return undefined;
      }
      this.resultMentionedRequester = !!this.params.requester && acceptedMentions.includes(this.params.requester.openId);
      this.acceptedText = combined;
      this.latestConclusion = this.conclusion(text);
      this.resultMessageId = this.messageId;
      return this.messageId;
    });
  }

  /** Called only after the normal delivery path accepted an oversized/fallback result. */
  acceptExternalResult(messageId: string | undefined, text: string): Promise<void> {
    return this.serial(async () => {
      if (!messageId || this.ended) return;
      if (messageId === this.messageId && this.resultMessageId === messageId) return;
      this.resultMessageId = messageId;
      this.resultMentionedRequester = false;
      this.latestConclusion = this.conclusion(text);
      await this.replaceStatus(this.message("resultExcerpt",{conclusion:this.latestConclusion}));
    });
  }

  private async replaceStatus(text: string): Promise<void> {
    if (!this.messageId) return;
    try {
      await editMessageFeishu({ cfg: this.params.cfg, accountId: this.params.accountId, messageId: this.messageId, card: workingResultCard(text,this.config) });
    } catch {
      this.params.log("working card status update failed; the old placeholder may remain visible");
    }
  }

  fail(): void { this.failed = true; }

  finish(reason?: string): Promise<void> {
    return this.serial(async () => {
      if (this.ended) return;
      if (this.background && !reason) return;
      this.ended = true;
      if (reason || !this.resultMessageId) {
        const status = reason ?? (this.failed
          ? this.message("failed")
          : this.message("emptyResult"));
        await this.replaceStatus(this.acceptedText ? `${this.acceptedText}\n\n---\n${status}` : status);
        return;
      }
      if (this.failed && this.acceptedText) {
        await this.replaceStatus(`${this.acceptedText}\n\n---\n${this.message("partialFailure")}`);
      }
      if (this.params.sourceSignal?.aborted || this.failed || !this.params.requester || this.notificationAttempted) return;
      this.notificationAttempted = true;
      if(this.resultMentionedRequester || (!this.workingImageKey && recentlyMentioned({...this.params,accountId:resolveFeishuRuntimeAccount(this.params).accountId,replyToMessageId:this.resultMessageId},this.params.requester.openId)))return;
      try {
        await sendMessageFeishu({
          cfg: this.params.cfg,
          accountId: this.params.accountId,
          to: this.params.to,
          replyToMessageId: this.resultMessageId,
          replyInThread: this.params.replyInThread,
          mentions: [this.params.requester],
          plainText: true,
          text: this.message("completionMention"),
        });
      } catch {
        // Result is already delivered. Never re-deliver it or retry an uncertain mention.
        this.params.log("working card result delivered, but completion mention failed or is unconfirmed");
      }
    });
  }
}
