export const pluginId = 'all-decision';

export function resolveConfiguration(config = {}) {
  const openai = config.providers?.openai ?? {};
  const url = new URL(openai.baseUrl ?? 'https://api.openai.com/v1');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('AllDecision baseUrl must be HTTPS without credentials, query or fragment');
  }
  return Object.freeze({
    providers: Object.freeze({
      openai: Object.freeze({
        enabled: openai.enabled !== false,
        endpoint: `${url.href.replace(/\/+$/, '')}/decisions`,
        secretPath: 'providers.openai.apiKey',
      }),
    }),
  });
}
