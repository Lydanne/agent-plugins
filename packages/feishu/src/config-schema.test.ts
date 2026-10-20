import {renderBusinessMessage,defaultCompletionMentions} from "./business-config.js";
import {readFileSync} from "node:fs";
import {resolveConfiguration} from "../../agent-worker/configuration.mjs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
// Feishu tests cover config schema plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { FeishuChannelConfigSchema, FeishuConfigSchema } from "./config-schema.js";

// The NEGATIVE webhook fixtures below spread these bases and add
// verificationToken separately so the GHSA-G353-MGV3-8PCJ opengrep pattern —
// which matches `connectionMode: "webhook"` next to `verificationToken` in
// one object literal (including via constant propagation) — does not flag the
// fixtures that prove the schema rejects them. Positive fixtures stay literal.
const topLevelWebhookBase = {
  connectionMode: "webhook",
  appId: "cli_top",
  appSecret: "secret_top", // pragma: allowlist secret
};
const accountWebhookBase = {
  connectionMode: "webhook",
  appId: "cli_main",
  appSecret: "secret_main", // pragma: allowlist secret
};

function expectSchemaIssue(
  result: ReturnType<typeof FeishuConfigSchema.safeParse>,
  issuePath: string,
) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(issuePath);
  }
}

describe("Feishu custom domains", () => {
  it.each([
    ["feishu", true],
    ["lark", true],
    ["https://tenant.example", true],
    ["HTTPS://tenant.example", true],
    ["HtTpS://Tenant.Example:8443/Api/Base%2FKeep/", true],
    ["HTTPS://fixture-user@tenant.example/base", true],
    ["HTTPS://tenant.example/base?tenant=Keep#Fragment", true],
    ["HTTPS://tenant.example/base?", true],
    ["HTTPS://tenant.example/base#", true],
    ["http://tenant.example", false],
    ["HTTP://tenant.example", false],
    ["https://[", false],
    ["HTTPS://[", false],
    ["tenant.example/base", false],
  ])("validates root and account domain %s consistently", (domain, accepted) => {
    for (const value of [{ domain }, { accounts: { work: { domain } } }]) {
      const parsed = FeishuConfigSchema.safeParse(value);
      expect(parsed.success, "Zod validation").toBe(accepted);
      if (parsed.success) {
        expect(parsed.data).toMatchObject(value);
      }
      const exported = validateJsonSchemaValue({
        schema: FeishuChannelConfigSchema.schema,
        cacheKey: "feishu-domain-test",
        value,
        applyDefaults: true,
      });
      expect(exported.ok, "exported JSON Schema validation").toBe(accepted);
      if (exported.ok) {
        expect(exported.value).toMatchObject(value);
      }
    }
  });
});

