// OpenAI Decisions wire format is kept outside the OpenClaw provider lifecycle.
// https://developers.openai.com/api/reference/resources/decisions/methods/create
export const openaiAdapter = Object.freeze({
  vendor: 'openai',
  models: Object.freeze(['gpt-6-luna']),
  encode: encodeOpenaiRequest,
  decode: decodeOpenaiResponse,
});

export class UnsupportedDecisionInput extends Error {}
export class InvalidDecisionResponse extends Error {}
export class DecisionRefusal extends Error {}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const probability = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const invalid = () => { throw new InvalidDecisionResponse('Invalid AllDecision response'); };

export function encodeOpenaiRequest(batch, model) {
  const entries = Object.entries(batch.questions);
  if (entries.length < 1 || entries.length > 256) throw new UnsupportedDecisionInput();
  const questions = entries.map(([, question], index) => {
    const name = `q${index}`;
    const instructions = question.instructions === undefined ? '' : text(question.instructions);
    if (question.type === 'choice') {
      const choices = Object.entries(question.criteria).map(([value, description]) => ({ value, description: text(description) }));
      if (choices.length < 2 || choices.length > 255) throw new UnsupportedDecisionInput();
      return { name, type: 'choice', instructions, choices };
    }
    if (question.type === 'score') {
      if (question.criteria.length < 2 || question.criteria.length > 10) throw new UnsupportedDecisionInput();
      return {
        name, type: 'score', instructions,
        levels: question.criteria.map((description, index) => ({ label: String(index), description: text(description) })),
      };
    }
    if (question.type !== 'boolean') throw new UnsupportedDecisionInput();
    // Preserve both anchors; predicate probability maps directly to probabilityTrue.
    return {
      name, type: 'predicate',
      instructions: [
        instructions,
        'Estimate the probability that the true condition holds for the supplied input.',
        ...(question.criteria?.true !== undefined ? [`True condition: ${text(question.criteria.true)}`] : []),
        ...(question.criteria?.false !== undefined ? [`False condition: ${text(question.criteria.false)}`] : []),
      ].filter(Boolean).join('\n'),
    };
  });
  // JSON is serialized as evidence, never interpreted as messages, image URLs or tool calls.
  // This preserves all host DecisionEntry arrays (including primitive arrays) without
  // imposing input_json's narrower object-array and 256 KiB restrictions.
  const body = { model, input: text(batch.state), questions };
  if (Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024) throw new UnsupportedDecisionInput();
  return body;
}

function confidence(answer) {
  if (answer.confidence === undefined) return {};
  if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) invalid();
  return { confidence: answer.confidence };
}

function distribution(items, expected, key) {
  if (!Array.isArray(items) || items.length !== expected.length) invalid();
  const values = new Map();
  for (const item of items) {
    if (!record(item) || !expected.includes(item[key]) || values.has(item[key]) || !probability(item.probability)) invalid();
    values.set(item[key], item.probability);
  }
  if (![...values.values()].some((value) => value > 0)) invalid();
  return values;
}

export function decodeOpenaiResponse(payload, batch) {
  const entries = Object.entries(batch.questions);
  if (!record(payload) || typeof payload.model !== 'string' || !payload.model.trim()
    || payload.model.length > 256 || !Array.isArray(payload.answers) || payload.answers.length !== entries.length) invalid();
  const byName = new Map();
  for (const answer of payload.answers) {
    if (!record(answer) || typeof answer.name !== 'string' || byName.has(answer.name)) invalid();
    byName.set(answer.name, answer);
  }
  const answers = entries.map(([id, question], index) => {
    const answer = byName.get(`q${index}`);
    if (!answer) invalid();
    if (answer.type === 'refusal') throw new DecisionRefusal('AllDecision question refused');
    if (question.type === 'boolean') {
      if (answer.type !== 'predicate' || !probability(answer.probability)) invalid();
      return [id, { type: 'boolean', probabilityTrue: answer.probability }];
    }
    if (answer.type !== question.type) invalid();
    if (question.type === 'choice') {
      const labels = Object.keys(question.criteria);
      if (typeof answer.choice !== 'string' || !labels.includes(answer.choice)) invalid();
      const values = distribution(answer.probabilities, labels, 'value');
      return [id, { type: 'choice', choice: answer.choice, probabilities: Object.fromEntries(values), ...confidence(answer) }];
    }
    const indices = question.criteria.map((_, index) => index);
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > indices.length - 1) invalid();
    const values = distribution(answer.probabilities, indices, 'value');
    if (answer.probabilities.some((item) => item.label !== String(item.value))) invalid();
    return [id, { type: 'score', score: answer.score, probabilities: indices.map((index) => values.get(index)), ...confidence(answer) }];
  });
  let usage;
  if (payload.usage !== undefined) {
    if (!record(payload.usage)) invalid();
    usage = {};
    for (const [wire, field] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']]) {
      const value = payload.usage[wire];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0) invalid();
        usage[field] = value;
      }
    }
  }
  return { model: payload.model, answers: Object.fromEntries(answers), ...(usage ? { usage } : {}) };
}
