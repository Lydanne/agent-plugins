import { createInboundDebouncer, resolveInboundDebounceMs } from "openclaw/plugin-sdk/channel-inbound-debounce";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { expect, it, vi } from "vitest";
import * as dedup from "./dedup.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

it.each(["更正一下：改查昨天", "还要多久？"])("urgent input %s bypasses running work and debounce", async (urgent) => {
  const claim = vi.spyOn(dedup, "claimUnprocessedFeishuMessage").mockImplementation(async ({ messageId }) => ({
    kind: "claimed", handle: { keys: [messageId!], commit: async () => true, release: () => {} },
  }));
  let finishFirst!: () => void;
  const gate = new Promise<void>((resolve) => { finishFirst = resolve; });
  const order: string[] = [];
  const errors = vi.fn();
  const handler = createFeishuMessageReceiveHandler({
    cfg: { messages: { inbound: { debounceMs: 1 } } }, accountId: "test",
    channelRuntime: {
      debounce: { createInboundDebouncer, resolveInboundDebounceMs },
      commands: { isControlCommandMessage: () => false },
    } as unknown as PluginRuntime["channel"],
    runtime: { log: vi.fn(), error: errors } as never,
    chatHistories: new Map(),
    resolveSequentialKey: getFeishuSequentialKey,
    resolveDebounceText: ({event}) => JSON.parse(event.message.content).text,
    hasProcessedMessage: async () => false,
    handleMessage: async ({preparedContent, event}) => {
      const text = preparedContent ?? JSON.parse(event.message.content).text;
      order.push(text);
      if (text === "first") await gate;
    },
  });
  const send = (text: string) => handler({
    sender: { sender_id: { open_id: "sender" }, sender_type: "user" },
    message: { message_id: text, chat_id: "chat", chat_type: "p2p", message_type: "text", content: JSON.stringify({text}) },
  });
  try {
    const first = send("first");
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    const second = send("ordinary second");
    const correction = send(urgent);
    await vi.waitFor(() => expect(order).toEqual(["first", urgent]));
    finishFirst();
    await vi.waitFor(() => expect(order).toEqual(["first", urgent, "ordinary second"]));
    await Promise.all([first, second, correction]);
    expect(errors).not.toHaveBeenCalled();
  } finally { finishFirst(); claim.mockRestore(); }
});

it("releases transport serialization after admitted execution takes ownership", async () => {
  const claim=vi.spyOn(dedup,"claimUnprocessedFeishuMessage").mockImplementation(async({messageId})=>({
    kind:"claimed",handle:{keys:[messageId!],commit:async()=>true,release:()=>{}},
  }));
  let finish!:()=>void; const gate=new Promise<void>(r=>{finish=r;});
  const calls:string[]=[];
  const handler=createFeishuMessageReceiveHandler({
    cfg:{messages:{inbound:{debounceMs:1}}},accountId:"admitted",chatHistories:new Map(),
    channelRuntime:{debounce:{createInboundDebouncer,resolveInboundDebounceMs},commands:{isControlCommandMessage:()=>false}} as unknown as PluginRuntime['channel'],
    runtime:{log:vi.fn(),error:vi.fn()} as never,
    resolveDebounceText:({event})=>JSON.parse(event.message.content).text,
    hasProcessedMessage:async()=>false,
    handleMessage:async({event,onDispatchReady,turnAdoptionLifecycle})=>{
      calls.push(event.message.message_id);
      turnAdoptionLifecycle?.onDeferred();onDispatchReady?.();
      if(event.message.message_id==='first')await gate;
      await turnAdoptionLifecycle?.onAdopted();
    },
  });
  const send=(id:string)=>handler({sender:{sender_id:{open_id:'sender'},sender_type:'user'},message:{message_id:id,chat_id:'chat',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:id})}});
  try{
    await send('first');await vi.waitFor(()=>expect(calls).toEqual(['first']));
    await send('second');await vi.waitFor(()=>expect(calls).toEqual(['first','second']));
  }finally{finish();claim.mockRestore();}
});