describe("FeishuConfigSchema webhook validation", () => {
  it("applies top-level defaults", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.domain).toBe("feishu");
    expect(result.connectionMode).toBe("websocket");
    expect(result.webhookPath).toBe("/feishu/events");
    expect(result.dmPolicy).toBe("pairing");
    expect(result.groupPolicy).toBe("allowlist");
    // requireMention has no schema-level default now — it is resolved at runtime
    // through shared channel group-policy resolution, with an open-group override
    // that defaults to false only when requireMention is otherwise unset.
    expect(result.requireMention).toBeUndefined();
  });

  it.each([
    ["legacy-hook", "/legacy-hook"],
    ["legacy-hook/", "/legacy-hook/"],
    ["legacy-hook?tenant=alpha", "/legacy-hook?tenant=alpha"],
    ["/legacy-hook?", "/legacy-hook?"],
    ["/legacy-hook?#", "/legacy-hook"],
    ["/legacy-hook#fragment", "/legacy-hook"],
    ["legacy-hook?tenant=alpha#fragment", "/legacy-hook?tenant=alpha"],
    ["#fragment", "/"],
    ["#?", "/"],
    ["?tenant=alpha#fragment", "/?tenant=alpha"],
    ["/other/../legacy-hook", "/legacy-hook"],
    ["/other/%2e%2e/legacy-hook", "/legacy-hook"],
    ["/other\\..\\legacy-hook", "/legacy-hook"],
    ["//example.com/legacy-hook", "/legacy-hook"],
    ["/\\example.com/legacy-hook", "/legacy-hook"],
    ["https://example.com/legacy-hook/?x=1#fragment", "/legacy-hook/?x=1"],
    ["/legacy hook", "/legacy%20hook"],
    ["/legacy?name=hello world", "/legacy?name=hello%20world"],
    ["/café", "/caf%C3%A9"],
    ["/💬", "/%F0%9F%92%AC"],
    ["/legacy?name=café", "/legacy?name=caf%C3%A9"],
    ["/legacy\tvalue", "/legacyvalue"],
    ["/legacy\nvalue", "/legacyvalue"],
    ["/legacy\u0000value", "/legacy%00value"],
    ["/legacy%23value", "/legacy%23value"],
    ["/legacy%2Fvalue", "/legacy%2Fvalue"],
    ["/legacy%5Cvalue", "/legacy%5Cvalue"],
    ["/legacy%00value", "/legacy%00value"],
    ["/legacy%ZZ", "/legacy%ZZ"],
    ["", "/feishu/events"],
    ["   ", "/feishu/events"],
  ])("accepts only canonical root and account webhook path %j", (webhookPath, canonicalPath) => {
    if (webhookPath === canonicalPath) {
      const result = FeishuConfigSchema.parse({
        webhookPath,
        accounts: { main: { webhookPath } },
      });
      expect(result.webhookPath).toBe(webhookPath);
      expect(result.accounts?.main?.webhookPath).toBe(webhookPath);
      return;
    }

    for (const [input, issuePath] of [
      [{ webhookPath }, "webhookPath"],
      [{ accounts: { main: { webhookPath } } }, "accounts.main.webhookPath"],
    ] as const) {
      const result = FeishuConfigSchema.safeParse(input);
      expectSchemaIssue(result, issuePath);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("openclaw doctor --fix");
      }
    }
  });

  it.each([
    "mailto:hello@example.com",
    "javascript:alert(1)",
    "ftp://host/hook",
    "file:///tmp/hook",
    "//[",
  ])("rejects unsupported root and account webhook URL %j", (webhookPath) => {
    expectSchemaIssue(FeishuConfigSchema.safeParse({ webhookPath }), "webhookPath");
    expectSchemaIssue(
      FeishuConfigSchema.safeParse({ accounts: { main: { webhookPath } } }),
      "accounts.main.webhookPath",
    );
  });

  it("rejects legacy webhook input while preserving the exported canonical default", () => {
    expect(
      FeishuChannelConfigSchema.runtime?.safeParse({
        webhookPath: "https://example.com/hook/?tenant=alpha#fragment",
      }),
    ).toMatchObject({ success: false });
    expect(
      FeishuChannelConfigSchema.runtime?.safeParse({ webhookPath: "/hook/?tenant=alpha" }),
    ).toMatchObject({ success: true, data: { webhookPath: "/hook/?tenant=alpha" } });
    expect(FeishuChannelConfigSchema.schema).toMatchObject({
      properties: {
        webhookPath: { default: "/feishu/events", type: "string" },
        accounts: {
          additionalProperties: { properties: { webhookPath: { type: "string" } } },
        },
      },
    });
  });

  it("does not force top-level policy defaults into account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {},
      },
    });

    expect(result.accounts?.main?.dmPolicy).toBeUndefined();
    expect(result.accounts?.main?.groupPolicy).toBeUndefined();
    expect(result.accounts?.main?.requireMention).toBeUndefined();
  });

  it("normalizes legacy groupPolicy allowall to open", () => {
    const result = FeishuConfigSchema.parse({
      groupPolicy: "allowall",
    });

    expect(result.groupPolicy).toBe("open");
  });

  it("accepts the canonical disabled DM policy", () => {
    expect(FeishuConfigSchema.parse({ dmPolicy: "disabled" }).dmPolicy).toBe("disabled");
    expect(
      FeishuConfigSchema.parse({ accounts: { work: { dmPolicy: "disabled" } } }).accounts?.work
        ?.dmPolicy,
    ).toBe("disabled");
  });

  it("exports legacy groupPolicy as a typed config input", () => {
    const expected = {
      anyOf: [
        { type: "string", enum: ["open", "disabled", "allowlist"] },
        { type: "string", const: "allowall" },
      ],
    };

    expect(FeishuChannelConfigSchema.schema).toMatchObject({
      properties: {
        groupPolicy: expected,
        accounts: {
          additionalProperties: {
            properties: { groupPolicy: expected },
          },
        },
      },
    });
  });

  it("rejects top-level webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      appId: "cli_top",
      appSecret: "secret_top", // pragma: allowlist secret
    });

    expectSchemaIssue(result, "verificationToken");
  });

  it("rejects top-level webhook mode without encryptKey", () => {
    // topLevelWebhookBase (see top of file) keeps the GHSA opengrep pattern
    // from matching this negative fixture.
    const result = FeishuConfigSchema.safeParse({
      ...topLevelWebhookBase,
      verificationToken: "token_top",
    });

    expectSchemaIssue(result, "encryptKey");
  });

  it("accepts top-level webhook mode with verificationToken and encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: "token_top",
      encryptKey: "encrypt_top",
      appId: "cli_top",
      appSecret: "secret_top", // pragma: allowlist secret
    });

    expect(result.success).toBe(true);
  });

  it("rejects account webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main", // pragma: allowlist secret
        },
      },
    });

    expectSchemaIssue(result, "accounts.main.verificationToken");
  });

  it("rejects account webhook mode without encryptKey", () => {
    // accountWebhookBase (see top of file) keeps the GHSA opengrep pattern
    // from matching this negative fixture.
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          ...accountWebhookBase,
          verificationToken: "token_main",
        },
      },
    });

    expectSchemaIssue(result, "accounts.main.encryptKey");
  });

  it("accepts account webhook mode inheriting top-level verificationToken and encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      verificationToken: "token_top",
      encryptKey: "encrypt_top",
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main", // pragma: allowlist secret
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef verificationToken in webhook mode", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: {
        source: "env",
        provider: "default",
        id: "FEISHU_VERIFICATION_TOKEN",
      },
      encryptKey: "encrypt_top",
      appId: "cli_top",
      appSecret: {
        source: "env",
        provider: "default",
        id: "FEISHU_APP_SECRET",
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef encryptKey in webhook mode", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: {
        source: "env",
        provider: "default",
        id: "FEISHU_VERIFICATION_TOKEN",
      },
      encryptKey: {
        source: "env",
        provider: "default",
        id: "FEISHU_ENCRYPT_KEY",
      },
      appId: "cli_top",
      appSecret: {
        source: "env",
        provider: "default",
        id: "FEISHU_APP_SECRET",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("FeishuConfigSchema replyInThread", () => {
  it("accepts replyInThread at top level", () => {
    const result = FeishuConfigSchema.parse({ replyInThread: "enabled" });
    expect(result.replyInThread).toBe("enabled");
  });

  it("defaults replyInThread to undefined when not set", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.replyInThread).toBeUndefined();
  });

  it("rejects invalid replyInThread value", () => {
    const result = FeishuConfigSchema.safeParse({ replyInThread: "always" });
    expect(result.success).toBe(false);
  });

  it("accepts replyInThread in group config", () => {
    const result = FeishuConfigSchema.parse({
      groups: { "oc-group": { replyInThread: "enabled" } },
    });
    expect(result.groups?.["oc-group"]?.replyInThread).toBe("enabled");
  });

  it("accepts replyInThread in account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: { replyInThread: "enabled" },
      },
    });
    expect(result.accounts?.main?.replyInThread).toBe("enabled");
  });
});

