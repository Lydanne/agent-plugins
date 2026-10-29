export class DecisionHttpFailure extends Error {
  constructor(reason, retryAfterMs) {
    super('AllDecision request unavailable');
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(duration) && duration >= 0 ? Math.min(60_000, Math.round(duration)) : undefined;
}

// Inject public SDK transport functions so tests never need host credentials or network.
export function createJsonTransport({ fetchWithSsrFGuard, readProviderJsonResponse }) {
  return async function requestJson({ endpoint, apiKey, body, context, assertCurrent }) {
    let guarded;
    let authorityError;
    const beforeRequest = () => {
      try { assertCurrent(); } catch (error) { authorityError = error; throw error; }
    };
    try {
      guarded = await fetchWithSsrFGuard({
        url: endpoint,
        init: {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        signal: context.signal,
        timeoutMs: Math.max(1, Math.min(30_000, context.deadlineMonotonicMs - performance.now())),
        requireHttps: true,
        maxRedirects: 0,
        mode: 'trusted_env_proxy',
        capture: false,
        beforeRequest,
        auditContext: 'AllDecision cloud decision',
      });
      beforeRequest();
      const response = guarded.response;
      if (!response.ok) {
        const reason = response.status === 401 || response.status === 403 ? 'authentication'
          : response.status === 429 ? 'rate-limited'
          : [400, 413, 422].includes(response.status) ? 'unsupported-input' : 'transport';
        throw new DecisionHttpFailure(reason, retryAfterMs(response.headers.get('retry-after')));
      }
      try {
        return await readProviderJsonResponse(response, 'AllDecision', {
          maxBytes: 2 * 1024 * 1024,
          signal: context.signal,
          timeoutMs: () => Math.max(1, context.deadlineMonotonicMs - performance.now()),
          requestHeaders: { Authorization: `Bearer ${apiKey}` },
        });
      } catch {
        context.signal.throwIfAborted();
        throw new DecisionHttpFailure('invalid-response');
      }
    } catch (error) {
      context.signal.throwIfAborted();
      if (authorityError) throw authorityError;
      if (error instanceof DecisionHttpFailure) throw error;
      // Never retain the vendor error body, request payload or reflected key.
      throw new DecisionHttpFailure('transport');
    } finally {
      if (guarded) {
        // Every response, including HTTP errors and malformed bodies, is physically
        // settled before the host considers the operation drained.
        try {
          try { if (!guarded.response.bodyUsed) await guarded.response.body?.cancel(); }
          finally { await guarded.release(); }
        } catch {
          context.signal.throwIfAborted();
          if (authorityError) throw authorityError;
          throw new DecisionHttpFailure('transport');
        }
      }
    }
  };
}
