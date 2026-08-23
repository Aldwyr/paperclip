import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";

type BackendFactoryOptions = {
  runnerInstanceId?: string;
  acpxRuntimeDirectory?: string;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
};

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  createBackend: vi.fn(
    (_input: NativeExecutionInputV1, _options: BackendFactoryOptions) => ({
      kind: "test",
    }),
  ),
  cancel: vi.fn(),
  release: null as null | (() => void),
}));

vi.mock("@paperclipai/paperclip-runner", () => ({
  CAPABILITY_SEMANTIC_TOOL_CATALOG: [],
  createNativeSessionBackend: state.createBackend,
  executeNativeSession: state.execute,
}));

import {
  continuingPendingInteractionIds,
  buildNativeProviderEnvironment,
  cancelNativeSession,
  createRunnerdBackend,
  executePaperclipNativeSession,
  getNativeSessionSteeringState,
  NativeSessionSteeringError,
  nativeSessionFailureDisposition,
  nativeSessionFailureSourceCode,
  nativeSessionRecoveryProjection,
  nativeGovernedWaitResult,
  providerPlanMarkdown,
  semanticProviderPlanMarkdown,
  steerNativeSession,
} from "./native-session-executor.js";

describe("native provider bootstrap environment", () => {
  it("inherits the host executable and credential-home context", () => {
    expect(buildNativeProviderEnvironment({}, {
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/runner",
      CODEX_HOME: "/Users/runner/.codex",
      PAPERCLIP_INTERNAL_SECRET: "must-not-leak",
    })).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/runner",
      CODEX_HOME: "/Users/runner/.codex",
    });
  });

  it("lets explicitly configured agent env override host defaults", () => {
    expect(buildNativeProviderEnvironment({
      PATH: "/agent/bin",
      OPENAI_API_KEY: "configured-provider-key",
    }, {
      PATH: "/host/bin",
      HOME: "/Users/runner",
    })).toEqual({
      PATH: "/agent/bin",
      HOME: "/Users/runner",
      OPENAI_API_KEY: "configured-provider-key",
    });
  });
});

const execution = {
  provider: { kind: "codex", model: null },
  binding: {
    companyId: "company",
    runId: "run-native-cancel",
    issueId: "issue",
    agentId: "agent",
  },
  completionContract: { id: "contract", sha256: "sha" },
} as NativeExecutionInputV1;