describe("FeishuConfigSchema optimization flags", () => {
  it("defaults top-level typingIndicator and resolveSenderNames to true", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.typingIndicator).toBe(true);
    expect(result.resolveSenderNames).toBe(true);
  });

  it("accepts only boolean bot ingress", () => {
    expect(FeishuConfigSchema.parse({ allowBots: true }).allowBots).toBe(true);
    expect(() => FeishuConfigSchema.parse({ allowBots: "mentions" })).toThrow();
  });

  it("keeps VC auto-join default-off without forcing account overrides", () => {
    const result = FeishuConfigSchema.parse({ accounts: { main: {} } });
    expect(result.vcAutoJoin).toBeUndefined();
    expect(result.accounts?.main?.vcAutoJoin).toBeUndefined();

    expect(FeishuConfigSchema.parse({ vcAutoJoin: true }).vcAutoJoin).toBe(true);
    expect(
      FeishuConfigSchema.parse({ accounts: { main: { vcAutoJoin: true } } }).accounts?.main
        ?.vcAutoJoin,
    ).toBe(true);
  });

  it("accepts top-level and account-level nested streaming config", () => {
    const result = FeishuConfigSchema.parse({
      streaming: {
        mode: "partial",
        chunkMode: "newline",
        block: { enabled: true, coalesce: { idleMs: 100 } },
      },
      accounts: {
        main: {
          streaming: { mode: "off", block: { enabled: false } },
        },
      },
    });

    expect(result.streaming?.block?.enabled).toBe(true);
    expect(result.streaming?.chunkMode).toBe("newline");
    expect(result.accounts?.main?.streaming).toEqual({
      mode: "off",
      block: { enabled: false },
    });
  });

  it.each([
    ["boolean streaming", { streaming: true }],
    ["flat blockStreaming", { blockStreaming: true }],
    ["flat blockStreamingCoalesce", { blockStreamingCoalesce: { idleMs: 100 } }],
    ["flat chunkMode", { chunkMode: "newline" }],
  ])("rejects legacy %s spelling", (_name, overrides) => {
    expect(FeishuConfigSchema.safeParse(overrides).success).toBe(false);
    expect(FeishuConfigSchema.safeParse({ accounts: { main: overrides } }).success).toBe(false);
  });

  it("accepts account-level optimization flags", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {
          typingIndicator: false,
          resolveSenderNames: false,
        },
      },
    });
    expect(result.accounts?.main?.typingIndicator).toBe(false);
    expect(result.accounts?.main?.resolveSenderNames).toBe(false);
  });
});

