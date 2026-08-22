import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";

type BackendFactoryOptions = {
  runnerInstanceId?: string;
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
  createNativeSessionBackend: state.createBackend,
  executeNativeSession: state.execute,
}));

import {
  buildNativeProviderEnvironment,
  cancelNativeSession,
  executePaperclipNativeSession,
  nativeSessionFailureDisposition,
  nativeSessionFailureSourceCode,
  providerPlanMarkdown,
  semanticProviderPlanMarkdown,
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
