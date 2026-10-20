import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveBootstrapFilesForPreparation } from "openclaw/plugin-sdk/codex-mcp-projection";

it("native bootstrap reloads changed and removed role files for the same existing session", async () => {
  await mkdir(".tmp", {recursive: true});
  const root = await mkdtemp(resolve(".tmp/bootstrap-"));
  try {
    const params = {workspaceDir: root, sessionKey: "agent:main:feishu:group:test", sessionId: "same",
      agentId: "main", chatType: "group", config: {agents: {defaults: {workspace: root}}}};
    await writeFile(join(root, "SOUL.md"), "role version one");
    const first = await resolveBootstrapFilesForPreparation(params);
    await writeFile(join(root, "SOUL.md"), "role version two");
    const second = await resolveBootstrapFilesForPreparation(params);
    expect(first.find(file => file.name === "SOUL.md")?.content).toBe("role version one");
    expect(second.find(file => file.name === "SOUL.md")?.content).toBe("role version two");
    await rm(join(root, "SOUL.md"));
    const third = await resolveBootstrapFilesForPreparation(params);
    expect(third.find(file => file.name === "SOUL.md")?.missing).toBe(true);
  } finally { await rm(root, {recursive: true, force: true}); }
});
