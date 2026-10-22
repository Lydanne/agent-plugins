import { expect, it, vi } from 'vitest';
import {
  buildConversationDecisionBatch, classifyConversationWithDecision, CONVERSATION_DECISION_MAX_BYTES,
  type ConversationDecisionOptions, type ConversationDecisionRuntime,
} from './conversation-window-decision.js';
const options: ConversationDecisionOptions = {
  agentId: 'support', config: {agents: {defaults: {decisionModel: 'typesafe/kev-latest'}}} as ConversationDecisionOptions['config'],
};
const input = {currentSender: 'user', message: '继续刚才的查询', recentConversation: [
  {role: 'user' as const, content: '请查一下这个任务'}, {role: 'assistant' as const, content: '请提供任务编号'},
], recentGroupMessages: []};
function result(choice = 'directed', probability = 0.95) {
  return {status: 'ok', result: {answers: {continuation: {type: 'choice', choice, probabilities: {
    directed: choice === 'directed' ? probability : 0.02,
    not_directed: choice === 'not_directed' ? probability : 0.02,
    uncertain: choice === 'uncertain' ? probability : 0.03,
  }}}}};
}
function setup() {
  const evaluate = vi.fn().mockResolvedValue(result());
  return {evaluate, decisions: {evaluate} as ConversationDecisionRuntime};
}
it('uses the host decision API with owning agent, typed rubric and its own deadline', async () => {
  const {evaluate, decisions} = setup();
  expect(await classifyConversationWithDecision(decisions, input, options)).toBe('directed');
  expect(evaluate).toHaveBeenCalledOnce();
  const [batch, request] = evaluate.mock.calls[0];
  expect(batch.state.message).toBe(input.message);
  expect(batch.questions.continuation.type).toBe('choice');
  expect(request).toMatchObject({agentId: 'support', purpose: 'feishu.conversation-window', timeoutMs: 1500});
  expect(request.signal).toBeInstanceOf(AbortSignal);
  evaluate.mockResolvedValue(result('not_directed'));
  expect(await classifyConversationWithDecision(decisions, input, options)).toBe('not_directed');
});
it('falls back on older hosts, off mode, absent owner and non-Kev or disabled agent selections', async () => {
  const {evaluate, decisions} = setup();
  expect(await classifyConversationWithDecision(undefined, input, options)).toBeUndefined();
  for (const override of [
    {decisionMode: 'off' as const}, {agentId: undefined}, {config: undefined},
    {config: {agents: {defaults: {decisionModel: 'typesafe/jev-latest'}}}},
    {config: {agents: {defaults: {decisionModel: 'typesafe/kev-latest'}, entries: {support: {decisionModel: ''}}}}},
  ]) expect(await classifyConversationWithDecision(decisions, input, {...options, ...override} as ConversationDecisionOptions)).toBeUndefined();
  expect(evaluate).not.toHaveBeenCalled();
});
it('falls back on unavailable, uncertain, low probability and invalid result shapes', async () => {
  const {evaluate, decisions} = setup();
  for (const response of [
    {status: 'unavailable', reason: 'deadline'}, {status: 'unavailable', reason: 'unsupported-input'},
    {status: 'unavailable', reason: 'not-configured'}, result('uncertain'), result('directed', 0.6),
    result('directed', NaN), result('unexpected'),
    {status: 'ok', result: {answers: {continuation: {type: 'boolean', probabilityTrue: 1}}}},
  ]) {
    evaluate.mockResolvedValue(response);
    expect(await classifyConversationWithDecision(decisions, input, options)).toBeUndefined();
  }
});
it('does not turn caller cancellation or host authority errors into fallback work', async () => {
  const {evaluate, decisions} = setup(); const controller = new AbortController();
  evaluate.mockImplementation(async () => {controller.abort(); return result();});
  await expect(classifyConversationWithDecision(decisions, input, {...options, signal: controller.signal})).rejects.toThrow();
  evaluate.mockRejectedValue(new Error('authority closed'));
  await expect(classifyConversationWithDecision(decisions, input, options)).rejects.toThrow('authority closed');
});
it('budgets actual UTF-8 serialized batch, drops whole old records and preserves essential evidence', () => {
  const group = Array.from({length: 50}, (_, i) => ({messageId: String(i), senderOpenId: 'other', timestamp: i, text: '群聊中文🙂'.repeat(300)}));
  const batch = buildConversationDecisionBatch({...input, recentGroupMessages: group});
  expect(batch).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(batch), 'utf8')).toBeLessThanOrEqual(CONVERSATION_DECISION_MAX_BYTES);
  expect(batch!.state.message).toBe(input.message);
  expect(batch!.state.recentConversation).toEqual(input.recentConversation);
  expect(batch!.state.omittedGroupMessages).toBeGreaterThan(0);
  expect(group).toHaveLength(50);
  expect(buildConversationDecisionBatch({...input, message: '中文🙂'.repeat(2000)})).toBeUndefined();
  expect(buildConversationDecisionBatch({...input, recentConversation: [
    {role: 'user', content: '旧'.repeat(6000)}, {role: 'assistant', content: '旧'}, ...input.recentConversation,
  ]})!.state.omittedConversationTurns).toBe(2);
  expect(buildConversationDecisionBatch({...input, recentConversation: [
    {role: 'user', content: '中文'.repeat(4000)}, {role: 'assistant', content: '请继续'},
  ]})).toBeUndefined();
});
it('skips Kev rather than silently truncating an oversized current message', async () => {
  const {evaluate, decisions} = setup();
  expect(await classifyConversationWithDecision(decisions, {...input, message: '\u0000'.repeat(2000)}, options)).toBeUndefined();
  expect(evaluate).not.toHaveBeenCalled();
});
it('accepts the exact serialized byte boundary and falls back one byte beyond it', () => {
  const base = {...input, message: '', recentConversation: []};
  const overhead = Buffer.byteLength(JSON.stringify(buildConversationDecisionBatch(base)), 'utf8');
  const message = 'a'.repeat(CONVERSATION_DECISION_MAX_BYTES - overhead);
  const batch = buildConversationDecisionBatch({...base, message});
  expect(Buffer.byteLength(JSON.stringify(batch), 'utf8')).toBe(CONVERSATION_DECISION_MAX_BYTES);
  expect(batch!.state.message).toBe(message);
  expect(buildConversationDecisionBatch({...base, message: message + 'a'})).toBeUndefined();
});
it('uses an explicit owning-agent Kev selection over a different global default', async () => {
  const {evaluate, decisions} = setup();
  const config = {agents: {defaults: {decisionModel: 'typesafe/jev-latest'}, entries: {support: {decisionModel: 'typesafe/kev-latest'}}}} as ConversationDecisionOptions['config'];
  expect(await classifyConversationWithDecision(decisions, input, {...options, config})).toBe('directed');
  expect(evaluate).toHaveBeenCalledOnce();
});
