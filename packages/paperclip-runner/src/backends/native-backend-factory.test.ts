import { describe, expect, it } from "vitest";

import type { NativeExecutionInput } from "../contracts/native-execution.js";
import { createNativeSessionBackend } from "./native-backend-factory.js";

function execution(
  provider: NativeExecutionInput["provider"],
  driverKind: NativeExecutionInput["session"]["driverKind"],
): NativeExecutionInput {
  return {
    schema: "paperclip.native-execution-input.v1",
    binding: {
      companyId: "company",
      runId: "run",
      issueId: "issue",
      agentId: "agent",
      executionWorkspaceId: "workspace",
    },
    task: {
      identifier: "PAP-1",
      title: "Exercise remote provider routing",
      description: null,
      prompt: "Complete the task.",
      workMode: "standard",
    },
    workspace: {
      cwd: "/workspace",
      repoUrl: null,
      repoRef: null,
      branchName: null,
    },
    session: {
      normalizedSessionId: "session",
      driverKind,
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
    provider,
    completionContract: {
      id: "contract",
      sha256: "sha256",
      schemaVersion: "1",
      contract: {
        revision: "revision",
        objective: "Complete the task.",
        criteria: [],
      },
    },
    interactionResponses: [],
    credentialBindings: [],
  };
}

describe("native backend factory runnerd routing", () => {
  it.each([
    [
      "OpenCode",
      execution(
        { kind: "opencode", model: "openrouter/model" },
        "opencode_server",
      ),
      "opencode_server",
      "1.18.17",
    ],
    [
      "ACPX",
      execution(
        {
          kind: "acpx",
          agent: "pi",
          model: "openrouter/deepseek/deepseek-v4-flash-0731",
          permissionPolicy: "interactive",
          profile: {
            driverKind: "acpx_runtime",
            protocolVersion: 1,
            acpxVersion: "0.13.1",
            agent: "pi",
            agentProfileVersion: 1,
            agentServerPackage: "pi-acp",
            agentServerVersion: "0.0.33",
            agentRuntimePackage: "@earendil-works/pi-coding-agent",
            agentRuntimeVersion: "0.84.2",
            commandDigest:
              "sha256:8c696f38296d53d0061fa11534570c5ddd951b63532aed30e0f1fcc676dc169f",
          },
        },
        "acpx_runtime",
      ),
      "acpx_runtime",
      "0.13.1",
    ],
  ])(
    "routes %s through the supplied runnerd transport while preserving its driver identity",
    async (_label, input, expectedKind, expectedVersion) => {
      const backend = createNativeSessionBackend(input, {
        codexTransportFactory: () => {
          throw new Error("descriptor must not launch the transport");
        },
      });
      await expect(backend.descriptor()).resolves.toMatchObject({
        name: expectedKind,
        version: expectedVersion,
        capabilities: {
          steering: false,
          goals: false,
          threadLineage: false,
          collaborationModes: ["default"],
        },
      });
    },
  );

  it("keeps direct OpenCode execution behind the explicit local runtime seam", () => {
    expect(() =>
      createNativeSessionBackend(
        execution(
          { kind: "opencode", model: "openrouter/model" },
          "opencode_server",
        ),
      ),
    ).toThrow("OpenCode native backend requires an instance runtime directory");
  });

  it("does not expose a retired direct ACPX fallback", () => {
    const acpx = execution(
      {
        kind: "acpx",
        agent: "pi",
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
        permissionPolicy: "interactive",
        profile: {
          driverKind: "acpx_runtime",
          protocolVersion: 1,
          acpxVersion: "0.13.1",
          agent: "pi",
          agentProfileVersion: 1,
          agentServerPackage: "pi-acp",
          agentServerVersion: "0.0.33",
          agentRuntimePackage: "@earendil-works/pi-coding-agent",
          agentRuntimeVersion: "0.84.2",
          commandDigest:
            "sha256:8c696f38296d53d0061fa11534570c5ddd951b63532aed30e0f1fcc676dc169f",
        },
      },
      "acpx_runtime",
    );
    expect(() => createNativeSessionBackend(acpx, {
      acpxRuntimeDirectory: "/tmp/retired-acpx-local",
    })).toThrow("ACPX native backend requires the runnerd transport");
  });
});
