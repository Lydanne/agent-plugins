import { pluginId, resolveConfiguration } from './configuration.mjs';
import { openaiAdapter, UnsupportedDecisionInput, InvalidDecisionResponse, DecisionRefusal } from './providers/openai.mjs';
import { DecisionHttpFailure } from './transport.mjs';

// One vendor adapter per module. Add new cloud protocols here without changing
// the OpenClaw lifecycle or allowing callers to supply an arbitrary endpoint.
export const adapters = Object.freeze([openaiAdapter]);
const unavailable = (reason) => ({ status: 'unavailable', reason });

export function createDecisionProvider({ config, readSecret, requestJson }) {
  const settings = resolveConfiguration(config);
  return {
    id: pluginId,
    contractVersion: 1,
    isReady() {
      return adapters.some(({ vendor }) => settings.providers[vendor]?.enabled
        && Boolean(readSecret(settings.providers[vendor].secretPath)?.value?.trim()));
    },
    async evaluate(batch, context) {
      const assertCurrent = () => {
        context.signal.throwIfAborted();
        if (context.isAdmissible && !context.isAdmissible()) throw new Error('AllDecision consumer authority closed');
        if (performance.now() >= context.deadlineMonotonicMs) throw new DOMException('AllDecision deadline elapsed', 'TimeoutError');
      };
      assertCurrent();
      const slash = context.model.indexOf('/');
      const vendor = context.model.slice(0, slash);
      const model = context.model.slice(slash + 1);
      const adapter = adapters.find((entry) => slash > 0 && entry.vendor === vendor && entry.models.includes(model));
      if (!adapter) return unavailable('unsupported-input');
      const selected = settings.providers[vendor];
      if (!selected?.enabled) return unavailable('credentials-unavailable');
      // Read only the current invocation's prepared snapshot. Never cache a key,
      // resolve a SecretRef here, or fall back to ambient environment credentials.
      const secret = readSecret(selected.secretPath);
      if (!secret?.value?.trim()) return unavailable('credentials-unavailable');
      let body;
      try { body = adapter.encode(batch, model); }
      catch (error) {
        if (error instanceof UnsupportedDecisionInput) return unavailable('unsupported-input');
        throw error;
      }
      let payload;
      try {
        payload = await requestJson({ endpoint: selected.endpoint, apiKey: secret.value, body, context, assertCurrent });
      } catch (error) {
        context.signal.throwIfAborted();
        if (!(error instanceof DecisionHttpFailure)) throw error;
        return { ...unavailable(error.reason), ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) };
      }
      assertCurrent();
      try { return { status: 'ok', result: adapter.decode(payload, batch) }; }
      catch (error) {
        if (error instanceof DecisionRefusal) return unavailable('unsupported-input');
        if (error instanceof InvalidDecisionResponse) return unavailable('invalid-response');
        throw error;
      }
    },
  };
}
