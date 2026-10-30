import {workerContextApi} from '../agent-repo-api/worker-cli.mjs';
import {registerOrganizationSync} from './src/organization-sync.js';
import {registerSourceRecallDelivery} from './src/source-task.js';
import {registerScheduledRequestAdapter} from './src/scheduled-request.js';
// Feishu plugin entrypoint registers its OpenClaw integration.
import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerDocumentBackground } from "./src/document-background.js";
import { registerCodexCompletion } from "./src/codex-completion.js";
import { registerWorkspaceContextHooks } from "./src/workspace-context.js";
import { registerFeishuContextProtocol } from "./src/context-protocol.js";
import { registerFeishuSubagentHooks } from "./subagent-hooks-api.js";
import { registerFeishuCli, registerFeishuCliCommands } from './src/cli-integration.js';

import {registerFeishuPeopleGroupSync} from './src/people-group-sync.js';
import {registerFeishuPeopleResolver} from './src/people-resolver.js';
import {registerFeishuPeopleTool} from './src/people-tool.js';

export default defineBundledChannelEntry({
  id: "feishu-conversation",
  name: "飞书会话窗口 / Feishu Conversation Window",
  description: "飞书/Lark 通道插件 / Feishu/Lark channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "feishuPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setFeishuRuntime",
  },
  registerFull(api) {
    api=workerContextApi(api);
    registerFeishuCli(api);
    registerFeishuContextProtocol(api);
    registerFeishuPeopleResolver(api);
    registerFeishuPeopleTool(api);
    registerFeishuPeopleGroupSync(api);
    registerOrganizationSync(api);
    registerCodexCompletion(api);
    registerSourceRecallDelivery(api);
    registerScheduledRequestAdapter(api);
    registerDocumentBackground(api);
    registerFeishuSubagentHooks(api);
    registerWorkspaceContextHooks(api);
    for (const exportName of [
      "registerAdaTaskProgressTool",
      "registerFeishuDocTools",
      "registerFeishuChatTools",
      "registerFeishuGroupHistoryTool",
      "registerFeishuWikiTools",
      "registerFeishuDriveTools",
      "registerFeishuPermTools",
      "registerFeishuBitableTools",
    ]) {
      const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(
        import.meta.url,
        { specifier: "./api.js", exportName },
      );
      register(api);
    }
  },
  registerCliMetadata: registerFeishuCliCommands,
});