describe("FeishuConfigSchema TTS overrides", () => {
  it("accepts top-level and account-level TTS overrides", () => {
    const result = FeishuConfigSchema.parse({
      tts: {
        auto: "always",
        provider: "openai",
        providers: {
          openai: {
            voice: "alloy",
          },
        },
      },
      accounts: {
        english: {
          tts: {
            providers: {
              openai: {
                voice: "shimmer",
              },
            },
          },
        },
      },
    });

    expect(result.tts).toEqual({
      auto: "always",
      provider: "openai",
      providers: {
        openai: {
          voice: "alloy",
        },
      },
    });
    expect(result.accounts?.english?.tts).toEqual({
      providers: {
        openai: {
          voice: "shimmer",
        },
      },
    });
  });
});

describe("FeishuConfigSchema actions", () => {
  it("accepts opt-in stickers at channel and account scope without changing defaults", () => {
    expect(FeishuConfigSchema.parse({}).actions?.sticker).toBeUndefined();
    const result = FeishuConfigSchema.parse({
      actions: { sticker: true },
      accounts: { work: { actions: { sticker: false } } },
    });
    expect(result.actions?.sticker).toBe(true);
    expect(result.accounts?.work?.actions?.sticker).toBe(false);
    expect(FeishuConfigSchema.safeParse({ actions: { sticker: "true" } }).success).toBe(false);
    expect(FeishuChannelConfigSchema.schema).toMatchObject({
      properties: {
        actions: { properties: { sticker: { type: "boolean" } } },
        accounts: {
          additionalProperties: {
            properties: { actions: { properties: { sticker: { type: "boolean" } } } },
          },
        },
      },
    });
  });
  it("accepts top-level reactions action gate", () => {
    const result = FeishuConfigSchema.parse({
      actions: { reactions: false },
    });
    expect(result.actions?.reactions).toBe(false);
  });

  it("accepts account-level reactions action gate", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {
          actions: { reactions: false },
        },
      },
    });
    expect(result.accounts?.main?.actions?.reactions).toBe(false);
  });
});

describe("FeishuConfigSchema stickerSets", () => {
  const entry = { file_received: ["thumbs up", "赞", "👍"] };

  function expectCatalogValidation(value: Record<string, unknown>, accepted: boolean) {
    expect(FeishuConfigSchema.safeParse(value).success, "Zod validation").toBe(accepted);
    const result = validateJsonSchemaValue({
      schema: FeishuChannelConfigSchema.schema,
      cacheKey: "feishu-sticker-catalog-test",
      value,
      applyDefaults: true,
    });
    expect(result.ok, "exported JSON Schema validation").toBe(accepted);
    if (result.ok) {
      expect(result.value).toMatchObject(value);
    }
  }

  it("accepts bounded bot catalogs only at channel scope", () => {
    const stickerSets = {
      "bot-without-prefix": entry,
      ["a".repeat(128)]: Object.fromEntries(
        Array.from({ length: 256 }, (_, index) => [
          `file_${index}`.padEnd(512, "界"),
          Array.from({ length: 8 }, () => "赞".repeat(64)),
        ]),
      ),
      ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`bot_${index}`, {}])),
    };
    expectCatalogValidation({ stickerSets }, true);
    expect(FeishuConfigSchema.parse({ stickerSets }).stickerSets).toEqual(stickerSets);
    expect(FeishuConfigSchema.parse({}).stickerSets).toBeUndefined();
    expectCatalogValidation({ accounts: { work: { stickerSets } } }, false);
  });

  it.each([
    ["too many bots", Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`bot_${i}`, {}]))],
    ["empty app ID", { "": entry }],
    ["padded app ID", { " bot ": entry }],
    ["long app ID", { ["a".repeat(129)]: entry }],
    [
      "too many entries",
      { bot: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`file_${i}`, ["yes"]])) },
    ],
    ["old array shape", { bot: [{ fileKey: "file_received", keywords: ["yes"] }] }],
    ["empty keywords", { bot: { file_received: [] } }],
    ["too many keywords", { bot: { file_received: Array(9).fill("yes") } }],
    ["blank keyword", { bot: { file_received: ["  "] } }],
    ["padded keyword", { bot: { file_received: [" yes "] } }],
    ["long keyword", { bot: { file_received: ["x".repeat(65)] } }],
    ["non-string keyword", { bot: { file_received: [12] } }],
    ["padded key", { bot: { " file_received ": ["yes"] } }],
    ["long key", { bot: { ["x".repeat(513)]: ["yes"] } }],
    ["path key", { bot: { "../sticker": ["yes"] } }],
    ["control key", { bot: { "file\u0000key": ["yes"] } }],
    ["unpaired surrogate key", { bot: { "\ud800": ["yes"] } }],
    ["unpaired surrogate keyword", { bot: { file_received: ["\udfff"] } }],
    ["unpaired surrogate app ID", { "\ud800": entry }],
  ])("rejects %s", (_name, stickerSets) => {
    expectCatalogValidation({ stickerSets }, false);
  });

  it.each(["👍", "e\u0301", "👋🏽", "👩‍💻"])(
    "uses Unicode scalar bounds consistently for %s",
    (unit) => {
      const bounded = (limit: number) => Array.from(unit.repeat(limit)).slice(0, limit).join("");
      const appId = bounded(128);
      const fileKey = bounded(512);
      const keyword = bounded(64);
      expectCatalogValidation({ stickerSets: { [appId]: { [fileKey]: [keyword] } } }, true);
      expectCatalogValidation({ stickerSets: { [appId + "x"]: entry } }, false);
      expectCatalogValidation({ stickerSets: { bot: { [fileKey + "x"]: ["yes"] } } }, false);
      expectCatalogValidation({ stickerSets: { bot: { file_received: [keyword + "x"] } } }, false);
    },
  );

  it.each([" ", "\n", "\t", "\u00a0", "\u2028", "\ufeff"])(
    "rejects stored padding %j",
    (padding) => {
      for (const padded of [`${padding}value`, `value${padding}`]) {
        expectCatalogValidation({ stickerSets: { [padded]: entry } }, false);
        expectCatalogValidation({ stickerSets: { bot: { [padded]: ["yes"] } } }, false);
        expectCatalogValidation({ stickerSets: { bot: { file_received: [padded] } } }, false);
      }
    },
  );
});

