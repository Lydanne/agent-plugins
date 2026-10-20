import test from 'node:test';
import assert from 'node:assert/strict';
import {registerQuestionBridge} from './question-bridge.mjs';
test('question reader and cancellation validate scope, owner, source and pending question',()=>{
 const p={taskId:'task',revision:0,senderId:'alice',accountId:'a',chatId:'chat',sessionKey:'main'};
 const q={questionId:'q',expiresAt:Date.now()+10000};let current={provenance:p,status:'awaiting_user',questions:[q],contextRequest:q,jobId:'job'};
 let service,cancels=0;
 registerQuestionBridge({registerService:s=>{service=s;}},{status:(id,scope)=>{assert.equal(id,'job');assert.equal(scope,'main');return current;},cancel:()=>{cancels++;return {status:'cancelled'};}},{authorizeReply:()=>true});
 const bridge=globalThis[Symbol.for('ada.worker-question.v1')];service.start();
 try{
  assert.equal(bridge.read({jobId:'job',questionId:'q',provenance:p}).status,'awaiting_user');
  assert.throws(()=>bridge.read({jobId:'job',questionId:'q',provenance:{...p,senderId:'bob'}}),/source/);
  assert.throws(()=>bridge.read({jobId:'job',questionId:'old',provenance:p}),/expired/);
  assert.equal(bridge.cancel({jobId:'job',questionId:'q',provenance:p}).status,'cancelled');assert.equal(cancels,1);
  current={...current,status:'running'};assert.throws(()=>bridge.cancel({jobId:'job',questionId:'q',provenance:p}),/awaiting/);assert.equal(cancels,1);
 }finally{service.stop();}
 assert.equal(bridge.read,undefined);assert.equal(bridge.cancel,undefined);
});

test('presentation distinguishes delivery failure and requires a usable text fallback',async()=>{
 const {contextPresentation,waitingPresentationInstruction}=await import('./question-bridge.mjs');
 const event={provenance:{sessionKey:'trusted'}};
 for(const handler of [undefined,async()=>undefined,async()=>({interactive:false})]){
  const result=await contextPresentation(handler,event);assert.deepEqual(result,{interactive:false,state:'unavailable'});assert.match(waitingPresentationInstruction(result),/立即用普通文字列出/);
 }
 const failed=await contextPresentation(async()=>{throw Error('private provider error');},event);
 assert.deepEqual(failed,{interactive:false,state:'failed'});assert.match(waitingPresentationInstruction(failed),/不要让用户确认卡片是否存在/);
 const delivered=await contextPresentation(async()=>({interactive:true}),event);assert.deepEqual(delivered,{interactive:true,state:'delivered'});assert.match(waitingPresentationInstruction(delivered),/成功投递/);assert.match(waitingPresentationInstruction(delivered),/不发送聊天消息/);assert.match(waitingPresentationInstruction(delivered),/不推测或向用户说明加急是否成功/);
 assert.deepEqual(await contextPresentation(async()=>({interactive:true}),{}),{interactive:false,state:'unavailable'});
});
