import { describe, expect, it, vi } from "vitest";
import { announceServiceReady, handleOnboardService, isInstallableReleaseVersion, shouldOfferForegroundStart } from "../onboard-service.js";

function supportedDetection() {
  return {
    supported: true as const,
    manager: {
      platform: "systemd" as const,
      instanceId: "default",
      serviceName: "paperclipai.service",
      definitionPath: "/tmp/paperclipai.service",
      renderDefinition: () => "unit",
      install: vi.fn(async () => ({ changed: true })),
      uninstall: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      status: vi.fn(async () => ({
        platform: "systemd" as const,
        serviceName: "paperclipai.service",
        installed: true,
        active: true,
        enabled: true,
        pid: 123,
      })),
      logs: vi.fn(async () => undefined),
      installedExecutablePath: vi.fn(async () => null),
    },
  };
}

describe("onboard service policy", () => {
  it("does not install during --yes onboarding without opt-in", async () => {
    const detection = supportedDetection();
    const info = vi.fn();

    const installed = await handleOnboardService(
      { yes: true },
      { detect: vi.fn(async () => detection), isInteractive: () => false, info },
    );

    expect(installed).toBe(false);
    expect(detection.manager.install).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("--install-service"));
  });

  it("installs when --yes explicitly opts in", async () => {
    const detection = supportedDetection();

    const installed = await handleOnboardService(
      { yes: true, installService: true },
      {
        detect: vi.fn(async () => detection),
        isInteractive: () => false,
        ensureServiceShim: vi.fn(async () => ({ ok: true, installedNow: false })),
      },
    );

    expect(installed).toBe(true);
    expect(detection.manager.install).toHaveBeenCalledWith({ startNow: true, startOnLogin: true });
  });

  it("asks during interactive onboarding", async () => {
    const detection = supportedDetection();
    const confirm = vi.fn(async () => true);

    const installed = await handleOnboardService(
      {},
      {
        detect: vi.fn(async () => detection),
        isInteractive: () => true,
        confirm,
        ensureServiceShim: vi.fn(async () => ({ ok: true, installedNow: false })),
      },
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(installed).toBe(true);
  });

  it("silences the hint with --no-install-service", async () => {
    const info = vi.fn();
    const detect = vi.fn(async () => supportedDetection());

    const installed = await handleOnboardService(
      { yes: true, installService: false },
      { detect, isInteractive: () => false, info },
    );

    expect(installed).toBe(false);
    expect(detect).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("materializes the managed shim before installing the service", async () => {
    const detection = supportedDetection();
    const success = vi.fn();
    const ensureServiceShim = vi.fn(async () => ({ ok: true, installedNow: true }));

    const installed = await handleOnboardService(
      { yes: true, installService: true },
      { detect: vi.fn(async () => detection), isInteractive: () => false, ensureServiceShim, success },
    );

    expect(installed).toBe(true);
    expect(ensureServiceShim).toHaveBeenCalledOnce();
    expect(success).toHaveBeenCalledWith(expect.stringContaining("managed paperclipai payload"));
    expect(detection.manager.install).toHaveBeenCalledWith({ startNow: true, startOnLogin: true });
  });

  it("declines instead of installing a service without a binary", async () => {
    const detection = supportedDetection();
    const warn = vi.fn();

    const installed = await handleOnboardService(
      { yes: true, installService: true },
      {
        detect: vi.fn(async () => detection),
        isInteractive: () => false,
        ensureServiceShim: vi.fn(async () => ({ ok: false, installedNow: false, reason: "npm exploded" })),
        warn,
      },
    );

    expect(installed).toBe(false);
    expect(detection.manager.install).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("npm exploded"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("paperclipai install"));
  });

});

describe("isInstallableReleaseVersion", () => {
  it("accepts calendar releases and rejects placeholders", () => {
    expect(isInstallableReleaseVersion("2026.824.1")).toBe(true);
    expect(isInstallableReleaseVersion("2026.818.0-beta.1")).toBe(true);
    expect(isInstallableReleaseVersion("0.3.1")).toBe(false);
    expect(isInstallableReleaseVersion("not-a-version")).toBe(false);
  });
});

describe("shouldOfferForegroundStart", () => {
  const base = { serviceInstalled: false, startAlreadyDecided: false, invokedByRun: false, interactive: true };

  it("offers a foreground start on a plain interactive onboard", () => {
    expect(shouldOfferForegroundStart(base)).toBe(true);
  });

  it("never prompts after the service was installed and started", () => {
    expect(shouldOfferForegroundStart({ ...base, serviceInstalled: true })).toBe(false);
  });

  it("never prompts when the start decision was already made by flags", () => {
    expect(shouldOfferForegroundStart({ ...base, startAlreadyDecided: true })).toBe(false);
  });

  it("never prompts when run itself invoked onboarding", () => {
    expect(shouldOfferForegroundStart({ ...base, invokedByRun: true })).toBe(false);
  });

  it("never prompts without an interactive terminal", () => {
    expect(shouldOfferForegroundStart({ ...base, interactive: false })).toBe(false);
  });
});

describe("announceServiceReady", () => {
  function readyDeps(overrides: Record<string, unknown> = {}) {
    return {
      probeHealth: vi.fn(async () => true),
      openBrowser: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      ...overrides,
    };
  }

  it("prints the URL and opens the browser once the service answers", async () => {
    const deps = readyDeps();
    const ready = await announceServiceReady({ baseUrl: "http://127.0.0.1:3100", interactive: true }, deps);
    expect(ready).toBe(true);
    expect(deps.probeHealth).toHaveBeenCalledWith("http://127.0.0.1:3100/api/health");
    expect(deps.success).toHaveBeenCalledWith("Paperclip is running at http://127.0.0.1:3100");
    expect(deps.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3100");
  });

  it("polls until the service becomes healthy", async () => {
    const probeHealth = vi.fn(async () => false).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const deps = readyDeps({ probeHealth });
    const ready = await announceServiceReady({ baseUrl: "http://127.0.0.1:3100", interactive: true, timeoutMs: 50, pollIntervalMs: 10 }, deps);
    expect(ready).toBe(true);
    expect(probeHealth).toHaveBeenCalledTimes(3);
  });

  it("prints the URL instead of opening a browser on non-interactive runs", async () => {
    const deps = readyDeps();
    await announceServiceReady({ baseUrl: "http://127.0.0.1:3100", interactive: false }, deps);
    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(deps.info).toHaveBeenCalledWith("Open http://127.0.0.1:3100 in your browser to get started.");
  });

  it("falls back to printing the URL when the browser cannot open", async () => {
    const deps = readyDeps({ openBrowser: vi.fn(async () => { throw new Error("no display"); }) });
    const ready = await announceServiceReady({ baseUrl: "http://127.0.0.1:3100", interactive: true }, deps);
    expect(ready).toBe(true);
    expect(deps.info).toHaveBeenCalledWith("Open http://127.0.0.1:3100 in your browser to get started.");
  });

  it("warns with service diagnostics when the service never answers", async () => {
    const deps = readyDeps({ probeHealth: vi.fn(async () => false) });
    const ready = await announceServiceReady({ baseUrl: "http://127.0.0.1:3100", interactive: true, timeoutMs: 30, pollIntervalMs: 10 }, deps);
    expect(ready).toBe(false);
    expect(deps.openBrowser).not.toHaveBeenCalled();
    const warned = (deps.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(warned).toContain("has not answered at http://127.0.0.1:3100");
    expect(warned).toContain("paperclipai service status");
    expect(warned).toContain("paperclipai service logs");
  });
});