describe("FeishuConfigSchema defaultAccount", () => {
  it("accepts defaultAccount when it matches an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      defaultAccount: "router-d",
      accounts: {
        "router-d": { appId: "cli_router", appSecret: "secret_router" }, // pragma: allowlist secret
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects defaultAccount when it does not match an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      defaultAccount: "router-d",
      accounts: {
        backup: { appId: "cli_backup", appSecret: "secret_backup" }, // pragma: allowlist secret
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("defaultAccount");
    }
  });
});

describe("working card configuration", () => {
  it("is opt-in and supports account-level overrides", () => {
    expect(FeishuConfigSchema.parse({}).workingCard).toBeUndefined();
    const value = { workingCard: { enabled: true }, accounts: { other: { workingCard: { enabled: false } } } };
    expect(FeishuConfigSchema.parse(value)).toMatchObject(value);
    expect(validateJsonSchemaValue({ schema: FeishuChannelConfigSchema.schema, cacheKey: "working-card-config", value, applyDefaults: true }).ok).toBe(true);
    expect(FeishuConfigSchema.safeParse({workingCard:{enabled:"true"}}).success).toBe(false);
  });
});

describe("fixed workspace synchronization config",()=>{
  it("accepts explicit operator configuration and rejects extra command parameters",()=>{
    expect(FeishuConfigSchema.safeParse({workspaceSync:{enabled:true,root:"/workspace/ada",timeoutMs:30000}}).success).toBe(true);
    expect(FeishuConfigSchema.safeParse({workspaceSync:{enabled:true,root:"/workspace/ada",command:"rm -rf"}}).success).toBe(false);
    expect(FeishuConfigSchema.safeParse({workspaceSync:{enabled:true,root:"/workspace/ada",timeoutMs:120000}}).success).toBe(false);
  });
});