describe("provider plan synchronization", () => {
  it("prefers the provider's completed Markdown when it is available", () => {
    expect(providerPlanMarkdown({
      markdown: "# Release plan\n\n1. Prepare\n2. Deploy",
      explanation: "This fallback must not replace the completed plan.",
      steps: [{ body: "Fallback", status: "pending" }],
    })).toBe("# Release plan\n\n1. Prepare\n2. Deploy");
  });

  it("extracts a completed plan from the semantic result artifact", () => {
    expect(semanticProviderPlanMarkdown({
      artifacts: [{
        kind: "native_provider_plan",
        ref: "<proposed_plan>\n# Health check\n\n1. Add endpoint\n2. Verify it\n</proposed_plan>",
      }],
    })).toBe("# Health check\n\n1. Add endpoint\n2. Verify it");
  });

  it("decodes the native provider's compact plan reference into readable Markdown", () => {
    expect(semanticProviderPlanMarkdown({
      artifacts: [{
        kind: "native_provider_plan",
        ref: "native-provider-plan:health-check-endpoint-v1#1-register-GET-health-return-200-json-status-ok;2-add-API-tests",
      }],
    })).toBe([
      "# Health check endpoint",
      "",
      "1. Register GET /health return 200 JSON status ok",
      "2. Add API tests",
    ].join("\n"));
  });

  it("decodes a task-scoped native plan URI", () => {
    expect(semanticProviderPlanMarkdown({
      artifacts: [{
        kind: "native_provider_plan",
        ref: "native-plan://DOT-13/health-check#1-add-GET-health;2-add-tests",
      }],
    })).toBe("# Health check\n\n1. Add GET /health\n2. Add tests");
  });

  it("retains readable Markdown embedded after a native provider plan reference", () => {
    expect(semanticProviderPlanMarkdown({
      artifacts: [{
        kind: "native_provider_plan",
        ref: "native-provider-plan:DOT-14-health-check-v1\n1. Add `GET /health`.\n2. Add tests.",
      }],
    })).toBe("# Health check\n\n1. Add `GET /health`.\n2. Add tests.");
  });

  it("normalizes a plain numbered native provider plan", () => {
    expect(semanticProviderPlanMarkdown({
      artifacts: [{
        kind: "native_provider_plan",
        ref: "1. Add GET /health. | 2. Add tests. | 3. Document it.",
      }],
    })).toBe("# Plan\n\n1. Add GET /health.\n2. Add tests.\n3. Document it.");
  });

  it("normalizes a task-labelled inline numbered plan", () => {
    expect(semanticProviderPlanMarkdown({
      artifacts: [{
        kind: "native_provider_plan",
        ref: "DOT-16 plan: (1) add GET /health; (2) add tests; (3) document it.",
      }],
    })).toBe("# Plan\n\n1. add GET /health\n2. add tests\n3. document it.");
  });

  it("uses an explicitly numbered semantic summary when the artifact is opaque", () => {
    expect(semanticProviderPlanMarkdown({
      summary: "Native provider plan completed: 1) add GET /health; 2) add tests; 3) document it.",
      artifacts: [{ kind: "native_provider_plan", ref: "native-provider-plan:DOT-18:health-check" }],
    })).toBe("# Plan\n\n1. add GET /health\n2. add tests\n3. document it.");
  });

  it("renders a bounded Markdown checklist without embedding provenance", () => {
    const markdown = providerPlanMarkdown({
      explanation: "Release safely",
      steps: [
        { body: "Prepare", status: "completed" },
        { body: "Deploy", status: "in_progress" },
        { body: "Verify", status: "blocked" },
      ],
      runId: "must-not-appear",
      providerThreadId: "native-secret",
    });
    expect(markdown).toBe([
      "Release safely",
      "",
      "- [x] Prepare",
      "- [ ] Deploy _(in progress)_",
      "- [ ] Verify _(blocked)_",
    ].join("\n"));
    expect(markdown).not.toContain("must-not-appear");
    expect(markdown).not.toContain("native-secret");
  });
});

describe("native governed waits", () => {
  it("turns a durable pending interaction into a response-wake result", () => {
    expect(nativeGovernedWaitResult({
      interaction: {
        id: "interaction-1",
        title: "Choose an output format",
        summary: null,
      },
      completionContract: {
        revision: "contract-v3",
        objective: "Create the requested output",
        criteria: [{ id: "objective", requirement: "The output is created" }],
      },
    })).toEqual(expect.objectContaining({
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary: "Waiting for Choose an output format.",
      completionClaim: expect.objectContaining({
        contractRevision: "contract-v3",
        objectiveSatisfied: false,
        criteria: [{
          criterionId: "objective",
          status: "unknown",
          evidenceRefs: ["interaction:interaction-1"],
        }],
      }),
      evidence: [{ ref: "interaction:interaction-1" }],
      attentionRequests: [],
      continuation: {
        kind: "response_wake",
        summary: "Resume from the resolved interaction response without repeating prior work.",
        idempotencyKey: "interaction-response:interaction-1",
      },
    }));
  });

  it("keeps an authority-checked partial item-verdict interaction as the wait target", () => {
    const partial = structuredClone(execution);
    partial.interactionResponses = [{
      interactionId: "interaction-partial",
      kind: "request_item_verdicts",
      response: {
        status: "pending",
        result: { version: 1, complete: false, items: [{ id: "alpha", verdict: "approve" }] },
      },
    }];
    expect(continuingPendingInteractionIds(partial)).toEqual(["interaction-partial"]);

    partial.interactionResponses[0]!.response.status = "answered";
    expect(continuingPendingInteractionIds(partial)).toEqual([]);
  });
});

