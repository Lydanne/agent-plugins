import { WizardCancelledError, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registration = vi.hoisted(() => ({
  initAppRegistration: vi.fn(),
  beginAppRegistration: vi.fn(),
  pollAppRegistration: vi.fn(),
  renderRegistrationQr: vi.fn(),
  getAppOwnerOpenId: vi.fn(),
}));
vi.mock("./app-registration.js", () => registration);
vi.mock("./probe.js", () => ({ probeFeishu: vi.fn(async () => ({ ok: false })) }));
import { feishuSetupWizard } from "./setup-surface.js";

function prompts(): WizardPrompter {
  return {
    intro: vi.fn(async () => {}), outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    text: vi.fn(async () => "manual-placeholder"),
    select: vi.fn(async ({ initialValue }) => initialValue) as WizardPrompter["select"],
    multiselect: vi.fn(async () => []), confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}
function run(prompter: WizardPrompter, beforePersistentEffect = vi.fn(async () => {})) {
  vi.mocked(prompter.select).mockResolvedValueOnce("scan").mockResolvedValueOnce("feishu").mockResolvedValueOnce("disabled");
  return feishuSetupWizard.finalize!({ cfg: {}, accountId: "default", credentialValues: {},
    runtime: createNonExitingRuntime(), prompter, forceAllowFrom: false,
    options: { beforePersistentEffect } });
}

beforeEach(() => {
  vi.resetAllMocks();
  registration.initAppRegistration.mockResolvedValue(undefined);
  registration.beginAppRegistration.mockResolvedValue({ deviceCode: "PRIVATE_DEVICE", qrUrl: "https://accounts.feishu.cn/verify?code=public", interval: 1, expireIn: 600 });
  registration.renderRegistrationQr.mockResolvedValue("  █▀▄  \n  ▀█▀  ");
  registration.pollAppRegistration.mockResolvedValue({ status: "success", result: { appId: "cli_test", appSecret: "PRIVATE_SECRET", domain: "feishu", openId: "ou_owner" } });
});

describe("hosted Feishu QR setup", () => {
  it("delivers QR and URL through the prompt before polling, without exposing private credentials", async () => {
    const p = prompts(); const guard = vi.fn(async () => {});
    const result = await run(p, guard);
    expect(p.note).toHaveBeenCalledWith(expect.stringContaining("  █▀▄  \n  ▀█▀  "), expect.any(String));
    expect(p.note).toHaveBeenCalledWith(expect.stringContaining("https://accounts.feishu.cn/verify?code=public"), expect.any(String));
    expect(JSON.stringify(vi.mocked(p.note).mock.calls)).not.toMatch(/PRIVATE_DEVICE|PRIVATE_SECRET/);
    expect(vi.mocked(p.note).mock.invocationCallOrder[0]).toBeLessThan(registration.pollAppRegistration.mock.invocationCallOrder[0]);
    expect(registration.pollAppRegistration.mock.invocationCallOrder[0]).toBeLessThan(guard.mock.invocationCallOrder[0]);
    expect(result?.cfg?.channels?.feishu).toMatchObject({ appId: "cli_test", appSecret: "PRIVATE_SECRET" });
  });

  it.each(["cancel", "close"])("ends on %s without polling or locking cancellation", async (kind) => {
    const p = prompts(); const guard = vi.fn(async () => {});
    const error = kind === "cancel" ? new WizardCancelledError() : new Error("window closed");
    vi.mocked(p.note).mockRejectedValueOnce(error);
    await expect(run(p, guard)).rejects.toBe(error);
    expect(registration.pollAppRegistration).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
  });

  it("cancels at a pending authorization checkpoint without persisting credentials", async () => {
    const p = prompts(); const guard = vi.fn(async () => {});
    const error = new WizardCancelledError();
    vi.mocked(p.note).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    registration.pollAppRegistration.mockImplementationOnce(async ({ onPending }) => { await onPending(); });
    await expect(run(p, guard)).rejects.toBe(error);
    expect(guard).not.toHaveBeenCalled();
  });

  it("counts time spent displaying the QR against its expiry", async () => {
    const p = prompts(); const now = vi.spyOn(Date, "now");
    const started = 1_000;
    now.mockReturnValue(started);
    vi.mocked(p.note).mockImplementationOnce(async () => { now.mockReturnValue(started + 601_000); });
    vi.mocked(p.text).mockRejectedValueOnce(new WizardCancelledError());
    try {
      await expect(run(p)).rejects.toBeInstanceOf(WizardCancelledError);
      expect(registration.pollAppRegistration).not.toHaveBeenCalled();
      expect(p.note).toHaveBeenCalledWith(expect.any(String), "飞书二维码已过期");
    } finally { now.mockRestore(); }
  });

  it("revalidates authority before adopting credentials", async () => {
    const error = new Error("setup authority changed");
    await expect(run(prompts(), vi.fn(async () => { throw error; }))).rejects.toBe(error);
  });

  it.each(["access_denied", "expired", "timeout", "error"])("shows %s before offering manual input", async (status) => {
    const p = prompts();
    registration.pollAppRegistration.mockResolvedValueOnce({ status, message: "无法连接飞书授权服务" });
    const stop = new WizardCancelledError();
    vi.mocked(p.text).mockRejectedValueOnce(stop);
    await expect(run(p)).rejects.toBe(stop);
    const notes = vi.mocked(p.note).mock.calls;
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes[1][1]).toMatch(/飞书/);
    expect(vi.mocked(p.note).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(p.text).mock.invocationCallOrder[0]);
  });

  it("shows challenge acquisition failures without leaking provider errors", async () => {
    const p = prompts();
    registration.beginAppRegistration.mockRejectedValueOnce(new Error("PRIVATE_TOKEN"));
    vi.mocked(p.text).mockRejectedValueOnce(new WizardCancelledError());
    await expect(run(p)).rejects.toBeInstanceOf(WizardCancelledError);
    expect(p.note).toHaveBeenCalledWith(expect.stringContaining("无法获取飞书登录二维码"), "飞书扫码失败");
    expect(JSON.stringify(vi.mocked(p.note).mock.calls)).not.toContain("PRIVATE_TOKEN");
  });
});