describe("bilingual configuration UI", () => {
  function fieldPaths(schema: unknown, prefix = ""): string[] {
    if (!schema || typeof schema !== "object") return [];
    const node = schema as Record<string, unknown>;
    const paths: string[] = [];
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.push(path, ...fieldPaths(child, path));
    }
    paths.push(...fieldPaths(node.items, `${prefix}.*`));
    paths.push(...fieldPaths(node.additionalProperties, `${prefix}.*`));
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(node[key])) {
        for (const child of node[key]) paths.push(...fieldPaths(child, prefix));
      }
    }
    return [...new Set(paths)];
  }

  it("covers every declared field including account, group, DM and secret-reference fields", () => {
    const hints = FeishuChannelConfigSchema.uiHints ?? {};
    expect(Object.keys(hints).sort()).toEqual(fieldPaths(FeishuChannelConfigSchema.schema).sort());
    for (const [path, hint] of Object.entries(hints)) {
      expect(hint.label, path).toMatch(/[\u4e00-\u9fff].* \/ [A-Za-z@]/);
      if (hint.help) expect(hint.help, path).toMatch(/[\u4e00-\u9fff].* \/ [A-Za-z]/);
    }
    expect(hints.workingCard.label).toBe("工作卡片 / Working card");
    expect(hints["accounts.*.workingCard"]).toEqual(hints.workingCard);
    expect(hints["accounts.*.groups.*.tools.allow"].label).toBe("允许的工具 / Allowed tools");
    expect(hints["accounts.*.dms.*.systemPrompt"].label).toBe("系统提示词 / System prompt");
  });

  it("keeps credentials sensitive in both global and account forms", () => {
    for (const prefix of ["", "accounts.*."]) {
      for (const field of ["appSecret", "encryptKey", "verificationToken"]) {
        expect(FeishuChannelConfigSchema.uiHints?.[`${prefix}${field}`].sensitive).toBe(true);
      }
    }
  });

  it("ships the same schema and hints in the manifest for forms before activation", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.channelConfigs.feishu).toEqual({
      schema: FeishuChannelConfigSchema.schema,
      uiHints: FeishuChannelConfigSchema.uiHints,
    });
  });
});

it("validates configurable history windows globally and per account",()=>{
 const mentionHistory={recentLimit:5,limit:20,quoteBefore:0,quoteAfter:20,deduplicateOlder:false,maxChars:12000};
 expect(FeishuConfigSchema.parse({mentionHistory,accounts:{test:{mentionHistory}}}).mentionHistory).toEqual(mentionHistory);
 for(const invalid of [{recentLimit:0},{recentLimit:51},{quoteBefore:-1},{quoteAfter:21},{quoteAfter:1.5},{deduplicateOlder:"false"}]) {
  expect(FeishuConfigSchema.safeParse({mentionHistory:invalid}).success).toBe(false);
 }
});
it("inherits individual history settings when an account overrides one field",async()=>{
 const {resolveFeishuAccount}=await import('./accounts.js');
 const cfg={channels:{feishu:{mentionHistory:{recentLimit:7,quoteBefore:2,deduplicateOlder:true},accounts:{test:{mentionHistory:{quoteAfter:0,deduplicateOlder:false}}}}}};
 expect(resolveFeishuAccount({cfg,accountId:'test'}).config.mentionHistory).toEqual({recentLimit:7,quoteBefore:2,quoteAfter:0,deduplicateOlder:false});
});

it("validates quote chain controls and inherits per-account overrides",async()=>{
 for(const quoteChain of [{maxDepth:0},{maxDepth:101},{maxChars:999},{maxChars:100001}]) {
  expect(FeishuConfigSchema.safeParse({quoteChain}).success).toBe(false);
 }
 const {resolveFeishuAccount}=await import('./accounts.js');
 const cfg={channels:{feishu:{quoteChain:{maxDepth:30,maxChars:30000},accounts:{test:{quoteChain:{maxDepth:10}}}}}};
 expect(resolveFeishuAccount({cfg,accountId:'test'}).config.quoteChain).toEqual({maxDepth:10,maxChars:30000});
});

it("validates summary settings and per-account inheritance",async()=>{
 for(const historySummary of [{triggerChars:999},{targetChars:255},{timeoutMs:999},{maxInputChars:9999},{model:" "}])
  expect(FeishuConfigSchema.safeParse({historySummary}).success).toBe(false);
 const {resolveFeishuAccount}=await import('./accounts.js');
 const cfg={channels:{feishu:{historySummary:{triggerChars:12000,targetChars:3000},accounts:{test:{historySummary:{enabled:false}}}}}};
 expect(resolveFeishuAccount({cfg,accountId:'test'}).config.historySummary).toEqual({triggerChars:12000,targetChars:3000,enabled:false});
});

