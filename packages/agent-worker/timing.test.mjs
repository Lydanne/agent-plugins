import {test} from 'node:test';
import assert from 'node:assert/strict';
import {duration,taskTime,toolCalls,callTime} from './timing.mjs';
test('task clocks freeze terminal and unknown jobs and distinguish queue and human waits',()=>{
 assert.equal(duration(3661000),'1h1m1s');assert.equal(duration(23),'<1s');assert.equal(duration(1000),'1s');assert.equal(duration(60000),'1m');assert.equal(duration(3600000),'1h');
 const task={createdAt:1000,status:'running'};
 assert.equal(taskTime(task,65000),'总用时 1m4s');
 assert.equal(taskTime({...task,status:'queued'},65000),'总用时 1m4s · 排队中');
 assert.equal(taskTime({...task,status:'awaiting_user',questions:[{createdAt:5000,waitingForUserAt:35000}]},65000),'总用时 1m4s · 等待用户 30s');
 assert.equal(taskTime({...task,status:'awaiting_main',questions:[{createdAt:5000}]},65000),'总用时 1m4s · 等待 Main 1m');
 assert.equal(taskTime({...task,status:'completed',finishedAt:62000},999000),'总用时 1m1s');
 assert.equal(taskTime({...task,status:'failed'},999000),'用时未记录');
 assert.equal(taskTime({...task,status:'unknown',heartbeatAt:62000},999000),'总用时 1m1s（截至最后心跳，状态待确认）');
 assert.equal(taskTime({status:'running'},999000),'用时未记录');
 assert.equal(taskTime({...task,createdAt:80000},65000),'总用时 0s');
});
test('tool durations pair observed events per turn, retain starts through updates, and never invent missing starts',()=>{
 const event=(event,time,id='same',type='command_execution')=>({event,time,item:{id,type}});
 const calls=toolCalls([{event:'turn.started'},event('item.started',1000),event('item.updated',2000),event('item.completed',3500),event('item.started',2000,'parallel','mcp_tool_call'),event('item.completed',6000,'parallel','mcp_tool_call'),{event:'turn.started'},event('item.started',9000),event('item.completed',9500,'old'),event('item.completed',10000,'message','agent_message')]);
 assert.equal(calls.length,4);assert.equal(callTime(calls[0],{},20000),'2s');assert.equal(callTime(calls[1],{},20000),'4s');
 assert.notEqual(calls[0].callKey,calls[2].callKey);assert.equal(callTime(calls[2],{status:'running'},20000),'11s');
 assert.equal(callTime(calls[2],{status:'timed_out',finishedAt:12000},20000),'3s · 未返回');
 assert.equal(callTime(calls[2],{status:'unknown',heartbeatAt:12000},20000),'3s · 待确认');
 assert.equal(callTime(calls[3],{},20000),'—');
});