function leaseDb(boundExecution: NativeExecutionInputV1 = execution): Db {
  const coordinator = {
    runId: boundExecution.binding.runId,
    companyId: boundExecution.binding.companyId,
    issueId: boundExecution.binding.issueId,
    phase: "observed",
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    resultId: null,
  };
  const update = () => ({
    set: () => ({ where: async () => [] }),
  });
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () => Promise.resolve([coordinator]),
          }),
        }),
      }),
    }),
    update,
  };
  return {
    transaction: async (operation: (transaction: Db) => Promise<unknown>) => operation(tx as unknown as Db),
    update,
  } as unknown as Db;
}

describe("native session cancellation", () => {
  beforeEach(() => {
    state.cancel.mockReset();
    state.release = null;
    state.execute.mockReset().mockImplementation(async (options) => {
      options.onSession?.({ cancel: state.cancel });
      await new Promise<void>((resolve) => { state.release = resolve; });
      options.onSession?.(null);
      return {
        result: { summary: "cancelled" },
        terminal: { runTerminalState: "cancelled" },
        turnId: "turn",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
  });

  it("routes control-plane cancellation to the active normalized session and removes the handle", async () => {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(cancelNativeSession(execution.binding.runId, "budget hard stop")).resolves.toBe(true);
    await expect(cancelNativeSession(execution.binding.runId, "duplicate budget stop")).resolves.toBe(true);
    expect(state.cancel).toHaveBeenCalledWith({ reason: "budget hard stop" });
    expect(state.cancel).toHaveBeenCalledTimes(1);

    state.release?.();
    await running;
    await expect(cancelNativeSession(execution.binding.runId, "late cancel")).resolves.toBe(false);
  });

  it("allows cancellation to be retried when the session dispatch fails", async () => {
    state.cancel.mockRejectedValueOnce(new Error("transport unavailable"));
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(cancelNativeSession(execution.binding.runId, "budget hard stop"))
      .rejects.toThrow("transport unavailable");
    await expect(cancelNativeSession(execution.binding.runId, "retry budget stop"))
      .resolves.toBe(true);
    expect(state.cancel).toHaveBeenNthCalledWith(2, { reason: "retry budget stop" });

    state.release?.();
    await running;
  });
});

describe("native session same-turn steering", () => {
  const capabilities = vi.fn();
  const snapshot = vi.fn();
  const steer = vi.fn();

  beforeEach(() => {
    state.release = null;
    capabilities.mockReset().mockResolvedValue({ steering: true });
    snapshot.mockReset().mockResolvedValue({ activeTurnId: "provider-turn-1" });
    steer.mockReset().mockResolvedValue(undefined);
    state.execute.mockReset().mockImplementation(async (options) => {
      options.onSession?.({ capabilities, snapshot, steer, cancel: vi.fn() });
      await new Promise<void>((resolve) => { state.release = resolve; });
      options.onSession?.(null);
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "provider-turn-1",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
  });

  async function startActiveSession() {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    return { running };
  }

  it("correlates the queued comment with the active provider turn acknowledgement", async () => {
    const { running } = await startActiveSession();

    await expect(getNativeSessionSteeringState(execution.binding.runId)).resolves.toEqual({
      disposition: "available",
      activeTurnId: "provider-turn-1",
    });
    await expect(steerNativeSession({
      runId: execution.binding.runId,
      message: "Check mobile overflow first.",
      correlationId: "queued-comment-1",
    })).resolves.toEqual({ turnId: "provider-turn-1" });
    expect(steer).toHaveBeenCalledWith({
      turnId: "provider-turn-1",
      message: { role: "user", text: "Check mobile overflow first." },
      correlationId: "queued-comment-1",
    });

    state.release?.();
    await running;
  });

  it.each([
    {
      label: "unsupported provider",
      prepare: () => capabilities.mockResolvedValue({ steering: false }),
      code: "steering_unsupported",
    },
    {
      label: "stale turn",
      prepare: () => snapshot.mockResolvedValue({ activeTurnId: null }),
      code: "steering_stale_turn",
    },
    {
      label: "provider rejection",
      prepare: () => steer.mockRejectedValue(new Error("request rejected")),
      code: "steering_rejected",
    },
  ])("keeps $label retryable with a stable code", async ({ prepare, code }) => {
    prepare();
    const { running } = await startActiveSession();

    const error = await steerNativeSession({
      runId: execution.binding.runId,
      message: "Retryable steering",
      correlationId: "queued-comment-error",
    }).catch((value) => value);
    expect(error).toBeInstanceOf(NativeSessionSteeringError);
    expect(error.code).toBe(code);

    state.release?.();
    await running;
  });

  it("bounds the provider acknowledgement wait", async () => {
    steer.mockReturnValue(new Promise(() => undefined));
    const { running } = await startActiveSession();

    const error = await steerNativeSession({
      runId: execution.binding.runId,
      message: "Do not wait forever",
      correlationId: "queued-comment-timeout",
      timeoutMs: 5,
    }).catch((value) => value);
    expect(error).toBeInstanceOf(NativeSessionSteeringError);
    expect(error.code).toBe("steering_timeout");

    state.release?.();
    await running;
  });
});

describe("native warm session supervision", () => {
  it("reuses one session across distinct governed runs and closes it after idle expiry", async () => {
    const close = vi.fn(async () => undefined);
    const sharedSession = { close };
    const base = {
      ...execution,
      binding: {
        ...execution.binding,
        executionWorkspaceId: "workspace",
      },
      workspace: { cwd: "/tmp/warm-native", repoUrl: null, repoRef: null, branchName: null },
      session: {
        normalizedSessionId: "session-warm-native",
        driverKind: "codex_app_server" as const,
        protocolVersion: 1 as const,
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 },
      },
    } as NativeExecutionInputV1;
    const second = {
      ...base,
      binding: { ...base.binding, runId: "run-native-warm-second" },
    };
    const result = {
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn",
      normalizedSessionId: "session-warm-native",
      providerSessionId: "provider-warm-native",
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    };
    state.execute.mockReset()
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.(sharedSession);
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBe(sharedSession);
        return result;
      });

    await executePaperclipNativeSession({ db: leaseDb(base), execution: base, runnerInstanceId: "runner" });
    await executePaperclipNativeSession({ db: leaseDb(second), execution: second, runnerInstanceId: "runner" });
    expect(close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith({
      reason: "warm native session idle timeout",
    }), { timeout: 500 });
  });
});

describe("native session bounded recovery", () => {
  it("preserves stable provider and runner failure causes", () => {
    expect(nativeSessionFailureSourceCode(new Error(
      "provider_frame_too_large: harness stdout frame exceeded 4194304 bytes",
    ))).toBe("provider_frame_too_large");
    expect(nativeSessionFailureSourceCode(new Error(
      "native_runner_process_exited: runnerd exited unexpectedly with code 1",
    ))).toBe("native_runner_process_exited");
    expect(nativeSessionFailureSourceCode(new Error(
      "provider_transport_failed: invalid JSON-RPC",
    ))).toBe("provider_transport_failed");
    expect(nativeSessionFailureSourceCode(new Error(
      "planning_mode_unsupported: installed Codex app-server did not confirm plan mode",
    ))).toBe("planning_mode_unsupported");
  });

  it("retries the same run twice and stops at the third failed attempt", () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
    expect(nativeSessionFailureDisposition(1, now)).toEqual({
      phase: "retryable_failure",
      failureCode: "native_session_interrupted",
      nextAttemptAt: new Date("2026-08-09T00:00:30.000Z"),
    });
    expect(nativeSessionFailureDisposition(2, now)).toEqual({
      phase: "retryable_failure",
      failureCode: "native_session_interrupted",
      nextAttemptAt: new Date("2026-08-09T00:00:30.000Z"),
    });
    expect(nativeSessionFailureDisposition(3, now)).toEqual({
      phase: "terminal_failure",
      failureCode: "native_session_retry_exhausted",
      nextAttemptAt: null,
    });
  });

  it("escalates exhausted result-less sessions to board review instead of leaving the provider as its own owner", () => {
    expect(nativeSessionRecoveryProjection({
      phase: "retryable_failure",
      failureCode: "native_session_interrupted",
      agentId: "agent-low-capability",
    })).toEqual({
      exhausted: false,
      issueStatus: null,
      recoveryOwner: { kind: "agent", agentId: "agent-low-capability" },
      recoveryActionOwnerType: "agent",
      recoveryActionOwnerAgentId: "agent-low-capability",
      recoveryActionCause: "native_session_interrupted",
      supersedeOnIdentityChange: true,
    });
    expect(nativeSessionRecoveryProjection({
      phase: "terminal_failure",
      failureCode: "native_session_retry_exhausted",
      agentId: "agent-low-capability",
    })).toEqual({
      exhausted: true,
      issueStatus: "in_review",
      recoveryOwner: { kind: "board" },
      recoveryActionOwnerType: "board",
      recoveryActionOwnerAgentId: null,
      recoveryActionCause: "native_session_retry_exhausted",
      supersedeOnIdentityChange: true,
    });
  });
});

describe("native process ownership", () => {
  it("forwards the app-server PID and process group through the production backend seam", async () => {
    const processMetadata = {
      pid: 42_001,
      processGroupId: 42_001,
      startedAt: "2026-08-18T18:00:00.000Z",
    };
    const onSpawn = vi.fn(async () => undefined);
    state.createBackend.mockClear();
    state.execute.mockReset().mockImplementation(async (options) => {
      await options.backend.onSpawn(processMetadata);
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "turn",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
    state.createBackend.mockImplementationOnce((_input, options) => ({
      kind: "test",
      onSpawn: options.onSpawn,
    }));

    await executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
      onSpawn,
    });

    expect(state.createBackend).toHaveBeenCalledWith(execution, expect.objectContaining({
      runnerInstanceId: "runner",
      onSpawn,
    }));
    expect(onSpawn).toHaveBeenCalledWith(processMetadata);
  });
});

describe("runnerd provider runtime wiring", () => {
  it("passes the isolated ACPX runtime directory to the native backend factory", async () => {
    const acpxExecution = {
      ...execution,
      schema: "paperclip.native-execution-input.v3",
      task: {
        identifier: "DOT-ACPX",
        title: "ACPX task",
        description: null,
        prompt: "Complete the ACPX task.",
        workMode: "standard",
      },
      workspace: { cwd: "/tmp/acpx-native", repoUrl: null, repoRef: null, branchName: null },
      session: {
        normalizedSessionId: "acpx-session",
        driverKind: "acpx_runtime",
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
      provider: {
        kind: "acpx",
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionPolicy: "interactive",
        profile: {
          driverKind: "acpx_runtime",
          protocolVersion: 1,
          acpxVersion: "0.13.1",
          agent: "codex",
          agentProfileVersion: 1,
          agentServerPackage: "@agentclientprotocol/codex-acp",
          agentServerVersion: "1.6.2",
          agentRuntimePackage: null,
          agentRuntimeVersion: null,
          commandDigest: "sha256:test",
        },
      },
      executionMode: "default",
      planningContext: null,
      interactionResponses: [],
      credentialBindings: [],
      runtimeContext: {},
    } as unknown as NativeExecutionInputV1;
    state.createBackend.mockClear();
    createRunnerdBackend({
      db: leaseDb(acpxExecution),
      execution: acpxExecution,
      runnerInstanceId: "runner",
    });

    expect(state.createBackend).toHaveBeenCalledWith(acpxExecution, expect.objectContaining({
      acpxRuntimeDirectory: expect.stringContaining("/runtime/paperclip-runner/acpx"),
    }));
  });
});
