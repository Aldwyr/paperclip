import { describe, expect, it } from "vitest";

import { buildNativeModelEnvelope, parseNativeExecutionInput, type NativeExecutionInputV1 } from "./native-execution.js";

const input: NativeExecutionInputV1 = {
  schema: "paperclip.native-execution-input.v1",
  binding: {
    companyId: "company-1",
    runId: "run-1",
    issueId: "issue-1",
    agentId: "agent-1",
    executionWorkspaceId: "workspace-1",
  },
  task: {
    identifier: "PAP-1",
    title: "Safe task",
    description: null,
    prompt: "# PAP-1: Safe task\n\nPlease address the latest comment.",
    workMode: "standard",
  },
  workspace: { cwd: "/safe/workspace", repoUrl: null, repoRef: null, branchName: null },
  session: {
    normalizedSessionId: null,
    driverKind: "codex_app_server",
    protocolVersion: 1,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
  },
  provider: { kind: "codex", model: null },
  completionContract: {
    id: "contract-1",
    sha256: "abc123",
    schemaVersion: "paperclip.completion-contract.v1",
    contract: {
      revision: "1",
      objective: "Complete the safe task.",
      criteria: [{ id: "objective", requirement: "The task is complete." }],
    },
  },
  interactionResponses: [],
  credentialBindings: [{
    bindingId: "opaque-binding",
    service: "github",
    destination: "github.com",
    expiresAt: null,
    displayName: "GitHub",
  }],
};

describe("NativeExecutionInputV1", () => {
  it("builds a model envelope without authority or credential bindings", () => {
    const parsed = parseNativeExecutionInput(input);
    const model = buildNativeModelEnvelope(parsed);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("company-1");
    expect(serialized).not.toContain("run-1");
    expect(serialized).not.toContain("opaque-binding");
    expect(model.task.title).toBe("Safe task");
    expect(model.task.prompt).toContain("latest comment");
  });

  it("rejects unknown context or environment escape hatches", () => {
    expect(() => parseNativeExecutionInput({ ...input, context: { secret: "canary" } })).toThrow(
      "unknown field context",
    );
    expect(() => parseNativeExecutionInput({
      ...input,
      workspace: { ...input.workspace, env: { PAPERCLIP_API_KEY: "canary" } },
    })).toThrow("unknown field env");
  });

  it("accepts a persisted OpenCode driver/model pair and rejects mismatches", () => {
    const opencode = parseNativeExecutionInput({
      ...input,
      session: { ...input.session, driverKind: "opencode_server" },
      provider: { kind: "opencode", model: "openrouter/deepseek/deepseek-v4-flash-0731" },
    });
    expect(opencode.provider).toEqual({
      kind: "opencode",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    expect(() => parseNativeExecutionInput({
      ...input,
      session: { ...input.session, driverKind: "opencode_server" },
      provider: { kind: "codex", model: null },
    })).toThrow("does not match");
  });

  it("deserializes pre-provider Codex state as Codex", () => {
    const legacy = structuredClone(input) as Record<string, unknown>;
    delete legacy.provider;
    expect(parseNativeExecutionInput(legacy).provider).toEqual({ kind: "codex", model: null });
  });

  it("accepts an immutable Claude Managed Agent profile and rejects driver or beta drift", () => {
    const claudeManaged = {
      ...input,
      session: { ...input.session, driverKind: "claude_managed_agents_api" },
      provider: {
        kind: "claude_managed",
        model: "claude-sonnet-5",
        managedProfile: {
          profileId: "managed-profile-1",
          anthropicAgentId: "agent_01",
          agentVersion: "3",
          environmentId: "environment_01",
          betaVersion: "managed-agents-2026-04-01",
        },
        maxSessionListCostUsd: 1,
      },
    } as const;
    const parsed = parseNativeExecutionInput(claudeManaged);
    expect(parsed.provider).toEqual(claudeManaged.provider);
    expect(buildNativeModelEnvelope(parsed).workspace).toBeNull();
    expect(() => parseNativeExecutionInput({
      ...claudeManaged,
      session: { ...claudeManaged.session, driverKind: "codex_app_server" },
    })).toThrow("does not match");
    expect(() => parseNativeExecutionInput({
      ...claudeManaged,
      provider: {
        ...claudeManaged.provider,
        managedProfile: { ...claudeManaged.provider.managedProfile, betaVersion: "future-beta" },
      },
    })).toThrow("betaVersion");
  });

  it("defaults legacy lifecycle state to per-turn and validates warm timeouts", () => {
    const legacy = structuredClone(input) as Record<string, unknown>;
    delete (legacy.session as Record<string, unknown>).lifecyclePolicy;
    expect(parseNativeExecutionInput(legacy).session.lifecyclePolicy).toEqual({
      mode: "per_turn",
      idleTimeoutMs: null,
    });
    expect(parseNativeExecutionInput({
      ...input,
      session: {
        ...input.session,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
      },
    }).session.lifecyclePolicy).toEqual({ mode: "warm", idleTimeoutMs: 300_000 });
    expect(() => parseNativeExecutionInput({
      ...input,
      session: {
        ...input.session,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 0 },
      },
    })).toThrow("positive integer");
  });
});
