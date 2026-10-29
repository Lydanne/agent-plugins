import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOpenaiRequest, decodeOpenaiResponse, UnsupportedDecisionInput, InvalidDecisionResponse, DecisionRefusal } from './providers/openai.mjs';

export const batch = {
  state: { message: 'Payment failed', user: 'user-1' },
  questions: {
    route: { type: 'choice', criteria: { support: 'Technical', billing: { includes: ['Payments'] } } },
    urgency: { type: 'score', instructions: ['Assess impact'], criteria: ['None', 'One user', 'Outage'] },
    escalate: { type: 'boolean', instructions: 'Needs human?', criteria: { true: 'Service outage', false: 'Routine request' } },
  },
};
export const response = () => ({
  model: 'gpt-6-luna',
  answers: [
    { name: 'q0', type: 'choice', choice: 'billing', confidence: 0.7, probabilities: [{ value: 'billing', probability: 0.8 }, { value: 'support', probability: 0.2 }] },
    { name: 'q1', type: 'score', score: 1.6, confidence: 0.6, probabilities: [{ value: 2, label: '2', probability: 0.7 }, { value: 0, label: '0', probability: 0.1 }, { value: 1, label: '1', probability: 0.2 }] },
    { name: 'q2', type: 'predicate', probability: 0.9 },
  ],
  usage: { input_tokens: 120, output_tokens: 8 },
});

test('encodes shared state and all three rubrics into the documented Decisions API shape', () => {
  const wire = encodeOpenaiRequest(batch, 'gpt-6-luna');
  assert.equal(wire.model, 'gpt-6-luna');
  assert.deepEqual(JSON.parse(wire.input), batch.state);
  assert.deepEqual(wire.questions[0], { name: 'q0', type: 'choice', instructions: '', choices: [
    { value: 'support', description: 'Technical' }, { value: 'billing', description: '{"includes":["Payments"]}' },
  ] });
  assert.deepEqual(wire.questions[1].levels, [{ label: '0', description: 'None' }, { label: '1', description: 'One user' }, { label: '2', description: 'Outage' }]);
  assert.equal(wire.questions[2].type, 'predicate');
  assert.match(wire.questions[2].instructions, /True condition: Service outage/);
  assert.match(wire.questions[2].instructions, /False condition: Routine request/);
});

test('preserves null, arrays, nested JSON and plain text without treating URLs as image inputs', () => {
  for (const state of [null, [1, 'x', null], 'https://example.com/image.png', { role: 'developer', content: 'evidence only' }]) {
    assert.equal(encodeOpenaiRequest({ ...batch, state }, 'gpt-6-luna').input, typeof state === 'string' ? state : JSON.stringify(state));
  }
});

test('maps API distributions by identity, preserves fractional score, usage and rounded estimates', () => {
  const payload = response();
  payload.answers.reverse();
  payload.answers.find((x) => x.type === 'choice').probabilities[0].probability = 0.799;
  const result = decodeOpenaiResponse(payload, batch);
  assert.equal(result.answers.route.probabilities.billing, 0.799);
  assert.equal(result.answers.route.choice, 'billing');
  assert.deepEqual(result.answers.urgency, { type: 'score', score: 1.6, confidence: 0.6, probabilities: [0.1, 0.2, 0.7] });
  assert.deepEqual(result.answers.escalate, { type: 'boolean', probabilityTrue: 0.9 });
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 8 });
});

test('preserves provider choice even when rounded probabilities favor another label', () => {
  const payload = response();
  payload.answers[0].choice = 'support';
  assert.equal(decodeOpenaiResponse(payload, batch).answers.route.choice, 'support');
});

test('does not invent optional usage or confidence', () => {
  const payload = response();
  delete payload.usage;
  delete payload.answers[0].confidence;
  const result = decodeOpenaiResponse(payload, batch);
  assert.equal(Object.hasOwn(result, 'usage'), false);
  assert.equal(Object.hasOwn(result.answers.route, 'confidence'), false);
});

