import { getPreparedPluginSecretInput } from 'openclaw/plugin-sdk/secret-input-runtime';
import { fetchWithSsrFGuard } from 'openclaw/plugin-sdk/ssrf-runtime';
import { readProviderJsonResponse } from 'openclaw/plugin-sdk/provider-http';
import { pluginId } from './configuration.mjs';
import { createDecisionProvider } from './provider.mjs';
import { createJsonTransport } from './transport.mjs';

export default {
  id: pluginId,
  name: 'AllDecision',
  description: 'Cloud decision models for OpenClaw',
  register(api) {
    if (typeof api.registerDecisionProvider !== 'function') {
      throw new Error('AllDecision requires OpenClaw DecisionProviderV1 support (tested on 2026.10.8)');
    }
    api.registerDecisionProvider(createDecisionProvider({
      config: api.pluginConfig,
      readSecret: (path) => getPreparedPluginSecretInput(pluginId, path),
      requestJson: createJsonTransport({ fetchWithSsrFGuard, readProviderJsonResponse }),
    }));
  },
};
