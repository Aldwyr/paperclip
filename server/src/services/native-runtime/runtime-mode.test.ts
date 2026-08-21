import { describe, expect, it } from "vitest";
import {
  NativeRuntimeEligibilityError,
  resolveHeartbeatNativeRuntimeMode,
  resolveNativeRuntimeMode,
} from "./runtime-mode.js";

const eligible = {
  enabled: true,
  runtimeConfig: { nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 } },
  agent: { status: "running", adapterType: "codex_local" },
  issue: { id: "issue", workMode: "standard" },
  target: { kind: "local" },
  workspaceId: "workspace",
} as const;

describe("resolveNativeRuntimeMode", () => {
  it("selects the Rust runner adapter without the experimental codex runtime toggle", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      enabled: false,
      runtimeConfig: {},
      adapterConfig: { provider: "codex" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toEqual(expect.objectContaining({
      kind: "native",
      reason: "eligible_opt_in",
      profile: { mode: "native", backend: "codex_app_server", protocolVersion: 1 },
    }));
  });

  it("rejects unknown Paperclip Runner providers", () => {
    expect(() => resolveNativeRuntimeMode({
      ...eligible,
      runtimeConfig: {},
      adapterConfig: { provider: "claude" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toThrow(/provider must be codex or opencode/);
  });

  it("selects OpenCode only with a provider/model value", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      runtimeConfig: {},
      adapterConfig: { provider: "opencode", model: "openrouter/deepseek/deepseek-v4-flash-0731" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toEqual(expect.objectContaining({
      profile: { mode: "native", backend: "opencode_server", protocolVersion: 1 },
    }));
    expect(() => resolveNativeRuntimeMode({
      ...eligible,
      runtimeConfig: {},
      adapterConfig: { provider: "opencode", model: "deepseek" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toThrow(/provider\/model/);
  });

  it("preserves legacy as the default and as the kill-switch behavior", () => {
    expect(resolveNativeRuntimeMode({ ...eligible, runtimeConfig: {} }).kind).toBe("legacy");
    expect(resolveNativeRuntimeMode({ ...eligible, enabled: false })).toEqual(expect.objectContaining({
      kind: "legacy",
      reason: "instance_flag_disabled",
    }));
  });

  it("selects native only for an eligible explicit profile", () => {
    expect(resolveNativeRuntimeMode(eligible)).toEqual(expect.objectContaining({
      kind: "native",
      reason: "eligible_opt_in",
    }));
  });

  it("keeps a persisted active run native while the global flag makes a fresh run legacy", () => {
    const disabled = { ...eligible, enabled: false };
    expect(resolveHeartbeatNativeRuntimeMode({
      ...disabled,
      persisted: {
        runtimeMode: "native",
        runtimeModeReason: "eligible_opt_in",
        runtimeModeResolvedAt: new Date(),
      },
    })).toEqual(expect.objectContaining({
      kind: "native",
      reason: "eligible_opt_in",
      authorityDecision: expect.objectContaining({ reasonCode: "live_continuation_registered" }),
    }));
    expect(resolveHeartbeatNativeRuntimeMode({
      ...disabled,
      persisted: { runtimeMode: null, runtimeModeReason: null, runtimeModeResolvedAt: null },
    })).toEqual(expect.objectContaining({ kind: "legacy", reason: "instance_flag_disabled" }));
    expect(disabled.runtimeConfig.nativeRunner.mode).toBe("native");
  });

  it("keeps a persisted OpenCode recovery on its immutable driver", () => {
    expect(resolveHeartbeatNativeRuntimeMode({
      ...eligible,
      enabled: false,
      adapterConfig: { provider: "codex" },
      persisted: {
        runtimeMode: "native",
        runtimeModeReason: "eligible_opt_in",
        runtimeModeResolvedAt: new Date(),
        driverKind: "opencode_server",
      },
    })).toEqual(expect.objectContaining({
      profile: { mode: "native", backend: "opencode_server", protocolVersion: 1 },
    }));
  });

  it("rejects an explicit native profile outside the approved boundary", () => {
    expect(() => resolveNativeRuntimeMode({ ...eligible, agent: { ...eligible.agent, adapterType: "claude_local" } }))
      .toThrow(NativeRuntimeEligibilityError);
    expect(() => resolveNativeRuntimeMode({ ...eligible, issue: { id: "issue", workMode: "skill_test" } }))
      .toThrow(NativeRuntimeEligibilityError);
    expect(() => resolveNativeRuntimeMode({ ...eligible, target: { kind: "remote" } }))
      .toThrow(NativeRuntimeEligibilityError);
  });

  it("allows paperclip_runner to use a transient local workspace for projectless issues", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      workspaceId: null,
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
      runtimeConfig: {},
      adapterConfig: { provider: "codex" },
    })).toEqual(expect.objectContaining({ kind: "native" }));
  });
});