it('exports configurable business presets at global and account scope with bilingual UI hints',()=>{
 const value={colleagueProfile:{guidance:'Use a neutral greeting',roles:[{name:'Operations',titleKeywords:['operator']}]},businessMessages:{completionMention:'Ready'},conversationCommands:{steerPrefixes:['Update'],progressPhrases:['Status?']},workingCard:{workingImage:'/tmp/image.gif',progressToolName:'task_progress',progressTemplate:'{current}'},workspaceSync:{root:'/workspace',branch:'release',remote:'primary',submodules:[],gitEnvironment:{},skillDirectories:['custom-skills'],roleFiles:['ROLE.md']}};
 expect(FeishuConfigSchema.safeParse(value).success).toBe(true);
 expect(FeishuConfigSchema.safeParse({accounts:{custom:value}}).success).toBe(true);
 expect(validateJsonSchemaValue({schema:FeishuChannelConfigSchema.schema,cacheKey:'generalized-global',value,applyDefaults:false}).ok).toBe(true);
 expect(validateJsonSchemaValue({schema:FeishuChannelConfigSchema.schema,cacheKey:'generalized-account',value:{accounts:{custom:value}},applyDefaults:false}).ok).toBe(true);
 for(const path of ['colleagueProfile.guidance','businessMessages.completionMention','workspaceSync.skillDirectories','workingCard.progressTemplate']) {
  expect(FeishuChannelConfigSchema.uiHints[path]?.label).toContain(' / ');
  expect(FeishuChannelConfigSchema.uiHints['accounts.*.'+path]?.label).toContain(' / ');
 }
 for(const skillDirectories of [['../private'],['/absolute'],['a//b']]) {
  const invalid={workspaceSync:{root:'/workspace',skillDirectories}};
  expect(FeishuConfigSchema.safeParse(invalid).success).toBe(false);
  expect(validateJsonSchemaValue({schema:FeishuChannelConfigSchema.schema,cacheKey:'generalized-invalid',value:invalid,applyDefaults:false}).ok).toBe(false);
 }
});

it('inherits nested business presets and replaces account-specific lists',async()=>{
 const {resolveFeishuAccount}=await import('./accounts.js');
 const cfg={channels:{feishu:{colleagueProfile:{guidance:'Global guidance',roles:[{name:'Global',titleKeywords:['global']}],commands:{rolePrefix:'Role',view:'Profile'}},businessMessages:{completionMention:'Ready',mentionSuffix:''},workingCard:{workingImage:'/tmp/global.gif'},conversationCommands:{steerPrefixes:['Update'],progressPhrases:['Status?']},accounts:{custom:{colleagueProfile:{roles:[],commands:{view:'Who am I?'}},businessMessages:{completionMention:'Done'},workingCard:{enabled:true},conversationCommands:{progressPhrases:[]}}}}}};
 const config=resolveFeishuAccount({cfg,accountId:'custom'}).config;
 expect(config.colleagueProfile).toMatchObject({guidance:'Global guidance',roles:[],commands:{rolePrefix:'Role',view:'Who am I?'}});
 expect(config.businessMessages).toEqual({completionMention:'Done',mentionSuffix:''});
 expect(config.workingCard).toEqual({enabled:true,workingImage:'/tmp/global.gif'});
 expect(config.conversationCommands).toEqual({steerPrefixes:['Update'],progressPhrases:[]});
});

it('host default application preserves inherited custom business settings',async()=>{
 const {resolveFeishuAccount}=await import('./accounts.js');
 const value={colleagueProfile:{guidance:'Custom global',commands:{rolePrefix:'Role'}},workingCard:{imageSize:'128px 128px',progressTemplate:'{current}'},businessMessages:{completionMention:'Custom global completion'},accounts:{custom:{colleagueProfile:{commands:{view:'View'}},workingCard:{enabled:true},businessMessages:{progressGreeting:'Hello'}}}};
 const validated=validateJsonSchemaValue({schema:FeishuChannelConfigSchema.schema,cacheKey:'business-inheritance-defaults',value,applyDefaults:true});
 expect(validated.ok).toBe(true);
 if(!validated.ok)throw Error('schema rejected business presets');
 const config=resolveFeishuAccount({cfg:{channels:{feishu:validated.value}},accountId:'custom'}).config;
 expect(config.colleagueProfile?.guidance).toBe('Custom global');
 expect(config.colleagueProfile?.commands).toMatchObject({rolePrefix:'Role',view:'View'});
 expect(config.workingCard?.progressTemplate).toBe('{current}');
 expect(config.workingCard?.imageSize).toBe('128px 128px');
 expect(config.businessMessages?.completionMention).toBe('Custom global completion');
});

