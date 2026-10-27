import {describe,expect,it} from "vitest";
import {traceHostErrorDelivery} from "./host-error-delivery-diagnostic.js";

describe("host error delivery diagnostics",()=>{
 it("correlates attempts and acknowledgements without recording private content",()=>{
  const logs:string[]=[];
  const ack=traceHostErrorDelivery({text:"Your message could not be sent: private secret (blocked by agent-repo)",to:"private-user",accountId:"private-account"},m=>logs.push(m));
  ack?.("om_fixture");expect(logs).toHaveLength(2);
  const events=logs.map(x=>JSON.parse(x.slice(x.indexOf("{") )));
  expect(events[0].traceId).toBe(events[1].traceId);expect(events[1].messageId).toBe("om_fixture");
  expect(events[0].frames.length).toBeGreaterThan(0);expect(events[0].replyBound).toBe(false);
  expect(logs.join()).not.toContain("private");expect(logs.join()).not.toContain(process.cwd());
 });
 it("does not trace normal answers or quoted error discussion",()=>{
  for(const text of ["normal reply","Example: Your message could not be sent: error (blocked by agent-repo)","Your message could not be sent: ordinary discussion"]){
   expect(traceHostErrorDelivery({text,to:"fixture"},()=>{throw Error("must not log");})).toBeUndefined();
  }
 });
 it("supports prefixed host failure notices and keeps real reply scope",()=>{
  const events:string[]=[];traceHostErrorDelivery({text:"Your request couldn't be completed: Your message could not be sent: error (blocked by agent-repo)",to:"fixture",replyToMessageId:"om_request"},m=>events.push(m));
  expect(events[0]).toContain('"replyBound":true');
 });
 it("logging failures cannot trigger an outgoing retry",()=>{
  const ack=traceHostErrorDelivery({text:"Your message could not be sent: error (blocked by agent-repo)",to:"fixture"},()=>{throw Error("logger failed");});
  expect(()=>ack?.("om_ack")).not.toThrow();
 });
});