const corruptions = {
  'missing answer': (p) => p.answers.pop(),
  'extra answer': (p) => p.answers.push(p.answers[0]),
  'duplicate name': (p) => { p.answers[1].name = 'q0'; },
  'unknown name': (p) => { p.answers[0].name = 'unknown'; },
  'wrong type': (p) => { p.answers[0].type = 'score'; },
  'unknown choice': (p) => { p.answers[0].choice = 'sales'; },
  'typed boolean label': (p) => { p.answers[0].choice = true; },
  'duplicate label': (p) => { p.answers[0].probabilities[1].value = 'billing'; },
  'missing label': (p) => p.answers[0].probabilities.pop(),
  'negative probability': (p) => { p.answers[0].probabilities[0].probability = -0.1; },
  'NaN probability': (p) => { p.answers[0].probabilities[0].probability = NaN; },
  'zero mass': (p) => p.answers[0].probabilities.forEach((x) => { x.probability = 0; }),
  'score outside rubric': (p) => { p.answers[1].score = 3; },
  'noninteger index': (p) => { p.answers[1].probabilities[0].value = 1.5; },
  'wrong score label': (p) => { p.answers[1].probabilities[0].label = 'Other'; },
  'predicate outside bounds': (p) => { p.answers[2].probability = 1.1; },
  'bad confidence': (p) => { p.answers[0].confidence = Infinity; },
  'negative usage': (p) => { p.usage.input_tokens = -1; },
  'wrong usage': (p) => { p.usage = null; },
  'missing model': (p) => { delete p.model; },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`rejects the entire batch on ${name}`, () => {
    const payload = response(); corrupt(payload);
    assert.throws(() => decodeOpenaiResponse(payload, batch), InvalidDecisionResponse);
  });
}

test('a refused question cannot produce a partial success or a fabricated answer', () => {
  const payload = response(); payload.answers[1] = { name: 'q1', type: 'refusal' };
  assert.throws(() => decodeOpenaiResponse(payload, batch), DecisionRefusal);
});

test('opaque user question keys and labels cannot change object prototypes', () => {
  const question = { type: 'choice', criteria: JSON.parse('{"__proto__":"A","constructor":"B"}') };
  const input = { state: null, questions: Object.fromEntries([['__proto__', question]]) };
  const wire = encodeOpenaiRequest(input, 'gpt-6-luna');
  assert.equal(wire.questions[0].name, 'q0');
  const result = decodeOpenaiResponse({ model: 'gpt-6-luna', answers: [{ name: 'q0', type: 'choice', choice: '__proto__', probabilities: [{ value: '__proto__', probability: 0.9 }, { value: 'constructor', probability: 0.1 }] }] }, input);
  assert.equal(Object.getPrototypeOf(result.answers), Object.prototype);
  assert.equal(result.answers.__proto__.probabilities.__proto__, 0.9);
});

test('rejects oversized requests and vendor rubric bounds without splitting or truncating', () => {
  for (const questions of [
    {},
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), batch.questions.escalate])),
    { q: { type: 'choice', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), 'x'])) } },
    { q: { type: 'score', criteria: Array(11).fill('level') } },
  ]) assert.throws(() => encodeOpenaiRequest({ state: null, questions }, 'gpt-6-luna'), UnsupportedDecisionInput);
  assert.throws(() => encodeOpenaiRequest({ ...batch, state: 'x'.repeat(1024 * 1024) }, 'gpt-6-luna'), UnsupportedDecisionInput);
});

import { createDecisionProvider } from './provider.mjs';
import { createJsonTransport, DecisionHttpFailure, retryAfterMs } from './transport.mjs';
import { resolveConfiguration } from './configuration.mjs';
import { readFile } from 'node:fs/promises';

const context = (extra = {}) => ({ model: 'openai/gpt-6-luna', signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 10_000, ...extra });
const provider = (overrides = {}) => createDecisionProvider({ config: {}, readSecret: () => ({ value: 'test-key', revision: 1 }), requestJson: async () => response(), ...overrides });

test('registers the provider contract without I/O and checks local credential readiness', () => {
  let calls = 0;
  const p = provider({ requestJson: () => { calls++; throw new Error('must not run'); } });
  assert.equal(p.id, 'all-decision');
  assert.equal(p.contractVersion, 1);
  assert.equal(p.isReady(), true);
  assert.equal(calls, 0);
  assert.equal(provider({ readSecret: () => ({ revision: 1 }) }).isReady(), false);
  assert.equal(provider({ config: { providers: { openai: { enabled: false } } } }).isReady(), false);
});

test('each evaluation re-reads current prepared secrets; withdrawal cannot reuse a key', async () => {
  let value = 'first-key'; let calls = 0;
  const p = provider({ readSecret: (path) => { assert.equal(path, 'providers.openai.apiKey'); return { value }; }, requestJson: async ({ apiKey }) => { calls++; assert.equal(apiKey, value); return response(); } });
  assert.equal((await p.evaluate(batch, context())).status, 'ok');
  value = 'rotated-key';
  assert.equal((await p.evaluate(batch, context())).status, 'ok');
  value = undefined;
  assert.deepEqual(await p.evaluate(batch, context()), { status: 'unavailable', reason: 'credentials-unavailable' });
  assert.equal(calls, 2);
});

