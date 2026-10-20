import {workerReportInstructions,delegationReportInstructions,defaultConfiguration} from './configuration.mjs';
import {contextRequestInstructions,pluginCapabilityInstructions} from './context-request.mjs';
import {experienceInstructions} from './experience.mjs';
import {normalizeMemoryContext,memoryPolicy} from './memory-context.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildTaskPrompt,selectExecutionSession,executionPolicyVersion,executorInstructions,businessDataPolicy,delegationDescription} from './index.mjs';
const params={task:'查询任务进度',context:'已知任务 ID',constraints:'development3，只读查询，不创建导出'};
test('delegates only structured task, constraints and context',()=>{
 assert.deepEqual(JSON.parse(buildTaskPrompt(params)),{kind:'business_task',reportInstructions:workerReportInstructions,contextRequestInstructions,pluginCapabilityInstructions,...params,memory:normalizeMemoryContext(undefined),memoryPolicy,dataPolicy:businessDataPolicy,experienceInstructions});
 assert.ok(executorInstructions.length<1000);
 assert.ok(executorInstructions.includes('push'));
 assert.ok(!buildTaskPrompt(params).includes(executorInstructions));
 const isolated=JSON.parse(buildTaskPrompt(params,{reportDirectory:'.tmp/codex-query/fixture'}));
 assert.equal(isolated.reportDirectory,'.tmp/codex-query/fixture');
 assert.ok(isolated.reportPolicy.includes('不覆盖其他 job'));
 assert.ok(isolated.reportInstructions.includes('每个任务都必须生成完成报告'));
 assert.ok(!isolated.reportPolicy.includes('实际结论'));
 assert.ok(experienceInstructions.guidance.includes('遵守 reportInstructions'));
 assert.ok(!experienceInstructions.guidance.includes('无报告返回'));
 assert.equal(isolated.constraints,params.constraints);
});
test('routes OpenClaw plugin capabilities through Main while allowing independently authorized CLI use using the existing request/reply protocol',()=>{
 const prompt=JSON.parse(buildTaskPrompt(params));
 assert.match(prompt.pluginCapabilityInstructions,/必须请求 Main/);
 assert.match(prompt.pluginCapabilityInstructions,/type=request/);
 assert.match(prompt.pluginCapabilityInstructions,/reply/);
 assert.match(prompt.pluginCapabilityInstructions,/自身已有权限内直接使用 Feishu CLI/);
 assert.match(prompt.pluginCapabilityInstructions,/feishu_cli、feishu_cli_auth.*仍必须请求 Main/);
 assert.match(prompt.pluginCapabilityInstructions,/替代历史提示/);
 assert.doesNotMatch(prompt.pluginCapabilityInstructions,/不直接执行 lark-cli|不自行安装、更新 CLI 或发起 OAuth/);
});
test('requires explicit bounded execution restrictions',()=>{
 for(const constraints of [undefined,'','  ','x'.repeat(4001)]) assert.throws(()=>buildTaskPrompt({...params,constraints}));
});
test('reuses lightweight sessions and migrates legacy sessions only once',()=>{
 assert.equal(selectExecutionSession(undefined),undefined);
 assert.equal(selectExecutionSession({sessionId:'old',roleHash:'legacy'}),undefined);
 assert.equal(selectExecutionSession({sessionId:'blocked-refresh',executionPolicyVersion:4}),undefined);
 assert.equal(selectExecutionSession({sessionId:'previous-report-policy',executionPolicyVersion:5}),undefined);
 assert.equal(selectExecutionSession({sessionId:'new',executionPolicyVersion}),'new');
});

test('keeps execution neutral while preserving explicit requested deliverables and complete data',()=>{
 const request={...params,task:'查询并生成客服话术',context:'目标 OpenID=openid-full；完整下载链接 https://example.test/result?signature=full；原提问者偏好简洁',mainReplies:[{answer:'交付物需要附完整证据'}]};
 const prompt=JSON.parse(buildTaskPrompt(request,{}, {...defaultConfiguration,executorInstructions:'自定义只读规则'}));
 assert.equal(prompt.task,request.task);
 assert.equal(prompt.context,request.context);
 assert.deepEqual(prompt.mainReplies,request.mainReplies);
 assert.equal(prompt.reportInstructions,workerReportInstructions);
 assert.ok(prompt.reportInstructions.includes('不作为执行或原报告的风格依据'));
 assert.ok(prompt.reportInstructions.includes('用户明确要求的产物'));
 const description=delegationDescription({...defaultConfiguration,delegationInstructions:'自定义委派规则'},true);
 assert.ok(description.includes(delegationReportInstructions));
 assert.ok(description.includes('自定义委派规则'));
 assert.ok(description.includes('末尾附完整原始报告链接'));
});

test('task people are channel-bound context, never model supplied parameters',()=>{
 const people={requester:{openId:'ou_reporter',giteaUsername:'reporter'},mentions:[{openId:'ou_dev',giteaUsername:'dev'}]};
 assert.equal(JSON.parse(buildTaskPrompt({...params,people})).people,undefined);
 const prompt=JSON.parse(buildTaskPrompt(params,{people}));assert.deepEqual(prompt.people,people);assert.match(prompt.peoplePolicy,/记录人为 requester/);
});