it("rejects codex-query invalid settings at the UI boundary with the same runtime constraints",()=>{
 const manifest=JSON.parse(readFileSync(new URL("../../agent-worker/openclaw.plugin.json",import.meta.url),"utf8"));
 const cases=[{cwd:"relative"},
  {skillDirectories:["../private"]},{skillDirectories:["a/./b"]},{skillDirectories:["a\\b"]},{reportDirectory:"-flag"},{reportDirectory:"a//b"},{reportDirectory:"a\0b"},{model:"   "},{timeoutMs:0},
  {cwd:"/tmp/project",skillDirectories:[".agents/skills"],reportDirectory:"reports"}];
 for(const value of cases){
  let accepted=true;try{resolveConfiguration(value)}catch{accepted=false;}
  expect(validateJsonSchemaValue({schema:manifest.configSchema,value,applyDefaults:true}).ok,JSON.stringify(value)).toBe(accepted);
 }
 for(const key of ["memoryRoot","memoryToolName","memoryEnabled","memorySemanticEnabled","memoryEmbeddingTimeoutMs"]){
  expect(validateJsonSchemaValue({schema:manifest.configSchema,value:{[key]:true},applyDefaults:true}).ok).toBe(false);
 }
});
it("exports Git name validation and bilingual hints for progress placeholder messages",()=>{
 const value={workspaceSync:{root:"/tmp/workspace",branch:"feature..invalid"}};
 expect(FeishuConfigSchema.safeParse(value).success).toBe(false);
 expect(validateJsonSchemaValue({schema:FeishuChannelConfigSchema.schema,value,applyDefaults:true}).ok).toBe(false);
 for(const name of ["progressInitial","progressEstimate","progressAge","asyncOversizedResult"]){
  expect(FeishuChannelConfigSchema.uiHints?.[`businessMessages.${name}`]?.label).toContain(" / ");
  expect(FeishuChannelConfigSchema.uiHints?.[`accounts.*.businessMessages.${name}`]?.label).toContain(" / ");
 }
});

it("exposes document delivery defaults without shadowing global settings on accounts",()=>{
 const parsed=validateJsonSchemaValue({schema:FeishuChannelConfigSchema.schema,value:{documentDelivery:{maxFiles:3,linkTemplate:'[{title}]({url})'},accounts:{work:{documentDelivery:{folderToken:'folder'}}}},applyDefaults:true});
 expect(parsed.ok).toBe(true);
 if(parsed.ok){const value=parsed.value as {documentDelivery:{maxFiles:number;enabled:boolean};accounts:{work:{documentDelivery:Record<string,unknown>}}};expect(value.documentDelivery.enabled).toBe(true);expect(value.accounts.work.documentDelivery).toEqual({folderToken:'folder'});}
 expect(FeishuConfigSchema.safeParse({documentDelivery:{maxFileMb:21}}).success).toBe(false);
 expect(FeishuChannelConfigSchema.uiHints?.['accounts.*.documentDelivery.linkTemplate']?.label).toContain(' / ');
});

it("selects each completion variant while preserving custom fixed copy",()=>{
 const random=vi.spyOn(Math,"random");
 try {
  for(const [index,copy] of defaultCompletionMentions.entries()){
   random.mockReturnValue((index+0.1)/defaultCompletionMentions.length);
   expect(renderBusinessMessage(undefined,"completionMention")).toBe(copy);
  }
  expect(renderBusinessMessage({completionMention:"Custom fixed",completionMentions:["Other"]},"completionMention")).toBe("Custom fixed");
  expect(renderBusinessMessage({completionMention:""},"completionMention")).toBe("");
 } finally {random.mockRestore();}
});
it.each(['failureMention','timeoutMention','cancelledMention'] as const)('supports independent terminal reminder %s globally and per account',async key=>{
 const {resolveFeishuAccount}=await import('./accounts.js');
 const value={businessMessages:{completionMention:'成功文案',[key]:'全局提醒'},accounts:{custom:{businessMessages:{[key]:'账号提醒'}}}};
 expect(FeishuConfigSchema.safeParse(value).success).toBe(true);
 expect(validateJsonSchemaValue({schema:FeishuChannelConfigSchema.schema,value,applyDefaults:false}).ok).toBe(true);
 const config=resolveFeishuAccount({cfg:{channels:{feishu:value}},accountId:'custom'}).config;
 expect(renderBusinessMessage(config.businessMessages,key)).toBe('账号提醒');
 expect(renderBusinessMessage({completionMention:'成功文案'},key)).not.toBe('成功文案');
 expect(FeishuChannelConfigSchema.uiHints?.[`businessMessages.${key}`]?.label).toContain(' / ');
 expect(FeishuChannelConfigSchema.uiHints?.[`accounts.*.businessMessages.${key}`]?.label).toContain(' / ');
});
it("validates completion candidates globally and per account and substitutes only supported values",()=>{
 const config={businessMessages:{completionMentions:["老师，完成了"]},accounts:{custom:{businessMessages:{completionMentions:["老师，{result}"]}}}};
 expect(FeishuConfigSchema.safeParse(config).success).toBe(true);
 expect(FeishuConfigSchema.safeParse({businessMessages:{completionMentions:[]}}).success).toBe(false);
 expect(FeishuConfigSchema.safeParse({businessMessages:{completionMentions:[""]}}).success).toBe(false);
 expect(renderBusinessMessage({completionMentions:["老师，{result}"]},"completionMention",{result:"搞定了"})).toBe("老师，搞定了");
 expect(renderBusinessMessage({completionMentions:[" "]},"completionMention")).toBe("老师，结果已更新，请查看上方回复。");
});