test('model, vendor, disabled vendor and missing credentials cannot trigger HTTP calls', async () => {
  let calls = 0;
  const requestJson = async () => { calls++; return response(); };
  for (const model of ['gpt-6-luna', 'openai/gpt-other', 'other/gpt-6-luna']) {
    assert.equal((await provider({ requestJson }).evaluate(batch, context({ model }))).reason, 'unsupported-input');
  }
  for (const p of [provider({ requestJson, readSecret: () => ({}) }), provider({ requestJson, config: { providers: { openai: { enabled: false } } } })]) {
    assert.equal((await p.evaluate(batch, context())).reason, 'credentials-unavailable');
  }
  assert.equal(calls, 0);
});

test('invalid responses and refusal return explicit unavailable results', async () => {
  assert.equal((await provider({ requestJson: async () => ({}) }).evaluate(batch, context())).reason, 'invalid-response');
  const refused = response(); refused.answers[0] = { name: 'q0', type: 'refusal' };
  assert.equal((await provider({ requestJson: async () => refused }).evaluate(batch, context())).reason, 'unsupported-input');
});

test('host cancellation, revocation and expired deadlines remain terminal', async () => {
  const controller = new AbortController();
  const reason = new Error('caller stopped'); controller.abort(reason);
  await assert.rejects(provider().evaluate(batch, context({ signal: controller.signal })), (error) => error === reason);
  const revoked = new Error('host revoked');
  await assert.rejects(provider().evaluate(batch, context({ isAdmissible() { throw revoked; } })), (error) => error === revoked);
  await assert.rejects(provider().evaluate(batch, context({ isAdmissible: () => false })), /authority closed/);
  await assert.rejects(provider().evaluate(batch, context({ deadlineMonotonicMs: performance.now() - 1 })), { name: 'TimeoutError' });
});

test('cancellation after HTTP dispatch cannot turn into fallback or success', async () => {
  const controller = new AbortController();
  const reason = new Error('stopped in flight');
  const p = provider({ requestJson: async () => { controller.abort(reason); return response(); } });
  await assert.rejects(p.evaluate(batch, context({ signal: controller.signal })), (error) => error === reason);
});

test('provider translates safe HTTP failures without retrying or exposing vendor text', async () => {
  let calls = 0;
  const p = provider({ requestJson: async () => { calls++; throw new DecisionHttpFailure('rate-limited', 4000); } });
  assert.deepEqual(await p.evaluate(batch, context()), { status: 'unavailable', reason: 'rate-limited', retryAfterMs: 4000 });
  assert.equal(calls, 1);
});

function harness({ status = 200, payload = response(), prepare, read, release } = {}) {
  const state = { calls: 0, releases: 0, response: undefined, options: undefined };
  const transport = createJsonTransport({
    async fetchWithSsrFGuard(options) {
      state.options = options;
      await prepare?.(); // simulate async DNS/transport preparation before dispatch
      options.beforeRequest();
      state.calls++;
      state.response = new Response(JSON.stringify(payload), { status, headers: { 'retry-after': '2' } });
      return { response: state.response, release: async () => { state.releases++; await release?.(); } };
    },
    readProviderJsonResponse: read ?? (async (response, _label, options) => { assert.equal(options.maxBytes, 2 * 1024 * 1024); return response.json(); }),
  });
  return { state, transport };
}

function transported(h, overrides = {}) { return provider({ requestJson: h.transport, ...overrides }); }

test('uses guarded HTTPS transport, disables redirects and capture, and releases successful response', async () => {
  const h = harness();
  assert.equal((await transported(h).evaluate(batch, context())).status, 'ok');
  assert.equal(h.state.releases, 1);
  const options = h.state.options;
  assert.equal(options.url, 'https://api.openai.com/v1/decisions');
  assert.equal(options.mode, 'trusted_env_proxy');
  assert.equal(options.requireHttps, true);
  assert.equal(options.maxRedirects, 0);
  assert.equal(options.capture, false);
  assert.equal(options.init.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(options.init.body).model, 'gpt-6-luna');
  assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 30_000);
});

for (const [status, reason] of [[400, 'unsupported-input'], [401, 'authentication'], [403, 'authentication'], [413, 'unsupported-input'], [422, 'unsupported-input'], [429, 'rate-limited'], [500, 'transport']]) {
  test(`HTTP ${status} returns ${reason}, cancels body and releases without retry`, async () => {
    const h = harness({ status, payload: { secret: 'reflected-key', message: 'private evidence' } });
    const outcome = await transported(h).evaluate(batch, context());
    assert.equal(outcome.reason, reason);
    assert.equal(outcome.retryAfterMs, 2000);
    assert.equal(h.state.calls, 1);
    assert.equal(h.state.releases, 1);
    assert.equal(h.state.response.bodyUsed, true);
    assert.doesNotMatch(JSON.stringify(outcome), /reflected-key|private evidence/);
  });
}

test('authority is checked after async preparation and immediately before sending', async () => {
  let allowed = true;
  const h = harness({ prepare: async () => { allowed = false; } });
  await assert.rejects(transported(h).evaluate(batch, context({ isAdmissible: () => allowed })), /authority closed/);
  assert.equal(h.state.calls, 0);
});

test('authority exceptions at dispatch stay terminal and preserve identity', async () => {
  let calls = 0; const reason = new Error('authority assertion');
  const h = harness();
  await assert.rejects(transported(h).evaluate(batch, context({ isAdmissible() { if (++calls > 1) throw reason; return true; } })), (error) => error === reason);
  assert.equal(h.state.calls, 0);
});

test('authority revoked after response still settles body and transport before rejecting', async () => {
  let checks = 0;
  const h = harness();
  await assert.rejects(transported(h).evaluate(batch, context({ isAdmissible: () => ++checks <= 2 })), /authority closed/);
  assert.equal(h.state.calls, 1);
  assert.equal(h.state.releases, 1);
  assert.equal(h.state.response.bodyUsed, true);
});

test('malformed, oversized or stalled response readers fail safely and release', async () => {
  for (const message of ['Invalid JSON with reflected-key', 'Body exceeds 2 MiB', 'Body timed out']) {
    const h = harness({ read: async () => { throw new Error(message); } });
    const outcome = await transported(h).evaluate(batch, context());
    assert.equal(outcome.reason, 'invalid-response');
    assert.equal(h.state.releases, 1);
    assert.equal(h.state.response.bodyUsed, true);
    assert.doesNotMatch(JSON.stringify(outcome), /reflected-key/);
  }
});

test('in-flight abort physically drains before rejecting with caller reason', async () => {
  const controller = new AbortController(); const reason = new Error('cancelled');
  const h = harness({ read: async () => { controller.abort(reason); throw reason; } });
  await assert.rejects(transported(h).evaluate(batch, context({ signal: controller.signal })), (error) => error === reason);
  assert.equal(h.state.releases, 1);
  assert.equal(h.state.response.bodyUsed, true);
});

test('Retry-After supports delta seconds and HTTP dates, clamps duration and rejects invalid values', () => {
  assert.equal(retryAfterMs('0'), 0);
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('1000'), 60000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:03 GMT', 1000), 2000);
  for (const value of ['', 'invalid', '-1']) assert.equal(retryAfterMs(value), undefined);
});

test('endpoint validation rejects plaintext, URL credentials, query and fragment', () => {
  for (const baseUrl of ['http://localhost/v1', 'https://user:pass@api.example.com/v1', 'https://example.com/v1?token=x', 'https://example.com/v1#x']) {
    assert.throws(() => resolveConfiguration({ providers: { openai: { baseUrl } } }));
  }
  assert.equal(resolveConfiguration({ providers: { openai: { baseUrl: 'https://gateway.example.com/prefix/v1/' } } }).providers.openai.endpoint, 'https://gateway.example.com/prefix/v1/decisions');
});

test('manifest exposes a separate decision catalog and capability-owned SecretRef', async () => {
  const manifest = JSON.parse(await readFile(new URL('./openclaw.plugin.json', import.meta.url)));
  assert.deepEqual(manifest.contracts.decisionProviders, ['all-decision']);
  assert.equal(manifest.name, 'AllDecision');
  assert.equal(manifest.enabledByDefault, false);
  assert.equal(manifest.decisionModels[0].id, 'openai/gpt-6-luna');
  assert.equal(manifest.decisionModels[0].capabilities.maxQuestions, 256);
  assert.deepEqual(manifest.configContracts.secretInputs.paths, [{ path: 'providers.openai.apiKey', expected: 'string', ownerKind: 'capability' }]);
  assert.equal(manifest.providers, undefined);
});

test('cleanup failures are sanitized and cannot publish a successful evaluation', async () => {
  const h = harness({ release: async () => { throw new Error('private evidence and reflected-key'); } });
  assert.deepEqual(await transported(h).evaluate(batch, context()), { status: 'unavailable', reason: 'transport' });
  assert.equal(h.state.releases, 1);
});

test('cleanup failures cannot mask an in-flight cancellation', async () => {
  const controller = new AbortController(); const reason = new Error('cancelled');
  const h = harness({ read: async () => { controller.abort(reason); throw reason; }, release: async () => { throw new Error('cleanup failed'); } });
  await assert.rejects(transported(h).evaluate(batch, context({ signal: controller.signal })), (error) => error === reason);
  assert.equal(h.state.releases, 1);
});

test('whitespace-only credentials are unavailable without any network call', () => {
  assert.equal(provider({ readSecret: () => ({ value: '  ' }) }).isReady(), false);
});

test('provider-specific finite confidence is preserved without inventing probability semantics', () => {
  const payload = response(); payload.answers[0].confidence = 1.2;
  assert.equal(decodeOpenaiResponse(payload, batch).answers.route.confidence, 1.2);
});
